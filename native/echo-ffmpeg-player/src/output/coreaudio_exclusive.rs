use super::cpal_shared::OutputResampler;
use crate::device::platform_macos::{
    coreaudio_device_display_name, coreaudio_status_message, prepare_coreaudio_exclusive_format,
    resolve_coreaudio_device_id, try_disable_coreaudio_mixing, CoreAudioMixingGuard,
    CoreAudioPcmFormat, CoreAudioPcmSampleFormat, CoreAudioPhysicalFormatGuard,
};
use crate::events::{PlayerErrorCode, PlayerEvent};
use crate::exclusive::ExclusiveGuard;
use crate::output::{fill_output_reusing, report_output_start, OutputStartSender};
use crate::shared::{SharedAudio, TARGET_CHANNELS};
use coreaudio_sys as ca;
use std::cell::UnsafeCell;
use std::ffi::c_void;
use std::slice;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

struct CoreAudioOutputContext {
    shared: Arc<SharedAudio>,
    format: CoreAudioPcmFormat,
    resampler: UnsafeCell<OutputResampler>,
    stereo_scratch: UnsafeCell<Vec<f32>>,
    output_scratch: UnsafeCell<Vec<f32>>,
}

unsafe impl Sync for CoreAudioOutputContext {}

struct CoreAudioExclusiveOutput {
    device_id: ca::AudioDeviceID,
    io_proc_id: ca::AudioDeviceIOProcID,
    context: *mut CoreAudioOutputContext,
    started: bool,
    physical_format_guard: Option<CoreAudioPhysicalFormatGuard>,
    _mixing_guard: Option<CoreAudioMixingGuard>,
    _exclusive_guard: Option<ExclusiveGuard>,
}

impl Drop for CoreAudioExclusiveOutput {
    fn drop(&mut self) {
        unsafe {
            if self.started {
                let _ = ca::AudioDeviceStop(self.device_id, self.io_proc_id);
            }
            let _ = ca::AudioDeviceDestroyIOProcID(self.device_id, self.io_proc_id);
            if !self.context.is_null() {
                drop(Box::from_raw(self.context));
                self.context = std::ptr::null_mut();
            }
            drop(self.physical_format_guard.take());
        }
    }
}

pub fn spawn_output_thread(
    device_name: String,
    shared: Arc<SharedAudio>,
    emit: fn(PlayerEvent),
    mut start_notify: Option<OutputStartSender>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        if let Err(message) =
            run_exclusive_output(&device_name, shared.clone(), emit, &mut start_notify)
        {
            report_output_start(&mut start_notify, Err(message.clone()));
            shared.request_output_stop();
            emit(PlayerEvent::error(
                PlayerErrorCode::OutputExclusive,
                message,
            ));
        }
    })
}

