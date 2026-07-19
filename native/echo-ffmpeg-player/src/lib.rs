mod config;
mod decoder;
mod device;
mod dsp;
mod effects;
mod events;
mod exclusive;
mod network_stream;
mod output;
mod shared;
mod tempo;

use crate::config::{PlayerConfig, PlayerConfigOptions, SpectrumConfig};
use crate::decoder::{audio_stream_ordinal_from_track_id, list_tracks_for_url, open_decoder};
use crate::effects::{
    clamp_spatial_mix, prepare_spatial_effect, DspSettings, PreparedSpatialEffect,
    DEFAULT_SPATIAL_MIX, EQ_BAND_COUNT,
};
use crate::events::{
    AudioDevice, PlayerEvent, PlayerState, SpectrumFrame, SpectrumOptions, SpectrumStatus,
    TrackInfo,
};
use crate::shared::{PlaybackSession, PlaybackSignal, SharedAudio};
use napi::bindgen_prelude::AsyncTask;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, Task};
use napi_derive::napi;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

static RUNTIME: Mutex<Option<PlayerRuntime>> = Mutex::new(None);
static EVENT_CALLBACK: Mutex<Option<Arc<Mutex<ThreadsafeFunction<PlayerEvent>>>>> =
    Mutex::new(None);

struct PlayerRuntime {
    config: PlayerConfig,
    session: Option<PlaybackSession>,
    state: PlayerState,
    current_url: Option<String>,
    current_audio_stream_ordinal: Option<usize>,
    current_seq: u64,
    dsp_settings: DspSettings,
    spectrum_config: SpectrumConfig,
    spectrum_analyzer: dsp::SpectrumAnalyzer,
    device_watcher: Option<device::DeviceWatcher>,
    fade_stop: Arc<AtomicBool>,
    loop_file: bool,
    audio_filter: String,
    spectrum_signal_logged: bool,
    spatial_request_seq: u64,
    spatial_mix: f32,
}

struct PreparedSource {
    session: PlaybackSession,
    url: String,
    audio_stream_ordinal: Option<usize>,
    seq: u64,
    duration: f64,
    start_position: f64,
    autostart: bool,
}

impl PlayerRuntime {
    fn new(config: PlayerConfig) -> Self {
        let spectrum_config = SpectrumConfig::default();
        Self {
            config,
            session: None,
            state: PlayerState {
                playing: false,
                paused: true,
                duration: 0.0,
                time_pos: 0.0,
            },
            current_url: None,
            current_audio_stream_ordinal: None,
            current_seq: 0,
            dsp_settings: DspSettings::default(),
            spectrum_analyzer: dsp::SpectrumAnalyzer::new(spectrum_config.clone()),
            spectrum_config,
            device_watcher: None,
            fade_stop: Arc::new(AtomicBool::new(false)),
            loop_file: false,
            audio_filter: String::new(),
            spectrum_signal_logged: false,
            spatial_request_seq: 0,
            spatial_mix: DEFAULT_SPATIAL_MIX,
        }
    }

