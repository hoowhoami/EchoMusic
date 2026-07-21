use super::cpal_shared::OutputResampler;
use crate::device::platform_windows::{
    activate_wasapi_audio_client, choose_wasapi_output_format, is_wasapi_buffer_size_not_aligned,
    resolve_wasapi_output_device, wasapi_duration_from_frames, wasapi_exclusive_buffer_duration,
    wasapi_wave_format, ComApartment, WasapiOutputFormat, WasapiSampleFormat,
};
use crate::events::{PlayerErrorCode, PlayerEvent};
use crate::output::{fill_output, report_output_start, OutputStartSender};
use crate::shared::{SharedAudio, TARGET_CHANNELS};
use std::ptr;
use std::slice;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Media::Audio;
use windows::Win32::System::Threading;

const WASAPI_EVENT_WAIT_MS: u32 = 10;
const WASAPI_FALLBACK_FEED_MS: u64 = 10;

struct EventHandle(HANDLE);

impl Drop for EventHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct WasapiExclusiveOutput {
    audio_client: Audio::IAudioClient,
    render_client: Audio::IAudioRenderClient,
    buffer_frames: u32,
    buffer_duration: i64,
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
    let _com = ComApartment::init()?;
    boost_current_thread_priority();

    let device = resolve_wasapi_output_device(device_name)?;
    let probe_client = activate_wasapi_audio_client(&device)?;
    let output_format = choose_wasapi_output_format(&probe_client, shared.sample_rate)?;
    let event = EventHandle(
        unsafe { Threading::CreateEventA(None, false, false, windows::core::PCSTR(ptr::null())) }
            .map_err(|err| format!("failed to create WASAPI output event: {err}"))?,
    );
    let output = open_wasapi_exclusive_output(&device, event.0, output_format)?;
    emit(PlayerEvent::log(
        "info",
        format!(
            "WASAPI exclusive opening: requested='{device_name}', sample_rate={}, engine_sample_rate={}, channels={}, format={:?}, buffer_100ns={buffer_duration}",
            output_format.sample_rate,
            shared.sample_rate,
            TARGET_CHANNELS,
            output_format.sample_format,
            buffer_duration = output.buffer_duration
        ),
    ));

    let mut output_scratch = Vec::<f32>::new();
    let mut resampler = OutputResampler::new(shared.sample_rate, output_format.sample_rate);

    unsafe {
        write_frames(
            &output.render_client,
            output.buffer_frames,
            output_format,
            &shared,
            &mut output_scratch,
            &mut resampler,
        )?;
        output
            .audio_client
            .Start()
            .map_err(|err| format!("failed to start WASAPI exclusive output: {err}"))?;
        shared.mark_output_started();
        report_output_start(start_notify, Ok(()));
        emit(PlayerEvent::log(
            "info",
            format!(
                "WASAPI exclusive output started: requested='{device_name}', sample_rate={}, engine_sample_rate={}",
                output_format.sample_rate, shared.sample_rate
            ),
        ));
        let mut last_feed_at = Instant::now();

        while !shared.should_stop_output() {
            match Threading::WaitForSingleObject(event.0, WASAPI_EVENT_WAIT_MS) {
                WAIT_OBJECT_0 => {
                    last_feed_at = Instant::now();
                    if feed_wasapi_exclusive(
                        &output.audio_client,
                        &output.render_client,
                        output.buffer_frames,
                        output_format,
                        &shared,
                        &mut output_scratch,
                        &mut resampler,
                    )? && feed_wasapi_exclusive(
                        &output.audio_client,
                        &output.render_client,
                        output.buffer_frames,
                        output_format,
                        &shared,
                        &mut output_scratch,
                        &mut resampler,
                    )? {
                        emit(PlayerEvent::log(
                            "warn",
                            "WASAPI exclusive output could not catch up with the device buffer"
                                .to_string(),
                        ));
                    }
                }
                WAIT_TIMEOUT => {
                    if last_feed_at.elapsed() >= Duration::from_millis(WASAPI_FALLBACK_FEED_MS)
                        && feed_wasapi_exclusive(
                            &output.audio_client,
                            &output.render_client,
                            output.buffer_frames,
                            output_format,
                            &shared,
                            &mut output_scratch,
                            &mut resampler,
                        )?
                    {
                        last_feed_at = Instant::now();
                    }
                }
                WAIT_FAILED => return Err("waiting for WASAPI output event failed".to_string()),
                other => return Err(format!("unexpected WASAPI wait result: {other:?}")),
            }
        }

        let _ = output.audio_client.Stop();
    }

