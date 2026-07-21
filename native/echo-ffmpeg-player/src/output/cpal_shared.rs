use crate::device::select_output_device_checked;
use crate::events::{PlayerErrorCode, PlayerEvent};
use crate::exclusive::ExclusiveGuard;
use crate::shared::{SharedAudio, TARGET_CHANNELS};
use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub fn spawn_output_thread(
    device_name: String,
    exclusive: bool,
    shared: Arc<SharedAudio>,
    emit: fn(PlayerEvent),
) -> JoinHandle<()> {
    #[cfg(target_os = "windows")]
    if exclusive {
        return super::wasapi_exclusive::spawn_output_thread(device_name, shared, emit);
    }

    thread::spawn(move || {
        let device = match select_output_device_checked(&device_name, exclusive) {
            Ok(device) => device,
            Err(message) => {
                shared.request_output_stop();
                emit(PlayerEvent::error(
                    PlayerErrorCode::OutputDeviceUnavailable,
                    message,
                ));
                return;
            }
        };
        let resolved_device_name = device.name().unwrap_or_else(|_| device_name.clone());
        let supported = match device.default_output_config() {
            Ok(config) => config,
            Err(err) => {
                shared.request_output_stop();
                emit(PlayerEvent::error(
                    PlayerErrorCode::OutputConfig,
                    format!("failed to get default output config: {err}"),
                ));
                return;
            }
        };
        let mut stream_config = supported.config();
        stream_config.sample_rate = cpal::SampleRate(shared.sample_rate);
        let output_channels = usize::from(stream_config.channels.max(1));
        emit(PlayerEvent::log(
            "info",
            format!(
                "audio output opening: requested='{device_name}', resolved='{resolved_device_name}', exclusive={exclusive}, sample_rate={}, channels={}, format={:?}",
                stream_config.sample_rate.0,
                output_channels,
                supported.sample_format()
            ),
        ));
        let exclusive_guard = if exclusive {
            match ExclusiveGuard::acquire(&device_name) {
                Ok(guard) => guard,
                Err(message) => {
                    shared.request_output_stop();
                    emit(PlayerEvent::error(
                        PlayerErrorCode::OutputExclusive,
                        message,
                    ));
                    return;
                }
            }
        } else {
            None
        };
        let stream = match build_output_stream(
            &device,
            supported.sample_format(),
            &stream_config,
            output_channels,
            shared.clone(),
            emit,
        ) {
            Ok(stream) => stream,
            Err(message) => {
                shared.request_output_stop();
                emit(PlayerEvent::error(PlayerErrorCode::OutputStream, message));
                return;
            }
        };
        if let Err(err) = stream.play() {
            shared.request_output_stop();
            emit(PlayerEvent::error(
                PlayerErrorCode::OutputStream,
                format!("failed to start audio output: {err}"),
            ));
            return;
        }
        shared.mark_output_started();
        emit(PlayerEvent::log(
            "info",
            format!("audio output started: resolved='{resolved_device_name}'"),
        ));
        while !shared.should_stop_output() {
            thread::sleep(Duration::from_millis(50));
        }
        drop(stream);
        drop(exclusive_guard);
    })
}