    fn stop_session(&mut self) {
        if let Some(session) = self.session.take() {
            session.stop_background();
        }
        self.state.playing = false;
        self.state.paused = true;
    }
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

fn with_runtime<T>(f: impl FnOnce(&mut PlayerRuntime) -> napi::Result<T>) -> napi::Result<T> {
    let mut guard = RUNTIME
        .lock()
        .map_err(|err| napi::Error::from_reason(format!("failed to lock player runtime: {err}")))?;
    let runtime = guard
        .as_mut()
        .ok_or_else(|| napi::Error::from_reason("player addon not initialized".to_string()))?;
    f(runtime)
}

fn prepare_source(
    url: String,
    audio_stream_ordinal: Option<usize>,
    seq: u64,
    start_position: f64,
    autostart: bool,
    config: PlayerConfig,
    dsp_settings: DspSettings,
) -> Result<PreparedSource, String> {
    let sample_rate =
        device::resolve_output_sample_rate(&config.audio_device, config.exclusive_output);
    let mut decoder = open_decoder(url.clone(), audio_stream_ordinal, sample_rate)?;
    if start_position > 0.0 {
        decoder.seek(start_position)?;
    }
    let duration = decoder.duration_secs();
    let shared = Arc::new(SharedAudio::new(
        sample_rate,
        config.audio_buffer_secs,
        &dsp_settings,
    ));
    if let Ok(mut volume) = shared.volume.lock() {
        *volume = 1.0;
    }
    shared.paused.store(!autostart, Ordering::Release);
    let interrupt = decoder.interrupt_handle();
    shared.bind_interrupt(interrupt);

    let (signal_tx, signal_rx) = sync_channel::<PlaybackSignal>(32);
    shared.bind_signal_sender(signal_tx);
    let signal_shared = shared.clone();
    let signal_url = url.clone();
    let signal_seq = seq;
    let position_thread = thread::Builder::new()
        .name("player-signal".to_string())
        .spawn(move || {
            while let Ok(signal) = signal_rx.recv() {
                match signal {
                    PlaybackSignal::TimeUpdate => {
                        emit_event(PlayerEvent::time_update(signal_shared.position_secs()));
                    }
                    PlaybackSignal::PlaybackEnd => {
                        if !restart_loop_if_enabled(signal_shared.clone()) {
                            emit_event(PlayerEvent::playback_end("eof"));
                        }
                        break;
                    }
                    PlaybackSignal::Stop => break,
                }
                if signal_shared.stop.load(Ordering::Acquire) {
                    break;
                }
            }
            let _ = (signal_url, signal_seq);
        })
        .map_err(|err| format!("failed to spawn signal thread: {err}"))?;

    let output_thread = output::spawn_output_thread(
        config.audio_device.clone(),
        config.exclusive_output,
        shared.clone(),
        emit_event,
    );
    let decode_thread = decoder::spawn_decode_thread(decoder, shared.clone());
    Ok(PreparedSource {
        session: PlaybackSession {
            shared,
            output_thread: Some(output_thread),
            decode_thread: Some(decode_thread),
            position_thread: Some(position_thread),
        },
        url,
        audio_stream_ordinal,
        seq,
        duration,
        start_position: start_position.max(0.0),
        autostart,
    })
}

fn apply_prepared_source(runtime: &mut PlayerRuntime, prepared: PreparedSource) {
    runtime.session = Some(prepared.session);
    runtime.current_url = Some(prepared.url.clone());
    runtime.current_audio_stream_ordinal = prepared.audio_stream_ordinal;
    runtime.current_seq = prepared.seq;
    runtime.state.duration = prepared.duration;
    runtime.state.time_pos = prepared.start_position;
    runtime.state.playing = prepared.autostart;
    runtime.state.paused = !prepared.autostart;

    emit_event(PlayerEvent::duration_change(prepared.duration));
    emit_event(PlayerEvent::file_loaded(prepared.url, prepared.seq));
    emit_event(PlayerEvent::state_change(runtime.state.clone()));
}

fn replace_source_async(
    url: String,
    audio_stream_ordinal: Option<usize>,
    seq: u64,
    start_position: f64,
    autostart: bool,
    config: PlayerConfig,
    dsp_settings: DspSettings,
) -> napi::Result<()> {
    let prepared = prepare_source(
        url,
        audio_stream_ordinal,
        seq,
        start_position,
        autostart,
        config,
        dsp_settings,
    )
    .map_err(napi::Error::from_reason)?;
    with_runtime(|runtime| {
        apply_prepared_source(runtime, prepared);
        Ok(())
    })
}

fn restart_loop_if_enabled(shared: Arc<SharedAudio>) -> bool {
    let plan = with_runtime(|runtime| {
        if !runtime.loop_file {
            return Ok(None);
        }
        let Some(session) = runtime.session.as_ref() else {
            return Ok(None);
        };
        if !Arc::ptr_eq(&session.shared, &shared) {
            return Ok(None);
        }
        let Some(url) = runtime.current_url.clone() else {
            return Ok(None);
        };
        let audio_stream = runtime.current_audio_stream_ordinal;
        let seq = runtime.current_seq;
        let config = runtime.config.clone();
        let dsp_settings = runtime.dsp_settings.clone();
        runtime.stop_session();
        runtime.state.time_pos = 0.0;
        Ok(Some((url, audio_stream, seq, config, dsp_settings)))
    })
    .ok()
    .flatten();

    let Some((url, audio_stream, seq, config, dsp_settings)) = plan else {
        return false;
    };

    let _ = thread::Builder::new()
        .name("player-loop-restart".to_string())
        .spawn(move || {
            if let Err(err) =
                replace_source_async(url, audio_stream, seq, 0.0, true, config, dsp_settings)
            {
                emit_event(PlayerEvent::error(
                    events::PlayerErrorCode::Decode,
                    format!("failed to restart loop playback: {err}"),
                ));
            }
        });
    true
}

fn restart_output_for_config(config: PlayerConfig) -> napi::Result<()> {
    device::validate_output_device(&config.audio_device, config.exclusive_output)
        .map_err(napi::Error::from_reason)?;

    let restart = with_runtime(|runtime| {
        runtime.config = config.clone();
        let Some(session) = runtime.session.as_mut() else {
            return Ok(None);
        };
        Ok(Some((
            session.shared.clone(),
            session.output_thread.take(),
            config.audio_device.clone(),
            config.exclusive_output,
        )))
    })?;

    let Some((shared, output_thread, audio_device, exclusive_output)) = restart else {
        return Ok(());
    };

    shared.request_output_stop();
    if let Some(handle) = output_thread {
        let _ = handle.join();
    }

    shared.prepare_output_restart();
    let new_output_thread =
        output::spawn_output_thread(audio_device, exclusive_output, shared.clone(), emit_event);
    let mut new_output_thread = Some(new_output_thread);
    let attached = with_runtime(|runtime| {
        let Some(session) = runtime.session.as_mut() else {
            return Ok(false);
        };
        if !Arc::ptr_eq(&session.shared, &shared) {
            return Ok(false);
        }
        session.output_thread = new_output_thread.take();
        Ok(true)
    })?;

    if !attached {
        shared.request_output_stop();
        if let Some(handle) = new_output_thread {
            let _ = handle.join();
        }
    }

    Ok(())
}

fn take_current_for_replace(
    runtime: &mut PlayerRuntime,
    url: Option<String>,
    audio_stream_ordinal: Option<usize>,
    seq: Option<u64>,
    _start_position: f64,
    _autostart: bool,
) -> Result<(String, Option<usize>, u64, PlayerConfig, DspSettings), String> {
    runtime.stop_session();
    let url = url
        .or_else(|| runtime.current_url.clone())
        .ok_or_else(|| "no audio source loaded".to_string())?;
    Ok((
        url,
        audio_stream_ordinal.or(runtime.current_audio_stream_ordinal),
        seq.unwrap_or(runtime.current_seq),
        runtime.config.clone(),
        runtime.dsp_settings.clone(),
    ))
}

#[napi]
pub fn initialize(config: Option<PlayerConfigOptions>) -> napi::Result<()> {
    destroy()?;
    let mut runtime = PlayerRuntime::new(PlayerConfig::from_options(config));
    runtime.device_watcher = device::DeviceWatcher::start(emit_event).unwrap_or(None);
    *RUNTIME.lock().map_err(|err| {
        napi::Error::from_reason(format!("failed to lock player runtime: {err}"))
    })? = Some(runtime);
    Ok(())
}

#[napi]
pub fn destroy() -> napi::Result<()> {
    if let Ok(mut callback) = EVENT_CALLBACK.lock() {
        *callback = None;
    }
    let runtime = RUNTIME
        .lock()
        .map_err(|err| napi::Error::from_reason(format!("failed to lock player runtime: {err}")))?
        .take();
    if let Some(mut runtime) = runtime {
        runtime.stop_session();
    }
    Ok(())
}

#[napi]
pub fn register_event_handler(callback: ThreadsafeFunction<PlayerEvent>) -> napi::Result<()> {
    *EVENT_CALLBACK.lock().map_err(|err| {
        napi::Error::from_reason(format!("failed to lock event callback: {err}"))
    })? = Some(Arc::new(Mutex::new(callback)));
    Ok(())
}

pub struct LoadFileTask {
    url: String,
    seq: u64,
    audio_stream_ordinal: Option<usize>,
}

impl Task for LoadFileTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let (url, audio_stream, seq, config, dsp_settings) = with_runtime(|runtime| {
            take_current_for_replace(
                runtime,
                Some(self.url.clone()),
                self.audio_stream_ordinal,
                Some(self.seq),
                0.0,
                false,
            )
            .map_err(napi::Error::from_reason)
        })?;
        replace_source_async(url, audio_stream, seq, 0.0, false, config, dsp_settings)
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn load_file(url: String, seq: Option<f64>) -> AsyncTask<LoadFileTask> {
    AsyncTask::new(LoadFileTask {
        url,
        seq: seq.unwrap_or(0.0).max(0.0) as u64,
        audio_stream_ordinal: None,
    })
}

#[napi]
pub fn load_mkv_track(url: String, track_id: i64, seq: Option<f64>) -> AsyncTask<LoadFileTask> {
    AsyncTask::new(LoadFileTask {
        url,
        seq: seq.unwrap_or(0.0).max(0.0) as u64,
        audio_stream_ordinal: audio_stream_ordinal_from_track_id(track_id),
    })
}

pub struct GetTrackListTask {
    url: Option<String>,
}

impl Task for GetTrackListTask {
    type Output = Vec<TrackInfo>;
    type JsValue = Vec<TrackInfo>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(self
            .url
            .as_deref()
            .map(list_tracks_for_url)
            .unwrap_or_default())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn get_track_list() -> AsyncTask<GetTrackListTask> {
    let url = RUNTIME.lock().ok().and_then(|runtime| {
        runtime
            .as_ref()
            .and_then(|runtime| runtime.current_url.clone())
    });
    AsyncTask::new(GetTrackListTask { url })
}

pub struct PlayTask;

impl Task for PlayTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_runtime(|runtime| {
            let Some(session) = runtime.session.as_ref() else {
                return Err(napi::Error::from_reason(
                    "no audio source loaded".to_string(),
                ));
            };
            session.shared.paused.store(false, Ordering::Release);
            runtime.state.playing = true;
            runtime.state.paused = false;
            emit_event(PlayerEvent::state_change(runtime.state.clone()));
            Ok(())
        })
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn play() -> AsyncTask<PlayTask> {
    AsyncTask::new(PlayTask)
}

#[napi]
pub fn pause() -> napi::Result<()> {
    with_runtime(|runtime| {
        if let Some(session) = runtime.session.as_ref() {
            session.shared.paused.store(true, Ordering::Release);
        }
        runtime.state.playing = false;
        runtime.state.paused = true;
        emit_event(PlayerEvent::state_change(runtime.state.clone()));
        Ok(())
    })
}

#[napi]
pub fn stop() -> napi::Result<()> {
    with_runtime(|runtime| {
        runtime.stop_session();
        runtime.state.time_pos = 0.0;
        emit_event(PlayerEvent::state_change(runtime.state.clone()));
        Ok(())
    })
}

pub struct SeekTask {
    position: f64,
}

struct SeekPlan {
    shared: Arc<SharedAudio>,
    decode_thread: Option<std::thread::JoinHandle<Option<decoder::DecoderData>>>,
    was_paused: bool,
    url: Option<String>,
    audio_stream_ordinal: Option<usize>,
    seq: u64,
    config: PlayerConfig,
    dsp_settings: DspSettings,
}

impl Task for SeekTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let position = self.position.max(0.0);
        let Some(plan) = with_runtime(|runtime| {
            let Some(session) = runtime.session.as_mut() else {
                return Ok(None);
            };
            let shared = session.shared.clone();
            let was_paused = shared.paused.load(Ordering::Acquire);
            shared.paused.store(true, Ordering::Release);
            shared.request_decode_stop();
            Ok(Some(SeekPlan {
                shared,
                decode_thread: session.decode_thread.take(),
                was_paused,
                url: runtime.current_url.clone(),
                audio_stream_ordinal: runtime.current_audio_stream_ordinal,
                seq: runtime.current_seq,
                config: runtime.config.clone(),
                dsp_settings: runtime.dsp_settings.clone(),
            }))
        })?
        else {
            return Ok(());
        };

