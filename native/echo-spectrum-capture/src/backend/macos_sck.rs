use crate::dsp::SampleRing;
use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, AnyProtocol, Bool, ClassBuilder, NSObject, Sel};
use objc2::{msg_send, sel, ClassType};
use objc2_foundation::{NSMutableArray, NSString};
use std::ffi::{c_char, c_void};
use std::ptr::{self, NonNull};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

const DEFAULT_SAMPLE_RATE: u32 = 48_000;
const SC_STREAM_OUTPUT_TYPE_AUDIO: isize = 1;

const K_AUDIO_FORMAT_LINEAR_PCM: u32 = u32::from_be_bytes(*b"lpcm");
const K_AUDIO_FORMAT_FLAG_IS_FLOAT: u32 = 1 << 0;
const K_AUDIO_FORMAT_FLAG_IS_SIGNED_INTEGER: u32 = 1 << 2;
const K_AUDIO_FORMAT_FLAG_IS_NON_INTERLEAVED: u32 = 1 << 5;

type CMSampleBufferRef = *mut c_void;
type CMBlockBufferRef = *mut c_void;
type CMAudioFormatDescriptionRef = *mut c_void;
type CFTypeRef = *const c_void;
type OSStatus = i32;

#[repr(C)]
#[derive(Clone, Copy)]
struct AudioStreamBasicDescription {
    sample_rate: f64,
    format_id: u32,
    format_flags: u32,
    bytes_per_packet: u32,
    frames_per_packet: u32,
    bytes_per_frame: u32,
    channels_per_frame: u32,
    bits_per_channel: u32,
    reserved: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct AudioBuffer {
    number_channels: u32,
    data_byte_size: u32,
    data: *mut c_void,
}

#[repr(C)]
struct AudioBufferList {
    number_buffers: u32,
    buffers: [AudioBuffer; 1],
}

#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    fn CMSampleBufferGetDataBuffer(sample_buffer: CMSampleBufferRef) -> CMBlockBufferRef;
    fn CMSampleBufferGetFormatDescription(
        sample_buffer: CMSampleBufferRef,
    ) -> CMAudioFormatDescriptionRef;
    fn CMAudioFormatDescriptionGetStreamBasicDescription(
        desc: CMAudioFormatDescriptionRef,
    ) -> *const AudioStreamBasicDescription;
    fn CMBlockBufferGetDataLength(block_buffer: CMBlockBufferRef) -> usize;
    fn CMBlockBufferCopyDataBytes(
        block_buffer: CMBlockBufferRef,
        offset_to_data: usize,
        data_length: usize,
        destination: *mut c_void,
    ) -> OSStatus;
    fn CMBlockBufferGetDataPointer(
        block_buffer: CMBlockBufferRef,
        offset_to_data: usize,
        length_at_offset_out: *mut usize,
        total_length_out: *mut usize,
        data_pointer_out: *mut *mut c_char,
    ) -> OSStatus;
    fn CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sample_buffer: CMSampleBufferRef,
        buffer_list_size_needed_out: *mut usize,
        buffer_list_out: *mut AudioBufferList,
        buffer_list_size: usize,
        block_buffer_allocator: *const c_void,
        block_buffer_memory_allocator: *const c_void,
        flags: u32,
        block_buffer_out: *mut CMBlockBufferRef,
    ) -> OSStatus;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: CFTypeRef);
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

pub struct MacSckSession {
    pub sample_rate: u32,
    pub last_error: Arc<Mutex<Option<String>>>,
    stream: Retained<AnyObject>,
    _output: Retained<AnyObject>,
    _queue: DispatchRetained<DispatchQueue>,
    _callback_state: Arc<MacCallbackState>,
}

impl Drop for MacSckSession {
    fn drop(&mut self) {
        let pair = Arc::new((Mutex::new(false), Condvar::new()));
        let pair_for_block = pair.clone();
        let block = RcBlock::new(move |_error: *mut AnyObject| {
            let (lock, cvar) = &*pair_for_block;
            if let Ok(mut done) = lock.lock() {
                *done = true;
                cvar.notify_one();
            }
        });

        unsafe {
            let responds: Bool = msg_send![&*self.stream, respondsToSelector: sel!(stopCaptureWithCompletionHandler:)];
            if responds.as_bool() {
                let _: () = msg_send![&*self.stream, stopCaptureWithCompletionHandler: &*block];
                let (lock, cvar) = &*pair;
                if let Ok(done) = lock.lock() {
                    let _ =
                        cvar.wait_timeout_while(done, Duration::from_millis(800), |done| !*done);
                }
            }
        }
    }
}

