mod audio_graph;
mod config;
mod control;
mod decoder;
mod device;
mod dispatcher;
mod dsp;
mod effects;
mod events;
mod exclusive;
mod filter;
mod output;
mod shared;
mod stream;
mod tempo;
mod vhe;
mod vpf;

use control::{
    attach_restarted_decoder, handle_output_device_list_change,
    handle_playback_output_device_event, mark_seek_plan_failed, open_decoder_at_position,
    prepare_dsp_settings_for_mix_rate, request_output_recovery, restart_output_for_runtime,
    schedule_idle_output_release_for_runtime, SeekPlan,
};
pub use control::{
    cancel_fade, configure_spectrum, fade, get_audio_devices, get_audio_graph,
    get_spectrum_snapshot, get_spectrum_status, pause_with_fade, play_with_fade, set_audio_effect,
    set_audio_graph_parameter, set_audio_graph_plan, set_audio_output, set_equalizer,
    set_http_proxy, set_network_timeout, set_normalization_gain, set_pause_on_device_disconnect,
    set_speed, set_stall_timeout, FadeTask, GetAudioDevicesTask, GetSpectrumSnapshotTask,
    SetAudioEffectTask, SetAudioGraphParameterTask, SetAudioGraphPlanTask, SetAudioOutputTask,
    SetEqualizerTask, SetNormalizationGainTask, SetSpeedTask,
};
pub use control::{seek, SeekTask};

use crate::config::{GaplessAudioPolicy, PlayerConfig, PlayerConfigOptions, SpectrumConfig};
use crate::decoder::{
    audio_stream_ordinal_from_track_id, list_tracks_for_url, open_decoder,
    open_decoder_with_interrupt,
};
use crate::dispatcher::{
    call_core_command, call_core_command_blocking, clear_event_callback, dispatch_core_command,
    reset_event_ids, send_event, send_events, set_event_callback, start_core_dispatcher,
    start_event_dispatcher, stop_core_dispatcher, stop_event_dispatcher,
};
use crate::effects::{prepare_spatial_effect, DspSettings, EQ_BAND_COUNT};
use crate::events::{
    AudioDevice, PlayerEvent, PlayerState, SpectrumFrame, SpectrumOptions, SpectrumStatus,
    TrackInfo,
};
use crate::shared::{MixFormat, PlaybackSession, PlaybackSignal, SharedAudio, TrackSwitchInfo};
use audio_graph::AudioGraphSnapshot;
use napi::bindgen_prelude::AsyncTask;
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Env, Task};
use napi_derive::napi;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{
    channel, sync_channel, RecvTimeoutError, SyncSender, TryRecvError, TrySendError,
};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const GAPLESS_PREDECODE_SECS: f64 = 0.5;

static RUNTIME: Mutex<Option<PlayerRuntime>> = Mutex::new(None);
/// Mirrors `RUNTIME.is_some()` for lock-free readiness checks on hot control
/// paths. All authoritative writes happen while holding the RUNTIME guard
/// (initialize sets true, shutdown sets false before take()), so ready==true
/// always implies RUNTIME is populated. Shutdown additionally flips it false
/// before acquiring the lock so in-flight fades fail fast.
static RUNTIME_READY: AtomicBool = AtomicBool::new(false);
/// Cache of the active session's SharedAudio for hot control paths (volume/fades).
/// Guarded by its own tiny mutex so a 16 ms fade tick never contends with load/seek
/// work that can hold RUNTIME for long stretches. Updated wherever runtime.session
/// changes: apply_prepared_source, stop_session, and the load-failure teardown.
static CURRENT_SHARED: Mutex<Option<Arc<SharedAudio>>> = Mutex::new(None);
/// User volume survives audio-session replacement. New sessions must not
/// fall back to SharedAudio's default volume while a track is being replaced.
static USER_VOLUME_BITS: AtomicU32 = AtomicU32::new(1.0f32.to_bits());
static NEXT_SEEK_REQUEST_SEQ: AtomicU64 = AtomicU64::new(0);
static LATEST_SEEK_REQUEST_SEQ: AtomicU64 = AtomicU64::new(0);
type RuntimeCommand = Box<dyn FnOnce(&mut PlayerRuntime) + Send + 'static>;

fn set_current_shared(shared: Option<Arc<SharedAudio>>) {
    if let Ok(mut guard) = CURRENT_SHARED.lock() {
        *guard = shared;
    }
}

pub(crate) fn current_shared() -> Option<Arc<SharedAudio>> {
    CURRENT_SHARED.lock().ok().and_then(|guard| guard.clone())
}

pub(crate) fn user_volume() -> f32 {
    f32::from_bits(USER_VOLUME_BITS.load(Ordering::Acquire)).clamp(0.0, 1.5)
}

pub(crate) fn set_session_volume(volume: f64) -> napi::Result<()> {
    if !RUNTIME_READY.load(Ordering::Acquire) {
        return Err(napi::Error::from_reason(
            "player addon not initialized".to_string(),
        ));
    }
    let normalized = (volume / 100.0).clamp(0.0, 1.5) as f32;
    if let Some(shared) = current_shared() {
        shared.set_volume(normalized);
    }
    Ok(())
}

fn cancel_runtime_fade() {
    if let Ok(guard) = RUNTIME.lock() {
        if let Some(runtime) = guard.as_ref() {
            runtime.fade_stop.store(true, Ordering::Release);
        }
    }
}

struct PlayerRuntime {
    config: PlayerConfig,
    session: Option<PlaybackSession>,
    state: PlayerState,
    core_state: PlaybackCoreState,
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
    audio_graph: AudioGraphSnapshot,
    audio_graph_revision: u64,
    spectrum_signal_logged: bool,
    spatial_request_seq: u64,
    idle_output_release_seq: u64,
    spatial_file_path: Option<String>,
    prepared_next: Option<PreparedNextSource>,
    gapless_prepare_interrupt: Option<(u64, Arc<AtomicBool>)>,
    seek_restart_interrupt: Option<Arc<AtomicBool>>,
    seek_request_seq: u64,
    seek_restore_paused: Option<bool>,
    pause_on_device_disconnect: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PlaybackCoreState {
    Idle,
    Loading,
    Buffering,
    Playing,
    Paused,
    Seeking,
    Draining,
    Error,
    DeviceLost,
    OutputReconfig,
}

impl PlaybackCoreState {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Loading => "loading",
            Self::Buffering => "buffering",
            Self::Playing => "playing",
            Self::Paused => "paused",
            Self::Seeking => "seeking",
            Self::Draining => "draining",
            Self::Error => "error",
            Self::DeviceLost => "device-lost",
            Self::OutputReconfig => "output-reconfig",
        }
    }

    const fn allows_idle_output_release(self) -> bool {
        matches!(self, Self::Paused | Self::Draining | Self::Error)
    }
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
    predecoded: Vec<shared::DecodedAudioChunk>,
    url: String,
    audio_stream_ordinal: Option<usize>,
    seq: u64,
    duration: f64,
    preferred_output_sample_format: shared::AudioSampleFormat,
    normalization_gain_db: f32,
}

