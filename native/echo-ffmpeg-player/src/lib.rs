mod audio;
mod decode;
mod device;
mod dsp;
mod error;
mod http_range;
mod log;
mod player;
mod spectrum;
mod types;

use crate::error::{PlayerError, PlayerResult};
use crate::log::LogLevel;
use crate::player::{FfmpegPlayer, LoadRequest};
use crate::spectrum::{SpectrumFrame, SpectrumOptions, SpectrumStatus};
use crate::types::{AudioDevice, PlayerEvent, PlayerState, TrackInfo};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::{Arc, Mutex};
use std::thread;

static PLAYER: Mutex<Option<Arc<FfmpegPlayer>>> = Mutex::new(None);
static EVENT_CALLBACK: Mutex<Option<Arc<Mutex<ThreadsafeFunction<PlayerEvent>>>>> =
    Mutex::new(None);

fn get_player() -> PlayerResult<Arc<FfmpegPlayer>> {
    PLAYER
        .lock()
        .map_err(|err| PlayerError::State(format!("failed to lock player slot: {err}")))?
        .as_ref()
        .cloned()
        .ok_or(PlayerError::NotInitialized)
}

fn with_player<T>(f: impl FnOnce(&FfmpegPlayer) -> PlayerResult<T>) -> napi::Result<T> {
    let player = get_player().map_err(PlayerError::into_napi)?;
    f(&player).map_err(PlayerError::into_napi)
}