struct MacCallbackState {
    ring: Arc<Mutex<SampleRing>>,
    sample_rate: AtomicU32,
    last_error: Arc<Mutex<Option<String>>>,
    unsupported_format_reported: AtomicBool,
}

impl MacCallbackState {
    fn new(ring: Arc<Mutex<SampleRing>>, last_error: Arc<Mutex<Option<String>>>) -> Self {
        Self {
            ring,
            sample_rate: AtomicU32::new(DEFAULT_SAMPLE_RATE),
            last_error,
            unsupported_format_reported: AtomicBool::new(false),
        }
    }

    fn set_error_once(&self, message: impl Into<String>) {
        if self
            .unsupported_format_reported
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            if let Ok(mut guard) = self.last_error.lock() {
                *guard = Some(message.into());
            }
        }
    }
}

struct StartedObjects {
    stream: usize,
    output: usize,
    queue: usize,
    sample_rate: u32,
}

type StartResult = Result<StartedObjects, String>;
type StartWaiter = Arc<(Mutex<Option<StartResult>>, Condvar)>;

pub fn start(ring: Arc<Mutex<SampleRing>>) -> Result<MacSckSession, String> {
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        let granted = unsafe { CGRequestScreenCaptureAccess() };
        if !granted {
            return Err(
                "ScreenCaptureKit requires macOS Screen Recording permission for this app"
                    .to_string(),
            );
        }
    }

    let shareable_content_class = class("SCShareableContent")?;
    let _ = class("SCStream")?;
    let _ = class("SCStreamConfiguration")?;
    let _ = class("SCContentFilter")?;

    let last_error = Arc::new(Mutex::new(None));
    let callback_state = Arc::new(MacCallbackState::new(ring, last_error.clone()));
    let waiter: StartWaiter = Arc::new((Mutex::new(None), Condvar::new()));

    let waiter_for_block = waiter.clone();
    let state_for_block = callback_state.clone();
    let error_slot_for_block = last_error.clone();
    let content_block = RcBlock::new(move |content: *mut AnyObject, error: *mut AnyObject| {
        let result = unsafe {
            build_and_start_stream(
                content,
                error,
                state_for_block.clone(),
                error_slot_for_block.clone(),
                waiter_for_block.clone(),
            )
        };

        if let Err(reason) = result {
            complete_waiter(&waiter_for_block, Err(reason));
        }
    });

    unsafe {
        let _: () = msg_send![
            shareable_content_class,
            getShareableContentWithCompletionHandler: &*content_block
        ];
    }

    let started = wait_for_start(&waiter, Duration::from_secs(8))??;

    let stream = unsafe {
        Retained::<AnyObject>::from_raw(started.stream as *mut AnyObject)
            .ok_or_else(|| "ScreenCaptureKit returned a null stream".to_string())?
    };
    let output = unsafe {
        Retained::<AnyObject>::from_raw(started.output as *mut AnyObject)
            .ok_or_else(|| "ScreenCaptureKit returned a null output object".to_string())?
    };
    let queue = unsafe {
        DispatchRetained::<DispatchQueue>::from_raw(
            NonNull::new(started.queue as *mut DispatchQueue)
                .ok_or_else(|| "ScreenCaptureKit returned a null queue".to_string())?,
        )
    };

    Ok(MacSckSession {
        sample_rate: started.sample_rate,
        last_error,
        stream,
        _output: output,
        _queue: queue,
        _callback_state: callback_state,
    })
}

