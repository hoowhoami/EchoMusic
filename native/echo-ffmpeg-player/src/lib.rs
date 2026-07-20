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
use crate::shared::{PlaybackSession, PlaybackSignal, SharedAudio, TrackSwitchInfo};
use napi::bindgen_prelude::AsyncTask;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, Task};
use napi_derive::napi;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

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
    latest_load_seq: u64,
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
    prepared_next: Option<PreparedNextSource>,
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

struct PreparedNextSource {
    decoder: decoder::DecoderData,
    url: String,
    audio_stream_ordinal: Option<usize>,
    seq: u64,
    duration: f64,
}

pub(crate) enum GaplessDecodeResult {
    NotPrepared,
    Activated(Option<decoder::DecoderData>),
}

struct ContinuousLoadPlan {
    shared: Arc<SharedAudio>,
    decode_thread: Option<std::thread::JoinHandle<Option<decoder::DecoderData>>>,
    request_seq: u64,
    was_paused: bool,
    previous_url: Option<String>,
    previous_audio_stream_ordinal: Option<usize>,
    previous_seq: u64,
    previous_duration: f64,
    previous_position: f64,
    config: PlayerConfig,
    dsp_settings: DspSettings,
}

enum LoadPlan {
    Initial {
        config: PlayerConfig,
        dsp_settings: DspSettings,
    },
    Continuous(ContinuousLoadPlan),
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
            latest_load_seq: 0,
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
            prepared_next: None,
        }
    }

    fn stop_session(&mut self) {
        self.prepared_next = None;
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
    let mut decoder = open_decoder(
        url.clone(),
        audio_stream_ordinal,
        sample_rate,
        config.packet_cache_options(),
    )?;
    if start_position > 0.0 {
        decoder.seek(start_position)?;
    }
    let duration = decoder.duration_secs();
    let shared = Arc::new(SharedAudio::new(
        sample_rate,
        config.audio_buffer_secs,
        config.playback_stall_timeout_secs,
        &dsp_settings,
    ));
    shared.set_volume(1.0);
    shared.set_position_secs(start_position);
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
            let tick = Duration::from_millis(250);
            let mut last_progress_samples = signal_shared.played_sample_count();
            let mut last_progress_at = Instant::now();
            let mut stall_reported = false;

            loop {
                match signal_rx.recv_timeout(tick) {
                    Ok(signal) => match signal {
                        PlaybackSignal::TimeUpdate => {
                            emit_event(PlayerEvent::time_update(signal_shared.position_secs()));
                        }
                        PlaybackSignal::Seeked => {
                            let position = signal_shared.position_secs();
                            emit_event(PlayerEvent::seeked(position));
                            emit_event(PlayerEvent::time_update(position));
                        }
                        PlaybackSignal::TrackSwitch(info) => {
                            apply_track_switch(info, signal_shared.clone());
                        }
                        PlaybackSignal::PlaybackEnd => {
                            if !restart_loop_if_enabled(signal_shared.clone()) {
                                emit_event(PlayerEvent::playback_end("eof"));
                            }
                            break;
                        }
                        PlaybackSignal::Stop => break,
                    },
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                if signal_shared.stop.load(Ordering::Acquire) {
                    break;
                }
                let current_samples = signal_shared.played_sample_count();
                if current_samples != last_progress_samples
                    || !signal_shared.should_watch_for_stall()
                {
                    last_progress_samples = current_samples;
                    last_progress_at = Instant::now();
                    stall_reported = false;
                    continue;
                }
                let stall_timeout = signal_shared.stall_timeout();
                if stall_timeout.is_zero() {
                    last_progress_at = Instant::now();
                    continue;
                }
                if !stall_reported && last_progress_at.elapsed() >= stall_timeout {
                    stall_reported = true;
                    emit_event(PlayerEvent::stalled(signal_shared.position_secs()));
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
    runtime.prepared_next = None;
    runtime.session = Some(prepared.session);
    runtime.current_url = Some(prepared.url.clone());
    runtime.current_audio_stream_ordinal = prepared.audio_stream_ordinal;
    runtime.current_seq = prepared.seq;
    runtime.latest_load_seq = runtime.latest_load_seq.max(prepared.seq);
    runtime.state.duration = prepared.duration;
    runtime.state.time_pos = prepared.start_position;
    runtime.state.playing = prepared.autostart;
    runtime.state.paused = !prepared.autostart;

    emit_event(PlayerEvent::duration_change(prepared.duration));
    emit_event(PlayerEvent::file_loaded(prepared.url, prepared.seq));
    emit_event(PlayerEvent::state_change(runtime.state.clone()));
}

fn apply_track_switch(info: TrackSwitchInfo, shared: Arc<SharedAudio>) {
    let _ = with_runtime(|runtime| {
        let Some(session) = runtime.session.as_ref() else {
            return Ok(());
        };
        if !Arc::ptr_eq(&session.shared, &shared) {
            return Ok(());
        }
        runtime.current_url = Some(info.url.clone());
        runtime.current_audio_stream_ordinal = info.audio_stream_ordinal;
        runtime.current_seq = info.seq;
        runtime.latest_load_seq = runtime.latest_load_seq.max(info.seq);
        runtime.state.duration = info.duration;
        runtime.state.time_pos = 0.0;
        runtime.state.playing = true;
        runtime.state.paused = false;
        emit_event(PlayerEvent::duration_change(info.duration));
        emit_event(PlayerEvent::file_loaded(info.url, info.seq));
        emit_event(PlayerEvent::state_change(runtime.state.clone()));
        emit_event(PlayerEvent::time_update(0.0));
        Ok(())
    });
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

pub(crate) fn try_activate_gapless_next(shared: Arc<SharedAudio>) -> GaplessDecodeResult {
    let next = with_runtime(|runtime| {
        let Some(session) = runtime.session.as_ref() else {
            return Ok(None);
        };
        if !Arc::ptr_eq(&session.shared, &shared) {
            return Ok(None);
        }
        Ok(runtime.prepared_next.take())
    })
    .ok()
    .flatten();

    let Some(next) = next else {
        return GaplessDecodeResult::NotPrepared;
    };

    emit_event(PlayerEvent::log(
        "info",
        format!(
            "gapless activating prepared next source: url='{}'",
            next.url
        ),
    ));
    shared.mark_gapless_boundary(TrackSwitchInfo {
        url: next.url,
        audio_stream_ordinal: next.audio_stream_ordinal,
        seq: next.seq,
        duration: next.duration,
    });
    GaplessDecodeResult::Activated(next.decoder.decode_into(shared))
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
        let url = self.url.clone();
        let audio_stream = self.audio_stream_ordinal;
        let seq = self.seq;
        let plan = with_runtime(|runtime| {
            runtime.prepared_next = None;
            runtime.latest_load_seq = seq;
            let Some(session) = runtime.session.as_mut() else {
                return Ok(LoadPlan::Initial {
                    config: runtime.config.clone(),
                    dsp_settings: runtime.dsp_settings.clone(),
                });
            };
            let shared = session.shared.clone();
            let was_paused = shared.paused.load(Ordering::Acquire);
            shared.paused.store(true, Ordering::Release);
            shared.request_decode_stop();
            Ok(LoadPlan::Continuous(ContinuousLoadPlan {
                shared,
                decode_thread: session.decode_thread.take(),
                request_seq: seq,
                was_paused,
                previous_url: runtime.current_url.clone(),
                previous_audio_stream_ordinal: runtime.current_audio_stream_ordinal,
                previous_seq: runtime.current_seq,
                previous_duration: runtime.state.duration,
                previous_position: session.shared.position_secs(),
                config: runtime.config.clone(),
                dsp_settings: runtime.dsp_settings.clone(),
            }))
        })?;

        match plan {
            LoadPlan::Initial {
                config,
                dsp_settings,
            } => replace_source_async(url, audio_stream, seq, 0.0, false, config, dsp_settings),
            LoadPlan::Continuous(plan) => {
                let reused = plan
                    .decode_thread
                    .and_then(|handle| handle.join().ok().flatten());
                let new_decoder = open_decoder(
                    url.clone(),
                    audio_stream,
                    plan.shared.sample_rate,
                    plan.config.packet_cache_options(),
                );
                match new_decoder {
                    Ok(decoder) => {
                        let duration = decoder.duration_secs();
                        with_runtime(|runtime| {
                            let Some(session) = runtime.session.as_mut() else {
                                return Ok(());
                            };
                            if !Arc::ptr_eq(&session.shared, &plan.shared)
                                || runtime.latest_load_seq != plan.request_seq
                            {
                                return Ok(());
                            }
                            session
                                .shared
                                .reset_for_decode_resume(0.0, &plan.dsp_settings);
                            session.shared.bind_interrupt(decoder.interrupt_handle());
                            session.decode_thread = Some(decoder::spawn_decode_thread(
                                decoder,
                                session.shared.clone(),
                            ));
                            session.shared.paused.store(true, Ordering::Release);
                            runtime.current_url = Some(url.clone());
                            runtime.current_audio_stream_ordinal = audio_stream;
                            runtime.current_seq = seq;
                            runtime.state.duration = duration;
                            runtime.state.time_pos = 0.0;
                            runtime.state.playing = false;
                            runtime.state.paused = true;
                            emit_event(PlayerEvent::duration_change(duration));
                            emit_event(PlayerEvent::file_loaded(url.clone(), seq));
                            emit_event(PlayerEvent::state_change(runtime.state.clone()));
                            Ok(())
                        })
                    }
                    Err(err) => {
                        if let Some(mut decoder) = reused {
                            decoder.reset_interrupt();
                            let restored = decoder.seek(plan.previous_position).is_ok();
                            with_runtime(|runtime| {
                                let Some(session) = runtime.session.as_mut() else {
                                    return Ok(());
                                };
                                if !Arc::ptr_eq(&session.shared, &plan.shared)
                                    || runtime.latest_load_seq != plan.request_seq
                                {
                                    return Ok(());
                                }
                                if restored {
                                    session.shared.reset_for_decode_resume(
                                        plan.previous_position,
                                        &plan.dsp_settings,
                                    );
                                    session.shared.bind_interrupt(decoder.interrupt_handle());
                                    session.decode_thread = Some(decoder::spawn_decode_thread(
                                        decoder,
                                        session.shared.clone(),
                                    ));
                                    session
                                        .shared
                                        .paused
                                        .store(plan.was_paused, Ordering::Release);
                                    runtime.current_url = plan.previous_url.clone();
                                    runtime.current_audio_stream_ordinal =
                                        plan.previous_audio_stream_ordinal;
                                    runtime.current_seq = plan.previous_seq;
                                    runtime.state.duration = plan.previous_duration;
                                    runtime.state.time_pos = plan.previous_position;
                                    runtime.state.playing = !plan.was_paused;
                                    runtime.state.paused = plan.was_paused;
                                    emit_event(PlayerEvent::state_change(runtime.state.clone()));
                                    emit_event(PlayerEvent::time_update(plan.previous_position));
                                } else {
                                    session.shared.mark_decode_failed();
                                    session.shared.paused.store(true, Ordering::Release);
                                    runtime.state.playing = false;
                                    runtime.state.paused = true;
                                    emit_event(PlayerEvent::state_change(runtime.state.clone()));
                                }
                                Ok(())
                            })?;
                        } else {
                            with_runtime(|runtime| {
                                if let Some(session) = runtime.session.as_mut() {
                                    if Arc::ptr_eq(&session.shared, &plan.shared) {
                                        session.shared.paused.store(true, Ordering::Release);
                                        session.shared.mark_decode_failed();
                                    }
                                }
                                runtime.state.playing = false;
                                runtime.state.paused = true;
                                emit_event(PlayerEvent::state_change(runtime.state.clone()));
                                Ok(())
                            })?;
                        }
                        Err(napi::Error::from_reason(err))
                    }
                }
            }
        }
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

pub struct PrepareNextSourceTask {
    url: String,
    seq: u64,
    audio_stream_ordinal: Option<usize>,
}

impl Task for PrepareNextSourceTask {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let (sample_rate, current_seq, shared, config) = with_runtime(|runtime| {
            let Some(session) = runtime.session.as_ref() else {
                return Ok(None);
            };
            Ok(Some((
                session.shared.sample_rate,
                runtime.current_seq,
                session.shared.clone(),
                runtime.config.clone(),
            )))
        })?
        .ok_or_else(|| napi::Error::from_reason("no active audio session".to_string()))?;

        let decoder = open_decoder(
            self.url.clone(),
            self.audio_stream_ordinal,
            sample_rate,
            config.packet_cache_options(),
        )
        .map_err(napi::Error::from_reason)?;
        let duration = decoder.duration_secs();
        let mut prepared = Some(PreparedNextSource {
            decoder,
            url: self.url.clone(),
            audio_stream_ordinal: self.audio_stream_ordinal,
            seq: self.seq,
            duration,
        });

        with_runtime(|runtime| {
            let Some(session) = runtime.session.as_ref() else {
                return Ok(false);
            };
            if !Arc::ptr_eq(&session.shared, &shared) || runtime.current_seq != current_seq {
                return Ok(false);
            }
            runtime.prepared_next = prepared.take();
            emit_event(PlayerEvent::log(
                "info",
                format!("gapless prepared next source: url='{}'", self.url),
            ));
            Ok(true)
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn prepare_next_source(
    url: String,
    track_id: Option<i64>,
    seq: Option<f64>,
) -> AsyncTask<PrepareNextSourceTask> {
    AsyncTask::new(PrepareNextSourceTask {
        url,
        seq: seq.unwrap_or(0.0).max(0.0) as u64,
        audio_stream_ordinal: track_id.and_then(audio_stream_ordinal_from_track_id),
    })
}

#[napi]
pub fn clear_prepared_next_source() -> napi::Result<()> {
    with_runtime(|runtime| {
        runtime.prepared_next = None;
        Ok(())
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
pub fn get_track_list(url: Option<String>) -> AsyncTask<GetTrackListTask> {
    let url = url.or_else(|| {
        RUNTIME.lock().ok().and_then(|runtime| {
            runtime
                .as_ref()
                .and_then(|runtime| runtime.current_url.clone())
        })
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
    current_position: f64,
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
                current_position: session.shared.position_secs(),
                dsp_settings: runtime.dsp_settings.clone(),
            }))
        })?
        else {
            return Ok(());
        };

        let reused = plan
            .decode_thread
            .and_then(|handle| handle.join().ok().flatten());

        let Some(mut decoder) = reused else {
            with_runtime(|runtime| {
                if let Some(session) = runtime.session.as_mut() {
                    if Arc::ptr_eq(&session.shared, &plan.shared) {
                        session
                            .shared
                            .paused
                            .store(plan.was_paused, Ordering::Release);
                    }
                }
                Ok(())
            })?;
            return Err(napi::Error::from_reason(
                "decoder is not available for seeking".to_string(),
            ));
        };

        decoder.reset_interrupt();
        if let Err(err) = decoder.seek(position) {
            let restored = decoder.seek(plan.current_position).is_ok();
            with_runtime(|runtime| {
                let Some(session) = runtime.session.as_mut() else {
                    return Ok(());
                };
                if !Arc::ptr_eq(&session.shared, &plan.shared) {
                    return Ok(());
                }
                if restored {
                    session
                        .shared
                        .reset_for_decode_resume(plan.current_position, &plan.dsp_settings);
                    session.shared.bind_interrupt(decoder.interrupt_handle());
                    session.decode_thread = Some(decoder::spawn_decode_thread(
                        decoder,
                        session.shared.clone(),
                    ));
                    session
                        .shared
                        .paused
                        .store(plan.was_paused, Ordering::Release);
                    runtime.state.time_pos = plan.current_position;
                    emit_event(PlayerEvent::time_update(plan.current_position));
                } else {
                    session.shared.mark_decode_failed();
                    session.shared.paused.store(true, Ordering::Release);
                }
                Ok(())
            })?;
            return Err(napi::Error::from_reason(err));
        }

        with_runtime(|runtime| {
            let Some(session) = runtime.session.as_mut() else {
                return Ok(());
            };
            if !Arc::ptr_eq(&session.shared, &plan.shared) {
                return Ok(());
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
            Ok(())
        })
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
            session.shared.set_volume(normalized);
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
            let speed = tempo::normalize_speed(self.speed);
            runtime.dsp_settings.speed = speed;
            if let Some(session) = runtime.session.as_ref() {
                session.shared.set_speed(speed);
            }
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

pub struct SetEqualizerTask {
    gains: Vec<f64>,
}

impl Task for SetEqualizerTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_runtime(|runtime| {
            let mut next = [0.0f32; EQ_BAND_COUNT];
            for (index, value) in self.gains.iter().take(EQ_BAND_COUNT).enumerate() {
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

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn set_equalizer(gains: Vec<f64>) -> AsyncTask<SetEqualizerTask> {
    AsyncTask::new(SetEqualizerTask { gains })
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

pub struct SetImpulseResponseMixTask {
    mix: f64,
}

impl Task for SetImpulseResponseMixTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_runtime(|runtime| {
            update_spatial_mix(runtime, self.mix as f32);
            Ok(())
        })
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn set_impulse_response_mix(mix: f64) -> AsyncTask<SetImpulseResponseMixTask> {
    AsyncTask::new(SetImpulseResponseMixTask { mix })
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

pub struct SetNormalizationGainTask {
    gain_db: f64,
}

impl Task for SetNormalizationGainTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_runtime(|runtime| {
            runtime.dsp_settings.normalization_gain_db = self.gain_db.clamp(-24.0, 24.0) as f32;
            if let Some(session) = runtime.session.as_ref() {
                if let Ok(mut chain) = session.shared.effects.lock() {
                    chain.update_settings(&runtime.dsp_settings);
                }
            }
            Ok(())
        })
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn set_normalization_gain(gain_db: f64) -> AsyncTask<SetNormalizationGainTask> {
    AsyncTask::new(SetNormalizationGainTask { gain_db })
}

pub struct FadeTask {
    from: f64,
    to: f64,
    duration_ms: f64,
    start_playback: bool,
    fade_stop: Arc<AtomicBool>,
}

impl Task for FadeTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let steps = (self.duration_ms / 16.0).ceil().max(1.0) as u32;
        self.fade_stop.store(false, Ordering::Release);
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
            if self.fade_stop.load(Ordering::Acquire) {
                break;
            }
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
    let fade_stop = RUNTIME
        .lock()
        .ok()
        .and_then(|runtime| runtime.as_ref().map(|runtime| runtime.fade_stop.clone()))
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    AsyncTask::new(FadeTask {
        from,
        to,
        duration_ms,
        start_playback: false,
        fade_stop,
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
    let fade_stop = RUNTIME
        .lock()
        .ok()
        .and_then(|runtime| runtime.as_ref().map(|runtime| runtime.fade_stop.clone()))
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    AsyncTask::new(FadeTask {
        from: saved_volume,
        to: 0.0,
        duration_ms,
        start_playback: false,
        fade_stop,
    })
}

#[napi]
pub fn play_with_fade(target_volume: f64, duration_ms: f64) -> AsyncTask<FadeTask> {
    let fade_stop = RUNTIME
        .lock()
        .ok()
        .and_then(|runtime| runtime.as_ref().map(|runtime| runtime.fade_stop.clone()))
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    AsyncTask::new(FadeTask {
        from: 0.0,
        to: target_volume,
        duration_ms,
        start_playback: true,
        fade_stop,
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
pub fn set_stall_timeout(seconds: f64) -> napi::Result<()> {
    with_runtime(|runtime| {
        let timeout = if seconds <= 0.0 {
            0.0
        } else {
            seconds.clamp(1.0, 60.0)
        };
        runtime.config.playback_stall_timeout_secs = timeout;
        if let Some(session) = runtime.session.as_ref() {
            session.shared.set_stall_timeout(timeout);
        }
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

pub struct GetSpectrumSnapshotTask;

impl Task for GetSpectrumSnapshotTask {
    type Output = Option<SpectrumFrame>;
    type JsValue = Option<SpectrumFrame>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
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

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn get_spectrum_snapshot() -> AsyncTask<GetSpectrumSnapshotTask> {
    AsyncTask::new(GetSpectrumSnapshotTask)
}