fn run_exclusive_output(
    device_name: &str,
    shared: Arc<SharedAudio>,
    emit: fn(PlayerEvent),
    start_notify: &mut Option<OutputStartSender>,
) -> Result<(), String> {
    let device_id = resolve_coreaudio_device_id(device_name)
        .ok_or_else(|| format!("CoreAudio output device not found: {device_name}"))?;
    let resolved_device_name = coreaudio_device_display_name(device_id);
    let exclusive_guard = ExclusiveGuard::acquire(device_name)?;
    let mixing_guard = try_disable_coreaudio_mixing(device_id);
    let (format, physical_format_guard) =
        prepare_coreaudio_exclusive_format(device_id, shared.sample_rate)?;
    emit(PlayerEvent::log(
        "info",
        format!(
            "CoreAudio exclusive opening: requested='{device_name}', resolved='{resolved_device_name}', sample_rate={}, engine_sample_rate={}, channels={}, format={:?}, non_interleaved={}, mixing_disabled={}",
            format.sample_rate,
            shared.sample_rate,
            format.channels,
            format.sample_format,
            format.non_interleaved,
            mixing_guard.is_some()
        ),
    ));

    let context = Box::into_raw(Box::new(CoreAudioOutputContext {
        resampler: UnsafeCell::new(OutputResampler::new(shared.sample_rate, format.sample_rate)),
        format,
        shared,
        stereo_scratch: UnsafeCell::new(Vec::new()),
        output_scratch: UnsafeCell::new(Vec::new()),
    }));
    let mut io_proc_id: ca::AudioDeviceIOProcID = None;
    let create_status = unsafe {
        ca::AudioDeviceCreateIOProcID(
            device_id,
            Some(render_callback),
            context.cast(),
            &mut io_proc_id,
        )
    };
    if create_status != 0 {
        unsafe {
            drop(Box::from_raw(context));
        }
        return Err(coreaudio_status_message(
            "failed to create CoreAudio exclusive IOProc",
            create_status,
        ));
    }

    let mut output = CoreAudioExclusiveOutput {
        device_id,
        io_proc_id,
        context,
        started: false,
        physical_format_guard,
        _mixing_guard: mixing_guard,
        _exclusive_guard: exclusive_guard,
    };

    let start_status = unsafe { ca::AudioDeviceStart(device_id, io_proc_id) };
    if start_status != 0 {
        return Err(coreaudio_status_message(
            "failed to start CoreAudio exclusive output",
            start_status,
        ));
    }

    output.started = true;
    output.context_ref().shared.mark_output_started();
    report_output_start(start_notify, Ok(()));
    emit(PlayerEvent::log(
        "info",
        format!("CoreAudio exclusive output started: resolved='{resolved_device_name}'"),
    ));

    while !output.context_ref().shared.should_stop_output() {
        thread::sleep(Duration::from_millis(50));
    }

    drop(output);
    Ok(())
}

impl CoreAudioExclusiveOutput {
    fn context_ref(&self) -> &CoreAudioOutputContext {
        unsafe { &*self.context }
    }
}

unsafe extern "C" fn render_callback(
    _device: ca::AudioObjectID,
    _now: *const ca::AudioTimeStamp,
    _input_data: *const ca::AudioBufferList,
    _input_time: *const ca::AudioTimeStamp,
    output_data: *mut ca::AudioBufferList,
    _output_time: *const ca::AudioTimeStamp,
    client_data: *mut c_void,
) -> ca::OSStatus {
    if output_data.is_null() || client_data.is_null() {
        return 0;
    }
    let context = &*(client_data as *const CoreAudioOutputContext);
    fill_coreaudio_buffers(context, output_data);
    0
}

unsafe fn fill_coreaudio_buffers(context: &CoreAudioOutputContext, list: *mut ca::AudioBufferList) {
    let buffer_count = (*list).mNumberBuffers as usize;
    if buffer_count == 0 {
        return;
    }
    let buffers = slice::from_raw_parts_mut((*list).mBuffers.as_mut_ptr(), buffer_count);
    if context.format.non_interleaved || buffer_count > 1 {
        fill_non_interleaved(buffers, context);
    } else {
        fill_interleaved(&mut buffers[0], context);
    }
}

fn fill_interleaved(buffer: &mut ca::AudioBuffer, context: &CoreAudioOutputContext) {
    if buffer.mData.is_null() || buffer.mDataByteSize == 0 {
        return;
    }
    let channels = (buffer.mNumberChannels as usize)
        .max(context.format.channels)
        .max(1);
    let sample_count = buffer.mDataByteSize as usize / context.format.bytes_per_sample();
    let frame_samples = sample_count - (sample_count % channels);
    match context.format.sample_format {
        CoreAudioPcmSampleFormat::F32 => unsafe {
            let output = slice::from_raw_parts_mut(buffer.mData.cast::<f32>(), frame_samples);
            fill_coreaudio_interleaved_output(output, channels, context);
        },
        CoreAudioPcmSampleFormat::I16 => unsafe {
            let output = slice::from_raw_parts_mut(buffer.mData.cast::<i16>(), frame_samples);
            let output_scratch = &mut *context.output_scratch.get();
            output_scratch.resize(frame_samples, 0.0);
            fill_coreaudio_interleaved_output(output_scratch, channels, context);
            for (target, sample) in output.iter_mut().zip(output_scratch.iter().copied()) {
                *target = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            }
        },
        CoreAudioPcmSampleFormat::I32 => unsafe {
            let output = slice::from_raw_parts_mut(buffer.mData.cast::<i32>(), frame_samples);
            let output_scratch = &mut *context.output_scratch.get();
            output_scratch.resize(frame_samples, 0.0);
            fill_coreaudio_interleaved_output(output_scratch, channels, context);
            for (target, sample) in output.iter_mut().zip(output_scratch.iter().copied()) {
                *target = (sample.clamp(-1.0, 1.0) * i32::MAX as f32).round() as i32;
            }
        },
    }
}