unsafe fn build_and_start_stream(
    content: *mut AnyObject,
    error: *mut AnyObject,
    callback_state: Arc<MacCallbackState>,
    last_error: Arc<Mutex<Option<String>>>,
    waiter: StartWaiter,
) -> Result<(), String> {
    if !error.is_null() {
        return Err(format!(
            "ScreenCaptureKit content request failed: {}",
            ns_error(error)
        ));
    }
    if content.is_null() {
        return Err("ScreenCaptureKit returned no shareable content".to_string());
    }

    let displays: *mut AnyObject = msg_send![content, displays];
    if displays.is_null() {
        return Err("ScreenCaptureKit returned no display list".to_string());
    }
    let display_count: usize = msg_send![displays, count];
    if display_count == 0 {
        return Err("ScreenCaptureKit found no capturable display".to_string());
    }
    let display: *mut AnyObject = msg_send![displays, objectAtIndex: 0usize];
    if display.is_null() {
        return Err("ScreenCaptureKit display is null".to_string());
    }

    let config = make_stream_configuration()?;
    let filter = make_content_filter(display)?;
    let output = make_output(callback_state)?;
    let queue = DispatchQueue::new("com.echomusic.spectrum.sck-audio", None);
    let stream = make_stream(&filter, &config, &output)?;

    let mut add_error: *mut AnyObject = ptr::null_mut();
    let added: Bool = msg_send![
        &*stream,
        addStreamOutput: &*output,
        type: SC_STREAM_OUTPUT_TYPE_AUDIO,
        sampleHandlerQueue: &*queue,
        error: &mut add_error
    ];
    if !added.as_bool() {
        return Err(format!(
            "ScreenCaptureKit add audio output failed: {}",
            ns_error(add_error)
        ));
    }

    let stream_raw = Retained::into_raw(stream) as usize;
    let output_raw = Retained::into_raw(output) as usize;
    let queue_raw = DispatchRetained::into_raw(queue).as_ptr() as usize;
    let sample_rate = DEFAULT_SAMPLE_RATE;
    let waiter_for_start = waiter.clone();

    let start_block = RcBlock::new(move |start_error: *mut AnyObject| {
        if start_error.is_null() {
            complete_waiter(
                &waiter_for_start,
                Ok(StartedObjects {
                    stream: stream_raw,
                    output: output_raw,
                    queue: queue_raw,
                    sample_rate,
                }),
            );
        } else {
            unsafe {
                release_raw_objects(stream_raw, output_raw, queue_raw);
            }
            complete_waiter(
                &waiter_for_start,
                Err(format!(
                    "ScreenCaptureKit start capture failed: {}",
                    ns_error(start_error)
                )),
            );
        }
    });

    let stream_ref = &*(stream_raw as *mut AnyObject);
    let _: () = msg_send![stream_ref, startCaptureWithCompletionHandler: &*start_block];

    if let Ok(mut guard) = last_error.lock() {
        *guard = None;
    }

    Ok(())
}

fn wait_for_start(waiter: &StartWaiter, timeout: Duration) -> Result<StartResult, String> {
    let (lock, cvar) = &**waiter;
    let guard = lock
        .lock()
        .map_err(|err| format!("failed to lock ScreenCaptureKit start state: {err}"))?;
    let (mut guard, _) = cvar
        .wait_timeout_while(guard, timeout, |value| value.is_none())
        .map_err(|err| format!("failed while waiting for ScreenCaptureKit start: {err}"))?;
    guard.take().ok_or_else(|| {
        "ScreenCaptureKit start timed out; check Screen Recording permission".to_string()
    })
}

fn complete_waiter(waiter: &StartWaiter, result: StartResult) {
    let (lock, cvar) = &**waiter;
    if let Ok(mut guard) = lock.lock() {
        if guard.is_none() {
            *guard = Some(result);
            cvar.notify_one();
        } else if let Ok(objects) = result {
            unsafe {
                release_raw_objects(objects.stream, objects.output, objects.queue);
            }
        }
    }
}

unsafe fn make_stream_configuration() -> Result<Retained<AnyObject>, String> {
    let config_class = class("SCStreamConfiguration")?;
    let config: Retained<AnyObject> = msg_send![config_class, new];

    if responds_to(&config, sel!(setWidth:)) {
        let _: () = msg_send![&*config, setWidth: 2usize];
    }
    if responds_to(&config, sel!(setHeight:)) {
        let _: () = msg_send![&*config, setHeight: 2usize];
    }
    if responds_to(&config, sel!(setQueueDepth:)) {
        let _: () = msg_send![&*config, setQueueDepth: 1isize];
    }
    if responds_to(&config, sel!(setShowsCursor:)) {
        let _: () = msg_send![&*config, setShowsCursor: Bool::NO];
    }
    if responds_to(&config, sel!(setCapturesAudio:)) {
        let _: () = msg_send![&*config, setCapturesAudio: Bool::YES];
    }
    if responds_to(&config, sel!(setExcludesCurrentProcessAudio:)) {
        let _: () = msg_send![&*config, setExcludesCurrentProcessAudio: Bool::NO];
    }
    if responds_to(&config, sel!(setSampleRate:)) {
        let _: () = msg_send![&*config, setSampleRate: DEFAULT_SAMPLE_RATE as isize];
    }
    if responds_to(&config, sel!(setChannelCount:)) {
        let _: () = msg_send![&*config, setChannelCount: 2isize];
    }

    if !responds_to(&config, sel!(setCapturesAudio:)) {
        return Err(
            "ScreenCaptureKit audio capture is not available on this macOS version".to_string(),
        );
    }

    Ok(config)
}

