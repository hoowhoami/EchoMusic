mod audio_graph;
mod config;
mod control;
mod decoder;
mod device;
mod dispatcher;
mod dsp;
mod events;
mod exclusive;
mod filter;
mod output;
mod shared;
mod spectrum;
mod stream;
mod tempo;

use control::{
    attach_restarted_decoder, handle_output_device_list_change,
    handle_playback_output_device_event, mark_seek_plan_failed, open_decoder_at_position,
    prepare_dsp_settings_for_mix_rate, request_output_recovery, restart_output_for_runtime,
    schedule_idle_output_release_for_runtime, SeekPlan,
};
pub use control::{
    cancel_fade, configure_spectrum, fade, get_audio_devices, get_audio_graph,
    get_spectrum_snapshot, get_spectrum_status, inspect_dsp_provider, pause_with_fade,
    play_with_fade, set_audio_effect, set_audio_graph_parameter, set_audio_graph_plan,
    set_audio_output, set_equalizer, set_http_proxy, set_network_timeout, set_normalization_gain,
    set_pause_on_device_disconnect, set_speed, set_stall_timeout, GetAudioDevicesTask,
    GetSpectrumSnapshotTask, SetAudioEffectTask, SetAudioGraphParameterTask, SetAudioGraphPlanTask,
    SetAudioOutputTask, SetEqualizerTask, SetNormalizationGainTask, SetSpeedTask,
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
    start_event_dispatcher, stop_core_dispatcher, stop_event_dispatcher, EventCallback,
};
use crate::dsp::{prepare_spatial_effect, DspSettings, EQ_BAND_COUNT};
use crate::events::{
    AudioDevice, PlayerEvent, PlayerState, SpectrumFrame, SpectrumOptions, SpectrumStatus,
    TrackInfo,
};
use crate::shared::{MixFormat, PlaybackSession, PlaybackSignal, SharedAudio, TrackSwitchInfo};
use audio_graph::AudioGraphSnapshot;
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

const GAPLESS_PREDECODE_SECS: f64 = 0.5;
const SOURCE_SWITCH_BASE_LEAD_SECS: f64 = 1.0;
const SOURCE_SWITCH_MIN_READY_SECS: f64 = 0.35;
const SOURCE_SWITCH_MAX_LEAD_SECS: f64 = 8.0;
const SOURCE_SWITCH_PREDECODE_SECS: f64 = 0.5;
const CONTROL_SIGNAL_WAKE_CAPACITY: usize = 1;

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
static NEXT_SOURCE_OPEN_REQUEST_SEQ: AtomicU64 = AtomicU64::new(0);
static LATEST_SOURCE_OPEN_REQUEST_SEQ: AtomicU64 = AtomicU64::new(0);
static FADE_GENERATION: AtomicU64 = AtomicU64::new(0);
type RuntimeCommand = Box<dyn FnOnce(&mut PlayerRuntime) + Send + 'static>;

pub(crate) fn runtime_guard() -> MutexGuard<'static, Option<PlayerRuntime>> {
    RUNTIME
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

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
    if !volume.is_finite() {
        return Err(napi::Error::from_reason(
            "volume must be finite".to_string(),
        ));
    }
    let normalized = (volume / 100.0).clamp(0.0, 1.5) as f32;
    if let Some(shared) = current_shared() {
        shared.set_volume(normalized);
    }
    Ok(())
}