fn build_output_stream(
    device: &cpal::Device,
    sample_format: SampleFormat,
    config: &StreamConfig,
    output_channels: usize,
    shared: Arc<SharedAudio>,
    emit: fn(PlayerEvent),
) -> Result<Stream, String> {
    let error_shared = shared.clone();
    let err_fn = move |err| {
        error_shared.request_output_stop();
        emit(PlayerEvent::error(
            PlayerErrorCode::OutputRuntime,
            format!("audio output error: {err}"),
        ));
    };
    match sample_format {
        SampleFormat::F32 => {
            let mut stereo_scratch = Vec::<f32>::new();
            device
                .build_output_stream(
                    config,
                    move |data: &mut [f32], _| {
                        fill_output_reusing(data, output_channels, &shared, &mut stereo_scratch)
                    },
                    err_fn,
                    None,
                )
                .map_err(|err| format!("failed to build f32 output stream: {err}"))
        }
        SampleFormat::I16 => {
            let mut output_scratch = Vec::<f32>::new();
            let mut stereo_scratch = Vec::<f32>::new();
            device
                .build_output_stream(
                    config,
                    move |data: &mut [i16], _| {
                        fill_output_converted(
                            data,
                            output_channels,
                            &shared,
                            &mut output_scratch,
                            &mut stereo_scratch,
                        )
                    },
                    err_fn,
                    None,
                )
                .map_err(|err| format!("failed to build i16 output stream: {err}"))
        }
        SampleFormat::U16 => {
            let mut output_scratch = Vec::<f32>::new();
            let mut stereo_scratch = Vec::<f32>::new();
            device
                .build_output_stream(
                    config,
                    move |data: &mut [u16], _| {
                        fill_output_converted(
                            data,
                            output_channels,
                            &shared,
                            &mut output_scratch,
                            &mut stereo_scratch,
                        )
                    },
                    err_fn,
                    None,
                )
                .map_err(|err| format!("failed to build u16 output stream: {err}"))
        }
        _ => Err("audio output sample format is not available".to_string()),
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn fill_output(output: &mut [f32], output_channels: usize, shared: &SharedAudio) {
    let mut stereo_scratch = Vec::<f32>::new();
    fill_output_reusing(output, output_channels, shared, &mut stereo_scratch);
}

fn fill_output_reusing(
    output: &mut [f32],
    output_channels: usize,
    shared: &SharedAudio,
    stereo_scratch: &mut Vec<f32>,
) {
    if shared.paused.load(Ordering::Acquire) || shared.should_stop_output() {
        output.fill(0.0);
        return;
    }
    let volume = shared.volume();
    let output_channels = output_channels.max(1);
    if output_channels == TARGET_CHANNELS {
        shared.pop_into(output);
        process_stereo_output(output, volume, shared);
    } else {
        let frames = output.len() / output_channels;
        stereo_scratch.resize(frames * TARGET_CHANNELS, 0.0);
        shared.pop_into(stereo_scratch);
        process_stereo_output(stereo_scratch, volume, shared);
        map_stereo_to_output(stereo_scratch, output, output_channels);
    }
    if shared.is_drained_for_output() && shared.mark_end_reported() {
        shared.notify_signal(crate::shared::PlaybackSignal::PlaybackEnd);
    }
}

fn fill_output_converted<T>(
    output: &mut [T],
    output_channels: usize,
    shared: &SharedAudio,
    output_scratch: &mut Vec<f32>,
    stereo_scratch: &mut Vec<f32>,
) where
    T: cpal::Sample + cpal::FromSample<f32>,
{
    output_scratch.resize(output.len(), 0.0);
    fill_output_reusing(output_scratch, output_channels, shared, stereo_scratch);
    for (target, sample) in output.iter_mut().zip(output_scratch.iter().copied()) {
        *target = T::from_sample(sample);
    }
}

fn process_stereo_output(output: &mut [f32], volume: f32, shared: &SharedAudio) {
    for sample in output.iter_mut() {
        *sample = (*sample * volume).clamp(-1.0, 1.0);
    }
    if let Ok(mut ring) = shared.spectrum_ring.try_lock() {
        ring.push_interleaved(output, TARGET_CHANNELS);
    }
}

fn map_stereo_to_output(stereo: &[f32], output: &mut [f32], output_channels: usize) {
    output.fill(0.0);
    if output_channels == 0 {
        return;
    }
    for (frame_index, frame) in output.chunks_exact_mut(output_channels).enumerate() {
        let left = stereo
            .get(frame_index * TARGET_CHANNELS)
            .copied()
            .unwrap_or(0.0);
        let right = stereo
            .get(frame_index * TARGET_CHANNELS + 1)
            .copied()
            .unwrap_or(left);
        if output_channels == 1 {
            frame[0] = (left + right) * 0.5;
        } else {
            frame[0] = left;
            frame[1] = right;
        }
    }
}