unsafe fn make_content_filter(display: *mut AnyObject) -> Result<Retained<AnyObject>, String> {
    let filter_class = class("SCContentFilter")?;
    let empty_windows = NSMutableArray::<AnyObject>::new();
    let empty_apps = NSMutableArray::<AnyObject>::new();
    let filter_alloc: *mut AnyObject = msg_send![filter_class, alloc];

    let has_simple: Bool = msg_send![filter_class, instancesRespondToSelector: sel!(initWithDisplay:excludingWindows:)];
    let filter_ptr: *mut AnyObject = if has_simple.as_bool() {
        msg_send![filter_alloc, initWithDisplay: display, excludingWindows: &*empty_windows]
    } else {
        msg_send![
            filter_alloc,
            initWithDisplay: display,
            excludingApplications: &*empty_apps,
            exceptingWindows: &*empty_windows
        ]
    };

    Retained::from_raw(filter_ptr)
        .ok_or_else(|| "failed to create ScreenCaptureKit content filter".to_string())
}

unsafe fn make_stream(
    filter: &AnyObject,
    config: &AnyObject,
    output: &AnyObject,
) -> Result<Retained<AnyObject>, String> {
    let stream_class = class("SCStream")?;
    let stream_alloc: *mut AnyObject = msg_send![stream_class, alloc];
    let stream_ptr: *mut AnyObject =
        msg_send![stream_alloc, initWithFilter: filter, configuration: config, delegate: output];
    Retained::from_raw(stream_ptr)
        .ok_or_else(|| "failed to create ScreenCaptureKit stream".to_string())
}

unsafe fn make_output(
    callback_state: Arc<MacCallbackState>,
) -> Result<Retained<AnyObject>, String> {
    let output: Retained<AnyObject> = msg_send![output_class(), new];
    let ivar = output
        .class()
        .instance_variable(c"callbackState")
        .ok_or_else(|| "ScreenCaptureKit output class missing callback state ivar".to_string())?;
    *ivar.load_ptr::<*mut c_void>(&output) = Arc::as_ptr(&callback_state) as *mut c_void;
    Ok(output)
}

fn output_class() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| {
        let superclass = NSObject::class();
        let mut builder =
            ClassBuilder::new(c"EchoSpectrumSckOutput", superclass).expect("class registered once");
        if let Some(proto) = AnyProtocol::get(c"SCStreamOutput") {
            builder.add_protocol(proto);
        }
        if let Some(proto) = AnyProtocol::get(c"SCStreamDelegate") {
            builder.add_protocol(proto);
        }
        builder.add_ivar::<*mut c_void>(c"callbackState");

        unsafe {
            let output_fn: extern "C-unwind" fn(_, _, _, _, _) = stream_did_output_sample_buffer;
            builder.add_method(sel!(stream:didOutputSampleBuffer:ofType:), output_fn);

            let stop_fn: extern "C-unwind" fn(_, _, _, _) = stream_did_stop_with_error;
            builder.add_method(sel!(stream:didStopWithError:), stop_fn);
        }

        builder.register()
    })
}

extern "C-unwind" fn stream_did_output_sample_buffer(
    this: &AnyObject,
    _cmd: Sel,
    _stream: *mut AnyObject,
    sample_buffer: CMSampleBufferRef,
    output_type: isize,
) {
    if output_type != SC_STREAM_OUTPUT_TYPE_AUDIO || sample_buffer.is_null() {
        return;
    }

    let Some(state) = callback_state_from_output(this) else {
        return;
    };

    unsafe {
        process_sample_buffer(state, sample_buffer);
    }
}

