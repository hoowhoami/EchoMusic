use crate::device::select_output_device_checked;
use crate::events::{PlayerErrorCode, PlayerEvent};
use crate::exclusive::ExclusiveGuard;
use crate::output::{report_output_start, OutputStartSender};
use crate::shared::{SharedAudio, TARGET_CHANNELS};
use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use std::collections::VecDeque;
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
    spawn_output_thread_with_start_notify(device_name, exclusive, shared, emit, None)
}

pub(crate) fn spawn_output_thread_with_start_notify(
    device_name: String,
    exclusive: bool,
    shared: Arc<SharedAudio>,
    emit: fn(PlayerEvent),
    mut start_notify: Option<OutputStartSender>,
) -> JoinHandle<()> {
    #[cfg(target_os = "windows")]
    if exclusive {
        return super::wasapi_exclusive::spawn_output_thread(
            device_name,
            shared,
            emit,
            start_notify,
        );
    }
    #[cfg(target_os = "linux")]
    if exclusive {
        return super::alsa_exclusive::spawn_output_thread(device_name, shared, emit, start_notify);
    }
    #[cfg(target_os = "macos")]
    if exclusive {
        return super::coreaudio_exclusive::spawn_output_thread(
            device_name,
            shared,
            emit,
            start_notify,
        );
    }

    thread::spawn(move || {
        let device = match select_output_device_checked(&device_name, exclusive) {
            Ok(device) => device,
            Err(message) => {
                report_output_start(&mut start_notify, Err(message.clone()));
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
                let message = format!("failed to get default output config: {err}");
                report_output_start(&mut start_notify, Err(message.clone()));
                shared.request_output_stop();
                emit(PlayerEvent::error(PlayerErrorCode::OutputConfig, message));
                return;
            }
        };
        let stream_config = supported.config();
        let output_channels = usize::from(stream_config.channels.max(1));
        emit(PlayerEvent::log(
            "info",
            format!(
                "audio output opening: requested='{device_name}', resolved='{resolved_device_name}', exclusive={exclusive}, sample_rate={}, engine_sample_rate={}, channels={}, format={:?}",
                stream_config.sample_rate.0,
                shared.sample_rate,
                output_channels,
                supported.sample_format()
            ),
        ));
        let exclusive_guard = if exclusive {
            match ExclusiveGuard::acquire(&device_name) {
                Ok(guard) => guard,
                Err(message) => {
                    report_output_start(&mut start_notify, Err(message.clone()));
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
                report_output_start(&mut start_notify, Err(message.clone()));
                shared.request_output_stop();
                emit(PlayerEvent::error(PlayerErrorCode::OutputStream, message));
                return;
            }
        };
        if let Err(err) = stream.play() {
            let message = format!("failed to start audio output: {err}");
            report_output_start(&mut start_notify, Err(message.clone()));
            shared.request_output_stop();
            emit(PlayerEvent::error(PlayerErrorCode::OutputStream, message));
            return;
        }
        shared.mark_output_started();
        report_output_start(&mut start_notify, Ok(()));
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
    let output_sample_rate = config.sample_rate.0.max(1);
    let err_fn = move |err| {
        if error_shared.should_stop_output() {
            return;
        }
        error_shared.request_output_stop();
        emit(PlayerEvent::error(
            PlayerErrorCode::OutputRuntime,
            format!("audio output error: {err}"),
        ));
    };
    match sample_format {
        SampleFormat::F32 => {
            let mut stereo_scratch = Vec::<f32>::new();
            let mut resampler = OutputResampler::new(shared.sample_rate, output_sample_rate);
            device
                .build_output_stream(
                    config,
                    move |data: &mut [f32], _| {
                        if output_sample_rate == shared.sample_rate {
                            fill_output_reusing(data, output_channels, &shared, &mut stereo_scratch)
                        } else {
                            resampler.fill_output(data, output_channels, &shared)
                        }
                    },
                    err_fn,
                    None,
                )
                .map_err(|err| format!("failed to build f32 output stream: {err}"))
        }
        SampleFormat::I16 => {
            let mut output_scratch = Vec::<f32>::new();
            let mut stereo_scratch = Vec::<f32>::new();
            let mut resampler = OutputResampler::new(shared.sample_rate, output_sample_rate);
            device
                .build_output_stream(
                    config,
                    move |data: &mut [i16], _| {
                        fill_output_converted(
                            data,
                            output_channels,
                            &shared,
                            output_sample_rate,
                            &mut output_scratch,
                            &mut stereo_scratch,
                            &mut resampler,
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
            let mut resampler = OutputResampler::new(shared.sample_rate, output_sample_rate);
            device
                .build_output_stream(
                    config,
                    move |data: &mut [u16], _| {
                        fill_output_converted(
                            data,
                            output_channels,
                            &shared,
                            output_sample_rate,
                            &mut output_scratch,
                            &mut stereo_scratch,
                            &mut resampler,
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

pub(crate) fn fill_output_reusing(
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
    output_sample_rate: u32,
    output_scratch: &mut Vec<f32>,
    stereo_scratch: &mut Vec<f32>,
    resampler: &mut OutputResampler,
) where
    T: cpal::Sample + cpal::FromSample<f32>,
{
    output_scratch.resize(output.len(), 0.0);
    if output_sample_rate == shared.sample_rate {
        fill_output_reusing(output_scratch, output_channels, shared, stereo_scratch);
    } else {
        resampler.fill_output(output_scratch, output_channels, shared);
    }
    for (target, sample) in output.iter_mut().zip(output_scratch.iter().copied()) {
        *target = T::from_sample(sample);
    }
}

struct OutputResampler {
    ratio: f64,
    position: f64,
    pending: VecDeque<f32>,
    input_scratch: Vec<f32>,
    stereo_output: Vec<f32>,
}

impl OutputResampler {
    fn new(input_sample_rate: u32, output_sample_rate: u32) -> Self {
        Self {
            ratio: input_sample_rate.max(1) as f64 / output_sample_rate.max(1) as f64,
            position: 0.0,
            pending: VecDeque::new(),
            input_scratch: Vec::new(),
            stereo_output: Vec::new(),
        }
    }

    fn fill_output(&mut self, output: &mut [f32], output_channels: usize, shared: &SharedAudio) {
        output.fill(0.0);
        if shared.paused.load(Ordering::Acquire) || shared.should_stop_output() {
            return;
        }

        let output_channels = output_channels.max(1);
        let frames = output.len() / output_channels;
        if frames == 0 {
            return;
        }

        self.stereo_output.resize(frames * TARGET_CHANNELS, 0.0);
        self.fill_stereo(frames, shared);
        process_stereo_output(&mut self.stereo_output, shared.volume(), shared);

        if output_channels == TARGET_CHANNELS {
            output[..self.stereo_output.len()].copy_from_slice(&self.stereo_output);
        } else {
            map_stereo_to_output(&self.stereo_output, output, output_channels);
        }

        if shared.is_drained_for_output() && self.pending.is_empty() && shared.mark_end_reported() {
            shared.notify_signal(crate::shared::PlaybackSignal::PlaybackEnd);
        }
    }

    fn fill_stereo(&mut self, frames: usize, shared: &SharedAudio) {
        let needed_frames = ((self.position + (frames.saturating_sub(1) as f64) * self.ratio)
            .floor() as usize)
            .saturating_add(2);
        self.ensure_pending_frames(needed_frames, shared);

        let pending_frames = self.pending.len() / TARGET_CHANNELS;
        if pending_frames == 0 {
            self.stereo_output.fill(0.0);
            self.position = 0.0;
            return;
        }

        for frame_index in 0..frames {
            let base = self.position.floor().max(0.0) as usize;
            let frac = (self.position - base as f64) as f32;
            let out = frame_index * TARGET_CHANNELS;
            if base + 1 < pending_frames {
                let a = base * TARGET_CHANNELS;
                let b = (base + 1) * TARGET_CHANNELS;
                self.stereo_output[out] = lerp(self.pending[a], self.pending[b], frac);
                self.stereo_output[out + 1] = lerp(self.pending[a + 1], self.pending[b + 1], frac);
            } else if base < pending_frames {
                let a = base * TARGET_CHANNELS;
                self.stereo_output[out] = self.pending[a];
                self.stereo_output[out + 1] = self.pending[a + 1];
            } else {
                self.stereo_output[out] = 0.0;
                self.stereo_output[out + 1] = 0.0;
            }
            self.position += self.ratio;
        }

        self.drain_consumed_frames(shared);
    }

    fn ensure_pending_frames(&mut self, needed_frames: usize, shared: &SharedAudio) {
        while self.pending.len() / TARGET_CHANNELS < needed_frames {
            let missing_frames = needed_frames.saturating_sub(self.pending.len() / TARGET_CHANNELS);
            if missing_frames == 0 {
                break;
            }
            self.input_scratch
                .resize(missing_frames * TARGET_CHANNELS, 0.0);
            let consumed_frames = shared.pop_into(&mut self.input_scratch);
            if consumed_frames == 0 {
                break;
            }
            let consumed_samples = consumed_frames * TARGET_CHANNELS;
            self.pending
                .extend(self.input_scratch[..consumed_samples].iter().copied());
            if consumed_frames < missing_frames {
                break;
            }
        }
    }

    fn drain_consumed_frames(&mut self, shared: &SharedAudio) {
        let pending_frames = self.pending.len() / TARGET_CHANNELS;
        if pending_frames == 0 {
            self.position = 0.0;
            return;
        }

        let max_drain_frames = if shared.is_drained_for_output() {
            pending_frames
        } else {
            pending_frames.saturating_sub(1)
        };
        let drain_frames = (self.position.floor() as usize).min(max_drain_frames);
        if drain_frames == 0 {
            return;
        }

        let drain_samples = drain_frames * TARGET_CHANNELS;
        for _ in 0..drain_samples {
            let _ = self.pending.pop_front();
        }
        self.position -= drain_frames as f64;
        if self.pending.is_empty() {
            self.position = 0.0;
        }
    }
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::DspSettings;

    #[test]
    fn output_resampler_converts_engine_rate_to_device_rate() {
        let shared = SharedAudio::new(48_000, 1.0, 8.0, &DspSettings::default());
        shared.paused.store(false, Ordering::Release);

        let input_frames = 480usize;
        let mut samples = Vec::with_capacity(input_frames * TARGET_CHANNELS);
        for frame in 0..input_frames {
            let value = frame as f32 / input_frames as f32;
            samples.push(value);
            samples.push(-value);
        }
        assert!(shared.push_samples(&samples));

        let mut resampler = OutputResampler::new(48_000, 44_100);
        let mut output = vec![0.0; 441 * TARGET_CHANNELS];
        resampler.fill_output(&mut output, TARGET_CHANNELS, &shared);

        assert!(output.iter().any(|sample| sample.abs() > 0.001));
        assert_eq!(shared.played_sample_count(), 480);
    }

    #[test]
    fn output_resampler_maps_stereo_to_device_channels() {
        let shared = SharedAudio::new(44_100, 1.0, 8.0, &DspSettings::default());
        shared.paused.store(false, Ordering::Release);
        assert!(shared.push_samples(&[0.25, -0.25, 0.5, -0.5]));

        let mut resampler = OutputResampler::new(44_100, 48_000);
        let mut output = vec![0.0; 2 * 4];
        resampler.fill_output(&mut output, 4, &shared);

        assert!(output[0].abs() > 0.0);
        assert_eq!(output[2], 0.0);
        assert_eq!(output[3], 0.0);
    }
}
