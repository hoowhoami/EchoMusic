use crate::device::watcher::run_debounced_device_events;
use crate::events::{AudioDevice, PlayerEvent};
use crate::exclusive::ExclusiveGuard;
use crate::shared::TARGET_CHANNELS;
use coreaudio_sys as ca;
use objc2_core_audio_types::{AudioBufferList, AudioValueRange};
use std::ffi::{c_char, c_void, CStr};
use std::mem;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const COREAUDIO_DEVICE_KEY_PREFIX: &str = "coreaudio:";
const COREAUDIO_HOG_NO_OWNER: i32 = -1;
const FALLBACK_SAMPLE_RATE: u32 = 48_000;
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

type CFStringRef = *const c_void;
type CFIndex = isize;
type Boolean = u8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CoreAudioPcmSampleFormat {
    F32,
    I16,
    I32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CoreAudioPcmFormat {
    pub sample_rate: u32,
    pub channels: usize,
    pub sample_format: CoreAudioPcmSampleFormat,
    pub non_interleaved: bool,
}

impl CoreAudioPcmFormat {
    pub fn bytes_per_sample(self) -> usize {
        match self.sample_format {
            CoreAudioPcmSampleFormat::F32 | CoreAudioPcmSampleFormat::I32 => 4,
            CoreAudioPcmSampleFormat::I16 => 2,
        }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(non_snake_case)]
struct AudioStreamRangedDescription {
    mFormat: ca::AudioStreamBasicDescription,
    mSampleRateRange: AudioValueRange,
}

pub(crate) struct CoreAudioPhysicalFormatGuard {
    stream_id: ca::AudioStreamID,
    original_format: Option<ca::AudioStreamBasicDescription>,
}

impl Drop for CoreAudioPhysicalFormatGuard {
    fn drop(&mut self) {
        if let Some(original_format) = self.original_format.take() {
            let _ = change_physical_format_sync(self.stream_id, original_format);
        }
    }
}

extern "C" {
    fn CFStringGetCString(
        the_string: CFStringRef,
        buffer: *mut c_char,
        buffer_size: CFIndex,
        encoding: u32,
    ) -> Boolean;
}

pub(crate) fn list_output_devices() -> Option<Vec<AudioDevice>> {
    let mut devices = Vec::new();
    let default_output_id = default_output_device_id();
    for id in all_audio_devices()? {
        if !has_output_streams(id) {
            continue;
        }
        let Some(name) = device_name(id) else {
            continue;
        };
        let uid = device_uid(id).unwrap_or_else(|| id.to_string());
        devices.push(AudioDevice {
            name: format!("{COREAUDIO_DEVICE_KEY_PREFIX}{uid}"),
            description: name,
            is_default: Some(default_output_id == Some(id)),
        });
    }
    (!devices.is_empty()).then_some(devices)
}

pub(crate) fn is_coreaudio_device_key(value: &str) -> bool {
    value.starts_with(COREAUDIO_DEVICE_KEY_PREFIX)
}

pub(crate) fn resolve_coreaudio_device_name(device_key: &str) -> Option<String> {
    let uid = device_key.strip_prefix(COREAUDIO_DEVICE_KEY_PREFIX)?;
    for id in all_audio_devices()? {
        if device_uid(id).as_deref() == Some(uid) {
            return device_name(id);
        }
    }
    None
}

pub(crate) fn acquire_exclusive(device_name: &str) -> Result<Option<ExclusiveGuard>, String> {
    let device_id = resolve_coreaudio_device_id(device_name)
        .ok_or_else(|| coreaudio_device_not_found_message(device_name))?;
    let current_pid = std::process::id() as i32;
    let owner = hog_mode_owner(device_id)?;

    if owner == current_pid {
        return Ok(Some(ExclusiveGuard::noop()));
    }
    if owner > 0 {
        return Err(format!(
            "CoreAudio exclusive output is already owned by process {owner}"
        ));
    }

    let new_owner = toggle_hog_mode(device_id)?;
    if new_owner != current_pid {
        return Err(format!(
            "failed to acquire CoreAudio exclusive output: owner is {new_owner}"
        ));
    }

    Ok(Some(ExclusiveGuard::coreaudio_hog(device_id)))
}

pub(crate) fn validate_coreaudio_exclusive_output(
    device_name: &str,
    sample_rate: u32,
) -> Result<(), String> {
    let guard = acquire_exclusive(device_name)?;
    let device_id = resolve_coreaudio_device_id(device_name)
        .ok_or_else(|| coreaudio_device_not_found_message(device_name))?;
    let (_format, format_guard) = prepare_coreaudio_exclusive_format(device_id, sample_rate)?;
    drop(format_guard);
    drop(guard);
    Ok(())
}

pub(crate) fn resolve_coreaudio_output_sample_rate(device_name: &str) -> u32 {
    resolve_coreaudio_device_id(device_name)
        .and_then(|device_id| coreaudio_stream_format(device_id).ok())
        .map(|format| format.sample_rate)
        .unwrap_or(FALLBACK_SAMPLE_RATE)
}

pub(crate) fn coreaudio_stream_format(
    device_id: ca::AudioDeviceID,
) -> Result<CoreAudioPcmFormat, String> {
    let stream_id = coreaudio_output_stream(device_id)?;
    coreaudio_stream_virtual_format(stream_id)
}

pub(crate) fn prepare_coreaudio_exclusive_format(
    device_id: ca::AudioDeviceID,
    sample_rate: u32,
) -> Result<(CoreAudioPcmFormat, Option<CoreAudioPhysicalFormatGuard>), String> {
    let stream_id = coreaudio_output_stream(device_id)?;
    let target_format = match find_best_physical_format(stream_id, sample_rate) {
        Ok(format) => format,
        Err(err) => {
            let current_format = coreaudio_stream_virtual_format(stream_id)?;
            if current_format.sample_rate == sample_rate {
                return Ok((current_format, None));
            }
            return Err(err);
        }
    };
    let original_format = coreaudio_physical_format(stream_id)?;
    let changed = !coreaudio_asbd_equals(&original_format, &target_format);
    if changed && !change_physical_format_sync(stream_id, target_format)? {
        return Err(format!(
            "failed to switch CoreAudio physical format to {sample_rate} Hz"
        ));
    }

    let format = coreaudio_stream_virtual_format(stream_id)?;
    if format.sample_rate != sample_rate {
        if changed {
            let _ = change_physical_format_sync(stream_id, original_format);
        }
        return Err(format!(
            "CoreAudio exclusive output sample rate mismatch after format switch: engine={sample_rate} Hz, device={} Hz",
            format.sample_rate
        ));
    }

    let guard = changed.then_some(CoreAudioPhysicalFormatGuard {
        stream_id,
        original_format: Some(original_format),
    });
    Ok((format, guard))
}

fn coreaudio_stream_virtual_format(
    stream_id: ca::AudioStreamID,
) -> Result<CoreAudioPcmFormat, String> {
    let asbd = property_data::<ca::AudioStreamBasicDescription>(
        stream_id,
        ca::kAudioStreamPropertyVirtualFormat,
        ca::kAudioObjectPropertyScopeGlobal,
        ca::kAudioObjectPropertyElementMain,
    )?;
    coreaudio_pcm_format(asbd)
}

fn coreaudio_physical_format(
    stream_id: ca::AudioStreamID,
) -> Result<ca::AudioStreamBasicDescription, String> {
    property_data::<ca::AudioStreamBasicDescription>(
        stream_id,
        ca::kAudioStreamPropertyPhysicalFormat,
        ca::kAudioObjectPropertyScopeGlobal,
        ca::kAudioObjectPropertyElementMain,
    )
}

pub(crate) fn coreaudio_device_display_name(device_id: ca::AudioDeviceID) -> String {
    device_name(device_id).unwrap_or_else(|| device_id.to_string())
}

pub(crate) fn release_exclusive(device_id: ca::AudioDeviceID) {
    let current_pid = std::process::id() as i32;
    if hog_mode_owner(device_id).ok() != Some(current_pid) {
        return;
    }
    let _ = toggle_hog_mode(device_id);
}

pub struct DeviceWatcher {
    stop: Arc<AtomicBool>,
    sender: SyncSender<()>,
    thread: Option<JoinHandle<()>>,
    listeners: Vec<CoreAudioPropertyListener>,
}

impl DeviceWatcher {
    pub fn start(emit: fn(PlayerEvent)) -> Result<Option<Self>, String> {
        let (tx, rx) = sync_channel::<()>(8);
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let listeners = register_coreaudio_device_listeners(tx.clone())?;
        let thread = thread::Builder::new()
            .name("player-device-watcher".to_string())
            .spawn(move || run_debounced_device_events(rx, thread_stop, emit))
            .map_err(|err| format!("failed to spawn CoreAudio device watcher: {err}"))?;
        Ok(Some(Self {
            stop,
            sender: tx,
            thread: Some(thread),
            listeners,
        }))
    }
}

impl Drop for DeviceWatcher {
    fn drop(&mut self) {
        self.listeners.clear();
        self.stop.store(true, Ordering::Release);
        let _ = self.sender.try_send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct CoreAudioPropertyListener {
    object_id: ca::AudioObjectID,
    address: ca::AudioObjectPropertyAddress,
    context: *mut SyncSender<()>,
}

unsafe impl Send for CoreAudioPropertyListener {}

impl Drop for CoreAudioPropertyListener {
    fn drop(&mut self) {
        unsafe {
            ca::AudioObjectRemovePropertyListener(
                self.object_id,
                &self.address,
                Some(coreaudio_device_listener),
                self.context.cast(),
            );
            drop(Box::from_raw(self.context));
        }
    }
}

fn register_coreaudio_device_listeners(
    sender: SyncSender<()>,
) -> Result<Vec<CoreAudioPropertyListener>, String> {
    [
        ca::kAudioHardwarePropertyDevices,
        ca::kAudioHardwarePropertyDefaultOutputDevice,
        ca::kAudioHardwarePropertyDefaultSystemOutputDevice,
    ]
    .into_iter()
    .map(|selector| register_coreaudio_listener(selector, sender.clone()))
    .collect()
}

fn register_coreaudio_listener(
    selector: ca::AudioObjectPropertySelector,
    sender: SyncSender<()>,
) -> Result<CoreAudioPropertyListener, String> {
    register_coreaudio_object_listener(ca::kAudioObjectSystemObject, selector, sender)
}

fn register_coreaudio_object_listener(
    object_id: ca::AudioObjectID,
    selector: ca::AudioObjectPropertySelector,
    sender: SyncSender<()>,
) -> Result<CoreAudioPropertyListener, String> {
    let address = ca::AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: ca::kAudioObjectPropertyScopeGlobal,
        mElement: ca::kAudioObjectPropertyElementMain,
    };
    let context = Box::into_raw(Box::new(sender));
    let status = unsafe {
        ca::AudioObjectAddPropertyListener(
            object_id,
            &address,
            Some(coreaudio_device_listener),
            context.cast(),
        )
    };
    if status != 0 {
        unsafe {
            drop(Box::from_raw(context));
        }
        return Err(format!(
            "failed to register CoreAudio device listener: {status}"
        ));
    }
    Ok(CoreAudioPropertyListener {
        object_id,
        address,
        context,
    })
}

fn default_output_device_id() -> Option<ca::AudioDeviceID> {
    read_system_output_device_id(ca::kAudioHardwarePropertyDefaultOutputDevice)
        .or_else(|| {
            read_system_output_device_id(ca::kAudioHardwarePropertyDefaultSystemOutputDevice)
        })
        .or_else(|| {
            all_audio_devices()?
                .into_iter()
                .find(|device_id| has_output_streams(*device_id))
        })
}

fn read_system_output_device_id(
    selector: ca::AudioObjectPropertySelector,
) -> Option<ca::AudioDeviceID> {
    let address = ca::AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: ca::kAudioObjectPropertyScopeGlobal,
        mElement: ca::kAudioObjectPropertyElementMain,
    };
    let mut id = ca::kAudioObjectUnknown;
    let mut size = mem::size_of::<ca::AudioDeviceID>() as u32;
    let status = unsafe {
        ca::AudioObjectGetPropertyData(
            ca::kAudioObjectSystemObject,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            (&mut id as *mut ca::AudioDeviceID).cast(),
        )
    };
    (status == 0 && id != ca::kAudioObjectUnknown).then_some(id)
}

pub(crate) fn resolve_coreaudio_device_id(device_name_or_key: &str) -> Option<ca::AudioDeviceID> {
    if crate::device::selection::is_default_device_name(device_name_or_key) {
        return default_output_device_id();
    }
    if let Some(uid) = device_name_or_key.strip_prefix(COREAUDIO_DEVICE_KEY_PREFIX) {
        for id in all_audio_devices()? {
            if has_output_streams(id) && device_uid(id).as_deref() == Some(uid) {
                return Some(id);
            }
        }
        return None;
    }

    let selector = crate::device::selection::parse_device_key(device_name_or_key);
    let mut occurrence = 0usize;
    for id in all_audio_devices()? {
        if !has_output_streams(id) {
            continue;
        }
        let Some(name) = device_name(id) else {
            continue;
        };
        if !crate::device::selection::device_name_matches_key(&name, &selector) {
            continue;
        }
        if occurrence == selector.occurrence {
            return Some(id);
        }
        occurrence += 1;
    }
    None
}

fn coreaudio_output_stream(device_id: ca::AudioDeviceID) -> Result<ca::AudioStreamID, String> {
    let streams = property_data_array::<ca::AudioStreamID>(
        device_id,
        ca::kAudioDevicePropertyStreams,
        ca::kAudioDevicePropertyScopeOutput,
        ca::kAudioObjectPropertyElementWildcard,
    )?;
    for stream_id in streams {
        let direction = property_data::<u32>(
            stream_id,
            ca::kAudioStreamPropertyDirection,
            ca::kAudioObjectPropertyScopeGlobal,
            ca::kAudioObjectPropertyElementMain,
        )
        .unwrap_or(0);
        if direction == 0 {
            return Ok(stream_id);
        }
    }
    Err(format!(
        "CoreAudio output device has no usable output stream: {device_id}"
    ))
}

fn coreaudio_pcm_format(
    asbd: ca::AudioStreamBasicDescription,
) -> Result<CoreAudioPcmFormat, String> {
    if asbd.mFormatID != ca::kAudioFormatLinearPCM {
        return Err(format!(
            "CoreAudio exclusive output requires linear PCM, got format {}",
            asbd.mFormatID
        ));
    }
    let flags = asbd.mFormatFlags;
    let bits = asbd.mBitsPerChannel;
    let sample_format = if flags & ca::kAudioFormatFlagIsFloat != 0 && bits == 32 {
        CoreAudioPcmSampleFormat::F32
    } else if flags & ca::kAudioFormatFlagIsSignedInteger != 0 && bits == 16 {
        CoreAudioPcmSampleFormat::I16
    } else if flags & ca::kAudioFormatFlagIsSignedInteger != 0 && bits == 32 {
        CoreAudioPcmSampleFormat::I32
    } else {
        return Err(format!(
            "CoreAudio exclusive output unsupported PCM format: flags={}, bits={bits}",
            asbd.mFormatFlags
        ));
    };
    let sample_rate = asbd.mSampleRate.round() as u32;
    let channels = asbd.mChannelsPerFrame as usize;
    if sample_rate == 0 || channels == 0 {
        return Err("CoreAudio exclusive output reported an invalid stream format".to_string());
    }
    Ok(CoreAudioPcmFormat {
        sample_rate,
        channels,
        sample_format,
        non_interleaved: flags & ca::kAudioFormatFlagIsNonInterleaved != 0,
    })
}

fn find_best_physical_format(
    stream_id: ca::AudioStreamID,
    sample_rate: u32,
) -> Result<ca::AudioStreamBasicDescription, String> {
    let formats = property_data_array::<AudioStreamRangedDescription>(
        stream_id,
        ca::kAudioStreamPropertyAvailablePhysicalFormats,
        ca::kAudioObjectPropertyScopeGlobal,
        ca::kAudioObjectPropertyElementMain,
    )?;
    let mut best = None::<ca::AudioStreamBasicDescription>;
    let mut best_score = u32::MAX;

    for ranged in formats {
        let mut asbd = ranged.mFormat;
        if coreaudio_rate_in_range(sample_rate, ranged.mSampleRateRange) {
            asbd.mSampleRate = sample_rate as f64;
        }
        let Ok(format) = coreaudio_pcm_format(asbd) else {
            continue;
        };
        if format.sample_rate != sample_rate {
            continue;
        }
        let channel_penalty = if format.channels >= TARGET_CHANNELS {
            format.channels.saturating_sub(TARGET_CHANNELS) as u32
        } else {
            (TARGET_CHANNELS.saturating_sub(format.channels) as u32).saturating_add(16)
        };
        let sample_penalty = match format.sample_format {
            CoreAudioPcmSampleFormat::F32 => 0,
            CoreAudioPcmSampleFormat::I32 => 1,
            CoreAudioPcmSampleFormat::I16 => 2,
        };
        let interleaved_penalty = u32::from(format.non_interleaved);
        let score = channel_penalty
            .saturating_mul(16)
            .saturating_add(sample_penalty)
            .saturating_add(interleaved_penalty);
        if score < best_score {
            best_score = score;
            best = Some(asbd);
        }
    }

    best.ok_or_else(|| {
        format!("CoreAudio exclusive output has no physical PCM format at {sample_rate} Hz")
    })
}

fn coreaudio_rate_in_range(sample_rate: u32, range: AudioValueRange) -> bool {
    let sample_rate = sample_rate as f64;
    sample_rate >= range.mMinimum.round() && sample_rate <= range.mMaximum.round()
}

fn change_physical_format_sync(
    stream_id: ca::AudioStreamID,
    target_format: ca::AudioStreamBasicDescription,
) -> Result<bool, String> {
    let previous_format = coreaudio_physical_format(stream_id)?;
    if coreaudio_asbd_equals(&previous_format, &target_format) {
        return Ok(true);
    }

    let (sender, receiver) = sync_channel::<()>(8);
    let listener = register_coreaudio_object_listener(
        stream_id,
        ca::kAudioStreamPropertyPhysicalFormat,
        sender,
    )?;
    set_property_data(
        stream_id,
        ca::kAudioStreamPropertyPhysicalFormat,
        ca::kAudioObjectPropertyScopeGlobal,
        ca::kAudioObjectPropertyElementMain,
        &target_format,
    )?;

    let deadline = Instant::now() + Duration::from_secs(2);
    let mut changed = false;
    while Instant::now() < deadline {
        let actual_format = coreaudio_physical_format(stream_id)?;
        if coreaudio_asbd_equals(&actual_format, &target_format) {
            changed = true;
            break;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let _ = receiver.recv_timeout(remaining.min(Duration::from_millis(100)));
    }
    drop(listener);

    if !changed {
        let _ = set_property_data(
            stream_id,
            ca::kAudioStreamPropertyPhysicalFormat,
            ca::kAudioObjectPropertyScopeGlobal,
            ca::kAudioObjectPropertyElementMain,
            &previous_format,
        );
    }
    Ok(changed)
}

fn coreaudio_asbd_equals(
    left: &ca::AudioStreamBasicDescription,
    right: &ca::AudioStreamBasicDescription,
) -> bool {
    let relevant_flags = ca::kAudioFormatFlagIsPacked
        | ca::kAudioFormatFlagIsFloat
        | ca::kAudioFormatFlagIsSignedInteger
        | ca::kAudioFormatFlagIsBigEndian
        | ca::kAudioFormatFlagIsNonInterleaved;
    (left.mSampleRate - right.mSampleRate).abs() < 1.0
        && left.mFormatID == right.mFormatID
        && (left.mFormatFlags & relevant_flags) == (right.mFormatFlags & relevant_flags)
        && left.mBitsPerChannel == right.mBitsPerChannel
        && left.mBytesPerPacket == right.mBytesPerPacket
        && left.mFramesPerPacket == right.mFramesPerPacket
        && left.mBytesPerFrame == right.mBytesPerFrame
        && left.mChannelsPerFrame == right.mChannelsPerFrame
}

fn property_data<T: Copy>(
    object_id: ca::AudioObjectID,
    selector: ca::AudioObjectPropertySelector,
    scope: ca::AudioObjectPropertyScope,
    element: ca::AudioObjectPropertyElement,
) -> Result<T, String> {
    unsafe {
        let address = ca::AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: scope,
            mElement: element,
        };
        let mut value = mem::zeroed::<T>();
        let mut size = mem::size_of::<T>() as u32;
        let status = ca::AudioObjectGetPropertyData(
            object_id,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            (&mut value as *mut T).cast(),
        );
        if status != 0 {
            return Err(coreaudio_status_message(
                "failed to read CoreAudio property",
                status,
            ));
        }
        Ok(value)
    }
}

fn property_data_array<T: Copy>(
    object_id: ca::AudioObjectID,
    selector: ca::AudioObjectPropertySelector,
    scope: ca::AudioObjectPropertyScope,
    element: ca::AudioObjectPropertyElement,
) -> Result<Vec<T>, String> {
    unsafe {
        let address = ca::AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: scope,
            mElement: element,
        };
        let mut size = 0u32;
        let status =
            ca::AudioObjectGetPropertyDataSize(object_id, &address, 0, std::ptr::null(), &mut size);
        if status != 0 {
            return Err(coreaudio_status_message(
                "failed to read CoreAudio property size",
                status,
            ));
        }
        let count = size as usize / mem::size_of::<T>();
        let mut values = vec![mem::zeroed::<T>(); count];
        let status = ca::AudioObjectGetPropertyData(
            object_id,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            values.as_mut_ptr().cast(),
        );
        if status != 0 {
            return Err(coreaudio_status_message(
                "failed to read CoreAudio property array",
                status,
            ));
        }
        Ok(values)
    }
}

fn set_property_data<T: Copy>(
    object_id: ca::AudioObjectID,
    selector: ca::AudioObjectPropertySelector,
    scope: ca::AudioObjectPropertyScope,
    element: ca::AudioObjectPropertyElement,
    value: &T,
) -> Result<(), String> {
    unsafe {
        let address = ca::AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: scope,
            mElement: element,
        };
        let status = ca::AudioObjectSetPropertyData(
            object_id,
            &address,
            0,
            std::ptr::null(),
            mem::size_of::<T>() as u32,
            (value as *const T).cast(),
        );
        if status != 0 {
            return Err(coreaudio_status_message(
                "failed to set CoreAudio property",
                status,
            ));
        }
        Ok(())
    }
}