pub(crate) fn emit_event(event: PlayerEvent) {
    if let Ok(guard) = EVENT_CALLBACK.lock() {
        if let Some(callback) = guard.as_ref() {
            if let Ok(callback) = callback.lock() {
                callback.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
    }
}

fn emit_error(error: &PlayerError) {
    emit_event(PlayerEvent::error(error.to_string()));
}

fn spawn_load_request(player: Arc<FfmpegPlayer>, request: LoadRequest) -> napi::Result<()> {
    thread::Builder::new()
        .name("echo-ffmpeg-load".to_string())
        .spawn(move || match player.complete_load_request(request) {
            Ok(true) => emit_event(PlayerEvent::file_loaded()),
            Ok(false) => emit_event(log::event(LogLevel::Info, "stale load request ignored")),
            Err(err) => {
                emit_error(&err);
                emit_event(log::event(
                    LogLevel::Error,
                    format!("load request failed: {err}"),
                ));
            }
        })
        .map_err(|err| napi::Error::from_reason(format!("failed to spawn load request: {err}")))?;
    Ok(())
}

#[napi]
pub fn initialize(_runtime_path: String) -> napi::Result<()> {
    let _ = destroy();
    let player = Arc::new(FfmpegPlayer::new());
    let mut guard = PLAYER.lock().map_err(|err| {
        napi::Error::from_reason(format!("failed to initialize echo-ffmpeg-player: {err}"))
    })?;
    *guard = Some(player);
    emit_event(log::event(
        LogLevel::Info,
        "echo-ffmpeg-player initialized; decode/output backend is pending",
    ));
    Ok(())
}

#[napi]
pub fn destroy() -> napi::Result<()> {
    if let Ok(mut callback) = EVENT_CALLBACK.lock() {
        *callback = None;
    }
    let player = PLAYER
        .lock()
        .map_err(|err| napi::Error::from_reason(format!("failed to lock player slot: {err}")))?
        .take();
    if let Some(player) = player {
        player.destroy();
    }
    Ok(())
}

#[napi]
pub fn register_event_handler(callback: ThreadsafeFunction<PlayerEvent>) -> napi::Result<()> {
    let callback = Arc::new(Mutex::new(callback));
    if let Ok(mut guard) = EVENT_CALLBACK.lock() {
        *guard = Some(callback);
    }

    emit_event(log::event(LogLevel::Info, "event handler registered"));
    if let Ok(devices) = device::list_output_devices() {
        emit_event(PlayerEvent::audio_device_list_changed(devices));
    }
    Ok(())
}

#[napi]
pub fn load_file(url: String) -> napi::Result<()> {
    let player = get_player().map_err(PlayerError::into_napi)?;
    let request = player
        .begin_load_file(&url)
        .map_err(PlayerError::into_napi)?;
    spawn_load_request(player, request)
}

#[napi]
pub fn load_mkv_track(url: String, track_id: i64) -> napi::Result<()> {
    let player = get_player().map_err(PlayerError::into_napi)?;
    let request = player
        .begin_load_mkv_track(&url, track_id)
        .map_err(PlayerError::into_napi)?;
    spawn_load_request(player, request)
}

#[napi]
pub fn set_audio_track(track_id: i64) -> napi::Result<()> {
    let player = get_player().map_err(PlayerError::into_napi)?;
    let request = player
        .begin_audio_track_switch(track_id)
        .map_err(PlayerError::into_napi)?;
    thread::Builder::new()
        .name("echo-ffmpeg-track-switch".to_string())
        .spawn(move || {
            if let Err(err) = player.complete_audio_track_switch(request) {
                emit_error(&err);
            }
        })
        .map_err(|err| napi::Error::from_reason(format!("failed to spawn track switch: {err}")))?;
    Ok(())
}

#[napi]
pub fn get_track_list() -> napi::Result<Vec<TrackInfo>> {
    with_player(|player| Ok(player.get_track_list()))
}

#[napi]
pub fn play() -> napi::Result<()> {
    with_player(|player| match player.play() {
        Ok(event) => {
            emit_event(event);
            Ok(())
        }
        Err(err) => {
            emit_error(&err);
            Err(err)
        }
    })
}

#[napi]
pub fn pause() -> napi::Result<()> {
    with_player(|player| {
        let event = player.pause()?;
        emit_event(event);
        Ok(())
    })
}

#[napi]
pub fn stop() -> napi::Result<()> {
    with_player(|player| {
        emit_event(player.stop());
        Ok(())
    })
}

#[napi]
pub fn seek(time: f64) -> napi::Result<()> {
    with_player(|player| {
        let event = player.seek(time)?;
        emit_event(event);
        Ok(())
    })
}

#[napi]
pub fn set_volume(volume: f64) -> napi::Result<()> {
    with_player(|player| player.set_volume(volume))
}

#[napi]
pub fn set_speed(speed: f64) -> napi::Result<()> {
    with_player(|player| player.set_speed(speed))
}

#[napi]
pub fn set_audio_device(device_name: String) -> napi::Result<()> {
    with_player(|player| player.set_audio_device(&device_name))
}

#[napi]
pub fn get_audio_devices() -> napi::Result<Vec<AudioDevice>> {
    with_player(|player| player.get_audio_devices())
}

#[napi]
pub fn start_spectrum(options: Option<SpectrumOptions>) -> napi::Result<SpectrumStatus> {
    with_player(|player| Ok(player.start_spectrum(options)))
}

#[napi]
pub fn stop_spectrum() -> napi::Result<SpectrumStatus> {
    with_player(|player| Ok(player.stop_spectrum()))
}

#[napi]
pub fn get_spectrum_status() -> napi::Result<SpectrumStatus> {
    with_player(|player| Ok(player.spectrum_status()))
}

#[napi]
pub fn get_spectrum_snapshot() -> napi::Result<Option<SpectrumFrame>> {
    with_player(|player| Ok(player.spectrum_snapshot()))
}

#[napi]
pub fn set_audio_filter(filter: String) -> napi::Result<()> {
    with_player(|player| player.set_audio_filter(&filter))
}

#[napi]
pub fn af_command(label: String, cmd: String, arg: String, target: String) -> napi::Result<()> {
    with_player(|player| player.af_command(&label, &cmd, &arg, &target))
}

#[napi]
pub fn set_eq(gains: Vec<f64>) -> napi::Result<()> {
    with_player(|player| player.set_eq(&gains))
}

#[napi]
pub fn set_normalization_gain(gain_db: f64) -> napi::Result<()> {
    with_player(|player| player.set_normalization_gain(gain_db))
}

#[napi]
pub fn set_exclusive(exclusive: bool) -> napi::Result<()> {
    with_player(|player| player.set_exclusive(exclusive))
}

#[napi]
pub fn set_media_title(title: String) -> napi::Result<()> {
    with_player(|player| {
        player.set_media_title(&title);
        Ok(())
    })
}

#[napi]
pub fn set_loop_file(value: String) -> napi::Result<()> {
    with_player(|player| {
        player.set_loop_file(&value);
        Ok(())
    })
}

#[napi]
pub fn get_state() -> napi::Result<PlayerState> {
    with_player(|player| Ok(player.state()))
}

#[napi]
pub fn get_property(name: String) -> napi::Result<String> {
    with_player(|player| player.get_property(&name))
}

#[napi]
pub fn fade(from: f64, to: f64, duration_ms: f64) -> napi::Result<()> {
    with_player(|player| player.fade(from, to, duration_ms.max(0.0) as u64))
}

#[napi]
pub fn pause_with_fade(saved_volume: f64, duration_ms: f64) -> napi::Result<()> {
    with_player(|player| player.pause_with_fade(saved_volume, duration_ms.max(0.0) as u64))
}

#[napi]
pub fn play_with_fade(target_volume: f64, duration_ms: f64) -> napi::Result<()> {
    with_player(
        |player| match player.play_with_fade(target_volume, duration_ms.max(0.0) as u64) {
            Ok(()) => {
                emit_event(PlayerEvent::state_change(false));
                Ok(())
            }
            Err(err) => {
                emit_error(&err);
                Err(err)
            }
        },
    )
}

#[napi]
pub fn cancel_fade() -> napi::Result<()> {
    with_player(|player| {
        player.cancel_fade();
        Ok(())
    })
}

#[napi]
pub fn is_fading() -> napi::Result<bool> {
    with_player(|player| Ok(player.is_fading()))
}
