use crate::device::platform_windows::{
    activate_wasapi_audio_client, choose_wasapi_sample_format, resolve_wasapi_output_device,
    wasapi_exclusive_buffer_duration, wasapi_wave_format, ComApartment, WasapiSampleFormat,
};
use crate::events::{PlayerErrorCode, PlayerEvent};
use crate::output::fill_output;
use crate::shared::{SharedAudio, TARGET_CHANNELS};
use std::ptr;
use std::slice;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Media::Audio;
use windows::Win32::System::Threading;

struct EventHandle(HANDLE);

impl Drop for EventHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

pub fn spawn_output_thread(
    device_name: String,
    shared: Arc<SharedAudio>,
    emit: fn(PlayerEvent),
) -> JoinHandle<()> {
    thread::spawn(move || {
        if let Err(message) = run_exclusive_output(&device_name, shared.clone()) {
            shared.request_output_stop();
            emit(PlayerEvent::error(
                PlayerErrorCode::OutputExclusive,
                message,
            ));
        }
    })
}

fn run_exclusive_output(device_name: &str, shared: Arc<SharedAudio>) -> Result<(), String> {
    let _com = ComApartment::init()?;
    boost_current_thread_priority();

    let device = resolve_wasapi_output_device(device_name)?;
    let audio_client = activate_wasapi_audio_client(&device)?;
    let sample_format = choose_wasapi_sample_format(&audio_client, shared.sample_rate)?;
    let wave_format = wasapi_wave_format(shared.sample_rate, sample_format);
    let buffer_duration = wasapi_exclusive_buffer_duration(&audio_client);

    unsafe {
        audio_client
            .Initialize(
                Audio::AUDCLNT_SHAREMODE_EXCLUSIVE,
                Audio::AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                buffer_duration,
                buffer_duration,
                &wave_format.Format,
                None,
            )
            .map_err(|err| format!("failed to open WASAPI exclusive output: {err}"))?;

        let event = EventHandle(
            Threading::CreateEventA(None, false, false, windows::core::PCSTR(ptr::null()))
                .map_err(|err| format!("failed to create WASAPI output event: {err}"))?,
        );
        audio_client
            .SetEventHandle(event.0)
            .map_err(|err| format!("failed to bind WASAPI output event: {err}"))?;

        let render_client = audio_client
            .GetService::<Audio::IAudioRenderClient>()
            .map_err(|err| format!("failed to create WASAPI render client: {err}"))?;
        let buffer_frames = audio_client
            .GetBufferSize()
            .map_err(|err| format!("failed to query WASAPI buffer size: {err}"))?;

        write_silence(&render_client, buffer_frames, sample_format)?;
        audio_client
            .Start()
            .map_err(|err| format!("failed to start WASAPI exclusive output: {err}"))?;
        shared.mark_output_started();

        while !shared.should_stop_output() {
            match Threading::WaitForSingleObject(event.0, 50) {
                WAIT_OBJECT_0 => {
                    let padding = audio_client
                        .GetCurrentPadding()
                        .map_err(|err| format!("failed to query WASAPI output padding: {err}"))?;
                    let frames_available = buffer_frames.saturating_sub(padding);
                    if frames_available > 0 {
                        write_frames(&render_client, frames_available, sample_format, &shared)?;
                    }
                }
                WAIT_TIMEOUT => {}
                WAIT_FAILED => return Err("waiting for WASAPI output event failed".to_string()),
                other => return Err(format!("unexpected WASAPI wait result: {other:?}")),
            }
        }

        let _ = audio_client.Stop();
    }

    Ok(())
}

fn write_frames(
    render_client: &Audio::IAudioRenderClient,
    frames: u32,
    sample_format: WasapiSampleFormat,
    shared: &SharedAudio,
) -> Result<(), String> {
    unsafe {
        let buffer = render_client
            .GetBuffer(frames)
            .map_err(|err| format!("failed to obtain WASAPI output buffer: {err}"))?;
        let sample_count = frames as usize * TARGET_CHANNELS;
        match sample_format {
            WasapiSampleFormat::F32 => {
                let data = slice::from_raw_parts_mut(buffer as *mut f32, sample_count);
                fill_output(data, TARGET_CHANNELS, shared);
            }
            WasapiSampleFormat::I16 => {
                let data = slice::from_raw_parts_mut(buffer as *mut i16, sample_count);
                let mut temp = vec![0.0f32; sample_count];
                fill_output(&mut temp, TARGET_CHANNELS, shared);
                for (target, sample) in data.iter_mut().zip(temp) {
                    *target = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
                }
            }
        }
        render_client
            .ReleaseBuffer(frames, 0)
            .map_err(|err| format!("failed to release WASAPI output buffer: {err}"))
    }
}

fn write_silence(
    render_client: &Audio::IAudioRenderClient,
    frames: u32,
    sample_format: WasapiSampleFormat,
) -> Result<(), String> {
    unsafe {
        let buffer = render_client
            .GetBuffer(frames)
            .map_err(|err| format!("failed to obtain WASAPI output buffer: {err}"))?;
        let sample_count = frames as usize * TARGET_CHANNELS;
        match sample_format {
            WasapiSampleFormat::F32 => {
                slice::from_raw_parts_mut(buffer as *mut f32, sample_count).fill(0.0);
            }
            WasapiSampleFormat::I16 => {
                slice::from_raw_parts_mut(buffer as *mut i16, sample_count).fill(0);
            }
        }
        render_client
            .ReleaseBuffer(frames, 0)
            .map_err(|err| format!("failed to release WASAPI output buffer: {err}"))
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