fn hog_mode_owner(device_id: ca::AudioDeviceID) -> Result<i32, String> {
    unsafe {
        let address = ca::AudioObjectPropertyAddress {
            mSelector: ca::kAudioDevicePropertyHogMode,
            mScope: ca::kAudioObjectPropertyScopeGlobal,
            mElement: ca::kAudioObjectPropertyElementMain,
        };
        let mut owner = COREAUDIO_HOG_NO_OWNER;
        let mut size = mem::size_of::<i32>() as u32;
        let status = ca::AudioObjectGetPropertyData(
            device_id,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            (&mut owner as *mut i32).cast(),
        );
        if status != 0 {
            return Err(coreaudio_status_message(
                "failed to read CoreAudio exclusive owner",
                status,
            ));
        }
        Ok(owner)
    }
}

fn toggle_hog_mode(device_id: ca::AudioDeviceID) -> Result<i32, String> {
    unsafe {
        let address = ca::AudioObjectPropertyAddress {
            mSelector: ca::kAudioDevicePropertyHogMode,
            mScope: ca::kAudioObjectPropertyScopeGlobal,
            mElement: ca::kAudioObjectPropertyElementMain,
        };
        let owner = COREAUDIO_HOG_NO_OWNER;
        let size = mem::size_of::<i32>() as u32;
        let status = ca::AudioObjectSetPropertyData(
            device_id,
            &address,
            0,
            std::ptr::null(),
            size,
            (&owner as *const i32).cast(),
        );
        if status != 0 {
            return Err(coreaudio_status_message(
                "failed to toggle CoreAudio exclusive output",
                status,
            ));
        }
    }
    hog_mode_owner(device_id)
}

