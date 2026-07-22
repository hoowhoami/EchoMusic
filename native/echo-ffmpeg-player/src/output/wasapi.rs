use super::cpal_shared::{fill_output_reusing, OutputResampler};
use crate::device::platform_windows::{
    activate_wasapi_audio_client, choose_wasapi_output_format, choose_wasapi_shared_output_format,
    is_wasapi_buffer_size_not_aligned, is_wasapi_device_in_use, resolve_wasapi_output_device,
    wasapi_client_error_message, wasapi_duration_from_frames, wasapi_exclusive_buffer_duration,
    ComApartment, WasapiOutputFormat, WasapiResolvedFormat, WasapiSampleFormat,
};
use crate::events::{PlayerErrorCode, PlayerEvent};
use crate::output::{report_output_start, report_output_start_failure, OutputStartSender};
use crate::shared::SharedAudio;
use std::ptr;
use std::slice;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use windows::core::PCSTR;
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

pub fn spawn_output_thread(
    device_name: String,
    exclusive: bool,
    shared: Arc<SharedAudio>,
    emit: fn(PlayerEvent),
    mut start_notify: Option<OutputStartSender>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        if let Err(message) = run_wasapi_output(
            &device_name,
            WasapiShareMode::from_exclusive(exclusive),
            shared.clone(),
            emit,
            &mut start_notify,
        ) {
            let startup_failure = report_output_start_failure(&mut start_notify, message.clone());
            shared.request_output_stop();
            if !startup_failure {
                emit(PlayerEvent::error(
                    WasapiShareMode::from_exclusive(exclusive).error_code(),
                    message,
                ));
            }
        }
    })
}

