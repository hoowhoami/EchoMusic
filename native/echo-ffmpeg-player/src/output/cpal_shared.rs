#[cfg(not(target_os = "windows"))]
use crate::device::select_output_device_checked;
#[cfg(not(target_os = "windows"))]
use crate::events::PlayerErrorCode;
use crate::events::PlayerEvent;
#[cfg(not(target_os = "windows"))]
use crate::exclusive::ExclusiveGuard;
use crate::output::OutputStartSender;
#[cfg(not(target_os = "windows"))]
use crate::output::{report_output_start, report_output_start_failure};
use crate::shared::SharedAudio;
#[cfg(not(target_os = "windows"))]
use cpal::traits::{DeviceTrait, StreamTrait};
#[cfg(not(target_os = "windows"))]
use cpal::{BufferSize, SampleFormat, Stream, StreamConfig};
use ffmpeg_audio::{sys, SwrContext};
use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::Arc;
#[cfg(not(target_os = "windows"))]
use std::thread;
use std::thread::JoinHandle;
#[cfg(not(target_os = "windows"))]
use std::time::Duration;
use std::{mem, ptr};

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
    start_notify: Option<OutputStartSender>,
) -> JoinHandle<()> {
    #[cfg(target_os = "windows")]
    {
        return super::wasapi::spawn_output_thread(
            device_name,
            exclusive,
            shared,
            emit,
            start_notify,
        );
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut start_notify = start_notify;
        #[cfg(target_os = "linux")]
        if exclusive {
            return super::alsa_exclusive::spawn_output_thread(
                device_name,
                shared,
                emit,
                start_notify,
            );
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
                    let startup_failure =
                        report_output_start_failure(&mut start_notify, message.clone());
                    shared.request_output_stop();
                    if !startup_failure {
                        emit(PlayerEvent::error(
                            PlayerErrorCode::OutputDeviceUnavailable,
                            message,
                        ));
                    }
                    return;
                }
            };
            let resolved_device_name = device.name().unwrap_or_else(|_| device_name.clone());
            let supported = match device.default_output_config() {
                Ok(config) => config,
                Err(err) => {
                    let message = format!("failed to get default output config: {err}");
                    let startup_failure =
                        report_output_start_failure(&mut start_notify, message.clone());
                    shared.request_output_stop();
                    if !startup_failure {
                        emit(PlayerEvent::error(PlayerErrorCode::OutputConfig, message));
                    }
                    return;
                }
            };
            let stream_config = supported.config();
            let output_channels = usize::from(stream_config.channels.max(1));
            let buffer_frames = cpal_buffer_frames(&stream_config);
            let output_stats = crate::shared::AudioOutputStats {
                backend: "cpal".to_string(),
                sample_rate: f64::from(stream_config.sample_rate.0),
                engine_sample_rate: f64::from(shared.mix_format.sample_rate),
                channels: output_channels as f64,
                format: format!("{:?}", supported.sample_format()),
                buffer_frames: buffer_frames as f64,
                buffer_secs: buffer_frames as f64 / f64::from(stream_config.sample_rate.0.max(1)),
                delay_secs: buffer_frames as f64 / f64::from(stream_config.sample_rate.0.max(1)),
                underruns: 0.0,
            };
            emit(PlayerEvent::log(
                "info",
                format!(
                    "audio output opening: requested='{device_name}', resolved='{resolved_device_name}', exclusive={exclusive}, sample_rate={}, engine_sample_rate={}, channels={}, format={:?}",
                    stream_config.sample_rate.0,
                    shared.mix_format.sample_rate,
                    output_channels,
                    supported.sample_format()
                ),
            ));
            shared.update_output_stats(output_stats);
            let exclusive_guard = if exclusive {
                match ExclusiveGuard::acquire(&device_name) {
                    Ok(guard) => guard,
                    Err(message) => {
                        let startup_failure =
                            report_output_start_failure(&mut start_notify, message.clone());
                        shared.request_output_stop();
                        if !startup_failure {
                            emit(PlayerEvent::error(
                                PlayerErrorCode::OutputExclusive,
                                message,
                            ));
                        }
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
                    let startup_failure =
                        report_output_start_failure(&mut start_notify, message.clone());
                    shared.request_output_stop();
                    if !startup_failure {
                        emit(PlayerEvent::error(PlayerErrorCode::OutputStream, message));
                    }
                    return;
                }
            };
            if let Err(err) = stream.play() {
                let message = format!("failed to start audio output: {err}");
                let startup_failure =
                    report_output_start_failure(&mut start_notify, message.clone());
                shared.request_output_stop();
                if !startup_failure {
                    emit(PlayerEvent::error(PlayerErrorCode::OutputStream, message));
                }
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
}

#[cfg(not(target_os = "windows"))]
fn cpal_buffer_frames(config: &StreamConfig) -> u32 {
    match config.buffer_size {
        BufferSize::Fixed(frames) => frames,
        BufferSize::Default => 0,
    }
}

#[cfg(not(target_os = "windows"))]
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
            let mut graph_scratch = Vec::<f32>::new();
            let mut resampler = OutputResampler::new(
                shared.mix_format.sample_rate,
                output_sample_rate,
                shared.mix_format.channels,
                output_channels,
            )?;
            device
                .build_output_stream(
                    config,
                    move |data: &mut [f32], _| {
                        if can_copy_graph_to_device(&shared, output_sample_rate, output_channels) {
                            fill_output_reusing(data, output_channels, &shared, &mut graph_scratch)
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
            let mut graph_scratch = Vec::<f32>::new();
            let mut resampler = OutputResampler::new(
                shared.mix_format.sample_rate,
                output_sample_rate,
                shared.mix_format.channels,
                output_channels,
            )?;
            device
                .build_output_stream(
                    config,
                    move |data: &mut [i16], _| {
                        fill_output_converted(
                            data,
                            output_channels,
                            &shared,
                            &mut output_scratch,
                            &mut graph_scratch,
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
            let mut graph_scratch = Vec::<f32>::new();
            let mut resampler = OutputResampler::new(
                shared.mix_format.sample_rate,
                output_sample_rate,
                shared.mix_format.channels,
                output_channels,
            )?;
            device
                .build_output_stream(
                    config,
                    move |data: &mut [u16], _| {
                        fill_output_converted(
                            data,
                            output_channels,
                            &shared,
                            &mut output_scratch,
                            &mut graph_scratch,
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

pub(crate) fn fill_output_reusing(
    output: &mut [f32],
    output_channels: usize,
    shared: &SharedAudio,
    graph_scratch: &mut Vec<f32>,
) {
    if shared.paused.load(Ordering::Acquire) || shared.should_stop_output() {
        output.fill(0.0);
        return;
    }
    let volume = shared.volume();
    let output_channels = output_channels.max(1);
    let graph_channels = shared.mix_format.channels.max(1);
    if output_channels == graph_channels {
        shared.pop_into(output);
        process_output_signal(
            output,
            output_channels,
            shared.mix_format.sample_rate,
            volume,
            shared,
        );
    } else {
        let frames = output.len() / output_channels;
        graph_scratch.resize(frames * graph_channels, 0.0);
        shared.pop_into(graph_scratch);
        map_channels_to_output(graph_scratch, graph_channels, output, output_channels);
        process_output_signal(
            output,
            output_channels,
            shared.mix_format.sample_rate,
            volume,
            shared,
        );
    }
    if shared.is_drained_for_output() && shared.mark_end_reported() {
        shared.notify_signal(crate::shared::PlaybackSignal::PlaybackEnd);
    }
}

#[cfg(not(target_os = "windows"))]
fn fill_output_converted<T>(
    output: &mut [T],
    output_channels: usize,
    shared: &SharedAudio,
    output_scratch: &mut Vec<f32>,
    graph_scratch: &mut Vec<f32>,
    resampler: &mut OutputResampler,
) where
    T: cpal::Sample + cpal::FromSample<f32>,
{
    output_scratch.resize(output.len(), 0.0);
    if can_copy_graph_to_device(shared, resampler.output_sample_rate, output_channels) {
        fill_output_reusing(output_scratch, output_channels, shared, graph_scratch);
    } else {
        resampler.fill_output(output_scratch, output_channels, shared);
    }
    for (target, sample) in output.iter_mut().zip(output_scratch.iter().copied()) {
        *target = T::from_sample(sample);
    }
}

pub(crate) struct OutputResampler {
    context: SwrContext,
    input_sample_rate: u32,
    output_sample_rate: u32,
    input_channels: usize,
    output_channels: usize,
    converted_pending: VecDeque<f32>,
    input_scratch: Vec<f32>,
    converted_scratch: Vec<f32>,
    device_output: Vec<f32>,
}

impl OutputResampler {
    pub(crate) fn new(
        input_sample_rate: u32,
        output_sample_rate: u32,
        input_channels: usize,
        output_channels: usize,
    ) -> Result<Self, String> {
        let input_channels = input_channels.max(1);
        let output_channels = output_channels.max(1);
        Ok(Self {
            context: build_swr_context(
                input_sample_rate,
                output_sample_rate,
                input_channels,
                output_channels,
            )?,
            input_sample_rate: input_sample_rate.max(1),
            output_sample_rate: output_sample_rate.max(1),
            input_channels,
            output_channels,
            converted_pending: VecDeque::new(),
            input_scratch: Vec::new(),
            converted_scratch: Vec::new(),
            device_output: Vec::new(),
        })
    }

    pub(crate) fn fill_output(
        &mut self,
        output: &mut [f32],
        output_channels: usize,
        shared: &SharedAudio,
    ) {
        output.fill(0.0);
        if shared.paused.load(Ordering::Acquire) || shared.should_stop_output() {
            return;
        }

        let output_channels = output_channels.max(1);
        let frames = output.len() / output_channels;
        if frames == 0 {
            return;
        }

        self.device_output.resize(frames * output_channels, 0.0);
        self.device_output.fill(0.0);
        self.fill_device(frames, shared);
        let take = output.len().min(self.device_output.len());
        output[..take].copy_from_slice(&self.device_output[..take]);

        if shared.is_drained_for_output()
            && self.converted_pending.is_empty()
            && shared.mark_end_reported()
        {
            shared.notify_signal(crate::shared::PlaybackSignal::PlaybackEnd);
        }
    }

    fn fill_device(&mut self, frames: usize, shared: &SharedAudio) {
        self.ensure_converted_frames(frames, shared);
        if self.converted_pending.len() < self.device_output.len()
            && !shared.is_drained_for_output()
        {
            return;
        }
        let take_samples = self.device_output.len().min(self.converted_pending.len());
        for sample in self.device_output.iter_mut().take(take_samples) {
            *sample = self.converted_pending.pop_front().unwrap_or(0.0);
        }
        process_output_signal(
            &mut self.device_output,
            self.output_channels,
            self.output_sample_rate,
            shared.volume(),
            shared,
        );
    }

    fn ensure_converted_frames(&mut self, needed_frames: usize, shared: &SharedAudio) {
        while self.converted_pending.len() / self.output_channels < needed_frames {
            let missing_output_frames =
                needed_frames.saturating_sub(self.converted_pending.len() / self.output_channels);
            let input_frames = self
                .input_frames_for_output(missing_output_frames)
                .saturating_add(256)
                .max(2048);
            self.input_scratch
                .resize(input_frames * self.input_channels, 0.0);
            let consumed_frames = shared.pop_into(&mut self.input_scratch);
            if consumed_frames == 0 {
                if shared.is_drained_for_output() {
                    self.flush_converter();
                }
                break;
            }
            let consumed_samples = consumed_frames * self.input_channels;
            self.converted_scratch.clear();
            if convert_with_swr(
                &mut self.context,
                &self.input_scratch[..consumed_samples],
                consumed_frames,
                self.output_channels,
                &mut self.converted_scratch,
            )
            .is_err()
            {
                break;
            }
            self.converted_pending
                .extend(self.converted_scratch.iter().copied());
        }
    }

    fn input_frames_for_output(&self, output_frames: usize) -> usize {
        ((output_frames as u128 * self.input_sample_rate as u128) / self.output_sample_rate as u128)
            as usize
    }

    fn flush_converter(&mut self) {
        self.converted_scratch.clear();
        if convert_with_swr(
            &mut self.context,
            &[],
            0,
            self.output_channels,
            &mut self.converted_scratch,
        )
        .is_ok()
        {
            self.converted_pending
                .extend(self.converted_scratch.iter().copied());
        }
    }
}

fn build_swr_context(
    input_sample_rate: u32,
    output_sample_rate: u32,
    input_channels: usize,
    output_channels: usize,
) -> Result<SwrContext, String> {
    let input_rate = i32::try_from(input_sample_rate.max(1))
        .map_err(|_| "input sample rate is too large for output resampler".to_string())?;
    let output_rate = i32::try_from(output_sample_rate.max(1))
        .map_err(|_| "output sample rate is too large for output resampler".to_string())?;
    unsafe {
        let mut input_layout = mem::zeroed::<sys::AVChannelLayout>();
        let mut output_layout = mem::zeroed::<sys::AVChannelLayout>();
        sys::av_channel_layout_default(&raw mut input_layout, input_channels.max(1) as i32);
        sys::av_channel_layout_default(&raw mut output_layout, output_channels.max(1) as i32);
        let result = SwrContext::new(
            &output_layout,
            sys::AVSampleFormat_AV_SAMPLE_FMT_FLT,
            output_rate,
            &input_layout,
            sys::AVSampleFormat_AV_SAMPLE_FMT_FLT,
            input_rate,
        )
        .map_err(|err| format!("failed to create output resampler: {err}"));
        sys::av_channel_layout_uninit(&raw mut input_layout);
        sys::av_channel_layout_uninit(&raw mut output_layout);
        result
    }
}

fn convert_with_swr(
    context: &mut SwrContext,
    input: &[f32],
    input_frames: usize,
    output_channels: usize,
    output: &mut Vec<f32>,
) -> Result<(), String> {
    let input_frames_i32 = i32::try_from(input_frames)
        .map_err(|_| "output resampler input is too large".to_string())?;
    let expected_frames = context
        .get_out_samples(input_frames_i32)
        .map_err(|err| format!("failed to size output resampler buffer: {err}"))?;
    if expected_frames <= 0 {
        return Ok(());
    }
    let expected_samples = (expected_frames as usize)
        .checked_mul(output_channels.max(1))
        .ok_or_else(|| "output resampler sample count overflowed".to_string())?;
    output.resize(expected_samples, 0.0);
    let byte_len = output
        .len()
        .checked_mul(mem::size_of::<f32>())
        .ok_or_else(|| "output resampler byte count overflowed".to_string())?;
    let input_ptrs = [if input.is_empty() {
        ptr::null()
    } else {
        input.as_ptr().cast::<u8>()
    }];
    let actual_frames = unsafe {
        let output_bytes = std::slice::from_raw_parts_mut(
            output.as_mut_ptr().cast::<mem::MaybeUninit<u8>>(),
            byte_len,
        );
        context
            .convert_packed(input_ptrs.as_ptr(), input_frames_i32, output_bytes)
            .map_err(|err| format!("failed to resample output buffer: {err}"))?
    };
    output.truncate(actual_frames.saturating_mul(output_channels.max(1)));
    Ok(())
}

fn process_output_signal(
    output: &mut [f32],
    channels: usize,
    sample_rate: u32,
    volume: f32,
    shared: &SharedAudio,
) {
    for sample in output.iter_mut() {
        *sample = (*sample * volume).clamp(-1.0, 1.0);
    }
    shared.set_spectrum_sample_rate(sample_rate);
    if let Ok(mut ring) = shared.spectrum_ring.try_lock() {
        ring.push_interleaved(output, channels.max(1));
    }
}

fn can_copy_graph_to_device(
    shared: &SharedAudio,
    output_sample_rate: u32,
    output_channels: usize,
) -> bool {
    output_sample_rate == shared.mix_format.sample_rate
        && output_channels.max(1) == shared.mix_format.channels.max(1)
}

fn map_channels_to_output(
    input: &[f32],
    input_channels: usize,
    output: &mut [f32],
    output_channels: usize,
) {
    output.fill(0.0);
    let input_channels = input_channels.max(1);
    let output_channels = output_channels.max(1);
    if input.is_empty() {
        return;
    }
    for (frame_index, frame) in output.chunks_exact_mut(output_channels).enumerate() {
        let input_frame_start = frame_index * input_channels;
        if output_channels == 1 {
            let mut sum = 0.0;
            let mut count = 0usize;
            for sample in input
                .get(input_frame_start..input_frame_start + input_channels)
                .unwrap_or(&[])
            {
                sum += *sample;
                count += 1;
            }
            frame[0] = if count == 0 { 0.0 } else { sum / count as f32 };
            continue;
        }
        if input_channels == 1 {
            let sample = input.get(input_frame_start).copied().unwrap_or(0.0);
            for target in frame.iter_mut() {
                *target = sample;
            }
            continue;
        }
        let copy_channels = output_channels.min(input_channels);
        if let Some(input_frame) = input.get(input_frame_start..input_frame_start + input_channels)
        {
            frame[..copy_channels].copy_from_slice(&input_frame[..copy_channels]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::DspSettings;
    use crate::shared::{MixFormat, MIX_CHANNELS};

    #[test]
    fn output_resampler_converts_engine_rate_to_device_rate() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(48_000),
            1.0,
            8.0,
            &DspSettings::default(),
        );
        shared.paused.store(false, Ordering::Release);

        let input_frames = 4096usize;
        let mut samples = Vec::with_capacity(input_frames * MIX_CHANNELS);
        for frame in 0..input_frames {
            let value = frame as f32 / input_frames as f32;
            samples.push(value);
            samples.push(-value);
        }
        assert!(shared.push_samples(&samples));
        shared.mark_eof();

        let mut resampler = OutputResampler::new(48_000, 44_100, MIX_CHANNELS, MIX_CHANNELS)
            .expect("output resampler should initialize");
        let mut output = vec![0.0; 441 * MIX_CHANNELS];
        resampler.fill_output(&mut output, MIX_CHANNELS, &shared);

        assert!(output.iter().any(|sample| sample.abs() > 0.001));
        assert!(shared.played_sample_count() > 0);
        assert!(shared.played_sample_count() <= input_frames as u64);
    }

    #[test]
    fn output_resampler_maps_stereo_to_device_channels() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(44_100),
            1.0,
            8.0,
            &DspSettings::default(),
        );
        shared.paused.store(false, Ordering::Release);
        let mut samples = Vec::new();
        for frame in 0..4096 {
            let value = frame as f32 / 4096.0;
            samples.push(value);
            samples.push(-value);
        }
        assert!(shared.push_samples(&samples));
        shared.mark_eof();

        let mut resampler = OutputResampler::new(44_100, 48_000, MIX_CHANNELS, 4)
            .expect("output resampler should initialize");
        let mut output = vec![0.0; 512 * 4];
        resampler.fill_output(&mut output, 4, &shared);

        assert!(output
            .chunks_exact(4)
            .any(|frame| frame[0].abs() > 0.001 || frame[1].abs() > 0.001));
        assert!(output.chunks_exact(4).all(|frame| frame[2] == 0.0));
        assert!(output.chunks_exact(4).all(|frame| frame[3] == 0.0));
    }

    #[test]
    fn output_resampler_holds_partial_pending_audio_during_underflow() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(44_100),
            1.0,
            8.0,
            &DspSettings::default(),
        );
        shared.paused.store(false, Ordering::Release);

        let input_frames = 2048usize;
        let mut samples = Vec::with_capacity(input_frames * MIX_CHANNELS);
        for frame in 0..input_frames {
            let value = (frame as f32 + 1.0) / input_frames as f32;
            samples.push(value);
            samples.push(-value);
        }
        assert!(shared.push_samples(&samples));

        let mut resampler = OutputResampler::new(44_100, 48_000, MIX_CHANNELS, MIX_CHANNELS)
            .expect("output resampler should initialize");
        let mut first_output = vec![0.0; 64 * MIX_CHANNELS];
        resampler.fill_output(&mut first_output, MIX_CHANNELS, &shared);
        assert!(first_output.iter().any(|sample| sample.abs() > 0.001));

        let mut underflow_output = vec![0.0; 131_072 * MIX_CHANNELS];
        resampler.fill_output(&mut underflow_output, MIX_CHANNELS, &shared);

        assert!(underflow_output.iter().all(|sample| *sample == 0.0));
        assert_eq!(shared.output_underrun_count(), 1);
    }

    #[test]
    fn shared_output_path_records_underrun_for_all_backends() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(48_000),
            1.0,
            8.0,
            &DspSettings::default(),
        );
        shared.paused.store(false, Ordering::Release);

        let mut output = vec![0.0; 256 * MIX_CHANNELS];
        let mut scratch = Vec::new();
        fill_output_reusing(&mut output, MIX_CHANNELS, &shared, &mut scratch);

        assert_eq!(shared.output_underrun_count(), 1);
    }

    #[test]
    fn resampled_output_path_records_underrun_for_all_backends() {
        let shared = SharedAudio::new(
            MixFormat::stereo_f32(44_100),
            1.0,
            8.0,
            &DspSettings::default(),
        );
        shared.paused.store(false, Ordering::Release);
        let mut resampler = OutputResampler::new(44_100, 48_000, MIX_CHANNELS, MIX_CHANNELS)
            .expect("output resampler should initialize");

        let mut output = vec![0.0; 256 * MIX_CHANNELS];
        resampler.fill_output(&mut output, MIX_CHANNELS, &shared);

        assert_eq!(shared.output_underrun_count(), 1);
    }
}