fn coreaudio_device_not_found_message(device_name: &str) -> String {
    if crate::device::selection::is_default_device_name(device_name) {
        "no CoreAudio output device available".to_string()
    } else {
        format!("CoreAudio output device not found: {device_name}")
    }
}

pub(crate) fn coreaudio_status_message(action: &str, status: i32) -> String {
    if let Some(fourcc) = coreaudio_status_fourcc(status) {
        format!("{action}: {status} ('{fourcc}')")
    } else {
        format!("{action}: {status}")
    }
}

fn coreaudio_status_fourcc(status: i32) -> Option<String> {
    let bytes = (status as u32).to_be_bytes();
    bytes
        .iter()
        .all(|byte| byte.is_ascii_graphic() || *byte == b' ')
        .then(|| String::from_utf8_lossy(&bytes).into_owned())
}

extern "C" fn coreaudio_device_listener(
    _object_id: ca::AudioObjectID,
    _number_addresses: u32,
    _addresses: *const ca::AudioObjectPropertyAddress,
    context: *mut c_void,
) -> i32 {
    if context.is_null() {
        return 0;
    }
    let sender = unsafe { &*(context as *const SyncSender<()>) };
    let _ = sender.try_send(());
    0
}

fn all_audio_devices() -> Option<Vec<ca::AudioDeviceID>> {
    unsafe {
        let address = ca::AudioObjectPropertyAddress {
            mSelector: ca::kAudioHardwarePropertyDevices,
            mScope: ca::kAudioObjectPropertyScopeGlobal,
            mElement: ca::kAudioObjectPropertyElementMain,
        };
        let mut size = 0u32;
        if ca::AudioObjectGetPropertyDataSize(
            ca::kAudioObjectSystemObject,
            &address,
            0,
            std::ptr::null(),
            &mut size,
        ) != 0
        {
            return None;
        }
        let count = size as usize / mem::size_of::<ca::AudioDeviceID>();
        let mut devices = vec![0 as ca::AudioDeviceID; count];
        if ca::AudioObjectGetPropertyData(
            ca::kAudioObjectSystemObject,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            devices.as_mut_ptr().cast(),
        ) != 0
        {
            return None;
        }
        Some(devices)
    }
}