        let reused = plan
            .decode_thread
            .and_then(|handle| handle.join().ok().flatten());

        if let Some(mut decoder) = reused {
            decoder.reset_interrupt();
            match decoder.seek(position) {
                Ok(()) => {
                    let applied = with_runtime(|runtime| {
                        let Some(session) = runtime.session.as_mut() else {
                            return Ok(false);
                        };
                        if !Arc::ptr_eq(&session.shared, &plan.shared) {
                            return Ok(false);
                        }
                        session
                            .shared
                            .reset_for_decode_resume(position, &plan.dsp_settings);
                        session.shared.bind_interrupt(decoder.interrupt_handle());
                        session.decode_thread = Some(decoder::spawn_decode_thread(
                            decoder,
                            session.shared.clone(),
                        ));
                        session
                            .shared
                            .paused
                            .store(plan.was_paused, Ordering::Release);
                        runtime.state.time_pos = position;
                        emit_event(PlayerEvent::time_update(position));
                        Ok(true)
                    })?;
                    if applied {
                        return Ok(());
                    }
                    return Ok(());
                }
                Err(err) => emit_event(PlayerEvent::log(
                    "warn",
                    format!("decoder seek reuse failed, reopening source: {err}"),
                )),
            }
        }

        let Some(url) = plan.url else {
            return Ok(());
        };
        with_runtime(|runtime| {
            let Some(session) = runtime.session.as_ref() else {
                return Ok(());
            };
            if Arc::ptr_eq(&session.shared, &plan.shared) {
                runtime.stop_session();
            }
            Ok(())
        })?;
        replace_source_async(
            url,
            plan.audio_stream_ordinal,
            plan.seq,
            position,
            !plan.was_paused,
            plan.config,
            plan.dsp_settings,
        )
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn seek(time: f64) -> AsyncTask<SeekTask> {
    AsyncTask::new(SeekTask { position: time })
}

#[napi]
pub fn set_volume(volume: f64) -> napi::Result<()> {
    with_runtime(|runtime| {
        let normalized = (volume / 100.0).clamp(0.0, 1.5) as f32;
        if let Some(session) = runtime.session.as_ref() {
            if let Ok(mut guard) = session.shared.volume.lock() {
                *guard = normalized;
            }
        }
        Ok(())
    })
}

pub struct SetSpeedTask {
    speed: f64,
}

impl Task for SetSpeedTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_runtime(|runtime| {
            runtime.dsp_settings.speed = tempo::normalize_speed(self.speed);
            Ok(())
        })
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn set_speed(speed: f64) -> AsyncTask<SetSpeedTask> {
    AsyncTask::new(SetSpeedTask { speed })
}

#[napi]
pub fn set_equalizer(gains: Vec<f64>) -> napi::Result<()> {
    with_runtime(|runtime| {
        let mut next = [0.0f32; EQ_BAND_COUNT];
        for (index, value) in gains.into_iter().take(EQ_BAND_COUNT).enumerate() {
            next[index] = value.clamp(-12.0, 12.0) as f32;
        }
        runtime.dsp_settings.equalizer = next;
        if let Some(session) = runtime.session.as_ref() {
            if let Ok(mut chain) = session.shared.effects.lock() {
                chain.update_settings(&runtime.dsp_settings);
            }
        }
        Ok(())
    })
}

pub struct SetImpulseResponseTask {
    payload: serde_json::Value,
}

impl Task for SetImpulseResponseTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let Some((file_path, mix)) =
            parse_impulse_response_payload(&self.payload).map_err(napi::Error::from_reason)?
        else {
            with_runtime(|runtime| {
                runtime.spatial_request_seq = runtime.spatial_request_seq.wrapping_add(1);
                runtime.dsp_settings.spatial = None;
                if let Some(session) = runtime.session.as_ref() {
                    if let Ok(mut chain) = session.shared.effects.lock() {
                        chain.update_settings(&runtime.dsp_settings);
                    }
                }
                emit_event(PlayerEvent::log(
                    "info",
                    "impulse response disabled".to_string(),
                ));
                Ok(())
            })?;
            return Ok(());
        };

