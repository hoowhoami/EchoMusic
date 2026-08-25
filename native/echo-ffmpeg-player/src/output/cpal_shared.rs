use crate::audio_graph::soft_limit_sample;
#[cfg(not(target_os = "windows"))]
use crate::device::{device_display_name, select_output_device_checked};
#[cfg(not(target_os = "windows"))]
use crate::events::PlayerErrorCode;
#[cfg(not(target_os = "windows"))]
use crate::events::PlayerEvent;
#[cfg(not(target_os = "windows"))]
use crate::exclusive::ExclusiveGuard;
#[cfg(not(target_os = "windows"))]
use crate::output::{
    build_output_stats, output_buffer_mode_for_frames, output_start_was_cancelled,
    OutputStartSender, OutputStopToken,
};
#[cfg(not(target_os = "windows"))]
use crate::output::{report_output_start, report_output_start_failure};
use crate::shared::SharedAudio;
#[cfg(not(target_os = "windows"))]
use cpal::traits::{DeviceTrait, StreamTrait};
#[cfg(not(target_os = "windows"))]
use cpal::{
    BufferSize, ErrorKind, OutputCallbackInfo, SampleFormat, Stream, StreamConfig,
    SupportedBufferSize,
};
use ffmpeg_audio::{sys, SwrContext};
use std::collections::VecDeque;
use std::sync::atomic::Ordering;
#[cfg(not(target_os = "windows"))]
use std::sync::Arc;
#[cfg(not(target_os = "windows"))]
use std::thread;
#[cfg(not(target_os = "windows"))]
use std::thread::JoinHandle;
#[cfg(not(target_os = "windows"))]
use std::time::Duration;
use std::{mem, ptr};