    Ok(())
}

fn open_wasapi_exclusive_output(
    device: &Audio::IMMDevice,
    event: HANDLE,
    output_format: WasapiOutputFormat,
) -> Result<WasapiExclusiveOutput, String> {
    let wave_format = wasapi_wave_format(output_format.sample_rate, output_format.sample_format);
    let mut aligned_buffer_frames = None;

    loop {
        let audio_client = activate_wasapi_audio_client(device)?;
        let buffer_duration = aligned_buffer_frames
            .map(|frames| wasapi_duration_from_frames(frames, output_format.sample_rate))
            .unwrap_or_else(|| wasapi_exclusive_buffer_duration(&audio_client));
        let result = unsafe {
            audio_client.Initialize(
                Audio::AUDCLNT_SHAREMODE_EXCLUSIVE,
                Audio::AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                buffer_duration,
                buffer_duration,
                &wave_format.Format,
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
                return Ok(WasapiExclusiveOutput {
                    audio_client,
                    render_client,
                    buffer_frames,
                    buffer_duration,
                });
            },
            Err(err)
                if is_wasapi_buffer_size_not_aligned(&err) && aligned_buffer_frames.is_none() =>
            {
                let frames = unsafe { audio_client.GetBufferSize() }
                    .map_err(|err| format!("failed to read WASAPI aligned buffer size: {err}"))?;
                aligned_buffer_frames = Some(frames);
            }
            Err(err) => return Err(format!("failed to open WASAPI exclusive output: {err}")),
        }
    }
}

fn feed_wasapi_exclusive(
    audio_client: &Audio::IAudioClient,
    render_client: &Audio::IAudioRenderClient,
    buffer_frames: u32,
    output_format: WasapiOutputFormat,
    shared: &SharedAudio,
    output_scratch: &mut Vec<f32>,
    resampler: &mut OutputResampler,
) -> Result<bool, String> {
    let padding = unsafe {
        audio_client
            .GetCurrentPadding()
            .map_err(|err| format!("failed to query WASAPI output padding: {err}"))?
    };
    if padding >= buffer_frames.saturating_mul(2) {
        return Ok(false);
    }

    let refill = padding < buffer_frames;
    write_frames(
        render_client,
        buffer_frames,
        output_format,
        shared,
        output_scratch,
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
    resampler: &mut OutputResampler,
) -> Result<(), String> {
    unsafe {
        let buffer = render_client
            .GetBuffer(frames)
            .map_err(|err| format!("failed to obtain WASAPI output buffer: {err}"))?;
        let sample_count = frames as usize * TARGET_CHANNELS;
        match output_format.sample_format {
            WasapiSampleFormat::F32 => {
                let data = slice::from_raw_parts_mut(buffer as *mut f32, sample_count);
                fill_wasapi_output(data, output_format.sample_rate, shared, resampler);
            }
            WasapiSampleFormat::I16 => {
                let data = slice::from_raw_parts_mut(buffer as *mut i16, sample_count);
                output_scratch.resize(sample_count, 0.0);
                fill_wasapi_output(output_scratch, output_format.sample_rate, shared, resampler);
                for (target, sample) in data.iter_mut().zip(output_scratch.iter().copied()) {
                    *target = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
                }
            }
        }
        render_client
            .ReleaseBuffer(frames, 0)
            .map_err(|err| format!("failed to release WASAPI output buffer: {err}"))
    }
}

fn fill_wasapi_output(
    output: &mut [f32],
    output_sample_rate: u32,
    shared: &SharedAudio,
    resampler: &mut OutputResampler,
) {
    if output_sample_rate == shared.sample_rate {
        fill_output(output, TARGET_CHANNELS, shared);
    } else {
        resampler.fill_output(output, TARGET_CHANNELS, shared);
    }
}

fn boost_current_thread_priority() {
    unsafe {
        let _ = Threading::SetThreadPriority(
            Threading::GetCurrentThread(),
            Threading::THREAD_PRIORITY_TIME_CRITICAL,
        );
    }
}