extern "C-unwind" fn stream_did_stop_with_error(
    this: &AnyObject,
    _cmd: Sel,
    _stream: *mut AnyObject,
    error: *mut AnyObject,
) {
    if error.is_null() {
        return;
    }
    if let Some(state) = callback_state_from_output(this) {
        if let Ok(mut guard) = state.last_error.lock() {
            *guard = Some(format!("ScreenCaptureKit stream stopped: {}", unsafe {
                ns_error(error)
            }));
        }
    }
}

fn callback_state_from_output(this: &AnyObject) -> Option<&'static MacCallbackState> {
    let ivar = this.class().instance_variable(c"callbackState")?;
    let ptr = unsafe { *ivar.load::<*mut c_void>(this) as *const MacCallbackState };
    if ptr.is_null() {
        None
    } else {
        Some(unsafe { &*ptr })
    }
}

unsafe fn process_sample_buffer(state: &MacCallbackState, sample_buffer: CMSampleBufferRef) {
    let format_desc = CMSampleBufferGetFormatDescription(sample_buffer);
    if format_desc.is_null() {
        return;
    }
    let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format_desc);
    if asbd.is_null() {
        return;
    }
    let asbd = *asbd;
    if asbd.sample_rate.is_finite() && asbd.sample_rate > 0.0 {
        state
            .sample_rate
            .store(asbd.sample_rate.round() as u32, Ordering::Release);
    }

    if asbd.format_id != K_AUDIO_FORMAT_LINEAR_PCM {
        state.set_error_once("ScreenCaptureKit delivered non-PCM audio");
        return;
    }
    if push_audio_buffer_list(state, sample_buffer, asbd) {
        return;
    }

    let block = CMSampleBufferGetDataBuffer(sample_buffer);
    if block.is_null() {
        return;
    }

    let data_len = CMBlockBufferGetDataLength(block);
    if data_len == 0 || data_len > 1_048_576 {
        return;
    }

    let mut length_at_offset = 0usize;
    let mut total_length = 0usize;
    let mut data_pointer: *mut c_char = ptr::null_mut();
    let pointer_status = CMBlockBufferGetDataPointer(
        block,
        0,
        &mut length_at_offset,
        &mut total_length,
        &mut data_pointer,
    );
    if pointer_status == 0
        && !data_pointer.is_null()
        && length_at_offset >= data_len
        && total_length >= data_len
    {
        let data = std::slice::from_raw_parts(data_pointer.cast::<u8>(), data_len);
        push_pcm_bytes(state, asbd, data);
        return;
    }

    let mut data = vec![0u8; data_len];
    let status = CMBlockBufferCopyDataBytes(block, 0, data_len, data.as_mut_ptr().cast());
    if status == 0 {
        push_pcm_bytes(state, asbd, &data);
    }
}

unsafe fn push_audio_buffer_list(
    state: &MacCallbackState,
    sample_buffer: CMSampleBufferRef,
    asbd: AudioStreamBasicDescription,
) -> bool {
    let mut needed_size = 0usize;
    let probe_status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sample_buffer,
        &mut needed_size,
        ptr::null_mut(),
        0,
        ptr::null(),
        ptr::null(),
        0,
        ptr::null_mut(),
    );
    if probe_status != 0 || needed_size == 0 || needed_size > 1_048_576 {
        return false;
    }

    let mut storage = vec![0u8; needed_size];
    let list = storage.as_mut_ptr().cast::<AudioBufferList>();
    let mut retained_block: CMBlockBufferRef = ptr::null_mut();
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sample_buffer,
        &mut needed_size,
        list,
        storage.len(),
        ptr::null(),
        ptr::null(),
        0,
        &mut retained_block,
    );
    if status != 0 {
        if !retained_block.is_null() {
            CFRelease(retained_block.cast());
        }
        return false;
    }

    let pushed = push_audio_buffers(state, asbd, &*list);
    if !retained_block.is_null() {
        CFRelease(retained_block.cast());
    }
    pushed
}