#[cfg(not(target_os = "windows"))]
pub(crate) fn spawn_shared_output_thread(
    device_name: String,
    exclusive: bool,
    shared: Arc<SharedAudio>,
    stop: OutputStopToken,
    emit: fn(PlayerEvent),
    start_notify: Option<OutputStartSender>,
) -> JoinHandle<()> {
    #[cfg(not(target_os = "windows"))]
    {
        let mut start_notify = start_notify;

        thread::spawn(move || {
            let device = match select_output_device_checked(&device_name, exclusive) {
                Ok(device) => device,
                Err(message) => {
                    let startup_failure =
                        report_output_start_failure(&mut start_notify, message.clone());
                    stop.request_stop();
                    if !startup_failure {
                        emit(PlayerEvent::error(
                            PlayerErrorCode::OutputDeviceUnavailable,
                            message,
                        ));
                    }
                    return;
                }
            };
            let resolved_device_name =
                device_display_name(&device).unwrap_or_else(|| device_name.clone());
            let backend_name = cpal_backend_name(&device);
            let supported = match device.default_output_config() {
                Ok(config) => config,
                Err(err) => {
                    let message = format!("failed to get default output config: {err}");
                    let startup_failure =
                        report_output_start_failure(&mut start_notify, message.clone());
                    stop.request_stop();
                    if !startup_failure {
                        emit(PlayerEvent::error(PlayerErrorCode::OutputConfig, message));
                    }
                    return;
                }
            };
            let base_stream_config = supported.config();
            let requested_buffer_frames = requested_cpal_buffer_frames(
                shared.requested_output_buffer_secs(),
                &base_stream_config,
            );
            let stream_config = cpal_stream_config_with_requested_buffer(
                &device,
                supported.sample_format(),
                base_stream_config,
                shared.requested_output_buffer_secs(),
            );
            if let Some(frames) = requested_buffer_frames {
                if !matches!(stream_config.buffer_size, BufferSize::Fixed(actual) if actual == frames)
                {
                    emit(PlayerEvent::log(
                        "warn",
                        format!(
                            "fixed output buffer not supported by device, falling back to default: requested='{device_name}', resolved='{resolved_device_name}', requested_frames={frames}, requested_secs={:.3}",
                            shared.requested_output_buffer_secs()
                        ),
                    ));
                }
            }
            let output_channels = usize::from(stream_config.channels.max(1));
            let exclusive_guard = if exclusive {
                match ExclusiveGuard::acquire(&device_name) {
                    Ok(guard) => guard,
                    Err(message) => {
                        let startup_failure =
                            report_output_start_failure(&mut start_notify, message.clone());
                        stop.request_stop();
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
                stream_config,
                output_channels,
                device_name.clone(),
                resolved_device_name.clone(),
                shared.clone(),
                stop.clone(),
                emit,
            ) {
                Ok(stream) => stream,
                Err(message) => {
                    let startup_failure =
                        report_output_start_failure(&mut start_notify, message.clone());
                    stop.request_stop();
                    if !startup_failure {
                        emit(PlayerEvent::error(PlayerErrorCode::OutputStream, message));
                    }
                    return;
                }
            };
            let buffer_estimate =
                cpal_buffer_estimate(&stream, &stream_config, supported.buffer_size());
            let device_buffer_secs =
                buffer_estimate.frames as f64 / f64::from(stream_config.sample_rate.max(1));
            let output_stats = build_output_stats(
                backend_name,
                &shared,
                stream_config.sample_rate,
                output_channels,
                format!("{:?}", supported.sample_format()),
                buffer_estimate.mode,
                buffer_estimate.frames as f64,
                device_buffer_secs,
            );
            emit(PlayerEvent::log(
                "info",
                format!(
                    "audio output opening: backend={backend_name}, requested='{device_name}', resolved='{resolved_device_name}', exclusive={exclusive}, sample_rate={}, engine_sample_rate={}, channels={}, format={:?}, buffer_mode={}, buffer_frames={}",
                    stream_config.sample_rate,
                    shared.mix_format.sample_rate,
                    output_channels,
                    supported.sample_format(),
                    output_stats.buffer_mode,
                    output_stats.buffer_frames
                ),
            ));
            if output_start_was_cancelled(&stop, &shared, &mut start_notify) {
                return;
            }
            shared.update_output_stats(output_stats);
            if let Err(err) = stream.play() {
                let message = format!("failed to start audio output: {err}");
                let startup_failure =
                    report_output_start_failure(&mut start_notify, message.clone());
                stop.request_stop();
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
            while !stop.should_stop(&shared) {
                thread::sleep(Duration::from_millis(50));
            }
            drop(stream);
            drop(exclusive_guard);
        })
    }
}

#[cfg(not(target_os = "windows"))]
fn cpal_backend_name(device: &cpal::Device) -> &'static str {
    #[cfg(target_os = "linux")]
    {
        return match device.id().ok().map(|id| id.host()) {
            Some(cpal::HostId::PipeWire) => "pipewire",
            Some(cpal::HostId::PulseAudio) => "pulseaudio",
            Some(cpal::HostId::Alsa) => "alsa-shared",
            _ => "cpal",
        };
    }
    #[cfg(target_os = "macos")]
    {
        let _ = device;
        "coreaudio-shared"
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = device;
        "cpal"
    }
}

#[cfg(not(target_os = "windows"))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct CpalBufferEstimate {
    frames: u32,
    mode: String,
}

#[cfg(not(target_os = "windows"))]
fn cpal_buffer_estimate(
    stream: &Stream,
    config: &StreamConfig,
    supported_buffer_size: &SupportedBufferSize,
) -> CpalBufferEstimate {
    match config.buffer_size {
        BufferSize::Fixed(frames) => CpalBufferEstimate {
            frames,
            mode: output_buffer_mode_for_frames(frames),
        },
        BufferSize::Default => cpal_host_controlled_buffer_estimate(stream, supported_buffer_size),
    }
}

#[cfg(not(target_os = "windows"))]
fn cpal_host_controlled_buffer_estimate(
    stream: &Stream,
    supported_buffer_size: &SupportedBufferSize,
) -> CpalBufferEstimate {
    let frames = stream
        .buffer_size()
        .ok()
        .filter(|frames| *frames > 0)
        .or_else(|| match supported_buffer_size {
            SupportedBufferSize::Range { min, .. } => Some(*min),
            SupportedBufferSize::Unknown => None,
        })
        .unwrap_or(0);
    CpalBufferEstimate {
        frames,
        mode: "host_controlled".to_string(),
    }
}

#[cfg(all(test, not(target_os = "windows")))]
fn cpal_host_controlled_buffer_estimate_from_values(
    runtime_frames: Option<u32>,
    supported_buffer_size: &SupportedBufferSize,
) -> CpalBufferEstimate {
    let frames = runtime_frames
        .filter(|frames| *frames > 0)
        .or_else(|| match supported_buffer_size {
            SupportedBufferSize::Range { min, .. } => Some(*min),
            SupportedBufferSize::Unknown => None,
        })
        .unwrap_or(0);
    CpalBufferEstimate {
        frames,
        mode: "host_controlled".to_string(),
    }
}

#[cfg(not(target_os = "windows"))]
fn cpal_stream_config_with_requested_buffer(
    device: &cpal::Device,
    sample_format: SampleFormat,
    config: StreamConfig,
    requested_buffer_secs: f64,
) -> StreamConfig {
    let Some(frames) = requested_cpal_buffer_frames(requested_buffer_secs, &config) else {
        return config;
    };
    let fixed_supported = cpal_fixed_buffer_supported(device, sample_format, &config, frames);
    cpal_stream_config_with_fixed_buffer_support(config, frames, fixed_supported)
}

#[cfg(not(target_os = "windows"))]
fn cpal_stream_config_with_fixed_buffer_support(
    mut config: StreamConfig,
    frames: u32,
    fixed_supported: bool,
) -> StreamConfig {
    if fixed_supported {
        config.buffer_size = BufferSize::Fixed(frames);
    }
    config
}

#[cfg(not(target_os = "windows"))]
fn requested_cpal_buffer_frames(buffer_secs: f64, config: &StreamConfig) -> Option<u32> {
    if buffer_secs <= 0.0 || !buffer_secs.is_finite() {
        return None;
    }
    let frames = (buffer_secs * f64::from(config.sample_rate.max(1))).round();
    if frames <= 0.0 || !frames.is_finite() {
        return None;
    }
    Some(frames.clamp(1.0, u32::MAX as f64) as u32)
}

#[cfg(not(target_os = "windows"))]
fn cpal_fixed_buffer_supported(
    device: &cpal::Device,
    sample_format: SampleFormat,
    config: &StreamConfig,
    frames: u32,
) -> bool {
    let Ok(ranges) = device.supported_output_configs() else {
        return false;
    };
    cpal_fixed_buffer_supported_in_ranges(ranges, sample_format, config, frames)
}

#[cfg(not(target_os = "windows"))]
fn cpal_fixed_buffer_supported_in_ranges(
    ranges: impl IntoIterator<Item = cpal::SupportedStreamConfigRange>,
    sample_format: SampleFormat,
    config: &StreamConfig,
    frames: u32,
) -> bool {
    ranges.into_iter().any(|range| {
        range.sample_format() == sample_format
            && range.channels() == config.channels
            && range.min_sample_rate() <= config.sample_rate
            && range.max_sample_rate() >= config.sample_rate
            && match range.buffer_size() {
                SupportedBufferSize::Range { min, max } => frames >= *min && frames <= *max,
                SupportedBufferSize::Unknown => false,
            }
    })
}

#[cfg(not(target_os = "windows"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CpalOutputErrorAction {
    Ignore { reason: &'static str },
    Recover { reason: &'static str },
    Escalate { reason: &'static str },
}

#[cfg(not(target_os = "windows"))]
fn classify_cpal_output_error(
    kind: ErrorKind,
    _requested_device_name: &str,
) -> CpalOutputErrorAction {
    match kind {
        ErrorKind::Xrun => CpalOutputErrorAction::Ignore { reason: "xrun" },
        // CPAL's CoreAudio DefaultOutput AudioUnit and PipeWire default node reroute the live
        // stream themselves. Rebuilding here would duplicate that transition; backends that lose
        // the route report DeviceNotAvailable/StreamInvalidated instead.
        ErrorKind::DeviceChanged => CpalOutputErrorAction::Ignore {
            reason: "device-changed",
        },
        ErrorKind::DeviceNotAvailable => CpalOutputErrorAction::Recover {
            reason: "device-not-available",
        },
        ErrorKind::StreamInvalidated => CpalOutputErrorAction::Recover {
            reason: "stream-invalidated",
        },
        _ => CpalOutputErrorAction::Escalate { reason: "backend" },
    }
}

#[cfg(not(target_os = "windows"))]
fn update_live_output_delay(shared: &SharedAudio, info: &OutputCallbackInfo) {
    let timestamp = info.timestamp();
    let delay = timestamp.playback.duration_since(timestamp.callback);
    shared.update_live_output_delay_secs(delay.as_secs_f64());
}

#[cfg(not(target_os = "windows"))]
fn build_output_stream(
    device: &cpal::Device,
    sample_format: SampleFormat,
    config: StreamConfig,
    output_channels: usize,
    requested_device_name: String,
    resolved_device_name: String,
    shared: Arc<SharedAudio>,
    stop: OutputStopToken,
    emit: fn(PlayerEvent),
) -> Result<Stream, String> {
    let error_shared = shared.clone();
    let error_stop = stop.clone();
    let output_sample_rate = config.sample_rate.max(1);
    let err_fn = move |err: cpal::Error| {
        if error_stop.should_stop(&error_shared) {
            return;
        }
        let action = classify_cpal_output_error(err.kind(), &requested_device_name);
        let message = format!(
            "audio output error: requested='{requested_device_name}', resolved='{resolved_device_name}', kind={:?}, error={err}",
            err.kind()
        );
        match action {
            CpalOutputErrorAction::Ignore { reason } => {
                emit(PlayerEvent::log(
                    "warn",
                    format!("{message}, action=ignore, reason={reason}"),
                ));
            }
            CpalOutputErrorAction::Recover { reason } => {
                if error_shared.should_pause_on_device_disconnect()
                    && super::is_disconnect_recovery_reason(reason)
                {
                    error_stop.request_stop();
                    emit(PlayerEvent::error_with_reason(
                        PlayerErrorCode::OutputRuntime,
                        message,
                        reason,
                    ));
                } else {
                    crate::request_output_recovery(error_shared.clone(), reason, message);
                }
            }
            CpalOutputErrorAction::Escalate { reason } => {
                error_stop.request_stop();
                emit(PlayerEvent::error_with_reason(
                    PlayerErrorCode::OutputRuntime,
                    message,
                    reason,
                ));
            }
        }
    };
    match sample_format {
        SampleFormat::F32 => {
            let callback_stop = stop.clone();
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
                    move |data: &mut [f32], info| {
                        update_live_output_delay(&shared, info);
                        if callback_stop.should_stop(&shared) {
                            data.fill(0.0);
                            return;
                        }
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
            let callback_stop = stop.clone();
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
                    move |data: &mut [i16], info| {
                        update_live_output_delay(&shared, info);
                        if callback_stop.should_stop(&shared) {
                            data.fill(0);
                            return;
                        }
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
            let callback_stop = stop;
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
                    move |data: &mut [u16], info| {
                        update_live_output_delay(&shared, info);
                        if callback_stop.should_stop(&shared) {
                            data.fill(0);
                            return;
                        }
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
    let channels = channels.max(1);
    let target_gain = volume * shared.normalization_gain();
    // Ramp from the gain applied at the end of the previous buffer to the current
    // target across this buffer, so fades and volume changes stay zipper-free even
    // though the control side only updates the target every ~16 ms.
    let start_gain = shared.applied_output_gain().unwrap_or(target_gain);
    let preserve_effect_limiter =
        shared.effect_limiter_active() && start_gain.max(target_gain) <= 1.0;
    let frames = output.len() / channels;
    if frames == 0 || (start_gain - target_gain).abs() <= f32::EPSILON {
        for sample in output.iter_mut() {
            let scaled = *sample * target_gain;
            *sample = if preserve_effect_limiter {
                scaled
            } else {
                soft_limit_sample(scaled)
            };
        }
    } else {
        let step = (target_gain - start_gain) / frames as f32;
        let mut chunks = output.chunks_exact_mut(channels);
        for (frame_index, frame) in chunks.by_ref().enumerate() {
            let gain = start_gain + step * (frame_index + 1) as f32;
            for sample in frame.iter_mut() {
                let scaled = *sample * gain;
                *sample = if preserve_effect_limiter {
                    scaled
                } else {
                    soft_limit_sample(scaled)
                };
            }
        }
        // A trailing partial frame (malformed buffer) still gets the target gain
        // so no sample is ever emitted unscaled.
        for sample in chunks.into_remainder() {
            let scaled = *sample * target_gain;
            *sample = if preserve_effect_limiter {
                scaled
            } else {
                soft_limit_sample(scaled)
            };
        }
    }
    shared.store_applied_output_gain(target_gain);
    shared.set_spectrum_sample_rate(sample_rate);
    if let Ok(mut ring) = shared.spectrum_ring.try_lock() {
        ring.push_interleaved(output, channels);
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
    use crate::dsp::DspSettings;
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

    #[test]
    fn requested_cpal_buffer_frames_follow_audio_buffer_secs() {
        let config = StreamConfig {
            channels: 2,
            sample_rate: 48_000,
            buffer_size: BufferSize::Default,
        };

        assert_eq!(requested_cpal_buffer_frames(0.2, &config), Some(9_600));
        assert_eq!(requested_cpal_buffer_frames(0.0, &config), None);
    }

    #[test]
    fn cpal_fixed_buffer_supported_checks_range_and_unknown() {
        let config = StreamConfig {
            channels: 2,
            sample_rate: 48_000,
            buffer_size: BufferSize::Default,
        };
        let matching_range = cpal::SupportedStreamConfigRange::new(
            2,
            44_100,
            96_000,
            SupportedBufferSize::Range {
                min: 256,
                max: 9_600,
            },
            SampleFormat::F32,
        );
        let too_small_range = cpal::SupportedStreamConfigRange::new(
            2,
            44_100,
            96_000,
            SupportedBufferSize::Range {
                min: 256,
                max: 4_800,
            },
            SampleFormat::F32,
        );
        let unknown_range = cpal::SupportedStreamConfigRange::new(
            2,
            44_100,
            96_000,
            SupportedBufferSize::Unknown,
            SampleFormat::F32,
        );

        assert!(cpal_fixed_buffer_supported_in_ranges(
            [matching_range],
            SampleFormat::F32,
            &config,
            9_600
        ));
        assert!(!cpal_fixed_buffer_supported_in_ranges(
            [too_small_range],
            SampleFormat::F32,
            &config,
            9_600
        ));
        assert!(!cpal_fixed_buffer_supported_in_ranges(
            [unknown_range],
            SampleFormat::F32,
            &config,
            9_600
        ));
    }

    #[test]
    fn cpal_stream_config_with_requested_buffer_keeps_default_when_fixed_unsupported() {
        let config = StreamConfig {
            channels: 2,
            sample_rate: 48_000,
            buffer_size: BufferSize::Default,
        };
        let stream_config = cpal_stream_config_with_fixed_buffer_support(config, 9_600, false);

        assert_eq!(stream_config.buffer_size, BufferSize::Default);

        let fixed_config = cpal_stream_config_with_fixed_buffer_support(config, 9_600, true);
        assert_eq!(fixed_config.buffer_size, BufferSize::Fixed(9_600));
    }

    #[test]
    fn cpal_output_error_classification_keeps_xrun_nonfatal() {
        assert_eq!(
            classify_cpal_output_error(ErrorKind::Xrun, "auto"),
            CpalOutputErrorAction::Ignore { reason: "xrun" }
        );
    }

    #[test]
    fn output_signal_ramps_between_buffer_gains_without_steps() {
        let mix_format = MixFormat::stereo_f32(48_000);
        let settings = DspSettings::default();
        let shared = SharedAudio::new(mix_format, 0.2, 8.0, &settings);

        // First buffer establishes the applied gain (no history -> direct apply).
        let mut first = [1.0f32; 8];
        process_output_signal(&mut first, 2, 48_000, 0.2, &shared);
        assert!(first.iter().all(|sample| (sample - 0.2).abs() < 0.0001));

        // Second buffer targets a higher gain and must ramp per frame from the
        // previously applied value instead of jumping.
        let mut second = [1.0f32; 8];
        process_output_signal(&mut second, 2, 48_000, 0.6, &shared);
        // 4 frames ramping 0.2 -> 0.6 in equal steps of 0.1, ending exactly on target.
        let expected = [0.3f32, 0.3, 0.4, 0.4, 0.5, 0.5, 0.6, 0.6];
        for (sample, expected) in second.iter().zip(expected) {
            assert!(
                (sample - expected).abs() < 0.0001,
                "ramped sample {sample} != expected {expected}"
            );
        }
        // Both channels of one frame share the same gain.
        assert_eq!(second[0], second[1]);

        // A steady third buffer applies the target uniformly again.
        let mut third = [1.0f32; 4];
        process_output_signal(&mut third, 2, 48_000, 0.6, &shared);
        assert!(third.iter().all(|sample| (sample - 0.6).abs() < 0.0001));
    }

    #[test]
    fn output_signal_ramp_history_resets_with_output_start() {
        let mix_format = MixFormat::stereo_f32(48_000);
        let settings = DspSettings::default();
        let shared = SharedAudio::new(mix_format, 0.2, 8.0, &settings);

        let mut first = [1.0f32; 4];
        process_output_signal(&mut first, 2, 48_000, 1.0, &shared);
        assert_eq!(shared.applied_output_gain(), Some(1.0));

        shared.prepare_output_start();
        assert_eq!(shared.applied_output_gain(), None);

        // After a stream restart the new target applies directly, no ramp from 1.0.
        let mut second = [1.0f32; 4];
        process_output_signal(&mut second, 2, 48_000, 0.25, &shared);
        assert!(second.iter().all(|sample| (sample - 0.25).abs() < 0.0001));
    }

    #[test]
    fn output_signal_applies_latest_normalization_gain() {
        let mix_format = MixFormat::stereo_f32(48_000);
        let mut settings = DspSettings::default();
        let shared = SharedAudio::new(mix_format, 0.2, 8.0, &settings);
        let mut output = [0.25, -0.25];

        settings.normalization_gain_db = 6.0;
        shared.update_dsp_settings(&settings);
        process_output_signal(&mut output, 2, 48_000, 0.5, &shared);

        let expected = 0.25 * 0.5 * settings.normalization_gain_linear();
        assert!((output[0] - expected).abs() < 0.00001);
        assert!((output[1] + expected).abs() < 0.00001);
    }

    #[test]
    fn output_signal_soft_limits_normalization_gain_overload() {
        let mix_format = MixFormat::stereo_f32(48_000);
        let mut settings = DspSettings::default();
        let shared = SharedAudio::new(mix_format, 0.2, 8.0, &settings);
        let mut output = [0.9, -0.9];

        settings.normalization_gain_db = 3.0;
        shared.update_dsp_settings(&settings);
        process_output_signal(&mut output, 2, 48_000, 1.0, &shared);

        assert!(output[0] < 1.0);
        assert!(output[0] > 0.95);
        assert!(output[1] > -1.0);
        assert!(output[1] < -0.95);
    }

    #[test]
    fn output_signal_preserves_process_unit_limiter_below_unity_gain() {
        let mix_format = MixFormat::stereo_f32(48_000);
        let settings = DspSettings::default();
        let shared = SharedAudio::new(mix_format, 0.2, 8.0, &settings);
        shared.set_effect_limiter_active_for_test(true);
        let mut output = [0.98, -0.98];

        process_output_signal(&mut output, 2, 48_000, 1.0, &shared);

        assert_eq!(output, [0.98, -0.98]);
    }

    #[test]
    fn output_signal_ignores_non_finite_normalization_gain() {
        let mix_format = MixFormat::stereo_f32(48_000);
        let mut settings = DspSettings::default();
        let shared = SharedAudio::new(mix_format, 0.2, 8.0, &settings);
        let mut output = [0.25, -0.25];

        settings.normalization_gain_db = f32::NAN;
        shared.update_dsp_settings(&settings);
        process_output_signal(&mut output, 2, 48_000, 0.5, &shared);

        assert_eq!(output, [0.125, -0.125]);
    }

    #[test]
    fn cpal_output_error_classification_marks_route_errors_recoverable() {
        assert_eq!(
            classify_cpal_output_error(ErrorKind::DeviceChanged, "auto"),
            CpalOutputErrorAction::Ignore {
                reason: "device-changed"
            }
        );
        assert_eq!(
            classify_cpal_output_error(ErrorKind::DeviceChanged, "hw:0,0"),
            CpalOutputErrorAction::Ignore {
                reason: "device-changed"
            }
        );
        assert_eq!(
            classify_cpal_output_error(ErrorKind::DeviceNotAvailable, "hw:0,0"),
            CpalOutputErrorAction::Recover {
                reason: "device-not-available"
            }
        );
        assert_eq!(
            classify_cpal_output_error(ErrorKind::StreamInvalidated, "hw:0,0"),
            CpalOutputErrorAction::Recover {
                reason: "stream-invalidated"
            }
        );
        assert_eq!(
            classify_cpal_output_error(ErrorKind::BackendError, "auto"),
            CpalOutputErrorAction::Escalate { reason: "backend" }
        );
    }

    #[test]
    fn disconnect_recovery_reason_excludes_default_device_changes() {
        assert!(super::super::is_disconnect_recovery_reason(
            "device-not-available"
        ));
        assert!(super::super::is_disconnect_recovery_reason(
            "stream-invalidated"
        ));
        assert!(!super::super::is_disconnect_recovery_reason(
            "device-changed"
        ));
    }

    #[test]
    fn cpal_default_buffer_range_uses_min_as_conservative_estimate() {
        let estimate = cpal_host_controlled_buffer_estimate_from_values(
            None,
            &SupportedBufferSize::Range {
                min: 512,
                max: 9_600,
            },
        );

        assert_eq!(estimate.frames, 512);
        assert_eq!(estimate.mode, "host_controlled");
    }

    #[test]
    fn cpal_runtime_buffer_size_overrides_default_range_estimate() {
        let estimate = cpal_host_controlled_buffer_estimate_from_values(
            Some(2_048),
            &SupportedBufferSize::Range {
                min: 512,
                max: 9_600,
            },
        );

        assert_eq!(estimate.frames, 2_048);
        assert_eq!(estimate.mode, "host_controlled");
    }
}