fn has_output_streams(id: ca::AudioDeviceID) -> bool {
    unsafe {
        let address = ca::AudioObjectPropertyAddress {
            mSelector: ca::kAudioDevicePropertyStreamConfiguration,
            mScope: ca::kAudioDevicePropertyScopeOutput,
            mElement: ca::kAudioObjectPropertyElementWildcard,
        };
        let mut size = 0u32;
        if ca::AudioObjectGetPropertyDataSize(id, &address, 0, std::ptr::null(), &mut size) != 0
            || size == 0
        {
            return false;
        }
        let mut buffer = Vec::<u8>::with_capacity(size as usize);
        let list = buffer.as_mut_ptr().cast::<AudioBufferList>();
        if ca::AudioObjectGetPropertyData(id, &address, 0, std::ptr::null(), &mut size, list.cast())
            != 0
        {
            return false;
        }
        let buffers =
            std::slice::from_raw_parts((*list).mBuffers.as_ptr(), (*list).mNumberBuffers as usize);
        buffers.iter().any(|buffer| buffer.mNumberChannels > 0)
    }
}

fn device_name(id: ca::AudioDeviceID) -> Option<String> {
    property_cf_string_scoped(
        id,
        ca::kAudioDevicePropertyDeviceNameCFString,
        ca::kAudioDevicePropertyScopeOutput,
    )
    .or_else(|| {
        property_cf_string_scoped(
            id,
            ca::kAudioObjectPropertyName,
            ca::kAudioObjectPropertyScopeGlobal,
        )
    })
    .or_else(|| {
        property_c_string_scoped(
            id,
            ca::kAudioObjectPropertyName,
            ca::kAudioObjectPropertyScopeGlobal,
        )
    })
}