unsafe fn push_audio_buffers(
    state: &MacCallbackState,
    asbd: AudioStreamBasicDescription,
    list: &AudioBufferList,
) -> bool {
    let buffer_count = list.number_buffers as usize;
    if buffer_count == 0 || buffer_count > 64 {
        return false;
    }

    let first = list.buffers.as_ptr();
    let buffers = std::slice::from_raw_parts(first, buffer_count);
    if buffers
        .iter()
        .any(|buffer| buffer.data.is_null() || buffer.data_byte_size == 0)
    {
        return false;
    }

    let non_interleaved = asbd.format_flags & K_AUDIO_FORMAT_FLAG_IS_NON_INTERLEAVED != 0;
    if !non_interleaved && buffer_count == 1 {
        let buffer = buffers[0];
        let data =
            std::slice::from_raw_parts(buffer.data.cast::<u8>(), buffer.data_byte_size as usize);
        let channels = buffer.number_channels.max(asbd.channels_per_frame).max(1) as usize;
        let bytes_per_frame = asbd.bytes_per_frame.max(1) as usize;
        push_pcm_bytes_with_layout(state, asbd, data, channels, bytes_per_frame);
        return true;
    }

    push_non_interleaved_pcm(state, asbd, buffers)
}

fn push_pcm_bytes(state: &MacCallbackState, asbd: AudioStreamBasicDescription, data: &[u8]) {
    let channels = asbd.channels_per_frame.max(1) as usize;
    let bytes_per_frame = asbd.bytes_per_frame.max(1) as usize;
    push_pcm_bytes_with_layout(state, asbd, data, channels, bytes_per_frame);
}

fn push_pcm_bytes_with_layout(
    state: &MacCallbackState,
    asbd: AudioStreamBasicDescription,
    data: &[u8],
    channels: usize,
    bytes_per_frame: usize,
) {
    let bits = asbd.bits_per_channel;
    let is_float = asbd.format_flags & K_AUDIO_FORMAT_FLAG_IS_FLOAT != 0;
    let is_signed = asbd.format_flags & K_AUDIO_FORMAT_FLAG_IS_SIGNED_INTEGER != 0;

    if let Ok(mut ring) = state.ring.try_lock() {
        if is_float && bits == 32 {
            push_f32_pcm(&mut ring, &data, channels, bytes_per_frame);
        } else if is_float && bits == 64 {
            push_f64_pcm(&mut ring, &data, channels, bytes_per_frame);
        } else if is_signed && bits == 16 {
            push_i16_pcm(&mut ring, &data, channels, bytes_per_frame);
        } else if is_signed && bits == 32 {
            push_i32_pcm(&mut ring, &data, channels, bytes_per_frame);
        } else {
            state.set_error_once(format!(
                "ScreenCaptureKit delivered unsupported PCM format: bits={bits}, flags={:#x}",
                asbd.format_flags
            ));
        }
    }
}

fn push_non_interleaved_pcm(
    state: &MacCallbackState,
    asbd: AudioStreamBasicDescription,
    buffers: &[AudioBuffer],
) -> bool {
    let bits = asbd.bits_per_channel;
    let bytes_per_sample = (bits / 8).max(1) as usize;
    let is_float = asbd.format_flags & K_AUDIO_FORMAT_FLAG_IS_FLOAT != 0;
    let is_signed = asbd.format_flags & K_AUDIO_FORMAT_FLAG_IS_SIGNED_INTEGER != 0;

    if !((is_float && (bits == 32 || bits == 64)) || (is_signed && (bits == 16 || bits == 32))) {
        state.set_error_once(format!(
            "ScreenCaptureKit delivered unsupported PCM format: bits={bits}, flags={:#x}",
            asbd.format_flags
        ));
        return false;
    }

    let frame_count = buffers
        .iter()
        .map(|buffer| {
            let channels = buffer.number_channels.max(1) as usize;
            buffer.data_byte_size as usize / (bytes_per_sample * channels)
        })
        .min()
        .unwrap_or(0);
    if frame_count == 0 {
        return false;
    }

    if let Ok(mut ring) = state.ring.try_lock() {
        for frame_index in 0..frame_count {
            let mut mono = 0.0f32;
            let mut sample_count = 0usize;
            for buffer in buffers {
                let channel_count = buffer.number_channels.max(1) as usize;
                let frame_stride = bytes_per_sample * channel_count;
                let data = unsafe {
                    std::slice::from_raw_parts(
                        buffer.data.cast::<u8>(),
                        buffer.data_byte_size as usize,
                    )
                };
                let frame_offset = frame_index * frame_stride;
                for channel in 0..channel_count {
                    let offset = frame_offset + channel * bytes_per_sample;
                    if let Some(sample) = read_pcm_sample(data, offset, bits, is_float, is_signed) {
                        mono += sample;
                        sample_count += 1;
                    }
                }
            }
            if sample_count > 0 {
                ring.push(mono / sample_count as f32);
            }
        }
        true
    } else {
        false
    }
}