        let (sample_rate, request_seq, should_prepare) = with_runtime(|runtime| {
            runtime.spatial_request_seq = runtime.spatial_request_seq.wrapping_add(1);
            runtime.spatial_mix = clamp_spatial_mix(mix);
            let sample_rate = if let Some(session) = runtime.session.as_ref() {
                session.shared.sample_rate
            } else {
                device::resolve_output_sample_rate(
                    &runtime.config.audio_device,
                    runtime.config.exclusive_output,
                )
            };

            let can_reuse_current = runtime
                .dsp_settings
                .spatial
                .as_ref()
                .is_some_and(|spatial| {
                    spatial.file_path == file_path && spatial.sample_rate() == sample_rate
                });
            if can_reuse_current {
                update_spatial_mix(runtime, mix);
            }

            Ok((sample_rate, runtime.spatial_request_seq, !can_reuse_current))
        })?;

        if !should_prepare {
            return Ok(());
        }

        let spatial = prepare_spatial_effect(&file_path, mix, sample_rate).map_err(|err| {
            emit_event(PlayerEvent::impulse_response_disabled(err.clone()));
            napi::Error::from_reason(err)
        })?;

        with_runtime(|runtime| {
            if runtime.spatial_request_seq != request_seq {
                emit_event(PlayerEvent::log(
                    "debug",
                    "stale impulse response load ignored".to_string(),
                ));
                return Ok(());
            }
            let mut spatial = spatial;
            spatial.mix = runtime.spatial_mix;
            let spatial_path = spatial.file_path.clone();
            let spatial_mix = spatial.mix;
            apply_prepared_spatial_effect(runtime, spatial);
            emit_event(PlayerEvent::log(
                "info",
                format!("impulse response enabled: path='{spatial_path}', mix={spatial_mix:.2}"),
            ));
            Ok(())
        })
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

fn apply_prepared_spatial_effect(runtime: &mut PlayerRuntime, spatial: PreparedSpatialEffect) {
    runtime.dsp_settings.spatial = Some(spatial);
    if let Some(session) = runtime.session.as_ref() {
        if let Ok(mut chain) = session.shared.effects.lock() {
            chain.update_settings(&runtime.dsp_settings);
        }
    }
}

fn update_spatial_mix(runtime: &mut PlayerRuntime, mix: f32) {
    let mix = clamp_spatial_mix(mix);
    runtime.spatial_mix = mix;
    if let Some(spatial) = runtime.dsp_settings.spatial.as_mut() {
        spatial.mix = mix;
    }
    if let Some(session) = runtime.session.as_ref() {
        if let Ok(mut chain) = session.shared.effects.lock() {
            chain.set_spatial_mix(mix);
        }
    }
}

fn parse_impulse_response_payload(
    payload: &serde_json::Value,
) -> Result<Option<(String, f32)>, String> {
    match payload {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(path) => {
            let path = path.trim();
            if path.is_empty() {
                Ok(None)
            } else {
                Ok(Some((path.to_string(), DEFAULT_SPATIAL_MIX)))
            }
        }
        serde_json::Value::Object(object) => {
            let path = object
                .get("filePath")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .trim();
            if path.is_empty() {
                return Ok(None);
            }
            let mix = object
                .get("mix")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(DEFAULT_SPATIAL_MIX as f64)
                .clamp(0.0, 1.0) as f32;
            Ok(Some((path.to_string(), mix)))
        }
        _ => Err("invalid impulse response payload".to_string()),
    }
}

#[napi]
pub fn set_impulse_response(payload: serde_json::Value) -> AsyncTask<SetImpulseResponseTask> {
    AsyncTask::new(SetImpulseResponseTask { payload })
}

#[napi]
pub fn set_impulse_response_mix(mix: f64) -> napi::Result<()> {
    with_runtime(|runtime| {
        update_spatial_mix(runtime, mix as f32);
        Ok(())
    })
}

#[napi]
pub fn get_audio_filter() -> napi::Result<String> {
    with_runtime(|runtime| Ok(runtime.audio_filter.clone()))
}

pub struct SetAudioDeviceTask {
    device_name: String,
}

impl Task for SetAudioDeviceTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let config = with_runtime(|runtime| {
            let mut config = runtime.config.clone();
            config.set_audio_device(&self.device_name);
            Ok(config)
        })?;
        restart_output_for_config(config)
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn set_audio_device(device_name: String) -> AsyncTask<SetAudioDeviceTask> {
    AsyncTask::new(SetAudioDeviceTask { device_name })
}

pub struct GetAudioDevicesTask;

impl Task for GetAudioDevicesTask {
    type Output = Vec<AudioDevice>;
    type JsValue = Vec<AudioDevice>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(device::list_output_devices())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn get_audio_devices() -> AsyncTask<GetAudioDevicesTask> {
    AsyncTask::new(GetAudioDevicesTask)
}

#[napi]
pub fn set_normalization_gain(gain_db: f64) -> napi::Result<()> {
    with_runtime(|runtime| {
        runtime.dsp_settings.normalization_gain_db = gain_db.clamp(-24.0, 24.0) as f32;
        if let Some(session) = runtime.session.as_ref() {
            if let Ok(mut chain) = session.shared.effects.lock() {
                chain.update_settings(&runtime.dsp_settings);
            }
        }
        Ok(())
    })
}

pub struct FadeTask {
    from: f64,
    to: f64,
    duration_ms: f64,
    start_playback: bool,
}

impl Task for FadeTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let steps = (self.duration_ms / 16.0).ceil().max(1.0) as u32;
        if self.start_playback {
            set_volume(self.from)?;
            with_runtime(|runtime| {
                if let Some(session) = runtime.session.as_ref() {
                    session.shared.paused.store(false, Ordering::Release);
                }
                runtime.state.playing = true;
                runtime.state.paused = false;
                emit_event(PlayerEvent::state_change(runtime.state.clone()));
                Ok(())
            })?;
        }
        let first_step = if self.start_playback { 1 } else { 0 };
        for step in first_step..=steps {
            let t = step as f64 / steps as f64;
            let value = self.from + (self.to - self.from) * t;
            set_volume(value)?;
            thread::sleep(Duration::from_millis(16));
        }
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn fade(from: f64, to: f64, duration_ms: f64) -> AsyncTask<FadeTask> {
    AsyncTask::new(FadeTask {
        from,
        to,
        duration_ms,
        start_playback: false,
    })
}

#[napi]
pub fn cancel_fade() -> napi::Result<()> {
    with_runtime(|runtime| {
        runtime.fade_stop.store(true, Ordering::Release);
        Ok(())
    })
}

#[napi]
pub fn pause_with_fade(saved_volume: f64, duration_ms: f64) -> AsyncTask<FadeTask> {
    AsyncTask::new(FadeTask {
        from: saved_volume,
        to: 0.0,
        duration_ms,
        start_playback: false,
    })
}

#[napi]
pub fn play_with_fade(target_volume: f64, duration_ms: f64) -> AsyncTask<FadeTask> {
    AsyncTask::new(FadeTask {
        from: 0.0,
        to: target_volume,
        duration_ms,
        start_playback: true,
    })
}

#[napi]
pub fn get_state() -> napi::Result<PlayerState> {
    with_runtime(|runtime| {
        if let Some(session) = runtime.session.as_ref() {
            runtime.state.time_pos = session.shared.position_secs();
        }
        Ok(runtime.state.clone())
    })
}

pub struct SetExclusiveTask {
    exclusive: bool,
}

impl Task for SetExclusiveTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let config = with_runtime(|runtime| {
            let mut config = runtime.config.clone();
            config.exclusive_output = self.exclusive;
            Ok(config)
        })?;
        restart_output_for_config(config)
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn set_exclusive_output(exclusive: bool) -> AsyncTask<SetExclusiveTask> {
    AsyncTask::new(SetExclusiveTask { exclusive })
}

#[napi]
pub fn set_loop_file(loop_file: bool) -> napi::Result<()> {
    with_runtime(|runtime| {
        runtime.loop_file = loop_file;
        Ok(())
    })
}

#[napi]
pub fn set_network_timeout(seconds: f64) -> napi::Result<()> {
    with_runtime(|runtime| {
        runtime.config.network_timeout_secs = seconds.clamp(1.0, 300.0);
        Ok(())
    })
}

#[napi]
pub fn set_http_proxy(proxy: String) -> napi::Result<()> {
    with_runtime(|runtime| {
        let trimmed = proxy.trim();
        runtime.config.http_proxy = (!trimmed.is_empty()).then(|| trimmed.to_string());
        Ok(())
    })
}

#[napi]
pub fn configure_spectrum(options: Option<SpectrumOptions>) -> napi::Result<SpectrumStatus> {
    with_runtime(|runtime| {
        runtime.spectrum_config = SpectrumConfig::from_options(options);
        runtime.spectrum_analyzer = dsp::SpectrumAnalyzer::new(runtime.spectrum_config.clone());
        runtime.spectrum_signal_logged = false;
        Ok(SpectrumStatus {
            available: true,
            running: true,
            reason: None,
        })
    })
}

#[napi]
pub fn get_spectrum_status() -> napi::Result<SpectrumStatus> {
    with_runtime(|_| {
        Ok(SpectrumStatus {
            available: true,
            running: true,
            reason: None,
        })
    })
}

#[napi]
pub fn get_spectrum_snapshot() -> napi::Result<Option<SpectrumFrame>> {
    with_runtime(|runtime| {
        let Some(session) = runtime.session.as_ref() else {
            return Ok(None);
        };
        let frame = session
            .shared
            .spectrum_ring
            .lock()
            .map(|ring| {
                runtime
                    .spectrum_analyzer
                    .analyze(&ring, session.shared.sample_rate)
            })
            .ok();
        if let Some(frame) = frame.as_ref() {
            if !runtime.spectrum_signal_logged && (frame.peak > 0.0 || frame.rms > 0.0) {
                runtime.spectrum_signal_logged = true;
                emit_event(PlayerEvent::log(
                    "info",
                    format!(
                        "spectrum signal detected: peak={:.4}, rms={:.4}, bins={}",
                        frame.peak,
                        frame.rms,
                        frame.bins.len()
                    ),
                ));
            }
        }
        Ok(frame)
    })
}