fn cancel_runtime_fade() {
    FADE_GENERATION.fetch_add(1, Ordering::AcqRel);
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
    spectrum_analyzer: spectrum::SpectrumAnalyzer,
    device_watcher: Option<device::DeviceWatcher>,
    loop_file: bool,
    audio_graph: AudioGraphSnapshot,
    audio_graph_revision: u64,
    spectrum_signal_logged: bool,
    spatial_request_seq: u64,
    idle_output_release_seq: u64,
    spatial_file_path: Option<String>,
    prepared_next: Option<PreparedNextSource>,
    gapless_prepare_interrupt: Option<(u64, Arc<AtomicBool>)>,
    source_open_interrupt: Option<(u64, Arc<AtomicBool>)>,
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

fn retire_prepared_next_background(prepared: Option<PreparedNextSource>, reason: &'static str) {
    retire_value_background(prepared, format!("player-prepared-next-reaper-{reason}"));
}

fn retire_value_background<T: Send + 'static>(value: Option<T>, name: String) {
    let Some(value) = value else {
        return;
    };
    let pending = Arc::new(Mutex::new(Some(value)));
    let worker_pending = pending.clone();
    let spawned = thread::Builder::new().name(name).spawn(move || {
        let value = worker_pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        drop(value);
    });
    if spawned.is_err() {
        let value = pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        drop(value);
    }
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
            spectrum_analyzer: spectrum::SpectrumAnalyzer::new(spectrum_config.clone()),
            spectrum_config,
            device_watcher: None,
            loop_file: false,
            audio_graph: AudioGraphSnapshot::default(),
            audio_graph_revision: 0,
            spectrum_signal_logged: false,
            spatial_request_seq: 0,
            idle_output_release_seq: 0,
            spatial_file_path: None,
            prepared_next: None,
            gapless_prepare_interrupt: None,
            source_open_interrupt: None,
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
        self.cancel_pending_source_open();
        self.seek_restore_paused = None;
        retire_prepared_next_background(self.prepared_next.take(), "stop-session");
        if let Some(session) = self.session.take() {
            set_current_shared(None);
            session.stop_background();
        }
        self.state.playing = false;
        self.state.paused = true;
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

    fn begin_source_open(&mut self, request_seq: u64, interrupt: Arc<AtomicBool>) {
        self.cancel_pending_source_open();
        self.source_open_interrupt = Some((request_seq, interrupt));
    }

    fn cancel_pending_source_open(&mut self) {
        if let Some((_, interrupt)) = self.source_open_interrupt.take() {
            interrupt.store(true, Ordering::Release);
        }
    }

    fn source_open_is_current(&self, request_seq: u64, interrupt: &Arc<AtomicBool>) -> bool {
        is_latest_source_open_request_seq(request_seq)
            && self.source_open_interrupt.as_ref().is_some_and(
                |(current_seq, current_interrupt)| {
                    *current_seq == request_seq && Arc::ptr_eq(current_interrupt, interrupt)
                },
            )
    }

    fn clear_source_open_if_current(
        &mut self,
        request_seq: u64,
        interrupt: &Arc<AtomicBool>,
    ) -> bool {
        if !self.source_open_is_current(request_seq, interrupt) {
            return false;
        }
        self.source_open_interrupt = None;
        true
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

    fn update_seek_restore_paused(&mut self, paused: bool) {
        if self.seek_restore_paused.is_some() {
            self.seek_restore_paused = Some(paused);
        }
    }

    fn take_seek_restore_paused(&mut self, request_seq: u64, fallback: bool) -> bool {
        if self.is_seek_request_current(request_seq) {
            self.seek_restore_paused.take().unwrap_or(fallback)
        } else {
            fallback
        }
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

fn next_source_open_request_seq() -> u64 {
    let seq = NEXT_SOURCE_OPEN_REQUEST_SEQ
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1)
        .max(1);
    LATEST_SOURCE_OPEN_REQUEST_SEQ.store(seq, Ordering::Release);
    seq
}

fn invalidate_source_open_requests() {
    let _ = next_source_open_request_seq();
}

fn is_latest_source_open_request_seq(seq: u64) -> bool {
    LATEST_SOURCE_OPEN_REQUEST_SEQ.load(Ordering::Acquire) == seq
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

fn contextualize_runtime_event(runtime: &PlayerRuntime, mut event: PlayerEvent) -> PlayerEvent {
    // Periodic audio ticks advance SharedAudio, not runtime.state.time_pos.
    // State changes (pause/resume/output restart) must not send an old position
    // back into the desktop lyric and mini-player clocks.
    if let (Some(state), Some(session)) = (event.state.as_mut(), runtime.session.as_ref()) {
        if session.shared.current_track_seq() == runtime.current_seq {
            state.time_pos = session.shared.position_secs();
        }
    }
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
    match state {
        PlaybackCoreState::Playing => runtime.update_seek_restore_paused(false),
        PlaybackCoreState::Idle
        | PlaybackCoreState::Paused
        | PlaybackCoreState::Draining
        | PlaybackCoreState::Error
        | PlaybackCoreState::DeviceLost => runtime.update_seek_restore_paused(true),
        PlaybackCoreState::Loading
        | PlaybackCoreState::Buffering
        | PlaybackCoreState::Seeking
        | PlaybackCoreState::OutputReconfig => {}
    }
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
    let mut guard = runtime_guard();
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
    interrupt: Arc<AtomicBool>,
) -> Result<PreparedSource, String> {
    let mut decoder = open_decoder_with_interrupt(
        url.clone(),
        audio_stream_ordinal,
        None,
        interrupt.clone(),
        config.packet_cache_options_for_url(&url),
        &config.stream_options(),
    )?;
    if interrupt.load(Ordering::Acquire) {
        return Err("source open cancelled".to_string());
    }
    if start_position > 0.0 {
        decoder.seek(start_position)?;
    }
    let duration = decoder.duration_secs();
    let source_sample_rate = decoder.mix_sample_rate();
    let output_sample_rate =
        device::preferred_output_sample_rate(&config.audio_device, config.exclusive_output);
    let requested_mix_sample_rate =
        config.resolve_initial_mix_sample_rate(source_sample_rate, output_sample_rate);
    let (mix_format, dsp_settings, initial_filter_graph) = prepare_initial_filter_graph(
        &config,
        dsp_settings,
        spatial_file_path.as_deref(),
        decoder.source_channels(),
        source_sample_rate,
        requested_mix_sample_rate,
    )?;
    if interrupt.load(Ordering::Acquire) {
        return Err("source open cancelled".to_string());
    }
    let mix_sample_rate = mix_format.sample_rate;
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
    if mix_sample_rate != requested_mix_sample_rate {
        emit_event(PlayerEvent::log(
            "warn",
            format!(
                "DSP provider negotiated a compatible engine mix rate: requested_sample_rate={requested_mix_sample_rate}, selected_sample_rate={mix_sample_rate}"
            ),
        ));
    }
    if let Some(spatial) = dsp_settings.spatial.as_ref() {
        emit_event(PlayerEvent::log(
            "info",
            format!(
                "impulse response enabled: path='{}', mix_sample_rate={}, ir_channels={}, mode={}, duration_ms={:.2}, peak_response_db={:.2}, auto_headroom_db={:.2}",
                spatial.file_path,
                mix_sample_rate,
                spatial.channels(),
                spatial.mode(),
                spatial.duration_secs() * 1_000.0,
                spatial.peak_response_db(),
                spatial.output_gain_db(),
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

    let (control_signal_tx, control_signal_rx) = sync_channel::<()>(CONTROL_SIGNAL_WAKE_CAPACITY);
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
                let signal = if let Some(signal) = signal_shared.take_pending_control_signal() {
                    Some(signal)
                } else {
                    match control_signal_rx.recv_timeout(tick) {
                        Ok(()) => signal_shared.take_pending_control_signal(),
                        Err(RecvTimeoutError::Timeout) => match telemetry_signal_rx.try_recv() {
                            Ok(signal) => Some(signal),
                            Err(TryRecvError::Empty | TryRecvError::Disconnected) => None,
                        },
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
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
                        PlaybackSignal::OutputStatsChanged => {
                            if let Some(stats) = signal_shared.output_stats() {
                                emit_shared_event(&signal_shared, PlayerEvent::output_stats(stats));
                            }
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
    let mut session = PlaybackSession {
        shared: shared.clone(),
        output_thread: Some(output_thread),
        filter_thread: None,
        decode_thread: None,
        decode_commands: None,
        position_thread: Some(position_thread),
    };
    let filter_thread =
        match filter::spawn_filter_thread_with_graph(shared.clone(), Some(initial_filter_graph)) {
            Ok(handle) => handle,
            Err(err) => {
                session.stop_background();
                return Err(err);
            }
        };
    session.filter_thread = Some(filter_thread);
    let decode_generation = shared.current_decode_generation();
    let (decode_thread, decode_commands) =
        match decoder::spawn_decode_worker(decoder, shared.clone(), decode_generation) {
            Ok(worker) => worker,
            Err(err) => {
                session.stop_background();
                return Err(err);
            }
        };
    session.decode_thread = Some(decode_thread);
    session.decode_commands = Some(decode_commands);
    Ok(PreparedSource {
        session,
        url,
        audio_stream_ordinal,
        seq,
        duration,
        start_position: start_position.max(0.0),
        autostart,
    })
}

fn prepare_initial_filter_graph(
    config: &PlayerConfig,
    dsp_settings: DspSettings,
    spatial_file_path: Option<&str>,
    source_channels: usize,
    source_sample_rate: u32,
    requested_mix_sample_rate: u32,
) -> Result<(MixFormat, DspSettings, audio_graph::AudioFilterGraph), String> {
    let has_provider = dsp_settings.provider_path.is_some();
    let mut sample_rates = vec![requested_mix_sample_rate.max(1)];
    if has_provider {
        for sample_rate in [source_sample_rate, 48_000, 44_100, 96_000] {
            if sample_rate >= 44_100 && !sample_rates.contains(&sample_rate) {
                sample_rates.push(sample_rate);
            }
        }
    }

    let mut last_error = None;
    for sample_rate in sample_rates {
        let candidate_settings = match prepare_dsp_settings_for_mix_rate(
            dsp_settings.clone(),
            spatial_file_path,
            sample_rate,
        ) {
            Ok(settings) => settings,
            Err(err) => {
                last_error = Some(err);
                continue;
            }
        };
        let channels = config
            .resolve_mix_channels(source_channels, candidate_settings.requires_stereo_graph());
        let mix_format = MixFormat::f32(sample_rate, channels);
        match audio_graph::AudioFilterGraph::new(mix_format, &candidate_settings) {
            Ok(graph)
                if provider_manifest_supports_sample_rate(
                    &graph,
                    candidate_settings.provider_preset_json.as_deref(),
                    sample_rate,
                ) =>
            {
                return Ok((mix_format, candidate_settings, graph));
            }
            Ok(_) => {
                last_error = Some(format!(
                    "DSP provider preset does not support {sample_rate} Hz"
                ));
            }
            Err(err) => {
                last_error = Some(err);
                if !has_provider {
                    break;
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "failed to prepare audio filter graph".to_string()))
}

fn provider_manifest_supports_sample_rate(
    graph: &audio_graph::AudioFilterGraph,
    preset_json: Option<&str>,
    sample_rate: u32,
) -> bool {
    let Some(preset_id) = preset_json
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .and_then(|value| {
            value
                .get("presetId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
    else {
        return true;
    };
    let Some(manifest) = graph.provider_descriptor().and_then(|descriptor| {
        serde_json::from_str::<serde_json::Value>(&descriptor.manifest_json).ok()
    }) else {
        return true;
    };
    let Some(supported_rates) = manifest
        .get("presets")
        .and_then(serde_json::Value::as_array)
        .and_then(|presets| {
            presets.iter().find(|preset| {
                preset.get("id").and_then(serde_json::Value::as_str) == Some(preset_id.as_str())
            })
        })
        .and_then(|preset| preset.get("supportedSampleRates"))
        .and_then(serde_json::Value::as_array)
    else {
        return true;
    };
    supported_rates
        .iter()
        .filter_map(serde_json::Value::as_u64)
        .any(|rate| rate == u64::from(sample_rate))
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
    retire_prepared_next_background(runtime.prepared_next.take(), "apply-source");
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
    open_request_seq: u64,
    interrupt: Arc<AtomicBool>,
) -> napi::Result<()> {
    let failed_url = url.clone();
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
        interrupt.clone(),
    );
    let mut prepared = match prepared {
        Ok(prepared) => Some(prepared),
        Err(err) => {
            let interrupt_for_command = interrupt.clone();
            let current = call_core_command("finish-source-open-error", move |runtime| {
                if !runtime.clear_source_open_if_current(open_request_seq, &interrupt_for_command) {
                    return Ok(false);
                }
                runtime.current_url = Some(failed_url);
                runtime.current_audio_stream_ordinal = audio_stream_ordinal;
                runtime.current_seq = seq;
                runtime.latest_load_seq = runtime.latest_load_seq.max(seq);
                runtime.state.duration = 0.0;
                runtime.state.time_pos = 0.0;
                runtime.state.playing = false;
                runtime.state.paused = true;
                set_runtime_core_state(runtime, PlaybackCoreState::Error, "load-error");
                emit_runtime_events(
                    runtime,
                    vec![
                        PlayerEvent::state_change(runtime.state.clone()),
                        PlayerEvent::duration_change(0.0),
                        PlayerEvent::time_update(0.0),
                    ],
                );
                Ok(true)
            })?;
            return if current {
                Err(napi::Error::from_reason(err))
            } else {
                Ok(())
            };
        }
    };
    call_core_command("apply-prepared-source", move |runtime| {
        if !runtime.clear_source_open_if_current(open_request_seq, &interrupt) {
            if let Some(prepared) = prepared.take() {
                prepared.session.stop_background();
            }
            return Ok(());
        }
        let prepared = prepared
            .take()
            .ok_or_else(|| napi::Error::from_reason("prepared source already applied"))?;
        apply_prepared_source(runtime, prepared);
        Ok(())
    })
}

fn update_runtime_audio_graph(runtime: &mut PlayerRuntime) {
    let previous = runtime.audio_graph.clone();
    let mut next = if let Some(session) = runtime.session.as_ref() {
        let output_stats = session.shared.output_stats();
        let provider_descriptor = session.shared.provider_descriptor();
        audio_graph::snapshot_filter_graph_with_device_output(
            session.shared.mix_format,
            &runtime.dsp_settings,
            output_stats.as_ref(),
            provider_descriptor.as_ref(),
        )
    } else {
        if runtime.dsp_settings.provider_path.is_some() {
            audio_graph::snapshot_filter_graph_with_device_output(
                MixFormat::stereo_f32(48_000),
                &runtime.dsp_settings,
                None,
                None,
            )
        } else {
            AudioGraphSnapshot::default()
        }
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
    let shared_for_command = shared.clone();
    let next = call_core_command("activate-gapless-next", move |runtime| {
        let Some(session) = runtime.session.as_ref() else {
            return Ok(None);
        };
        if !Arc::ptr_eq(&session.shared, &shared_for_command) {
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
        retire_prepared_next_background(runtime.prepared_next.take(), "loop-restart");
        session.stop_decode_background("loop-restart");
        let generation = shared.reset_for_decode_resume(0.0, &runtime.dsp_settings);
        let eq_active = runtime
            .dsp_settings
            .equalizer
            .iter()
            .any(|gain| gain.abs() >= 0.01);
        let spatial = runtime.dsp_settings.spatial.as_ref();
        emit_runtime_event(runtime, PlayerEvent::log(
            "info",
            format!(
                "loop restart reusing audio filter chain: speed={:.2}x, normalization_gain_db={:.2} dB, eq_active={}, spatial_enabled={}, provider_enabled={}",
                runtime.dsp_settings.speed,
                runtime.dsp_settings.normalization_gain_db,
                eq_active,
                spatial.is_some(),
                runtime.dsp_settings.provider_path.is_some()
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
        let mut guard = runtime_guard();
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
    cancel_runtime_fade();
    invalidate_seek_requests();
    invalidate_source_open_requests();
    if clear_callback {
        clear_event_callback();
    }
    stop_core_dispatcher();
    let runtime = {
        let mut guard = runtime_guard();
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
pub fn register_event_handler(callback: EventCallback) -> napi::Result<()> {
    start_event_dispatcher()?;
    set_event_callback(callback)
}

pub struct LoadFileTask {
    url: String,
    seq: u64,
    audio_stream_ordinal: Option<usize>,
    open_request_seq: u64,
    interrupt: Arc<AtomicBool>,
}

pub struct SwitchSourceTask {
    url: String,
    seq: u64,
    audio_stream_ordinal: Option<usize>,
    open_request_seq: u64,
    interrupt: Arc<AtomicBool>,
}

impl Task for SwitchSourceTask {
    type Output = (f64, f64);
    type JsValue = (f64, f64);

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let url = self.url.clone();
        let seq = self.seq;
        let audio_stream = self.audio_stream_ordinal;
        let open_request_seq = self.open_request_seq;
        let interrupt = self.interrupt.clone();
        let interrupt_for_begin = interrupt.clone();
        let begin = call_core_command("begin-source-switch", move |runtime| {
            if !is_latest_source_open_request_seq(open_request_seq) {
                return Ok(None);
            }
            runtime.cancel_pending_gapless_prepare();
            retire_prepared_next_background(runtime.prepared_next.take(), "source-switch-begin");
            let session = runtime
                .session
                .as_ref()
                .ok_or_else(|| napi::Error::from_reason("no active audio session".to_string()))?;
            let commands = session.decode_commands.as_ref().cloned().ok_or_else(|| {
                napi::Error::from_reason("active decoder is not available".to_string())
            })?;
            let plan = (
                session.shared.clone(),
                runtime.current_seq,
                session.shared.current_decode_generation(),
                commands,
                runtime.config.clone(),
            );
            runtime.begin_source_open(open_request_seq, interrupt_for_begin);
            Ok(Some(plan))
        })?;
        let Some((shared, current_seq, generation, commands, config)) = begin else {
            return Err(napi::Error::from_reason(
                "stale source switch ignored".to_string(),
            ));
        };

        let operation = (|| -> napi::Result<(f64, f64, f64, u128)> {
            let mut decoder = open_decoder_with_interrupt(
                url.clone(),
                audio_stream,
                Some(shared.mix_format.sample_rate),
                interrupt.clone(),
                config.packet_cache_options_for_url(&url),
                &config.stream_options(),
            )
            .map_err(napi::Error::from_reason)?;
            let duration = decoder.duration_secs();

            // Seek the replacement stream to a future hand-off point while the old
            // source keeps decoding and playing. If a remote seek consumes the
            // initial lead, retry farther ahead based on the measured latency. The
            // decode worker can then swap readers without performing network I/O.
            let mut lead_secs = SOURCE_SWITCH_BASE_LEAD_SECS;
            let mut switch_at_secs = shared.position_secs() + lead_secs;
            let mut prepare_elapsed_ms = 0u128;
            let mut predecoded = Vec::new();
            for _ in 0..3 {
                switch_at_secs = shared.position_secs() + lead_secs;
                if duration > 0.0 {
                    switch_at_secs = switch_at_secs.min((duration - 0.05).max(0.0));
                }
                let prepare_started = Instant::now();
                decoder
                    .prepare_seamless_seek(switch_at_secs)
                    .map_err(napi::Error::from_reason)?;
                predecoded = decoder
                    .predecode_chunks(SOURCE_SWITCH_PREDECODE_SECS)
                    .map_err(napi::Error::from_reason)?;
                prepare_elapsed_ms = prepare_started.elapsed().as_millis();
                let ready_secs = switch_at_secs - shared.position_secs();
                if ready_secs >= SOURCE_SWITCH_MIN_READY_SECS
                    || (duration > 0.0 && duration <= shared.position_secs() + 0.1)
                {
                    break;
                }
                lead_secs = ((prepare_elapsed_ms as f64 / 1000.0) * 1.5 + 0.5)
                    .clamp(SOURCE_SWITCH_BASE_LEAD_SECS, SOURCE_SWITCH_MAX_LEAD_SECS);
            }

            let interrupt_for_validation = interrupt.clone();
            let shared_for_validation = shared.clone();
            let valid = call_core_command("validate-source-switch", move |runtime| {
                Ok(
                    runtime.source_open_is_current(open_request_seq, &interrupt_for_validation)
                        && runtime.session.as_ref().is_some_and(|session| {
                            Arc::ptr_eq(&session.shared, &shared_for_validation)
                        })
                        && runtime.current_seq == current_seq,
                )
            })?;
            if !valid {
                return Err(napi::Error::from_reason(
                    "stale source switch ignored".to_string(),
                ));
            }

            let (reply_tx, reply_rx) = sync_channel(1);
            commands
                .send(decoder::DecodeCommand::SwitchSource {
                    decoder: Box::new(decoder),
                    predecoded,
                    switch_at_secs,
                    generation,
                    reply: reply_tx,
                })
                .map_err(|_| napi::Error::from_reason("active decoder stopped".to_string()))?;
            let switch_position = reply_rx
                .recv_timeout(Duration::from_secs(15))
                .map_err(|_| napi::Error::from_reason("source switch timed out".to_string()))?
                .map_err(napi::Error::from_reason)?;
            Ok((
                switch_position,
                duration,
                switch_at_secs,
                prepare_elapsed_ms,
            ))
        })();

        let (switch_position, duration, switch_at_secs, prepare_elapsed_ms) = match operation {
            Ok(output) => output,
            Err(err) => {
                let interrupt_for_error = interrupt.clone();
                let _ = call_core_command("finish-source-switch-error", move |runtime| {
                    runtime.clear_source_open_if_current(open_request_seq, &interrupt_for_error);
                    Ok(())
                });
                return Err(err);
            }
        };

        let interrupt_for_commit = interrupt.clone();
        call_core_command("commit-source-switch", move |runtime| {
            if !runtime.clear_source_open_if_current(open_request_seq, &interrupt_for_commit) {
                return Err(napi::Error::from_reason(
                    "stale source switch ignored".to_string(),
                ));
            }
            let Some(session_shared) = runtime
                .session
                .as_ref()
                .map(|session| session.shared.clone())
            else {
                return Err(napi::Error::from_reason(
                    "audio session changed during source switch".to_string(),
                ));
            };
            if !Arc::ptr_eq(&session_shared, &shared) || runtime.current_seq != current_seq {
                return Err(napi::Error::from_reason(
                    "stale source switch ignored".to_string(),
                ));
            }
            runtime.cancel_pending_gapless_prepare();
            retire_prepared_next_background(runtime.prepared_next.take(), "source-switch-commit");
            runtime.current_url = Some(url.clone());
            runtime.current_audio_stream_ordinal = audio_stream;
            runtime.current_seq = seq;
            runtime.latest_load_seq = runtime.latest_load_seq.max(seq);
            runtime.state.duration = duration;
            emit_runtime_events(
                runtime,
                vec![
                    PlayerEvent::duration_change(duration),
                    PlayerEvent::log(
                        "info",
                        format!(
                            "source switched without output restart: position={switch_position:.3}, scheduled={switch_at_secs:.3}, prepare_ms={prepare_elapsed_ms}, url='{url}'"
                        ),
                    ),
                ],
            );
            Ok(())
        })?;
        Ok((switch_position, duration))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

impl Task for LoadFileTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let url = self.url.clone();
        let audio_stream = self.audio_stream_ordinal;
        let seq = self.seq;
        let open_request_seq = self.open_request_seq;
        let interrupt = self.interrupt.clone();
        let interrupt_for_begin = interrupt.clone();
        let plan = call_core_command("begin-load", move |runtime| {
            if !is_latest_source_open_request_seq(open_request_seq) {
                return Ok(None);
            }
            runtime.cancel_idle_output_release();
            runtime.cancel_pending_seek_restart();
            runtime.cancel_pending_gapless_prepare();
            runtime.seek_restore_paused = None;
            retire_prepared_next_background(runtime.prepared_next.take(), "load-begin");
            runtime.latest_load_seq = seq;
            set_runtime_core_state(runtime, PlaybackCoreState::Loading, "load");
            let plan = if runtime.session.is_some()
                && runtime.config.gapless_audio == GaplessAudioPolicy::No
            {
                runtime.stop_session();
                LoadPlan::Initial {
                    config: runtime.config.clone(),
                    dsp_settings: runtime.dsp_settings.clone(),
                    spatial_file_path: runtime.spatial_file_path.clone(),
                    pause_on_device_disconnect: runtime.pause_on_device_disconnect,
                }
            } else if let Some(session) = runtime.session.as_mut() {
                let shared = session.shared.clone();
                shared.paused.store(true, Ordering::Release);
                shared.request_decode_stop();
                session.stop_decode_background("load-replace");
                LoadPlan::Continuous(ContinuousLoadPlan {
                    shared,
                    request_seq: seq,
                    config: runtime.config.clone(),
                    dsp_settings: runtime.dsp_settings.clone(),
                    spatial_file_path: runtime.spatial_file_path.clone(),
                })
            } else {
                LoadPlan::Initial {
                    config: runtime.config.clone(),
                    dsp_settings: runtime.dsp_settings.clone(),
                    spatial_file_path: runtime.spatial_file_path.clone(),
                    pause_on_device_disconnect: runtime.pause_on_device_disconnect,
                }
            };
            runtime.begin_source_open(open_request_seq, interrupt_for_begin);
            Ok(Some(plan))
        })?;

        let Some(plan) = plan else {
            return Ok(());
        };

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
                open_request_seq,
                interrupt,
            ),
            LoadPlan::Continuous(plan) => {
                let new_decoder = open_decoder_with_interrupt(
                    url.clone(),
                    audio_stream,
                    Some(plan.shared.mix_format.sample_rate),
                    interrupt.clone(),
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
                        let dsp_settings = match prepare_dsp_settings_for_mix_rate(
                            plan.dsp_settings,
                            plan.spatial_file_path.as_deref(),
                            plan.shared.mix_format.sample_rate,
                        ) {
                            Ok(settings) => settings,
                            Err(err) => {
                                let interrupt_for_command = interrupt.clone();
                                let _ =
                                    call_core_command("finish-load-dsp-error", move |runtime| {
                                        runtime.clear_source_open_if_current(
                                            open_request_seq,
                                            &interrupt_for_command,
                                        );
                                        Ok(())
                                    });
                                return Err(napi::Error::from_reason(err));
                            }
                        };
                        let interrupt_for_commit = interrupt.clone();
                        call_core_command("commit-load", move |runtime| {
                            if !runtime
                                .source_open_is_current(open_request_seq, &interrupt_for_commit)
                            {
                                return Ok(());
                            }
                            runtime.clear_source_open_if_current(
                                open_request_seq,
                                &interrupt_for_commit,
                            );
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
                            )
                            .map_err(napi::Error::from_reason)?;
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
                        let interrupt_for_error = interrupt.clone();
                        let current =
                            call_core_command("finish-load-open-error", move |runtime| {
                                if !runtime
                                    .source_open_is_current(open_request_seq, &interrupt_for_error)
                                {
                                    return Ok(false);
                                }
                                runtime.clear_source_open_if_current(
                                    open_request_seq,
                                    &interrupt_for_error,
                                );
                                let matches_current_plan =
                                    runtime.session.as_ref().is_some_and(|session| {
                                        Arc::ptr_eq(&session.shared, &plan.shared)
                                    });
                                if !matches_current_plan
                                    || runtime.latest_load_seq != plan.request_seq
                                {
                                    return Ok(false);
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
                                runtime.latest_load_seq =
                                    runtime.latest_load_seq.max(plan.request_seq);
                                runtime.state.duration = 0.0;
                                runtime.state.time_pos = 0.0;
                                runtime.state.playing = false;
                                runtime.state.paused = true;
                                set_runtime_core_state(
                                    runtime,
                                    PlaybackCoreState::Error,
                                    "load-error",
                                );
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
                                Ok(true)
                            })?;
                        if current {
                            Err(napi::Error::from_reason(err))
                        } else {
                            Ok(())
                        }
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
        open_request_seq: next_source_open_request_seq(),
        interrupt: Arc::new(AtomicBool::new(false)),
    })
}

#[napi]
pub fn load_mkv_track(url: String, track_id: i64, seq: Option<f64>) -> AsyncTask<LoadFileTask> {
    invalidate_seek_requests();
    AsyncTask::new(LoadFileTask {
        url,
        seq: seq.unwrap_or(0.0).max(0.0) as u64,
        audio_stream_ordinal: audio_stream_ordinal_from_track_id(track_id),
        open_request_seq: next_source_open_request_seq(),
        interrupt: Arc::new(AtomicBool::new(false)),
    })
}

#[napi]
pub fn switch_source(
    url: String,
    track_id: Option<i64>,
    seq: Option<f64>,
) -> AsyncTask<SwitchSourceTask> {
    invalidate_seek_requests();
    AsyncTask::new(SwitchSourceTask {
        url,
        seq: seq.unwrap_or(0.0).max(0.0) as u64,
        audio_stream_ordinal: track_id.and_then(audio_stream_ordinal_from_track_id),
        open_request_seq: next_source_open_request_seq(),
        interrupt: Arc::new(AtomicBool::new(false)),
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
    interrupt: Arc<AtomicBool>,
}

impl Drop for GaplessPrepareGuard {
    fn drop(&mut self) {
        self.shared.finish_gapless_prepare(self.epoch);
        let epoch = self.epoch;
        let interrupt = self.interrupt.clone();
        dispatch_core_command(
            "finish-gapless-prepare",
            Box::new(move |runtime| {
                if runtime.gapless_prepare_interrupt.as_ref().is_some_and(
                    |(current_epoch, current_interrupt)| {
                        *current_epoch == epoch && Arc::ptr_eq(current_interrupt, &interrupt)
                    },
                ) {
                    runtime.gapless_prepare_interrupt = None;
                }
            }),
        );
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
            interrupt: self.interrupt.clone(),
        };
        if !pending_shared.gapless_prepare_request_is_current(request_id) {
            return Ok(false);
        }
        let (sample_rate, current_seq, shared, config) =
            call_core_command("snapshot-next-source-preparation", |runtime| {
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

        let url_for_log = self.url.clone();
        call_core_command("commit-next-source-preparation", move |runtime| {
            let still_current = runtime.session.as_ref().is_some_and(|session| {
                Arc::ptr_eq(&session.shared, &shared)
                    && runtime.current_seq == current_seq
                    && session
                        .shared
                        .gapless_prepare_request_is_current(request_id)
            });
            if !still_current {
                retire_prepared_next_background(prepared.take(), "prepare-next-stale");
                return Ok(false);
            }
            let prepared = prepared.take().ok_or_else(|| {
                napi::Error::from_reason("prepared next source already committed".to_string())
            })?;
            let previous = runtime.prepared_next.replace(prepared);
            retire_prepared_next_background(previous, "prepare-next-replaced");
            runtime.gapless_prepare_interrupt = None;
            emit_runtime_event(
                runtime,
                PlayerEvent::log(
                    "info",
                    format!(
                        "gapless prepared next source: url='{}', predecoded_chunks={}",
                        url_for_log,
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
    call_core_command("begin-next-source-preparation", |runtime| {
        runtime.cancel_pending_gapless_prepare();
        retire_prepared_next_background(runtime.prepared_next.take(), "prepare-next-begin");
        let Some(session) = runtime.session.as_ref() else {
            return Ok(0.0);
        };
        Ok(session.shared.begin_gapless_prepare() as f64)
    })
}

#[napi]
pub fn cancel_next_source_preparation(request_id: f64) -> napi::Result<bool> {
    let request_id = request_id.max(0.0) as u64;
    call_core_command("cancel-next-source-preparation", move |runtime| {
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
            retire_prepared_next_background(runtime.prepared_next.take(), "prepare-next-cancel");
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
    let interrupt_for_command = interrupt.clone();
    let pending_prepare = call_core_command("register-next-source-preparation", move |runtime| {
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
            runtime.gapless_prepare_interrupt = Some((request_id, interrupt_for_command.clone()));
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
    call_core_command("clear-prepared-next-source", |runtime| {
        runtime.cancel_pending_gapless_prepare();
        retire_prepared_next_background(runtime.prepared_next.take(), "prepare-next-clear");
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
    invalidate_source_open_requests();
    call_core_command("stop", |runtime| {
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
    if !volume.is_finite() {
        return Err(napi::Error::from_reason(
            "volume must be finite".to_string(),
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
    call_core_command("set-loop-file", move |runtime| {
        runtime.loop_file = loop_file;
        Ok(())
    })
}

#[cfg(test)]
mod runtime_state_tests {
    use super::*;

    struct SlowDrop(Arc<AtomicBool>);

    impl Drop for SlowDrop {
        fn drop(&mut self) {
            thread::sleep(Duration::from_millis(100));
            self.0.store(true, Ordering::Release);
        }
    }

    #[test]
    fn seek_completion_uses_the_latest_playback_intent() {
        let mut runtime = PlayerRuntime::new(PlayerConfig::default());
        runtime.state.paused = true;

        assert!(runtime.begin_seek_restore_paused());
        runtime.update_seek_restore_paused(false);

        assert!(!runtime.take_seek_restore_paused(0, true));
        assert!(runtime.seek_restore_paused.is_none());
    }

    #[test]
    fn stop_session_leaves_core_transition_to_the_event_emitting_caller() {
        let mut runtime = PlayerRuntime::new(PlayerConfig::default());
        runtime.core_state = PlaybackCoreState::Playing;

        runtime.stop_session();

        assert_eq!(runtime.core_state, PlaybackCoreState::Playing);
        assert!(!runtime.state.playing);
        assert!(runtime.state.paused);
    }

    #[test]
    fn superseding_source_open_interrupts_old_request_and_protects_new_slot() {
        let mut runtime = PlayerRuntime::new(PlayerConfig::default());
        let old_seq = next_source_open_request_seq();
        let old_interrupt = Arc::new(AtomicBool::new(false));
        runtime.begin_source_open(old_seq, old_interrupt.clone());

        let new_seq = next_source_open_request_seq();
        let new_interrupt = Arc::new(AtomicBool::new(false));
        runtime.begin_source_open(new_seq, new_interrupt.clone());

        assert!(old_interrupt.load(Ordering::Acquire));
        assert!(!new_interrupt.load(Ordering::Acquire));
        assert!(!runtime.clear_source_open_if_current(old_seq, &old_interrupt));
        assert!(runtime.source_open_is_current(new_seq, &new_interrupt));
        assert!(runtime.clear_source_open_if_current(new_seq, &new_interrupt));
        assert!(runtime.source_open_interrupt.is_none());
    }

    #[test]
    fn stable_core_state_transitions_update_pending_seek_intent() {
        let mut runtime = PlayerRuntime::new(PlayerConfig::default());
        runtime.state.paused = false;
        assert!(!runtime.begin_seek_restore_paused());

        set_runtime_core_state(
            &mut runtime,
            PlaybackCoreState::DeviceLost,
            "test-device-lost",
        );

        assert!(runtime.take_seek_restore_paused(0, false));
    }

    #[test]
    fn prepared_next_retirement_does_not_block_the_dispatcher_caller() {
        let dropped = Arc::new(AtomicBool::new(false));
        let started = Instant::now();

        retire_value_background(
            Some(SlowDrop(dropped.clone())),
            "player-prepared-next-reaper-test".to_string(),
        );

        assert!(started.elapsed() < Duration::from_millis(50));
        let deadline = Instant::now() + Duration::from_secs(1);
        while !dropped.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        assert!(dropped.load(Ordering::Acquire));
    }
}