fn read_pcm_sample(
    data: &[u8],
    offset: usize,
    bits: u32,
    is_float: bool,
    is_signed: bool,
) -> Option<f32> {
    if is_float && bits == 32 {
        Some(f32::from_ne_bytes(
            data.get(offset..offset + 4)?.try_into().ok()?,
        ))
    } else if is_float && bits == 64 {
        Some(f64::from_ne_bytes(data.get(offset..offset + 8)?.try_into().ok()?) as f32)
    } else if is_signed && bits == 16 {
        Some(
            i16::from_ne_bytes(data.get(offset..offset + 2)?.try_into().ok()?) as f32
                / i16::MAX as f32,
        )
    } else if is_signed && bits == 32 {
        Some(
            i32::from_ne_bytes(data.get(offset..offset + 4)?.try_into().ok()?) as f32
                / i32::MAX as f32,
        )
    } else {
        None
    }
}

fn push_f32_pcm(ring: &mut SampleRing, data: &[u8], channels: usize, bytes_per_frame: usize) {
    for frame in data.chunks_exact(bytes_per_frame) {
        let mut mono = 0.0f32;
        for channel in 0..channels {
            let offset = channel * 4;
            if offset + 4 > frame.len() {
                break;
            }
            mono += f32::from_ne_bytes(frame[offset..offset + 4].try_into().unwrap());
        }
        ring.push(mono / channels as f32);
    }
}

fn push_f64_pcm(ring: &mut SampleRing, data: &[u8], channels: usize, bytes_per_frame: usize) {
    for frame in data.chunks_exact(bytes_per_frame) {
        let mut mono = 0.0f32;
        for channel in 0..channels {
            let offset = channel * 8;
            if offset + 8 > frame.len() {
                break;
            }
            mono += f64::from_ne_bytes(frame[offset..offset + 8].try_into().unwrap()) as f32;
        }
        ring.push(mono / channels as f32);
    }
}

fn push_i16_pcm(ring: &mut SampleRing, data: &[u8], channels: usize, bytes_per_frame: usize) {
    for frame in data.chunks_exact(bytes_per_frame) {
        let mut mono = 0.0f32;
        for channel in 0..channels {
            let offset = channel * 2;
            if offset + 2 > frame.len() {
                break;
            }
            mono += i16::from_ne_bytes(frame[offset..offset + 2].try_into().unwrap()) as f32
                / i16::MAX as f32;
        }
        ring.push(mono / channels as f32);
    }
}

fn push_i32_pcm(ring: &mut SampleRing, data: &[u8], channels: usize, bytes_per_frame: usize) {
    for frame in data.chunks_exact(bytes_per_frame) {
        let mut mono = 0.0f32;
        for channel in 0..channels {
            let offset = channel * 4;
            if offset + 4 > frame.len() {
                break;
            }
            mono += i32::from_ne_bytes(frame[offset..offset + 4].try_into().unwrap()) as f32
                / i32::MAX as f32;
        }
        ring.push(mono / channels as f32);
    }
}

unsafe fn responds_to(object: &AnyObject, selector: Sel) -> bool {
    let responds: Bool = msg_send![object, respondsToSelector: selector];
    responds.as_bool()
}

unsafe fn release_raw_objects(stream: usize, output: usize, queue: usize) {
    if stream != 0 {
        drop(Retained::<AnyObject>::from_raw(stream as *mut AnyObject));
    }
    if output != 0 {
        drop(Retained::<AnyObject>::from_raw(output as *mut AnyObject));
    }
    if queue != 0 {
        if let Some(queue) = NonNull::new(queue as *mut DispatchQueue) {
            drop(DispatchRetained::<DispatchQueue>::from_raw(queue));
        }
    }
}

fn class(name: &'static str) -> Result<&'static AnyClass, String> {
    let name = std::ffi::CString::new(name).map_err(|_| "invalid Objective-C class".to_string())?;
    AnyClass::get(&name).ok_or_else(|| format!("{name:?} is unavailable on this macOS version"))
}

unsafe fn ns_error(error: *mut AnyObject) -> String {
    if error.is_null() {
        return "unknown error".to_string();
    }

    let desc: *mut NSString = msg_send![error, localizedDescription];
    if let Some(desc) = Retained::<NSString>::retain(desc) {
        desc.to_string()
    } else {
        "unknown error".to_string()
    }
}
