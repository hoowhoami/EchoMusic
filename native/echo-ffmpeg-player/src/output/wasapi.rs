use super::cpal_shared::{fill_output_reusing, OutputResampler};
use crate::device::platform_windows::{
    activate_wasapi_audio_client, choose_wasapi_output_format, choose_wasapi_shared_output_format,
    is_wasapi_buffer_size_not_aligned, is_wasapi_device_in_use, resolve_wasapi_output_device,
    wasapi_client_error_message, wasapi_duration_from_frames, wasapi_exclusive_buffer_duration,
    ComApartment, WasapiOutputFormat, WasapiResolvedFormat, WasapiSampleFormat,
};
use crate::events::{PlayerErrorCode, PlayerEvent};
use crate::output::{
    build_output_stats, output_buffer_mode_for_frames, output_start_was_cancelled,
    report_output_start, report_output_start_failure, service_wasapi_event, OutputStartSender,
    OutputStopToken,
};
use crate::shared::SharedAudio;
use std::ptr;
use std::slice;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use windows::core::{HRESULT, PCSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Media::Audio;
use windows::Win32::System::Threading;

const WASAPI_EVENT_WAIT_MS: u32 = 10;
const WASAPI_EXCLUSIVE_DEVICE_RELEASE_TIMEOUT: Duration = Duration::from_millis(1500);
const WASAPI_EXCLUSIVE_DEVICE_RELEASE_RETRY: Duration = Duration::from_millis(50);

struct EventHandle(HANDLE);

impl Drop for EventHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WasapiShareMode {
    Shared,
    Exclusive,
}

impl WasapiShareMode {
    fn from_exclusive(exclusive: bool) -> Self {
        if exclusive {
            Self::Exclusive
        } else {
            Self::Shared
        }
    }

    fn as_wasapi(self) -> Audio::AUDCLNT_SHAREMODE {
        match self {
            Self::Shared => Audio::AUDCLNT_SHAREMODE_SHARED,
            Self::Exclusive => Audio::AUDCLNT_SHAREMODE_EXCLUSIVE,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Shared => "shared",
            Self::Exclusive => "exclusive",
        }
    }

    fn backend(self) -> &'static str {
        match self {
            Self::Shared => "wasapi",
            Self::Exclusive => "wasapi-exclusive",
        }
    }

    fn error_code(self) -> PlayerErrorCode {
        match self {
            Self::Shared => PlayerErrorCode::OutputStream,
            Self::Exclusive => PlayerErrorCode::OutputExclusive,
        }
    }
}