fn fill_coreaudio_interleaved_output(
    output: &mut [f32],
    channels: usize,
    context: &CoreAudioOutputContext,
) {
    if context.format.sample_rate == context.shared.sample_rate {
        let stereo_scratch = unsafe { &mut *context.stereo_scratch.get() };
        fill_output_reusing(output, channels, &context.shared, stereo_scratch);
    } else {
        let resampler = unsafe { &mut *context.resampler.get() };
        resampler.fill_output(output, channels, &context.shared);
    }
}

fn fill_non_interleaved(buffers: &mut [ca::AudioBuffer], context: &CoreAudioOutputContext) {
    let frames = buffers
        .iter()
        .filter(|buffer| !buffer.mData.is_null())
        .map(|buffer| buffer.mDataByteSize as usize / context.format.bytes_per_sample())
        .min()
        .unwrap_or(0);
    if frames == 0 {
        return;
    }

    let stereo_scratch = unsafe { &mut *context.stereo_scratch.get() };
    let output_scratch = unsafe { &mut *context.output_scratch.get() };
    stereo_scratch.resize(frames * TARGET_CHANNELS, 0.0);
    if context.format.sample_rate == context.shared.sample_rate {
        fill_output_reusing(
            stereo_scratch,
            TARGET_CHANNELS,
            &context.shared,
            output_scratch,
        );
    } else {
        let resampler = unsafe { &mut *context.resampler.get() };
        resampler.fill_output(stereo_scratch, TARGET_CHANNELS, &context.shared);
    }

    for (channel, buffer) in buffers.iter_mut().enumerate() {
        if buffer.mData.is_null() {
            continue;
        }
        match context.format.sample_format {
            CoreAudioPcmSampleFormat::F32 => unsafe {
                let output = slice::from_raw_parts_mut(buffer.mData.cast::<f32>(), frames);
                write_non_interleaved_channel(output, stereo_scratch, channel);
            },
            CoreAudioPcmSampleFormat::I16 => unsafe {
                let output = slice::from_raw_parts_mut(buffer.mData.cast::<i16>(), frames);
                for (frame, target) in output.iter_mut().enumerate() {
                    let sample = non_interleaved_sample(stereo_scratch, frame, channel);
                    *target = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
                }
            },
            CoreAudioPcmSampleFormat::I32 => unsafe {
                let output = slice::from_raw_parts_mut(buffer.mData.cast::<i32>(), frames);
                for (frame, target) in output.iter_mut().enumerate() {
                    let sample = non_interleaved_sample(stereo_scratch, frame, channel);
                    *target = (sample.clamp(-1.0, 1.0) * i32::MAX as f32).round() as i32;
                }
            },
        }
    }
}

fn write_non_interleaved_channel(output: &mut [f32], stereo: &[f32], channel: usize) {
    for (frame, target) in output.iter_mut().enumerate() {
        *target = non_interleaved_sample(stereo, frame, channel);
    }
}

fn non_interleaved_sample(stereo: &[f32], frame: usize, channel: usize) -> f32 {
    let left = stereo.get(frame * TARGET_CHANNELS).copied().unwrap_or(0.0);
    let right = stereo
        .get(frame * TARGET_CHANNELS + 1)
        .copied()
        .unwrap_or(left);
    match channel {
        0 => left,
        1 => right,
        _ => 0.0,
    }
}