pub(crate) enum GaplessDecodeResult {
    NotPrepared,
    Activated(Option<decoder::DecoderData>),
}

struct ContinuousLoadPlan {
    shared: Arc<SharedAudio>,
    request_seq: u64,
    config: PlayerConfig,
    dsp_settings: DspSettings,
    spatial_file_path: Option<String>,
}

enum LoadPlan {
    Initial {
        config: PlayerConfig,
        dsp_settings: DspSettings,
        spatial_file_path: Option<String>,
        pause_on_device_disconnect: bool,
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
            core_state: PlaybackCoreState::Idle,
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
            audio_graph: AudioGraphSnapshot::default(),
            audio_graph_revision: 0,
            spectrum_signal_logged: false,
            spatial_request_seq: 0,
            idle_output_release_seq: 0,
            spatial_file_path: None,
            prepared_next: None,
            gapless_prepare_interrupt: None,
            seek_restart_interrupt: None,
            seek_request_seq: 0,
            seek_restore_paused: None,
            pause_on_device_disconnect: false,
        }
    }

    fn cancel_idle_output_release(&mut self) {
        self.idle_output_release_seq = self.idle_output_release_seq.wrapping_add(1);
    }

    fn next_idle_output_release_seq(&mut self) -> u64 {
        self.cancel_idle_output_release();
        self.idle_output_release_seq
    }

    fn stop_session(&mut self) {
        self.cancel_idle_output_release();
        self.cancel_pending_seek_restart();
        self.cancel_pending_gapless_prepare();
        self.seek_restore_paused = None;
        self.prepared_next = None;
        if let Some(session) = self.session.take() {
            set_current_shared(None);
            session.stop_background();
        }
        self.state.playing = false;
        self.state.paused = true;
        self.core_state = PlaybackCoreState::Idle;
    }

    fn cancel_pending_seek_restart(&mut self) {
        if let Some(interrupt) = self.seek_restart_interrupt.take() {
            interrupt.store(true, Ordering::Release);
        }
    }

    fn cancel_pending_gapless_prepare(&mut self) {
        if let Some((_, interrupt)) = self.gapless_prepare_interrupt.take() {
            interrupt.store(true, Ordering::Release);
        }
        if let Some(session) = self.session.as_ref() {
            session.shared.clear_gapless_prepares();
        }
    }

    fn clear_pending_seek_restart(&mut self, interrupt: Option<&Arc<AtomicBool>>) {
        let Some(interrupt) = interrupt else {
            return;
        };
        if self
            .seek_restart_interrupt
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, interrupt))
        {
            self.seek_restart_interrupt = None;
        }
    }

    fn accept_seek_request_seq(&mut self, request_seq: u64) -> bool {
        if !is_latest_seek_request_seq(request_seq) {
            return false;
        }
        self.seek_request_seq = request_seq;
        true
    }

    fn is_seek_request_current(&self, request_seq: u64) -> bool {
        request_seq == 0 || self.seek_request_seq == request_seq
    }

    fn begin_seek_restore_paused(&mut self) -> bool {
        let was_paused = self.seek_restore_paused.unwrap_or(self.state.paused);
        self.seek_restore_paused = Some(was_paused);
        was_paused
    }

    fn clear_seek_restore_paused_if_current(&mut self, request_seq: u64) {
        if self.is_seek_request_current(request_seq) {
            self.seek_restore_paused = None;
        }
    }
}

fn next_seek_request_seq() -> u64 {
    let seq = NEXT_SEEK_REQUEST_SEQ
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1)
        .max(1);
    LATEST_SEEK_REQUEST_SEQ.store(seq, Ordering::Release);
    seq
}

fn invalidate_seek_requests() {
    let _ = next_seek_request_seq();
}

fn is_latest_seek_request_seq(seq: u64) -> bool {
    seq == 0 || LATEST_SEEK_REQUEST_SEQ.load(Ordering::Acquire) == seq
}

pub(crate) fn emit_event(event: PlayerEvent) {
    if event.event == "error" {
        let core_state = match event.error_code.as_deref() {
            Some("output-device-unavailable") | Some("output-runtime") => {
                PlaybackCoreState::DeviceLost
            }
            _ => PlaybackCoreState::Error,
        };
        dispatch_core_command(
            "player-error",
            Box::new(move |runtime| {
                set_runtime_core_state(runtime, core_state, "player-error");
            }),
        );
    }
    send_event(event);
}

fn emit_events(events: Vec<PlayerEvent>) {
    send_events(events);
}

fn contextualize_runtime_event(runtime: &PlayerRuntime, event: PlayerEvent) -> PlayerEvent {
    let generation = runtime
        .session
        .as_ref()
        .map(|session| session.shared.current_decode_generation())
        .unwrap_or_default();
    event.with_playback_context(runtime.current_seq, generation)
}

fn contextualize_shared_event(shared: &SharedAudio, event: PlayerEvent) -> PlayerEvent {
    event.with_playback_context(
        shared.current_track_seq(),
        shared.current_decode_generation(),
    )
}

fn emit_runtime_event(runtime: &PlayerRuntime, event: PlayerEvent) {
    emit_event(contextualize_runtime_event(runtime, event));
}

fn emit_runtime_events(runtime: &PlayerRuntime, events: Vec<PlayerEvent>) {
    emit_events(
        events
            .into_iter()
            .map(|event| contextualize_runtime_event(runtime, event))
            .collect(),
    );
}