fn device_uid(id: ca::AudioDeviceID) -> Option<String> {
    property_cf_string_scoped(
        id,
        ca::kAudioDevicePropertyDeviceUID,
        ca::kAudioObjectPropertyScopeGlobal,
    )
    .or_else(|| {
        property_c_string_scoped(
            id,
            ca::kAudioDevicePropertyDeviceUID,
            ca::kAudioObjectPropertyScopeGlobal,
        )
    })
}

fn property_cf_string_scoped(
    id: ca::AudioDeviceID,
    selector: ca::AudioObjectPropertySelector,
    scope: ca::AudioObjectPropertyScope,
) -> Option<String> {
    unsafe {
        let address = ca::AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: scope,
            mElement: ca::kAudioObjectPropertyElementMain,
        };
        let mut size = mem::size_of::<CFStringRef>() as u32;
        let mut value: CFStringRef = std::ptr::null();
        if ca::AudioObjectGetPropertyData(
            id,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            (&mut value as *mut CFStringRef).cast(),
        ) != 0
            || value.is_null()
        {
            return None;
        }

        cf_string_to_string(value)
    }
}

fn cf_string_to_string(value: CFStringRef) -> Option<String> {
    unsafe {
        let mut buffer = vec![0i8; 1024];
        if CFStringGetCString(
            value,
            buffer.as_mut_ptr(),
            buffer.len() as CFIndex,
            K_CF_STRING_ENCODING_UTF8,
        ) == 0
        {
            return None;
        }
        CStr::from_ptr(buffer.as_ptr())
            .to_str()
            .ok()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    }
}

fn property_c_string_scoped(
    id: ca::AudioDeviceID,
    selector: ca::AudioObjectPropertySelector,
    scope: ca::AudioObjectPropertyScope,
) -> Option<String> {
    unsafe {
        let address = ca::AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: scope,
            mElement: ca::kAudioObjectPropertyElementMain,
        };
        let mut size = 0u32;
        if ca::AudioObjectGetPropertyDataSize(id, &address, 0, std::ptr::null(), &mut size) != 0 {
            return None;
        }
        let mut buffer = vec![0u8; size as usize + 1];
        if ca::AudioObjectGetPropertyData(
            id,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            buffer.as_mut_ptr().cast(),
        ) != 0
        {
            return None;
        }
        CStr::from_ptr(buffer.as_ptr().cast())
            .to_str()
            .ok()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    }
}