fn run_wasapi_output(
    device_name: &str,
    share_mode: WasapiShareMode,
    shared: Arc<SharedAudio>,
    emit: fn(PlayerEvent),
    start_notify: &mut Option<OutputStartSender>,
) -> Result<(), String> {
    let _com = ComApartment::init()?;
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

    let device = resolve_wasapi_output_device(device_name)?;
    let probe_client = activate_wasapi_audio_client(&device)?;
    let source_format = shared.source_sample_format();
    let resolved_format = match share_mode {
        WasapiShareMode::Shared => {
            choose_wasapi_shared_output_format(&probe_client, shared.mix_format.channels)?
        }
        WasapiShareMode::Exclusive => choose_wasapi_output_format(
            &probe_client,
            shared.mix_format.sample_rate,
            source_format,
        )?,
    };
    let output_format = resolved_format.output;
    let event = EventHandle(
        unsafe { Threading::CreateEventA(None, false, false, windows::core::PCSTR(ptr::null())) }
            .map_err(|err| format!("failed to create WASAPI output event: {err}"))?,
    );
    let output = open_wasapi_output(&device, event.0, resolved_format, share_mode, emit)?;
    shared.update_output_stats(crate::shared::AudioOutputStats {
        backend: share_mode.backend().to_string(),
        sample_rate: f64::from(output_format.sample_rate),
        engine_sample_rate: f64::from(shared.mix_format.sample_rate),
        channels: output_format.channels as f64,
        format: format!("{:?}", output_format.sample_format),
        buffer_frames: f64::from(output.buffer_frames),
        buffer_secs: output.buffer_frames as f64 / f64::from(output_format.sample_rate.max(1)),
        delay_secs: output.buffer_frames as f64 / f64::from(output_format.sample_rate.max(1)),
        underruns: 0.0,
    });
    emit(PlayerEvent::log(
        "info",
        format!(
            "WASAPI {} opening: requested='{device_name}', sample_rate={}, engine_sample_rate={}, channels={}, source_format={:?}, format={:?}, buffer_frames={}, buffer_100ns={buffer_duration}",
            share_mode.label(),
            output_format.sample_rate,
            shared.mix_format.sample_rate,
            output_format.channels,
            source_format,
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
    )?;

    unsafe {
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
            wasapi_client_error_message(
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
        while !shared.should_stop_output() {
            match Threading::WaitForSingleObject(event.0, WASAPI_EVENT_WAIT_MS) {
                WAIT_OBJECT_0 => {
                    let refill = feed_wasapi_output(
                        &output.audio_client,
                        &output.render_client,
                        output.buffer_frames,
                        output_format,
                        share_mode,
                        &shared,
                        &mut output_scratch,
                        &mut graph_scratch,
                        &mut resampler,
                    )?;
                    if refill
                        && feed_wasapi_output(
                            &output.audio_client,
                            &output.render_client,
                            output.buffer_frames,
                            output_format,
                            share_mode,
                            &shared,
                            &mut output_scratch,
                            &mut graph_scratch,
                            &mut resampler,
                        )?
                    {
                        emit(PlayerEvent::log(
                            "warn",
                            format!(
                                "WASAPI {} output could not refill the device buffer fast enough",
                                share_mode.label()
                            ),
                        ));
                    }
                }
                WAIT_TIMEOUT => {}
                WAIT_FAILED => return Err("waiting for WASAPI output event failed".to_string()),
                other => return Err(format!("unexpected WASAPI wait result: {other:?}")),
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
) -> Result<WasapiOutput, String> {
    let output_format = resolved_format.output;
    let mut aligned_buffer_frames = None;
    let wait_started_at = Instant::now();
    let mut logged_device_wait = false;

    loop {
        let audio_client = activate_wasapi_audio_client(device)?;
        let buffer_duration = aligned_buffer_frames
            .map(|frames| wasapi_duration_from_frames(frames, output_format.sample_rate))
            .unwrap_or_else(|| match share_mode {
                WasapiShareMode::Shared => 0,
                WasapiShareMode::Exclusive => wasapi_exclusive_buffer_duration(&audio_client),
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
                audio_client
                    .SetEventHandle(event)
                    .map_err(|err| format!("failed to bind WASAPI output event: {err}"))?;
                let render_client = audio_client
                    .GetService::<Audio::IAudioRenderClient>()
                    .map_err(|err| format!("failed to create WASAPI render client: {err}"))?;
                let buffer_frames = audio_client
                    .GetBufferSize()
                    .map_err(|err| format!("failed to query WASAPI buffer size: {err}"))?;
                return Ok(WasapiOutput {
                    audio_client,
                    render_client,
                    buffer_frames,
                    buffer_duration,
                });
            },
            Err(err)
                if share_mode == WasapiShareMode::Exclusive
                    && is_wasapi_buffer_size_not_aligned(&err)
                    && aligned_buffer_frames.is_none() =>
            {
                let frames = unsafe { audio_client.GetBufferSize() }
                    .map_err(|err| format!("failed to read WASAPI aligned buffer size: {err}"))?;
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
                return Err(wasapi_client_error_message(
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
    output_format: WasapiOutputFormat,
    share_mode: WasapiShareMode,
    shared: &SharedAudio,
    output_scratch: &mut Vec<f32>,
    graph_scratch: &mut Vec<f32>,
    resampler: &mut OutputResampler,
) -> Result<bool, String> {
    if buffer_frames == 0 {
        return Ok(false);
    }
    let padding = unsafe {
        audio_client.GetCurrentPadding().map_err(|err| {
            wasapi_client_error_message("failed to query WASAPI output padding", &err)
        })?
    };
    let (frames_to_write, refill) = match share_mode {
        WasapiShareMode::Shared => {
            if buffer_frames <= padding {
                return Ok(false);
            }
            (buffer_frames - padding, false)
        }
        WasapiShareMode::Exclusive => {
            if padding >= buffer_frames.saturating_mul(2) {
                return Ok(false);
            }
            (buffer_frames, padding < buffer_frames)
        }
    };
    write_frames(
        render_client,
        frames_to_write,
        output_format,
        shared,
        output_scratch,
        graph_scratch,
        resampler,
    )?;
    Ok(refill)
}

fn write_frames(
    render_client: &Audio::IAudioRenderClient,
    frames: u32,
    output_format: WasapiOutputFormat,
    shared: &SharedAudio,
    output_scratch: &mut Vec<f32>,
    graph_scratch: &mut Vec<f32>,
    resampler: &mut OutputResampler,
) -> Result<(), String> {
    unsafe {
        let buffer = render_client.GetBuffer(frames).map_err(|err| {
            wasapi_client_error_message("failed to obtain WASAPI output buffer", &err)
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
            wasapi_client_error_message("failed to release WASAPI output buffer", &err)
        })
    }
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