fn set_runtime_core_state(
    runtime: &mut PlayerRuntime,
    state: PlaybackCoreState,
    reason: &'static str,
) {
    if runtime.core_state == state {
        return;
    }
    runtime.core_state = state;
    emit_runtime_event(
        runtime,
        PlayerEvent::core_state_change(state.as_str(), reason),
    );
}

pub(crate) fn on_core_loop_tick(runtime: &mut PlayerRuntime) {
    let Some(session) = runtime.session.as_ref() else {
        return;
    };
    if runtime.state.playing
        && !session.shared.paused.load(Ordering::Acquire)
        && matches!(runtime.core_state, PlaybackCoreState::Paused)
    {
        set_runtime_core_state(runtime, PlaybackCoreState::Playing, "core-loop-tick");
    }
}

pub(crate) fn emit_shared_event(shared: &SharedAudio, event: PlayerEvent) {
    emit_event(contextualize_shared_event(shared, event));
}

fn emit_shared_events(shared: &SharedAudio, events: Vec<PlayerEvent>) {
    emit_events(
        events
            .into_iter()
            .map(|event| contextualize_shared_event(shared, event))
            .collect(),
    );
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

fn mark_playback_idle_after_end(shared: Arc<SharedAudio>) {
    dispatch_core_command(
        "playback-end",
        Box::new(move |runtime| {
            let Some(session) = runtime.session.as_ref() else {
                return;
            };
            if !Arc::ptr_eq(&session.shared, &shared) {
                return;
            }
            runtime.state.playing = false;
            runtime.state.paused = true;
            set_runtime_core_state(runtime, PlaybackCoreState::Draining, "playback-end");
            emit_runtime_events(
                runtime,
                vec![
                    PlayerEvent::state_change(runtime.state.clone()),
                    PlayerEvent::playback_end("eof"),
                ],
            );
            schedule_idle_output_release_for_runtime(runtime);
        }),
    );
}

fn prepare_source(
    url: String,
    audio_stream_ordinal: Option<usize>,
    seq: u64,
    start_position: f64,
    autostart: bool,
    config: PlayerConfig,
    dsp_settings: DspSettings,
    spatial_file_path: Option<String>,
    pause_on_device_disconnect: bool,
) -> Result<PreparedSource, String> {
    let mut decoder = open_decoder(
        url.clone(),
        audio_stream_ordinal,
        None,
        config.packet_cache_options_for_url(&url),
        &config.stream_options(),
    )?;
    if start_position > 0.0 {
        decoder.seek(start_position)?;
    }
    let duration = decoder.duration_secs();
    let source_sample_rate = decoder.mix_sample_rate();
    let output_sample_rate =
        device::preferred_output_sample_rate(&config.audio_device, config.exclusive_output);
    let mix_sample_rate =
        config.resolve_initial_mix_sample_rate(source_sample_rate, output_sample_rate);
    let dsp_settings = prepare_dsp_settings_for_mix_rate(
        dsp_settings,
        spatial_file_path.as_deref(),
        mix_sample_rate,
    )?;
    let mix_channels = config.resolve_mix_channels(
        decoder.source_channels(),
        dsp_settings.requires_stereo_graph(),
    );
    let mix_format = MixFormat::f32(mix_sample_rate, mix_channels);
    if mix_sample_rate != source_sample_rate {
        emit_event(PlayerEvent::log(
            "info",
            format!(
                "audio samplerate policy selected engine mix rate: source_sample_rate={source_sample_rate}, output_sample_rate={}, mix_sample_rate={mix_sample_rate}",
                output_sample_rate
                    .map(|rate| rate.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            ),
        ));
    }
    if let Some(spatial) = dsp_settings.spatial.as_ref() {
        emit_event(PlayerEvent::log(
            "info",
            format!(
                "impulse response enabled: path='{}', mix_sample_rate={}, ir_channels={}, mode={}",
                spatial.file_path,
                mix_sample_rate,
                spatial.channels(),
                spatial.mode()
            ),
        ));
    }
    let shared = Arc::new(SharedAudio::with_output_buffer(
        mix_format,
        config.audio_buffer_secs,
        config.playback_stall_timeout_secs,
        &dsp_settings,
    ));
    shared.set_pause_on_device_disconnect(pause_on_device_disconnect);
    shared.begin_output_preroll();
    shared.set_source_sample_format(decoder.source_sample_format());
    shared.set_preferred_output_sample_format(
        config.resolve_output_sample_format(decoder.source_sample_format()),
    );
    shared.set_track_seq(seq);
    shared.set_volume(user_volume());
    shared.set_position_secs(start_position);
    shared.paused.store(!autostart, Ordering::Release);
    let interrupt = decoder.interrupt_handle();
    shared.bind_interrupt(interrupt);

    let (control_signal_tx, control_signal_rx) = channel::<PlaybackSignal>();
    let (telemetry_signal_tx, telemetry_signal_rx) = sync_channel::<PlaybackSignal>(32);
    shared
        .bind_signal_senders(control_signal_tx, telemetry_signal_tx)
        .map_err(str::to_string)?;
    let signal_shared = shared.clone();
    let signal_url = url.clone();
    let signal_seq = seq;
    let position_thread = thread::Builder::new()
        .name("player-signal".to_string())
        .spawn(move || {
            let tick = Duration::from_millis(250);
            let mut last_clock_samples = signal_shared.played_sample_count();
            let mut last_clock_track_seq = signal_shared.current_track_seq();
            let mut last_clock_at = Instant::now();
            let mut last_progress_samples = signal_shared.played_sample_count();
            let mut last_progress_at = Instant::now();
            let mut stall_reported = false;
            loop {
                let signal = match control_signal_rx.recv_timeout(tick) {
                    Ok(signal) => Some(signal),
                    Err(RecvTimeoutError::Timeout) => match telemetry_signal_rx.try_recv() {
                        Ok(signal) => Some(signal),
                        Err(TryRecvError::Empty | TryRecvError::Disconnected) => None,
                    },
                    Err(RecvTimeoutError::Disconnected) => break,
                };
                if let Some(signal) = signal {
                    match signal {
                        PlaybackSignal::PlaybackRestart(position) => {
                            emit_shared_events(
                                &signal_shared,
                                vec![
                                    PlayerEvent::playback_restart(position, "seek"),
                                    PlayerEvent::seeked(position),
                                    PlayerEvent::time_update(position),
                                ],
                            );
                            last_clock_samples = signal_shared.played_sample_count();
                            last_clock_track_seq = signal_shared.current_track_seq();
                            last_clock_at = Instant::now();
                        }
                        PlaybackSignal::AoState {
                            paused,
                            reason,
                            buffering_state,
                            buffered_secs,
                            target_secs,
                        } => {
                            emit_shared_event(
                                &signal_shared,
                                PlayerEvent::ao_state_change(
                                    paused,
                                    reason,
                                    buffering_state,
                                    buffered_secs,
                                    target_secs,
                                ),
                            );
                            let ao_shared = signal_shared.clone();
                            dispatch_core_command(
                                "ao-state",
                                Box::new(move |runtime| {
                                    let Some(session) = runtime.session.as_ref() else {
                                        return;
                                    };
                                    if !Arc::ptr_eq(&session.shared, &ao_shared) {
                                        return;
                                    }
                                    if paused {
                                        set_runtime_core_state(
                                            runtime,
                                            PlaybackCoreState::Buffering,
                                            if reason == "underrun" {
                                                "ao-underrun"
                                            } else {
                                                "ao-preroll"
                                            },
                                        );
                                    } else if runtime.state.playing && !runtime.state.paused {
                                        set_runtime_core_state(
                                            runtime,
                                            PlaybackCoreState::Playing,
                                            "ao-resume",
                                        );
                                    }
                                }),
                            );
                        }
                        PlaybackSignal::PacketCacheStats(stats) => {
                            emit_shared_event(
                                &signal_shared,
                                PlayerEvent::packet_cache_stats(stats),
                            );
                        }
                        PlaybackSignal::OutputStats(stats) => {
                            emit_shared_event(&signal_shared, PlayerEvent::output_stats(stats));
                            let output_shared = signal_shared.clone();
                            dispatch_core_command(
                                "audio-output-stats",
                                Box::new(move |runtime| {
                                    let Some(session) = runtime.session.as_ref() else {
                                        return;
                                    };
                                    if Arc::ptr_eq(&session.shared, &output_shared) {
                                        update_runtime_audio_graph(runtime);
                                    }
                                }),
                            );
                        }
                        PlaybackSignal::TrackSwitch(info) => {
                            apply_track_switch(info, signal_shared.clone());
                        }
                        PlaybackSignal::PlaybackEnd => {
                            if !restart_loop_if_enabled(signal_shared.clone()) {
                                mark_playback_idle_after_end(signal_shared.clone());
                            }
                        }
                        PlaybackSignal::Stop => break,
                    }
                }
                signal_shared.refresh_output_stats();
                if signal_shared.stop.load(Ordering::Acquire) {
                    break;
                }
                let current_samples = signal_shared.played_sample_count();
                let current_track_seq = signal_shared.current_track_seq();
                let now = Instant::now();
                if current_track_seq != last_clock_track_seq || current_samples < last_clock_samples
                {
                    last_clock_samples = current_samples;
                    last_clock_track_seq = current_track_seq;
                    last_clock_at = now;
                } else if current_samples != last_clock_samples
                    && now.duration_since(last_clock_at) >= tick
                {
                    emit_shared_event(
                        &signal_shared,
                        PlayerEvent::time_update(signal_shared.position_secs()),
                    );
                    last_clock_samples = current_samples;
                    last_clock_at = now;
                }
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
                    emit_shared_event(
                        &signal_shared,
                        PlayerEvent::stalled(signal_shared.position_secs()),
                    );
                }
            }
            let _ = (signal_url, signal_seq);
        })
        .map_err(|err| format!("failed to spawn signal thread: {err}"))?;

    let output_thread = output::spawn_output_backend(
        config.audio_device.clone(),
        config.exclusive_output,
        shared.clone(),
        emit_event,
        None,
    );
    let filter_thread = filter::spawn_filter_thread(shared.clone());
    let decode_generation = shared.current_decode_generation();
    let (decode_thread, decode_commands) =
        decoder::spawn_decode_worker(decoder, shared.clone(), decode_generation);
    Ok(PreparedSource {
        session: PlaybackSession {
            shared,
            output_thread: Some(output_thread),
            filter_thread: Some(filter_thread),
            decode_thread: Some(decode_thread),
            decode_commands: Some(decode_commands),
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
    let PreparedSource {
        session,
        url,
        audio_stream_ordinal,
        seq,
        duration,
        start_position,
        autostart,
    } = prepared;
    runtime.cancel_idle_output_release();
    runtime.cancel_pending_gapless_prepare();
    runtime.prepared_next = None;
    runtime.seek_restore_paused = None;
    set_current_shared(Some(session.shared.clone()));
    if let Some(previous) = runtime.session.replace(session) {
        previous.stop_background();
    }
    runtime.current_url = Some(url.clone());
    runtime.current_audio_stream_ordinal = audio_stream_ordinal;
    runtime.current_seq = seq;
    runtime.latest_load_seq = runtime.latest_load_seq.max(seq);
    runtime.state.duration = duration;
    runtime.state.time_pos = start_position;
    runtime.state.playing = autostart;
    runtime.state.paused = !autostart;
    update_runtime_audio_graph(runtime);
    set_runtime_core_state(
        runtime,
        if autostart {
            PlaybackCoreState::Playing
        } else {
            PlaybackCoreState::Paused
        },
        "source-applied",
    );

    emit_runtime_events(runtime, {
        let mut events = vec![
            PlayerEvent::duration_change(duration),
            PlayerEvent::file_loaded(url, seq),
            PlayerEvent::state_change(runtime.state.clone()),
        ];
        if autostart {
            events.push(PlayerEvent::playback_restart(start_position, "load"));
        }
        events
    });
    if !autostart {
        schedule_idle_output_release_for_runtime(runtime);
    }
}

fn apply_track_switch(info: TrackSwitchInfo, shared: Arc<SharedAudio>) {
    dispatch_core_command(
        "track-switch",
        Box::new(move |runtime| {
            let Some(session) = runtime.session.as_ref() else {
                return;
            };
            if !Arc::ptr_eq(&session.shared, &shared) {
                return;
            }
            runtime.cancel_idle_output_release();
            runtime.current_url = Some(info.url.clone());
            runtime.current_audio_stream_ordinal = info.audio_stream_ordinal;
            runtime.current_seq = info.seq;
            runtime.latest_load_seq = runtime.latest_load_seq.max(info.seq);
            runtime.state.duration = info.duration;
            runtime.state.time_pos = 0.0;
            runtime.state.playing = true;
            runtime.state.paused = false;
            set_runtime_core_state(runtime, PlaybackCoreState::Playing, "gapless-track-switch");
            emit_runtime_events(
                runtime,
                vec![
                    PlayerEvent::duration_change(info.duration),
                    PlayerEvent::file_loaded(info.url, info.seq),
                    PlayerEvent::state_change(runtime.state.clone()),
                    PlayerEvent::playback_restart(0.0, "gapless-track-switch"),
                    PlayerEvent::time_update(0.0),
                ],
            );
        }),
    );
}

fn replace_source_async(
    url: String,
    audio_stream_ordinal: Option<usize>,
    seq: u64,
    start_position: f64,
    autostart: bool,
    config: PlayerConfig,
    dsp_settings: DspSettings,
    spatial_file_path: Option<String>,
    pause_on_device_disconnect: bool,
) -> napi::Result<()> {
    let prepared = prepare_source(
        url,
        audio_stream_ordinal,
        seq,
        start_position,
        autostart,
        config,
        dsp_settings,
        spatial_file_path,
        pause_on_device_disconnect,
    )
    .map_err(napi::Error::from_reason)?;
    with_runtime(|runtime| {
        apply_prepared_source(runtime, prepared);
        Ok(())
    })
}

fn update_runtime_audio_graph(runtime: &mut PlayerRuntime) {
    let previous = runtime.audio_graph.clone();
    let mut next = if let Some(session) = runtime.session.as_ref() {
        let output_stats = session.shared.output_stats();
        audio_graph::snapshot_filter_graph_with_device_output(
            session.shared.mix_format,
            &runtime.dsp_settings,
            output_stats.as_ref(),
        )
    } else {
        AudioGraphSnapshot::default()
    };
    next.revision = previous.revision;
    if next != previous {
        runtime.audio_graph_revision = runtime.audio_graph_revision.wrapping_add(1);
        next.revision = runtime.audio_graph_revision as f64;
        runtime.audio_graph = next;
        emit_runtime_event(
            runtime,
            PlayerEvent::audio_graph_change(runtime.audio_graph.clone()),
        );
    }
}

pub(crate) fn activate_gapless_next_decoder(
    shared: Arc<SharedAudio>,
    generation: u64,
) -> GaplessDecodeResult {
    if !shared.is_decode_generation_current(generation) {
        return GaplessDecodeResult::NotPrepared;
    }
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

    emit_shared_event(
        &shared,
        PlayerEvent::log(
            "info",
            format!(
                "gapless activating prepared next source: url='{}'",
                next.url
            ),
        ),
    );
    shared.set_source_sample_format(next.decoder.source_sample_format());
    shared.set_preferred_output_sample_format(next.preferred_output_sample_format);
    // Apply the target track's loudness before any predecoded samples cross the
    // boundary; waiting for the renderer restart event is too late.
    shared.set_normalization_gain_db(next.normalization_gain_db);
    shared.mark_gapless_boundary(TrackSwitchInfo {
        url: next.url,
        audio_stream_ordinal: next.audio_stream_ordinal,
        seq: next.seq,
        duration: next.duration,
    });
    for chunk in next.predecoded {
        if !shared.push_decoded_chunk_for_generation(chunk, generation) {
            return GaplessDecodeResult::Activated(None);
        }
    }
    GaplessDecodeResult::Activated(Some(next.decoder))
}

fn restart_loop_if_enabled(shared: Arc<SharedAudio>) -> bool {
    let plan = call_core_command("loop-restart-plan", move |runtime| {
        if !runtime.loop_file {
            return Ok(None);
        }
        let Some(session) = runtime.session.as_mut() else {
            return Ok(None);
        };
        if !Arc::ptr_eq(&session.shared, &shared) {
            return Ok(None);
        }
        let Some(url) = runtime.current_url.clone() else {
            return Ok(None);
        };
        shared.paused.store(true, Ordering::Release);
        shared.request_decode_stop();
        runtime.prepared_next = None;
        session.stop_decode_background("loop-restart");
        let generation = shared.reset_for_decode_resume(0.0, &runtime.dsp_settings);
        let eq_active = runtime
            .dsp_settings
            .equalizer
            .iter()
            .any(|gain| gain.abs() >= 0.01);
        let spatial = runtime.dsp_settings.spatial.as_ref();
        let vpf = runtime.dsp_settings.vpf.as_ref();
        emit_runtime_event(runtime, PlayerEvent::log(
            "info",
            format!(
                "loop restart reusing audio filter chain: speed={:.2}x, normalization_gain_db={:.2} dB, eq_active={}, spatial_enabled={}, vpf_enabled={}",
                runtime.dsp_settings.speed,
                runtime.dsp_settings.normalization_gain_db,
                eq_active,
                spatial.is_some(),
                vpf.is_some()
            ),
        ));
        runtime.state.time_pos = 0.0;
        Ok(Some(SeekPlan {
            shared,
            was_paused: false,
            url,
            audio_stream_ordinal: runtime.current_audio_stream_ordinal,
            generation,
            request_seq: 0,
            config: runtime.config.clone(),
            interrupt: None,
            decode_commands: None,
        }))
    })
    .ok()
    .flatten();

    let Some(plan) = plan else {
        return false;
    };

    let _ = thread::Builder::new()
        .name("player-loop-restart".to_string())
        .spawn(move || {
            let result = open_decoder_at_position(&plan, 0.0)
                .and_then(|decoder| attach_restarted_decoder(&plan, decoder, 0.0, false));
            if let Err(err) = result {
                let _ = mark_seek_plan_failed(&plan);
                emit_event(
                    PlayerEvent::error(
                        events::PlayerErrorCode::Decode,
                        format!("failed to restart loop playback: {err}"),
                    )
                    .with_playback_context(plan.shared.current_track_seq(), plan.generation),
                );
            }
        });
    true
}

#[napi]
pub fn initialize(config: Option<PlayerConfigOptions>) -> napi::Result<()> {
    shutdown_runtime(false)?;
    reset_event_ids();
    start_event_dispatcher()?;
    let mut runtime = PlayerRuntime::new(PlayerConfig::from_options(config));
    runtime.device_watcher = device::DeviceWatcher::start(
        emit_event,
        handle_playback_output_device_event,
        handle_output_device_list_change,
    )
    .unwrap_or(None);
    {
        let mut guard = RUNTIME.lock().map_err(|err| {
            napi::Error::from_reason(format!("failed to lock player runtime: {err}"))
        })?;
        *guard = Some(runtime);
        // Publish readiness while still holding the RUNTIME guard so it cannot
        // interleave with a concurrent shutdown_runtime: shutdown writes false
        // under the same guard before taking the runtime, so ready==true always
        // implies RUNTIME is populated.
        RUNTIME_READY.store(true, Ordering::Release);
    }
    start_core_dispatcher()?;
    Ok(())
}

#[napi]
pub fn destroy() -> napi::Result<()> {
    shutdown_runtime(true)
}

fn shutdown_runtime(clear_callback: bool) -> napi::Result<()> {
    // Early best-effort flip so lock-free control paths (set_volume from an
    // in-flight fade) start failing as soon as possible. The authoritative
    // write happens below under the RUNTIME guard.
    RUNTIME_READY.store(false, Ordering::Release);
    invalidate_seek_requests();
    if clear_callback {
        clear_event_callback();
    }
    stop_core_dispatcher();
    let runtime = {
        let mut guard = RUNTIME.lock().map_err(|err| {
            napi::Error::from_reason(format!("failed to lock player runtime: {err}"))
        })?;
        // Authoritative write under the same guard initialize() uses, so a
        // concurrent initialize cannot leave ready==true with RUNTIME=None.
        RUNTIME_READY.store(false, Ordering::Release);
        guard.take()
    };
    if let Some(mut runtime) = runtime {
        runtime.stop_session();
    }
    // stop_session already clears this, but clear again in case shutdown raced a
    // runtime that was never fully initialized.
    set_current_shared(None);
    stop_event_dispatcher();
    Ok(())
}

#[napi]
pub fn register_event_handler(callback: ThreadsafeFunction<PlayerEvent>) -> napi::Result<()> {
    start_event_dispatcher()?;
    set_event_callback(callback)
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
            runtime.cancel_idle_output_release();
            runtime.cancel_pending_seek_restart();
            runtime.cancel_pending_gapless_prepare();
            runtime.seek_restore_paused = None;
            runtime.prepared_next = None;
            runtime.latest_load_seq = seq;
            set_runtime_core_state(runtime, PlaybackCoreState::Loading, "load");
            if runtime.session.is_some() && runtime.config.gapless_audio == GaplessAudioPolicy::No {
                runtime.stop_session();
                return Ok(LoadPlan::Initial {
                    config: runtime.config.clone(),
                    dsp_settings: runtime.dsp_settings.clone(),
                    spatial_file_path: runtime.spatial_file_path.clone(),
                    pause_on_device_disconnect: runtime.pause_on_device_disconnect,
                });
            }
            let Some(session) = runtime.session.as_mut() else {
                return Ok(LoadPlan::Initial {
                    config: runtime.config.clone(),
                    dsp_settings: runtime.dsp_settings.clone(),
                    spatial_file_path: runtime.spatial_file_path.clone(),
                    pause_on_device_disconnect: runtime.pause_on_device_disconnect,
                });
            };
            let shared = session.shared.clone();
            shared.paused.store(true, Ordering::Release);
            shared.request_decode_stop();
            session.stop_decode_background("load-replace");
            Ok(LoadPlan::Continuous(ContinuousLoadPlan {
                shared,
                request_seq: seq,
                config: runtime.config.clone(),
                dsp_settings: runtime.dsp_settings.clone(),
                spatial_file_path: runtime.spatial_file_path.clone(),
            }))
        })?;

        match plan {
            LoadPlan::Initial {
                config,
                dsp_settings,
                spatial_file_path,
                pause_on_device_disconnect,
            } => replace_source_async(
                url,
                audio_stream,
                seq,
                0.0,
                false,
                config,
                dsp_settings,
                spatial_file_path,
                pause_on_device_disconnect,
            ),
            LoadPlan::Continuous(plan) => {
                let new_decoder = open_decoder(
                    url.clone(),
                    audio_stream,
                    Some(plan.shared.mix_format.sample_rate),
                    plan.config.packet_cache_options_for_url(&url),
                    &plan.config.stream_options(),
                );
                match new_decoder {
                    Ok(decoder) => {
                        let duration = decoder.duration_secs();
                        let source_sample_format = decoder.source_sample_format();
                        let preferred_output_sample_format = plan
                            .config
                            .resolve_output_sample_format(source_sample_format);
                        let dsp_settings = prepare_dsp_settings_for_mix_rate(
                            plan.dsp_settings,
                            plan.spatial_file_path.as_deref(),
                            plan.shared.mix_format.sample_rate,
                        )
                        .map_err(napi::Error::from_reason)?;
                        with_runtime(|runtime| {
                            let Some(session) = runtime.session.as_mut() else {
                                return Ok(());
                            };
                            if !Arc::ptr_eq(&session.shared, &plan.shared)
                                || runtime.latest_load_seq != plan.request_seq
                            {
                                return Ok(());
                            }
                            let generation =
                                session.shared.reset_for_decode_resume(0.0, &dsp_settings);
                            session
                                .shared
                                .set_source_sample_format(source_sample_format);
                            session
                                .shared
                                .set_preferred_output_sample_format(preferred_output_sample_format);
                            session.shared.bind_interrupt(decoder.interrupt_handle());
                            session.shared.set_track_seq(seq);
                            let (decode_thread, decode_commands) = decoder::spawn_decode_worker(
                                decoder,
                                session.shared.clone(),
                                generation,
                            );
                            session.decode_thread = Some(decode_thread);
                            session.decode_commands = Some(decode_commands);
                            session.shared.paused.store(true, Ordering::Release);
                            runtime.current_url = Some(url.clone());
                            runtime.current_audio_stream_ordinal = audio_stream;
                            runtime.current_seq = seq;
                            runtime.state.duration = duration;
                            runtime.state.time_pos = 0.0;
                            runtime.state.playing = false;
                            runtime.state.paused = true;
                            update_runtime_audio_graph(runtime);
                            set_runtime_core_state(
                                runtime,
                                PlaybackCoreState::Paused,
                                "load-complete",
                            );
                            emit_runtime_events(
                                runtime,
                                vec![
                                    PlayerEvent::duration_change(duration),
                                    PlayerEvent::file_loaded(url.clone(), seq),
                                    PlayerEvent::state_change(runtime.state.clone()),
                                ],
                            );
                            schedule_idle_output_release_for_runtime(runtime);
                            Ok(())
                        })
                    }
                    Err(err) => {
                        with_runtime(|runtime| {
                            let matches_current_plan = runtime
                                .session
                                .as_ref()
                                .is_some_and(|session| Arc::ptr_eq(&session.shared, &plan.shared));
                            if !matches_current_plan || runtime.latest_load_seq != plan.request_seq
                            {
                                return Ok(());
                            }

                            if let Some(session) = runtime.session.take() {
                                set_current_shared(None);
                                session.shared.paused.store(true, Ordering::Release);
                                session.shared.mark_decode_failed();
                                session.shared.set_track_seq(plan.request_seq);
                                session.stop_background();
                            }
                            runtime.current_url = Some(url.clone());
                            runtime.current_audio_stream_ordinal = audio_stream;
                            runtime.current_seq = plan.request_seq;
                            runtime.latest_load_seq = runtime.latest_load_seq.max(plan.request_seq);
                            runtime.state.duration = 0.0;
                            runtime.state.time_pos = 0.0;
                            runtime.state.playing = false;
                            runtime.state.paused = true;
                            set_runtime_core_state(runtime, PlaybackCoreState::Error, "load-error");
                            emit_runtime_event(
                                runtime,
                                PlayerEvent::state_change(runtime.state.clone()),
                            );
                            emit_runtime_events(
                                runtime,
                                vec![
                                    PlayerEvent::duration_change(0.0),
                                    PlayerEvent::time_update(0.0),
                                ],
                            );
                            Ok(())
                        })?;
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
    invalidate_seek_requests();
    AsyncTask::new(LoadFileTask {
        url,
        seq: seq.unwrap_or(0.0).max(0.0) as u64,
        audio_stream_ordinal: None,
    })
}

#[napi]
pub fn load_mkv_track(url: String, track_id: i64, seq: Option<f64>) -> AsyncTask<LoadFileTask> {
    invalidate_seek_requests();
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
    pending_prepare: Option<(Arc<SharedAudio>, u64)>,
    interrupt: Arc<AtomicBool>,
    normalization_gain_db: f32,
}

struct GaplessPrepareGuard {
    shared: Arc<SharedAudio>,
    epoch: u64,
}

impl Drop for GaplessPrepareGuard {
    fn drop(&mut self) {
        self.shared.finish_gapless_prepare(self.epoch);
    }
}

impl Drop for PrepareNextSourceTask {
    fn drop(&mut self) {
        if let Some((shared, epoch)) = self.pending_prepare.take() {
            shared.finish_gapless_prepare(epoch);
        }
    }
}

impl Task for PrepareNextSourceTask {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let Some((pending_shared, request_id)) = self.pending_prepare.take() else {
            return Ok(false);
        };
        let _pending = GaplessPrepareGuard {
            shared: pending_shared.clone(),
            epoch: request_id,
        };
        if !pending_shared.gapless_prepare_request_is_current(request_id) {
            return Ok(false);
        }
        let (sample_rate, current_seq, shared, config) = with_runtime(|runtime| {
            let Some(session) = runtime.session.as_ref() else {
                return Ok(None);
            };
            Ok(Some((
                session.shared.mix_format.sample_rate,
                runtime.current_seq,
                session.shared.clone(),
                runtime.config.clone(),
            )))
        })?
        .ok_or_else(|| napi::Error::from_reason("no active audio session".to_string()))?;

        if config.gapless_audio == GaplessAudioPolicy::No {
            return Ok(false);
        }

        let mut decoder = open_decoder_with_interrupt(
            self.url.clone(),
            self.audio_stream_ordinal,
            Some(sample_rate),
            self.interrupt.clone(),
            config.packet_cache_options_for_url(&self.url),
            &config.stream_options(),
        )
        .map_err(napi::Error::from_reason)?;
        let duration = decoder.duration_secs();
        let preferred_output_sample_format =
            config.resolve_output_sample_format(decoder.source_sample_format());
        let predecoded =
            predecode_gapless_head(&mut decoder, sample_rate).map_err(napi::Error::from_reason)?;
        let mut prepared = Some(PreparedNextSource {
            decoder,
            predecoded,
            url: self.url.clone(),
            audio_stream_ordinal: self.audio_stream_ordinal,
            seq: self.seq,
            duration,
            preferred_output_sample_format,
            normalization_gain_db: self.normalization_gain_db,
        });

        with_runtime(|runtime| {
            let Some(session) = runtime.session.as_ref() else {
                return Ok(false);
            };
            if !Arc::ptr_eq(&session.shared, &shared)
                || runtime.current_seq != current_seq
                || !session
                    .shared
                    .gapless_prepare_request_is_current(request_id)
            {
                return Ok(false);
            }
            runtime.prepared_next = prepared.take();
            runtime.gapless_prepare_interrupt = None;
            emit_runtime_event(
                runtime,
                PlayerEvent::log(
                    "info",
                    format!(
                        "gapless prepared next source: url='{}', predecoded_chunks={}",
                        self.url,
                        runtime
                            .prepared_next
                            .as_ref()
                            .map(|next| next.predecoded.len())
                            .unwrap_or_default()
                    ),
                ),
            );
            Ok(true)
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

fn predecode_gapless_head(
    decoder: &mut decoder::DecoderData,
    mix_sample_rate: u32,
) -> Result<Vec<shared::DecodedAudioChunk>, String> {
    let target_frames = ((mix_sample_rate.max(1) as f64) * GAPLESS_PREDECODE_SECS) as usize;
    let mut frames = 0usize;
    let mut chunks = Vec::new();
    while frames < target_frames {
        let Some(chunk) = decoder.decode_next_chunk()? else {
            break;
        };
        frames = frames.saturating_add(chunk.estimated_mix_frames(mix_sample_rate));
        chunks.push(chunk);
    }
    Ok(chunks)
}

#[napi]
pub fn begin_next_source_preparation() -> napi::Result<f64> {
    with_runtime(|runtime| {
        runtime.cancel_pending_gapless_prepare();
        runtime.prepared_next = None;
        let Some(session) = runtime.session.as_ref() else {
            return Ok(0.0);
        };
        Ok(session.shared.begin_gapless_prepare() as f64)
    })
}

#[napi]
pub fn cancel_next_source_preparation(request_id: f64) -> napi::Result<bool> {
    let request_id = request_id.max(0.0) as u64;
    with_runtime(|runtime| {
        if runtime
            .gapless_prepare_interrupt
            .as_ref()
            .is_some_and(|(epoch, _)| *epoch == request_id)
        {
            if let Some((_, interrupt)) = runtime.gapless_prepare_interrupt.take() {
                interrupt.store(true, Ordering::Release);
            }
        }
        let Some(session) = runtime.session.as_ref() else {
            return Ok(false);
        };
        let cancelled = session.shared.cancel_gapless_prepare(request_id);
        if cancelled {
            runtime.prepared_next = None;
        }
        Ok(cancelled)
    })
}

#[napi]
pub fn prepare_next_source(
    url: String,
    track_id: Option<i64>,
    seq: Option<f64>,
    request_id: f64,
    normalization_gain_db: Option<f64>,
) -> AsyncTask<PrepareNextSourceTask> {
    let request_id = request_id.max(0.0) as u64;
    let interrupt = Arc::new(AtomicBool::new(false));
    let pending_prepare = with_runtime(|runtime| {
        let pending = runtime
            .session
            .as_ref()
            .filter(|session| {
                session
                    .shared
                    .gapless_prepare_request_is_current(request_id)
            })
            .map(|session| (session.shared.clone(), request_id));
        if pending.is_some() {
            runtime.gapless_prepare_interrupt = Some((request_id, interrupt.clone()));
        }
        Ok(pending)
    })
    .ok()
    .flatten();
    AsyncTask::new(PrepareNextSourceTask {
        url,
        seq: seq.unwrap_or(0.0).max(0.0) as u64,
        audio_stream_ordinal: track_id.and_then(audio_stream_ordinal_from_track_id),
        pending_prepare,
        interrupt,
        normalization_gain_db: normalization_gain_db.unwrap_or(0.0) as f32,
    })
}

#[napi]
pub fn clear_prepared_next_source() -> napi::Result<()> {
    with_runtime(|runtime| {
        runtime.cancel_pending_gapless_prepare();
        runtime.prepared_next = None;
        Ok(())
    })
}

pub struct GetTrackListTask {
    url: Option<String>,
    config: PlayerConfig,
}

impl Task for GetTrackListTask {
    type Output = Vec<TrackInfo>;
    type JsValue = Vec<TrackInfo>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let stream_options = self.config.stream_options();
        Ok(self
            .url
            .as_deref()
            .map(|url| list_tracks_for_url(url, &stream_options))
            .unwrap_or_default())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn get_track_list(url: Option<String>) -> AsyncTask<GetTrackListTask> {
    let (url, config) = RUNTIME
        .lock()
        .ok()
        .and_then(|runtime| {
            runtime.as_ref().map(|runtime| {
                (
                    url.clone().or_else(|| runtime.current_url.clone()),
                    runtime.config.clone(),
                )
            })
        })
        .unwrap_or_else(|| (url, PlayerConfig::default()));
    AsyncTask::new(GetTrackListTask { url, config })
}

pub struct PlayTask;

impl Task for PlayTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        call_core_command_blocking("play", |runtime| {
            runtime.cancel_idle_output_release();
            let Some(session) = runtime.session.as_ref() else {
                return Err(napi::Error::from_reason(
                    "no audio source loaded".to_string(),
                ));
            };
            let output_needs_restart = session
                .output_thread
                .as_ref()
                .is_none_or(output::AudioOutputHandle::has_exited)
                || !session.shared.output_has_started();
            if output_needs_restart {
                let config = runtime.config.clone();
                restart_output_for_runtime(runtime, config, false)?;
                runtime.cancel_idle_output_release();
            }
            let Some(session) = runtime.session.as_ref() else {
                return Err(napi::Error::from_reason(
                    "audio session ended while resuming output".to_string(),
                ));
            };
            session.shared.paused.store(false, Ordering::Release);
            runtime.state.playing = true;
            runtime.state.paused = false;
            set_runtime_core_state(runtime, PlaybackCoreState::Playing, "play");
            emit_runtime_event(runtime, PlayerEvent::state_change(runtime.state.clone()));
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
    call_core_command("pause", |runtime| {
        if let Some(session) = runtime.session.as_ref() {
            session.shared.paused.store(true, Ordering::Release);
        }
        runtime.state.playing = false;
        runtime.state.paused = true;
        set_runtime_core_state(runtime, PlaybackCoreState::Paused, "pause");
        emit_runtime_event(runtime, PlayerEvent::state_change(runtime.state.clone()));
        schedule_idle_output_release_for_runtime(runtime);
        Ok(())
    })
}

#[napi]
pub fn stop() -> napi::Result<()> {
    invalidate_seek_requests();
    with_runtime(|runtime| {
        runtime.stop_session();
        runtime.state.time_pos = 0.0;
        update_runtime_audio_graph(runtime);
        set_runtime_core_state(runtime, PlaybackCoreState::Idle, "stop");
        emit_runtime_event(runtime, PlayerEvent::state_change(runtime.state.clone()));
        Ok(())
    })
}

#[napi]
pub fn set_volume(volume: f64) -> napi::Result<()> {
    // Hot path for fades: apply straight to the active session's shared state
    // without touching the RUNTIME mutex, which load/seek tasks can hold for
    // long stretches. Volume is not part of PlayerRuntime state, so nothing
    // else needs the big lock. The readiness flag preserves with_runtime's
    // "player addon not initialized" contract for uninitialized/destroyed
    // runtimes; an initialized runtime without a session stays a silent no-op.
    if !RUNTIME_READY.load(Ordering::Acquire) {
        return Err(napi::Error::from_reason(
            "player addon not initialized".to_string(),
        ));
    }
    let normalized = (volume / 100.0).clamp(0.0, 1.5) as f32;
    cancel_runtime_fade();
    USER_VOLUME_BITS.store(normalized.to_bits(), Ordering::Release);
    set_session_volume(volume)
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

#[napi]
pub fn set_loop_file(loop_file: bool) -> napi::Result<()> {
    with_runtime(|runtime| {
        runtime.loop_file = loop_file;
        Ok(())
    })
}