struct WasapiOutput {
    audio_client: Audio::IAudioClient,
    render_client: Audio::IAudioRenderClient,
    buffer_frames: u32,
    buffer_duration: i64,
    stream_latency_100ns: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WasapiOutputErrorAction {
    Ignore { reason: &'static str },
    Recover { reason: &'static str },
    Escalate { reason: &'static str },
}

#[derive(Clone, Debug)]
struct WasapiOutputFailure {
    message: String,
    action: WasapiOutputErrorAction,
}

impl WasapiOutputFailure {
    fn backend(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            action: WasapiOutputErrorAction::Escalate { reason: "backend" },
        }
    }

    fn recover(message: impl Into<String>, reason: &'static str) -> Self {
        Self {
            message: message.into(),
            action: WasapiOutputErrorAction::Recover { reason },
        }
    }

    fn from_client_error(context: &str, err: &windows::core::Error) -> Self {
        Self {
            message: wasapi_client_error_message(context, err),
            action: classify_wasapi_client_error(err.code()),
        }
    }
}

struct MmcssTask {
    handle: HANDLE,
}

impl MmcssTask {
    fn register() -> Result<Self, String> {
        let mut task_index = 0u32;
        let handle = unsafe {
            Threading::AvSetMmThreadCharacteristicsA(
                PCSTR(b"Pro Audio\0".as_ptr()),
                &mut task_index,
            )
        }
        .map_err(|err| format!("failed to set WASAPI thread to Pro Audio MMCSS: {err}"))?;
        unsafe {
            Threading::AvSetMmThreadPriority(handle, Threading::AVRT_PRIORITY_HIGH)
                .map_err(|err| format!("failed to raise WASAPI MMCSS priority: {err}"))?;
        }
        Ok(Self { handle })
    }
}

impl Drop for MmcssTask {
    fn drop(&mut self) {
        unsafe {
            let _ = Threading::AvRevertMmThreadCharacteristics(self.handle);
        }
    }
}

fn classify_wasapi_client_error(code: HRESULT) -> WasapiOutputErrorAction {
    if code == Audio::AUDCLNT_E_DEVICE_INVALIDATED {
        WasapiOutputErrorAction::Recover {
            reason: "device-not-available",
        }
    } else if code == Audio::AUDCLNT_E_RESOURCES_INVALIDATED
        || code == Audio::AUDCLNT_E_SERVICE_NOT_RUNNING
    {
        WasapiOutputErrorAction::Recover {
            reason: "stream-invalidated",
        }
    } else if code == Audio::AUDCLNT_E_BUFFER_ERROR || code == Audio::AUDCLNT_E_CPUUSAGE_EXCEEDED {
        WasapiOutputErrorAction::Ignore { reason: "xrun" }
    } else {
        WasapiOutputErrorAction::Escalate { reason: "backend" }
    }
}

fn handle_wasapi_output_failure(
    requested_mode: WasapiShareMode,
    shared: &Arc<SharedAudio>,
    stop: &OutputStopToken,
    emit: fn(PlayerEvent),
    start_notify: &mut Option<OutputStartSender>,
    failure: WasapiOutputFailure,
) -> bool {
    let WasapiOutputFailure { message, action } = failure;
    let startup_failure = report_output_start_failure(start_notify, message.clone());
    if startup_failure {
        stop.request_stop();
        return true;
    }

    match action {
        WasapiOutputErrorAction::Ignore { reason } => {
            emit(PlayerEvent::log(
                "warn",
                format!(
                    "WASAPI {} ignored output error after stream exit: reason={reason}, message={message}",
                    requested_mode.label()
                ),
            ));
        }
        WasapiOutputErrorAction::Recover { reason } => {
            if shared.should_pause_on_device_disconnect()
                && super::is_disconnect_recovery_reason(reason)
            {
                stop.request_stop();
                emit(PlayerEvent::error_with_reason(
                    PlayerErrorCode::OutputRuntime,
                    message,
                    reason,
                ));
            } else {
                crate::request_output_recovery(Arc::clone(shared), reason, message);
            }
        }
        WasapiOutputErrorAction::Escalate { reason } => {
            stop.request_stop();
            emit(PlayerEvent::error_with_reason(
                requested_mode.error_code(),
                message,
                reason,
            ));
        }
    }
    false
}

pub fn spawn_output_thread(
    device_name: String,
    exclusive: bool,
    shared: Arc<SharedAudio>,
    stop: OutputStopToken,
    emit: fn(PlayerEvent),
    start_notify: Option<OutputStartSender>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut start_notify = start_notify;
        let requested_mode = WasapiShareMode::from_exclusive(exclusive);
        match run_wasapi_output(
            &device_name,
            requested_mode,
            shared.clone(),
            stop.clone(),
            emit,
            &mut start_notify,
        ) {
            Ok(()) => {}
            Err(failure) => {
                if handle_wasapi_output_failure(
                    requested_mode,
                    &shared,
                    &stop,
                    emit,
                    &mut start_notify,
                    failure,
                ) {
                    return;
                }
            }
        }
    })
}

fn run_wasapi_output(
    device_name: &str,
    share_mode: WasapiShareMode,
    shared: Arc<SharedAudio>,
    stop: OutputStopToken,
    emit: fn(PlayerEvent),
    start_notify: &mut Option<OutputStartSender>,
) -> Result<(), WasapiOutputFailure> {
    let _com = ComApartment::init().map_err(WasapiOutputFailure::backend)?;
    let _mmcss = match MmcssTask::register() {
        Ok(task) => {
            emit(PlayerEvent::log(
                "info",
                format!(
                    "WASAPI {} output thread registered with MMCSS Pro Audio",
                    share_mode.label()
                ),
            ));
            Some(task)
        }
        Err(err) => {
            emit(PlayerEvent::log("warn", err));
            None
        }
    };

    let device = resolve_wasapi_output_device(device_name).map_err(WasapiOutputFailure::backend)?;
    let probe_client =
        activate_wasapi_audio_client(&device).map_err(WasapiOutputFailure::backend)?;
    let preferred_output_format = shared.preferred_output_sample_format();
    let resolved_format = match share_mode {
        WasapiShareMode::Shared => {
            choose_wasapi_shared_output_format(&probe_client, shared.mix_format.channels)
                .map_err(WasapiOutputFailure::backend)?
        }
        WasapiShareMode::Exclusive => choose_wasapi_output_format(
            &probe_client,
            shared.mix_format.sample_rate,
            shared.mix_format.channels,
            preferred_output_format,
        )
        .map_err(WasapiOutputFailure::backend)?,
    };
    let output_format = resolved_format.output;
    let event = EventHandle(
        unsafe { Threading::CreateEventA(None, false, false, windows::core::PCSTR(ptr::null())) }
            .map_err(|err| {
            WasapiOutputFailure::backend(format!("failed to create WASAPI output event: {err}"))
        })?,
    );
    let output = open_wasapi_output(&device, event.0, resolved_format, share_mode, emit)?;
    let device_buffer_secs =
        output.buffer_frames as f64 / f64::from(output_format.sample_rate.max(1));
    shared.update_output_stats(build_output_stats(
        share_mode.backend(),
        &shared,
        output_format.sample_rate,
        output_format.channels,
        format!("{:?}", output_format.sample_format),
        output_buffer_mode_for_frames(output.buffer_frames),
        f64::from(output.buffer_frames),
        device_buffer_secs,
    ));
    emit(PlayerEvent::log(
        "info",
        format!(
            "WASAPI {} opening: requested='{device_name}', sample_rate={}, engine_sample_rate={}, channels={}, preferred_output_format={:?}, format={:?}, buffer_frames={}, buffer_100ns={buffer_duration}",
            share_mode.label(),
            output_format.sample_rate,
            shared.mix_format.sample_rate,
            output_format.channels,
            preferred_output_format,
            output_format.sample_format,
            output.buffer_frames,
            buffer_duration = output.buffer_duration
        ),
    ));

    let mut output_scratch = Vec::<f32>::new();
    let mut graph_scratch = Vec::<f32>::new();
    let mut resampler = OutputResampler::new(
        shared.mix_format.sample_rate,
        output_format.sample_rate,
        shared.mix_format.channels,
        output_format.channels,
    )
    .map_err(WasapiOutputFailure::backend)?;

    unsafe {
        if output_start_was_cancelled(&stop, &shared, start_notify) {
            return Ok(());
        }
        write_frames(
            &output.render_client,
            output.buffer_frames,
            output_format,
            &shared,
            &mut output_scratch,
            &mut graph_scratch,
            &mut resampler,
        )?;
        output.audio_client.Start().map_err(|err| {
            WasapiOutputFailure::from_client_error(
                &format!("failed to start WASAPI {} output", share_mode.label()),
                &err,
            )
        })?;
        shared.mark_output_started();
        report_output_start(start_notify, Ok(()));
        emit(PlayerEvent::log(
            "info",
            format!(
                "WASAPI {} output started: requested='{device_name}', sample_rate={}, engine_sample_rate={}",
                share_mode.label(), output_format.sample_rate, shared.mix_format.sample_rate
            ),
        ));
        while !stop.should_stop(&shared) {
            match Threading::WaitForSingleObject(event.0, WASAPI_EVENT_WAIT_MS) {
                WAIT_OBJECT_0 => {
                    match feed_wasapi_output(
                        &output.audio_client,
                        &output.render_client,
                        output.buffer_frames,
                        output.stream_latency_100ns,
                        output_format,
                        share_mode,
                        &shared,
                        &mut output_scratch,
                        &mut graph_scratch,
                        &mut resampler,
                    ) {
                        Ok(()) => {}
                        Err(failure)
                            if matches!(failure.action, WasapiOutputErrorAction::Ignore { .. }) =>
                        {
                            emit(PlayerEvent::log(
                                "warn",
                                format!(
                                    "WASAPI {} transient output error: {}",
                                    share_mode.label(),
                                    failure.message
                                ),
                            ));
                            continue;
                        }
                        Err(failure) => return Err(failure),
                    }
                }
                WAIT_TIMEOUT => {}
                WAIT_FAILED => {
                    return Err(WasapiOutputFailure::recover(
                        "waiting for WASAPI output event failed",
                        "stream-invalidated",
                    ));
                }
                other => {
                    return Err(WasapiOutputFailure::backend(format!(
                        "unexpected WASAPI wait result: {other:?}"
                    )));
                }
            }
        }

        let _ = output.audio_client.Stop();
    }

    Ok(())
}

fn open_wasapi_output(
    device: &Audio::IMMDevice,
    event: HANDLE,
    resolved_format: WasapiResolvedFormat,
    share_mode: WasapiShareMode,
    emit: fn(PlayerEvent),
) -> Result<WasapiOutput, WasapiOutputFailure> {
    let output_format = resolved_format.output;
    let mut aligned_buffer_frames = None;
    let wait_started_at = Instant::now();
    let mut logged_device_wait = false;

    loop {
        let audio_client =
            activate_wasapi_audio_client(device).map_err(WasapiOutputFailure::backend)?;
        let buffer_duration = aligned_buffer_frames
            .map(|frames| wasapi_duration_from_frames(frames, output_format.sample_rate))
            .unwrap_or_else(|| {
                // In event-driven exclusive mode this is also the wakeup period.
                // Keep larger user buffers in the software queue instead of
                // turning each device packet (and pause/fade response) into seconds.
                match share_mode {
                    WasapiShareMode::Shared => 0,
                    WasapiShareMode::Exclusive => wasapi_exclusive_buffer_duration(&audio_client),
                }
            });
        let result = unsafe {
            audio_client.Initialize(
                share_mode.as_wasapi(),
                Audio::AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                buffer_duration,
                buffer_duration,
                &resolved_format.wave_format.Format,
                None,
            )
        };

        match result {
            Ok(()) => unsafe {
                audio_client.SetEventHandle(event).map_err(|err| {
                    WasapiOutputFailure::from_client_error(
                        "failed to bind WASAPI output event",
                        &err,
                    )
                })?;
                let render_client = audio_client
                    .GetService::<Audio::IAudioRenderClient>()
                    .map_err(|err| {
                        WasapiOutputFailure::from_client_error(
                            "failed to create WASAPI render client",
                            &err,
                        )
                    })?;
                let buffer_frames = audio_client.GetBufferSize().map_err(|err| {
                    WasapiOutputFailure::from_client_error(
                        "failed to query WASAPI buffer size",
                        &err,
                    )
                })?;
                let stream_latency_100ns = audio_client.GetStreamLatency().unwrap_or(0);
                return Ok(WasapiOutput {
                    audio_client,
                    render_client,
                    buffer_frames,
                    buffer_duration,
                    stream_latency_100ns,
                });
            },
            Err(err)
                if share_mode == WasapiShareMode::Exclusive
                    && is_wasapi_buffer_size_not_aligned(&err)
                    && aligned_buffer_frames.is_none() =>
            {
                let frames = unsafe { audio_client.GetBufferSize() }.map_err(|err| {
                    WasapiOutputFailure::from_client_error(
                        "failed to read WASAPI aligned buffer size",
                        &err,
                    )
                })?;
                aligned_buffer_frames = Some(frames);
            }
            Err(err)
                if share_mode == WasapiShareMode::Exclusive
                    && is_wasapi_device_in_use(&err)
                    && wait_started_at.elapsed() < WASAPI_EXCLUSIVE_DEVICE_RELEASE_TIMEOUT =>
            {
                if !logged_device_wait {
                    emit(PlayerEvent::log(
                        "info",
                        "WASAPI exclusive output waiting for endpoint release".to_string(),
                    ));
                    logged_device_wait = true;
                }
                thread::sleep(WASAPI_EXCLUSIVE_DEVICE_RELEASE_RETRY);
            }
            Err(err) => {
                return Err(WasapiOutputFailure::from_client_error(
                    &format!("failed to open WASAPI {} output", share_mode.label()),
                    &err,
                ));
            }
        }
    }
}

fn feed_wasapi_output(
    audio_client: &Audio::IAudioClient,
    render_client: &Audio::IAudioRenderClient,
    buffer_frames: u32,
    stream_latency_100ns: i64,
    output_format: WasapiOutputFormat,
    share_mode: WasapiShareMode,
    shared: &SharedAudio,
    output_scratch: &mut Vec<f32>,
    graph_scratch: &mut Vec<f32>,
    resampler: &mut OutputResampler,
) -> Result<(), WasapiOutputFailure> {
    let queued_frames = service_wasapi_event(
        share_mode == WasapiShareMode::Exclusive,
        buffer_frames,
        || unsafe {
            audio_client.GetCurrentPadding().map_err(|err| {
                WasapiOutputFailure::from_client_error(
                    "failed to query WASAPI output padding",
                    &err,
                )
            })
        },
        |frames| {
            write_frames(
                render_client,
                frames,
                output_format,
                shared,
                output_scratch,
                graph_scratch,
                resampler,
            )
        },
    )?;
    update_wasapi_live_output_delay(
        shared,
        share_mode,
        queued_frames,
        buffer_frames,
        output_format.sample_rate,
        stream_latency_100ns,
    );
    Ok(())
}

fn write_frames(
    render_client: &Audio::IAudioRenderClient,
    frames: u32,
    output_format: WasapiOutputFormat,
    shared: &SharedAudio,
    output_scratch: &mut Vec<f32>,
    graph_scratch: &mut Vec<f32>,
    resampler: &mut OutputResampler,
) -> Result<(), WasapiOutputFailure> {
    unsafe {
        let buffer = render_client.GetBuffer(frames).map_err(|err| {
            WasapiOutputFailure::from_client_error("failed to obtain WASAPI output buffer", &err)
        })?;
        let output_channels = output_format.channels.max(1);
        let sample_count = frames as usize * output_channels;
        match output_format.sample_format {
            WasapiSampleFormat::F32 => {
                let data = slice::from_raw_parts_mut(buffer as *mut f32, sample_count);
                fill_wasapi_output(
                    data,
                    output_format.sample_rate,
                    output_channels,
                    shared,
                    graph_scratch,
                    resampler,
                );
            }
            WasapiSampleFormat::I16 => {
                let data = slice::from_raw_parts_mut(buffer as *mut i16, sample_count);
                output_scratch.resize(sample_count, 0.0);
                fill_wasapi_output(
                    output_scratch,
                    output_format.sample_rate,
                    output_channels,
                    shared,
                    graph_scratch,
                    resampler,
                );
                for (target, sample) in data.iter_mut().zip(output_scratch.iter().copied()) {
                    *target = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
                }
            }
            WasapiSampleFormat::U8 => {
                let data = slice::from_raw_parts_mut(buffer as *mut u8, sample_count);
                output_scratch.resize(sample_count, 0.0);
                fill_wasapi_output(
                    output_scratch,
                    output_format.sample_rate,
                    output_channels,
                    shared,
                    graph_scratch,
                    resampler,
                );
                for (target, sample) in data.iter_mut().zip(output_scratch.iter().copied()) {
                    *target = ((sample.clamp(-1.0, 1.0) + 1.0) * 127.5).round() as u8;
                }
            }
            WasapiSampleFormat::I24 => {
                let data = slice::from_raw_parts_mut(buffer as *mut u8, sample_count * 3);
                output_scratch.resize(sample_count, 0.0);
                fill_wasapi_output(
                    output_scratch,
                    output_format.sample_rate,
                    output_channels,
                    shared,
                    graph_scratch,
                    resampler,
                );
                for (target, sample) in data.chunks_exact_mut(3).zip(output_scratch.iter().copied())
                {
                    let value = (sample.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
                    let bytes = value.to_le_bytes();
                    target[0] = bytes[0];
                    target[1] = bytes[1];
                    target[2] = bytes[2];
                }
            }
            WasapiSampleFormat::I24In32 => {
                let data = slice::from_raw_parts_mut(buffer as *mut i32, sample_count);
                output_scratch.resize(sample_count, 0.0);
                fill_wasapi_output(
                    output_scratch,
                    output_format.sample_rate,
                    output_channels,
                    shared,
                    graph_scratch,
                    resampler,
                );
                for (target, sample) in data.iter_mut().zip(output_scratch.iter().copied()) {
                    let value = (sample.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
                    *target = value << 8;
                }
            }
            WasapiSampleFormat::I32 => {
                let data = slice::from_raw_parts_mut(buffer as *mut i32, sample_count);
                output_scratch.resize(sample_count, 0.0);
                fill_wasapi_output(
                    output_scratch,
                    output_format.sample_rate,
                    output_channels,
                    shared,
                    graph_scratch,
                    resampler,
                );
                for (target, sample) in data.iter_mut().zip(output_scratch.iter().copied()) {
                    *target = (sample.clamp(-1.0, 1.0) * i32::MAX as f32).round() as i32;
                }
            }
        }
        render_client.ReleaseBuffer(frames, 0).map_err(|err| {
            WasapiOutputFailure::from_client_error("failed to release WASAPI output buffer", &err)
        })
    }
}

fn update_wasapi_live_output_delay(
    shared: &SharedAudio,
    share_mode: WasapiShareMode,
    queued_frames: u32,
    buffer_frames: u32,
    sample_rate: u32,
    stream_latency_100ns: i64,
) {
    shared.update_live_output_delay_secs(wasapi_live_output_delay_secs(
        share_mode,
        queued_frames,
        buffer_frames,
        sample_rate,
        stream_latency_100ns,
    ));
}

fn wasapi_live_output_delay_secs(
    share_mode: WasapiShareMode,
    queued_frames: u32,
    buffer_frames: u32,
    sample_rate: u32,
    stream_latency_100ns: i64,
) -> f64 {
    let sample_rate = f64::from(sample_rate.max(1));
    let queued_secs = match share_mode {
        WasapiShareMode::Shared => f64::from(queued_frames) / sample_rate,
        WasapiShareMode::Exclusive => f64::from(buffer_frames) / sample_rate,
    };
    let stream_latency_secs = (stream_latency_100ns.max(0) as f64) / 10_000_000.0;
    queued_secs + stream_latency_secs
}

fn fill_wasapi_output(
    output: &mut [f32],
    output_sample_rate: u32,
    output_channels: usize,
    shared: &SharedAudio,
    graph_scratch: &mut Vec<f32>,
    resampler: &mut OutputResampler,
) {
    if output_sample_rate == shared.mix_format.sample_rate
        && shared.mix_format.channels == output_channels
    {
        fill_output_reusing(output, output_channels, shared, graph_scratch);
    } else {
        resampler.fill_output(output, output_channels, shared);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wasapi_client_error_classification_marks_disconnects_recoverable() {
        assert_eq!(
            classify_wasapi_client_error(Audio::AUDCLNT_E_DEVICE_INVALIDATED),
            WasapiOutputErrorAction::Recover {
                reason: "device-not-available"
            }
        );
        assert_eq!(
            classify_wasapi_client_error(Audio::AUDCLNT_E_RESOURCES_INVALIDATED),
            WasapiOutputErrorAction::Recover {
                reason: "stream-invalidated"
            }
        );
        assert_eq!(
            classify_wasapi_client_error(Audio::AUDCLNT_E_SERVICE_NOT_RUNNING),
            WasapiOutputErrorAction::Recover {
                reason: "stream-invalidated"
            }
        );
    }

    #[test]
    fn wasapi_client_error_classification_keeps_xruns_nonfatal() {
        assert_eq!(
            classify_wasapi_client_error(Audio::AUDCLNT_E_BUFFER_ERROR),
            WasapiOutputErrorAction::Ignore { reason: "xrun" }
        );
        assert_eq!(
            classify_wasapi_client_error(Audio::AUDCLNT_E_CPUUSAGE_EXCEEDED),
            WasapiOutputErrorAction::Ignore { reason: "xrun" }
        );
        assert_eq!(
            classify_wasapi_client_error(Audio::AUDCLNT_E_UNSUPPORTED_FORMAT),
            WasapiOutputErrorAction::Escalate { reason: "backend" }
        );
    }

    #[test]
    fn wasapi_live_output_delay_uses_padding_and_stream_latency() {
        assert!(
            (wasapi_live_output_delay_secs(WasapiShareMode::Shared, 480, 960, 48_000, 10_000)
                - 0.011)
                .abs()
                < f64::EPSILON
        );
        assert!(
            (wasapi_live_output_delay_secs(WasapiShareMode::Exclusive, 0, 960, 48_000, 10_000)
                - 0.021)
                .abs()
                < f64::EPSILON
        );
    }
}
