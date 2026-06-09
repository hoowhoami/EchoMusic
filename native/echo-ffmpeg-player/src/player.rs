use crate::audio::AudioOutput;
use crate::decode::{self, AudioFormat, DecodeReadResult, DecoderBackend, FfmpegDecoder};
use crate::device;
use crate::dsp::{
    parse_audio_filter_settings, DspProcessor, DspSettings, ImpulseResponseSettings, EQ_BAND_COUNT,
    EQ_FREQUENCIES,
};
use crate::error::{clamp_f64, PlayerError, PlayerResult};
use crate::spectrum::{self, SpectrumFrame, SpectrumOptions, SpectrumStatus, SpectrumTap};
use crate::types::{AudioDevice, PlayerEvent, PlayerState, TrackInfo};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const START_PREBUFFER_MS: usize = 300;
const REBUFFER_RESUME_MS: usize = 450;
const SEEK_RESUME_MS: usize = 60;
const MAX_OUTPUT_PUSH_FRAMES: usize = 2048;
const BUFFERING_RETRY_DELAY: Duration = Duration::from_millis(8);

#[derive(Debug, Default)]
struct PlayerConfig {
    audio_filter: String,
    equalizer_gains: [f64; EQ_BAND_COUNT],
    exclusive: bool,
    impulse_response_path: String,
    impulse_response_mix: f64,
    loop_file: String,
    media_title: String,
    normalization_gain_db: f64,
    playback_speed: f64,
}

impl PlayerConfig {
    fn dsp_settings(&self) -> PlayerResult<DspSettings> {
        let impulse_response =
            (!self.impulse_response_path.is_empty()).then(|| ImpulseResponseSettings {
                path: self.impulse_response_path.clone(),
                mix: self.impulse_response_mix as f32,
            });
        DspSettings::from_values(
            &self.equalizer_gains,
            self.normalization_gain_db,
            impulse_response,
            self.playback_speed,
        )
    }
}

pub struct FfmpegPlayer {
    state: Arc<Mutex<PlayerState>>,
    config: Arc<Mutex<PlayerConfig>>,
    output: Arc<Mutex<Option<AudioOutput>>>,
    spectrum: SpectrumTap,
    tracks: Arc<Mutex<Vec<TrackInfo>>>,
    codec_name: Arc<Mutex<String>>,
    worker: Mutex<Option<DecoderWorker>>,
    load_serial: Mutex<()>,
    load_interrupt: Mutex<Option<Arc<AtomicBool>>>,
    load_seq: AtomicU64,
    seek_seq: Arc<AtomicU64>,
    fade_seq: Arc<AtomicU64>,
    fade_active: Arc<AtomicBool>,
    shutdown: Arc<AtomicBool>,
}

pub(crate) struct LoadRequest {
    seq: u64,
    path: String,
    audio_track_id: i64,
    interrupt: Arc<AtomicBool>,
}

pub(crate) struct TrackSwitchRequest {
    load: Option<LoadRequest>,
    time_pos: f64,
    was_playing: bool,
}

struct DecoderWorker {
    commands: mpsc::Sender<PlaybackCommand>,
    handle: Option<JoinHandle<()>>,
    interrupt: Arc<AtomicBool>,
}

enum PlaybackCommand {
    Play,
    Pause,
    RefreshOutput,
    Seek { time: f64, seq: u64 },
    Shutdown,
}

impl FfmpegPlayer {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(PlayerState::default())),
            config: Arc::new(Mutex::new(PlayerConfig {
                impulse_response_mix: 0.4,
                loop_file: "no".to_string(),
                playback_speed: 1.0,
                ..PlayerConfig::default()
            })),
            output: Arc::new(Mutex::new(None)),
            spectrum: SpectrumTap::new(),
            tracks: Arc::new(Mutex::new(Vec::new())),
            codec_name: Arc::new(Mutex::new(String::new())),
            worker: Mutex::new(None),
            load_serial: Mutex::new(()),
            load_interrupt: Mutex::new(None),
            load_seq: AtomicU64::new(0),
            seek_seq: Arc::new(AtomicU64::new(0)),
            fade_seq: Arc::new(AtomicU64::new(0)),
            fade_active: Arc::new(AtomicBool::new(false)),
            shutdown: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn destroy(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.cancel_pending_load();
        self.cancel_fade();
        let _ = self.stop_spectrum();
        self.stop_worker();
        if let Ok(mut output) = self.output.lock() {
            output.take();
        }
    }

    pub fn state(&self) -> PlayerState {
        self.state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    pub(crate) fn begin_load_file(&self, url: &str) -> PlayerResult<LoadRequest> {
        self.begin_load_source(url, 0)
    }

    pub(crate) fn begin_load_mkv_track(
        &self,
        url: &str,
        track_id: i64,
    ) -> PlayerResult<LoadRequest> {
        self.begin_load_source(url, track_id)
    }

    pub(crate) fn complete_load_request(&self, request: LoadRequest) -> PlayerResult<bool> {
        self.load_source(request)
    }

    fn begin_load_source(&self, url: &str, audio_track_id: i64) -> PlayerResult<LoadRequest> {
        let path = url.trim();
        if path.is_empty() {
            return Err(PlayerError::InvalidInput("url cannot be empty".to_string()));
        }
        if audio_track_id < 0 {
            return Err(PlayerError::InvalidInput(
                "audio track id must be >= 0".to_string(),
            ));
        }

        let seq = self.load_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let interrupt = Arc::new(AtomicBool::new(false));
        if let Ok(mut guard) = self.load_interrupt.lock() {
            if let Some(previous) = guard.replace(interrupt.clone()) {
                previous.store(true, Ordering::SeqCst);
            }
        }

        self.stop_worker_detached();
        self.cancel_fade();
        self.with_output(|output| {
            output.set_paused(true);
            output.clear_blocking();
        });
        if let Ok(mut state) = self.state.lock() {
            state.path = path.to_string();
            state.idle = true;
            state.playing = false;
            state.paused = true;
            state.time_pos = 0.0;
            state.duration = 0.0;
            state.audio_track_id = audio_track_id.max(0);
        }
        if let Ok(mut tracks) = self.tracks.lock() {
            tracks.clear();
        }
        if let Ok(mut codec_name) = self.codec_name.lock() {
            codec_name.clear();
        }
        crate::emit_event(PlayerEvent::duration_change(0.0));
        crate::emit_event(PlayerEvent::time_update(0.0));

        Ok(LoadRequest {
            seq,
            path: path.to_string(),
            audio_track_id,
            interrupt,
        })
    }

    fn load_source(&self, request: LoadRequest) -> PlayerResult<bool> {
        let _load_guard = self
            .load_serial
            .lock()
            .map_err(|err| PlayerError::State(format!("failed to lock load serial: {err}")))?;
        if !self.is_current_load(request.seq) {
            return Ok(false);
        }

        let output = self.ensure_output()?;
        output.clear_blocking();
        output.set_paused(true);
        if !self.is_current_load(request.seq) || request.interrupt.load(Ordering::SeqCst) {
            return Ok(false);
        }

        let target = AudioFormat {
            sample_rate: output.sample_rate(),
            channels: output.channels().clamp(1, 8),
        };
        let mut decoder = FfmpegDecoder::new(target, request.interrupt.clone())?;
        let decoded_format = match decoder.load(&request.path, request.audio_track_id) {
            Ok(format) => format,
            Err(_)
                if !self.is_current_load(request.seq)
                    || request.interrupt.load(Ordering::SeqCst) =>
            {
                return Ok(false);
            }
            Err(err) => return Err(err),
        };
        if !self.is_current_load(request.seq) || request.interrupt.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let duration = decoder.duration().unwrap_or_default();
        let tracks = decoder.track_list();
        let codec_name = decoder.codec_name();

        if let Ok(mut state) = self.state.lock() {
            state.path = request.path.clone();
            state.idle = false;
            state.playing = false;
            state.paused = true;
            state.time_pos = 0.0;
            state.duration = duration;
            state.audio_track_id = request.audio_track_id.max(0);
        }
        if let Ok(mut slot) = self.tracks.lock() {
            *slot = tracks;
        }
        if let Ok(mut slot) = self.codec_name.lock() {
            *slot = codec_name;
        }
        crate::emit_event(PlayerEvent::duration_change(duration));
        crate::emit_event(crate::log::event(
            crate::log::LogLevel::Info,
            format!(
                "decoder loaded: {}Hz {}ch duration={duration:.3}s",
                decoded_format.sample_rate, decoded_format.channels
            ),
        ));

        let worker = DecoderWorker::start(
            decoder,
            output,
            self.state.clone(),
            self.config.clone(),
            self.shutdown.clone(),
            request.interrupt,
            self.seek_seq.clone(),
            self.loop_enabled(),
        )?;
        let mut guard = self
            .worker
            .lock()
            .map_err(|err| PlayerError::State(format!("failed to lock decoder worker: {err}")))?;
        *guard = Some(worker);

        Ok(true)
    }

    pub fn get_track_list(&self) -> Vec<TrackInfo> {
        self.tracks
            .lock()
            .map(|tracks| tracks.clone())
            .unwrap_or_default()
    }

    pub fn play(&self) -> PlayerResult<PlayerEvent> {
        self.send_worker_command(PlaybackCommand::Play)?;
        if let Ok(mut state) = self.state.lock() {
            state.playing = true;
            state.paused = false;
        }
        Ok(PlayerEvent::state_change(false))
    }

    pub fn pause(&self) -> PlayerResult<PlayerEvent> {
        if let Some(sender) = self.worker_command_sender() {
            let _ = sender.send(PlaybackCommand::Pause);
        }
        if let Ok(mut state) = self.state.lock() {
            state.playing = false;
            state.paused = true;
        }
        self.with_output(|output| output.set_paused(true));
        Ok(PlayerEvent::state_change(true))
    }

    pub fn stop(&self) -> PlayerEvent {
        self.cancel_pending_load();
        self.stop_worker();
        if let Ok(mut state) = self.state.lock() {
            state.playing = false;
            state.paused = true;
            state.time_pos = 0.0;
            state.duration = 0.0;
            state.path.clear();
            state.idle = true;
            state.audio_track_id = 0;
        }
        if let Ok(mut tracks) = self.tracks.lock() {
            tracks.clear();
        }
        if let Ok(mut codec_name) = self.codec_name.lock() {
            codec_name.clear();
        }
        self.with_output(|output| {
            output.set_paused(true);
            output.clear_blocking();
        });
        PlayerEvent::idle()
    }

    pub fn seek(&self, time: f64) -> PlayerResult<PlayerEvent> {
        let time = clamp_f64(time, 0.0, f64::MAX)?;
        self.with_output(|output| output.clear_blocking());
        let seq = self.seek_seq.fetch_add(1, Ordering::SeqCst) + 1;
        self.send_worker_command(PlaybackCommand::Seek { time, seq })?;
        if let Ok(mut state) = self.state.lock() {
            state.time_pos = time;
        }
        Ok(PlayerEvent::time_update(time))
    }

    pub fn set_volume(&self, volume: f64) -> PlayerResult<()> {
        let volume = clamp_f64(volume, 0.0, 100.0)?;
        if let Ok(mut state) = self.state.lock() {
            state.volume = volume;
        }
        self.with_output(|output| output.set_volume_percent(volume));
        Ok(())
    }

    pub fn set_speed(&self, speed: f64) -> PlayerResult<()> {
        let speed = clamp_f64(speed, 0.1, 5.0)?;
        if let Ok(mut state) = self.state.lock() {
            state.speed = speed;
        }
        if let Ok(mut config) = self.config.lock() {
            config.playback_speed = speed;
        }
        Ok(())
    }

    pub fn set_audio_device(&self, device_name: &str) -> PlayerResult<()> {
        let name = normalize_device_name(device_name);
        let (previous_name, volume, paused) = self
            .state
            .lock()
            .map(|mut state| {
                let previous_name = state.audio_device.clone();
                let volume = state.volume;
                let paused = state.paused;
                state.audio_device = name.clone();
                (previous_name, volume, paused)
            })
            .unwrap_or_else(|_| ("auto".to_string(), 100.0, true));

        let output_slot = self.output.clone();
        let state = self.state.clone();
        let spectrum_sink = self.spectrum.sink();
        let exclusive = self.exclusive_requested();
        let worker_command = self.worker_command_sender();
        thread::Builder::new()
            .name("echo-ffmpeg-device-switch".to_string())
            .spawn(move || {
                let result = switch_active_output_device(
                    &output_slot,
                    &name,
                    exclusive,
                    volume,
                    paused,
                    spectrum_sink,
                );
                match result {
                    Ok(switched) => {
                        if switched {
                            if let Some(command) = worker_command {
                                let _ = command.send(PlaybackCommand::RefreshOutput);
                            }
                            crate::emit_event(crate::log::event(
                                crate::log::LogLevel::Info,
                                format!("audio output switched to {name}"),
                            ));
                        }
                    }
                    Err(err) => {
                        if let Ok(mut state) = state.lock() {
                            if state.audio_device == name {
                                state.audio_device = previous_name;
                            }
                        }
                        crate::emit_event(crate::log::event(
                            crate::log::LogLevel::Error,
                            format!("audio output switch failed: {err}"),
                        ));
                    }
                }
            })
            .map_err(|err| PlayerError::Backend(format!("failed to spawn device switch: {err}")))?;
        Ok(())
    }

    pub fn get_audio_devices(&self) -> PlayerResult<Vec<AudioDevice>> {
        device::list_output_devices()
    }

    pub fn start_spectrum(&self, options: Option<SpectrumOptions>) -> SpectrumStatus {
        match self.ensure_output() {
            Ok(output) => {
                let status =
                    self.spectrum
                        .start(options, output.sample_rate(), Arc::clone(&self.state));
                output.set_spectrum_sink(self.spectrum.sink());
                status
            }
            Err(err) => spectrum::unavailable_status(err.to_string()),
        }
    }

    pub fn stop_spectrum(&self) -> SpectrumStatus {
        self.with_output(|output| output.set_spectrum_sink(None));
        self.spectrum.stop()
    }

    pub fn spectrum_status(&self) -> SpectrumStatus {
        self.spectrum.status()
    }

    pub fn spectrum_snapshot(&self) -> Option<SpectrumFrame> {
        self.spectrum.snapshot()
    }

    pub fn set_audio_filter(&self, filter: &str) -> PlayerResult<()> {
        let parsed_settings = parse_audio_filter_settings(filter)?;
        if let Ok(mut config) = self.config.lock() {
            config.audio_filter = filter.to_string();
            if let Some(settings) = parsed_settings {
                config.equalizer_gains = settings.equalizer_gains_db.map(f64::from);
                config.normalization_gain_db = f64::from(settings.normalization_gain_db);
                if let Some(ir) = settings.impulse_response {
                    config.impulse_response_path = ir.path;
                    config.impulse_response_mix = f64::from(ir.mix);
                } else {
                    config.impulse_response_path.clear();
                    config.impulse_response_mix = 0.4;
                }
            } else if !filter.trim().is_empty() {
                return Err(PlayerError::Unsupported(
                    "audio filter chain is not supported by the native DSP graph".to_string(),
                ));
            }
        }
        Ok(())
    }

    pub fn af_command(&self, label: &str, cmd: &str, arg: &str, target: &str) -> PlayerResult<()> {
        if label == "irs" && cmd == "weights" && target == "amix@irsmix" {
            let mix = parse_ir_mix_weight(arg)?;
            if let Ok(mut config) = self.config.lock() {
                config.impulse_response_mix = mix;
                config.audio_filter = build_audio_filter(&config);
            }
            return Ok(());
        }

        Err(PlayerError::Unsupported(format!(
            "runtime filter command '{cmd}' for '{label}' is not supported"
        )))
    }

    pub fn set_eq(&self, gains: &[f64]) -> PlayerResult<()> {
        if gains.len() != 10 {
            return Err(PlayerError::InvalidInput(
                "expected 10 equalizer gains".to_string(),
            ));
        }
        for gain in gains {
            let _ = clamp_f64(*gain, -12.0, 12.0)?;
        }
        let mut equalizer_gains = [0.0; EQ_BAND_COUNT];
        equalizer_gains.copy_from_slice(gains);
        if let Ok(mut config) = self.config.lock() {
            config.equalizer_gains = equalizer_gains;
            config.audio_filter = build_audio_filter(&config);
        }
        Ok(())
    }

    pub fn set_normalization_gain(&self, gain_db: f64) -> PlayerResult<()> {
        let gain_db = clamp_f64(gain_db, -36.0, 36.0)?;
        if let Ok(mut config) = self.config.lock() {
            config.normalization_gain_db = gain_db;
            config.audio_filter = build_audio_filter(&config);
        }
        Ok(())
    }

    pub fn set_exclusive(&self, exclusive: bool) -> PlayerResult<()> {
        let state_before = self.state();
        let previous = self
            .config
            .lock()
            .map(|mut config| {
                let previous = config.exclusive;
                config.exclusive = exclusive;
                previous
            })
            .map_err(|err| PlayerError::State(format!("failed to lock player config: {err}")))?;

        if previous == exclusive {
            return Ok(());
        }

        let device_name = self.state().audio_device;
        crate::emit_event(crate::log::event(
            crate::log::LogLevel::Info,
            format!(
                "audio exclusive switch requested: {previous} -> {exclusive}, device={device_name}, playing={}, paused={}",
                state_before.playing, state_before.paused
            ),
        ));
        match self.reopen_output(&device_name) {
            Ok(()) => {
                let _ = self.send_worker_command(PlaybackCommand::RefreshOutput);
                crate::emit_event(crate::log::event(
                    crate::log::LogLevel::Info,
                    format!(
                        "audio exclusive switch applied: requested={exclusive}, actual={}",
                        self.output_exclusive()
                    ),
                ));
                Ok(())
            }
            Err(err) => {
                if let Ok(mut config) = self.config.lock() {
                    config.exclusive = previous;
                }
                if let Err(recovery_err) = self.reopen_output(&device_name) {
                    crate::emit_event(crate::log::event(
                        crate::log::LogLevel::Error,
                        format!(
                            "audio output recovery after exclusive switch failed: {recovery_err}"
                        ),
                    ));
                }
                let _ = self.send_worker_command(PlaybackCommand::RefreshOutput);
                Err(err)
            }
        }
    }

    pub fn set_media_title(&self, title: &str) {
        if let Ok(mut config) = self.config.lock() {
            config.media_title = title.to_string();
        }
    }

    pub fn set_loop_file(&self, value: &str) {
        if let Ok(mut config) = self.config.lock() {
            config.loop_file = if value == "inf" { "inf" } else { "no" }.to_string();
        }
    }

    pub(crate) fn begin_audio_track_switch(
        &self,
        track_id: i64,
    ) -> PlayerResult<TrackSwitchRequest> {
        if track_id < 0 {
            return Err(PlayerError::InvalidInput(
                "audio track id must be >= 0".to_string(),
            ));
        }
        let (path, time_pos, was_playing, can_reload) = self
            .state
            .lock()
            .map(|state| {
                (
                    state.path.clone(),
                    state.time_pos,
                    state.playing && !state.paused,
                    !state.path.is_empty() && !state.idle,
                )
            })
            .unwrap_or_else(|_| (String::new(), 0.0, false, false));

        if can_reload {
            Ok(TrackSwitchRequest {
                load: Some(self.begin_load_source(&path, track_id)?),
                time_pos,
                was_playing,
            })
        } else if let Ok(mut state) = self.state.lock() {
            state.audio_track_id = track_id;
            Ok(TrackSwitchRequest {
                load: None,
                time_pos: 0.0,
                was_playing: false,
            })
        } else {
            Err(PlayerError::State(
                "failed to lock player state".to_string(),
            ))
        }
    }

    pub(crate) fn complete_audio_track_switch(
        &self,
        request: TrackSwitchRequest,
    ) -> PlayerResult<()> {
        if let Some(load) = request.load {
            if self.complete_load_request(load)? {
                crate::emit_event(PlayerEvent::file_loaded());
                if request.time_pos > 0.0 {
                    let _ = self.seek(request.time_pos)?;
                }
                if request.was_playing {
                    let _ = self.play()?;
                }
            }
        }
        Ok(())
    }

    pub fn get_property(&self, name: &str) -> PlayerResult<String> {
        let state = self.state();
        let config = self.config.lock().unwrap_or_else(|err| err.into_inner());
        match name {
            "af" => Ok(config.audio_filter.clone()),
            "audio-codec-name" => Ok(self
                .codec_name
                .lock()
                .map(|codec| codec.clone())
                .unwrap_or_default()),
            "audio-device" => Ok(state.audio_device),
            "audio-exclusive" => Ok(if self.output_exclusive() { "yes" } else { "no" }.to_string()),
            "audio-params" => Ok(self.audio_params()),
            "decoder-status" => Ok(if state.idle { "idle" } else { "ready" }.to_string()),
            "force-media-title" => Ok(config.media_title.clone()),
            "loop-file" => Ok(config.loop_file.clone()),
            "pause" => Ok(if state.paused { "yes" } else { "no" }.to_string()),
            "speed" => Ok(state.speed.to_string()),
            "time-pos" => Ok(state.time_pos.to_string()),
            "duration" => Ok(state.duration.to_string()),
            "volume" => Ok(state.volume.to_string()),
            other => Err(PlayerError::Unsupported(format!(
                "property '{other}' is not implemented"
            ))),
        }
    }

    pub fn fade(&self, from: f64, to: f64, duration_ms: u64) -> PlayerResult<()> {
        let from = clamp_f64(from, 0.0, 100.0)?;
        let to = clamp_f64(to, 0.0, 100.0)?;
        self.start_fade(from, to, duration_ms);
        Ok(())
    }

    pub fn pause_with_fade(&self, saved_volume: f64, duration_ms: u64) -> PlayerResult<()> {
        let saved_volume = clamp_f64(saved_volume, 0.0, 100.0)?;
        let seq = self.start_fade(saved_volume, 0.0, duration_ms);
        let state = self.state.clone();
        let fade_seq = self.fade_seq.clone();
        let shutdown = self.shutdown.clone();
        let output = self.output.clone();
        let worker_command = self.worker_command_sender();
        let _ = thread::Builder::new()
            .name("echo-ffmpeg-pause-fade".to_string())
            .spawn(move || {
                thread::sleep(Duration::from_millis(duration_ms));
                if shutdown.load(Ordering::SeqCst) || fade_seq.load(Ordering::SeqCst) != seq {
                    return;
                }
                if let Ok(mut state) = state.lock() {
                    state.playing = false;
                    state.paused = true;
                    state.volume = saved_volume;
                }
                if let Ok(guard) = output.lock() {
                    if let Some(output) = guard.as_ref() {
                        output.set_paused(true);
                        output.set_volume_percent(saved_volume);
                    }
                }
                if let Some(command) = worker_command {
                    let _ = command.send(PlaybackCommand::Pause);
                }
                crate::emit_event(PlayerEvent::state_change(true));
            });
        Ok(())
    }

    pub fn play_with_fade(&self, target_volume: f64, duration_ms: u64) -> PlayerResult<()> {
        let target_volume = clamp_f64(target_volume, 0.0, 100.0)?;
        if let Ok(mut state) = self.state.lock() {
            state.volume = 0.0;
        }
        self.start_fade(0.0, target_volume, duration_ms);
        self.send_worker_command(PlaybackCommand::Play)?;
        if let Ok(mut state) = self.state.lock() {
            state.playing = true;
            state.paused = false;
        }
        self.with_output(|output| {
            output.set_volume_percent(0.0);
        });
        Ok(())
    }

    pub fn cancel_fade(&self) {
        self.fade_seq.fetch_add(1, Ordering::SeqCst);
        self.fade_active.store(false, Ordering::SeqCst);
    }

    pub fn is_fading(&self) -> bool {
        self.fade_active.load(Ordering::SeqCst)
    }

    fn start_fade(&self, from: f64, to: f64, duration_ms: u64) -> u64 {
        self.cancel_fade();
        let seq = self.fade_seq.fetch_add(1, Ordering::SeqCst) + 1;
        self.fade_active.store(true, Ordering::SeqCst);

        let state = self.state.clone();
        let fade_seq = self.fade_seq.clone();
        let fade_active = self.fade_active.clone();
        let shutdown = self.shutdown.clone();
        let output = self.output.clone();

        let _ = thread::Builder::new()
            .name("echo-ffmpeg-fade".to_string())
            .spawn(move || {
                if duration_ms == 0 {
                    if let Ok(mut state) = state.lock() {
                        state.volume = to;
                    }
                    if let Ok(guard) = output.lock() {
                        if let Some(output) = guard.as_ref() {
                            output.set_volume_percent(to);
                        }
                    }
                    fade_active.store(false, Ordering::SeqCst);
                    crate::emit_event(PlayerEvent::fade_complete());
                    return;
                }

                let steps = (duration_ms / 16).max(1) as usize;
                let step_duration = Duration::from_millis((duration_ms / steps as u64).max(1));
                let diff = to - from;
                for index in 1..=steps {
                    if shutdown.load(Ordering::SeqCst) || fade_seq.load(Ordering::SeqCst) != seq {
                        return;
                    }
                    let progress = index as f64 / steps as f64;
                    let eased = 1.0 - (1.0 - progress).powi(2);
                    if let Ok(mut state) = state.lock() {
                        state.volume = (from + diff * eased).clamp(0.0, 100.0);
                    }
                    if let Ok(guard) = output.lock() {
                        if let Some(output) = guard.as_ref() {
                            output.set_volume_percent((from + diff * eased).clamp(0.0, 100.0));
                        }
                    }
                    if index < steps {
                        thread::sleep(step_duration);
                    }
                }
                fade_active.store(false, Ordering::SeqCst);
                crate::emit_event(PlayerEvent::fade_complete());
            });
        seq
    }

    fn reopen_output(&self, device_name: &str) -> PlayerResult<()> {
        let state = self.state();
        let exclusive = self.exclusive_requested();
        let mut guard = self
            .output
            .lock()
            .map_err(|err| PlayerError::State(format!("failed to lock output slot: {err}")))?;
        if let Some(output) = guard.as_ref() {
            output.reopen(device_name, exclusive)?;
            output.set_volume_percent(state.volume);
            output.set_paused(state.paused);
            output.set_spectrum_sink(self.spectrum.sink());
        } else {
            let output = AudioOutput::open(device_name, exclusive)?;
            output.set_volume_percent(state.volume);
            output.set_paused(state.paused);
            output.set_spectrum_sink(self.spectrum.sink());
            *guard = Some(output);
        }
        crate::emit_event(crate::log::event(
            crate::log::LogLevel::Info,
            format!(
                "audio output reopened: device={device_name}, requestedExclusive={exclusive}, playing={}, paused={}",
                state.playing, state.paused
            ),
        ));
        Ok(())
    }

    fn with_output(&self, f: impl FnOnce(&AudioOutput)) {
        if let Ok(guard) = self.output.lock() {
            if let Some(output) = guard.as_ref() {
                f(output);
            }
        }
    }

    fn audio_params(&self) -> String {
        self.output
            .lock()
            .ok()
            .and_then(|guard| {
                guard.as_ref().map(|output| {
                    format!(
                        "format={} samplerate={} channels={} exclusive={} bufferedFrames={} renderedFrames={} underruns={} error={}",
                        decode::PCM_FORMAT_SAMPLE,
                        output.sample_rate(),
                        output.channels(),
                        if output.exclusive() { "yes" } else { "no" },
                        output.buffered_frames(),
                        output.rendered_frames(),
                        output.underruns(),
                        output.last_error().unwrap_or_default()
                    )
                })
            })
            .unwrap_or_default()
    }

    fn exclusive_requested(&self) -> bool {
        self.config
            .lock()
            .map(|config| config.exclusive)
            .unwrap_or(false)
    }

    fn output_exclusive(&self) -> bool {
        self.output
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(AudioOutput::exclusive))
            .unwrap_or(false)
    }

    fn ensure_output(&self) -> PlayerResult<AudioOutput> {
        if let Ok(guard) = self.output.lock() {
            if let Some(output) = guard.as_ref() {
                return Ok(output.clone());
            }
        }

        let device_name = self.state().audio_device;
        self.reopen_output(&device_name)?;
        self.output
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().cloned())
            .ok_or_else(|| PlayerError::Backend("audio output did not open".to_string()))
    }

    fn is_current_load(&self, seq: u64) -> bool {
        self.load_seq.load(Ordering::SeqCst) == seq && !self.shutdown.load(Ordering::SeqCst)
    }

    fn send_worker_command(&self, command: PlaybackCommand) -> PlayerResult<()> {
        let sender = self
            .worker_command_sender()
            .ok_or_else(|| PlayerError::State("no decoder worker is loaded".to_string()))?;
        sender
            .send(command)
            .map_err(|err| PlayerError::State(format!("decoder worker is not available: {err}")))
    }

    fn worker_command_sender(&self) -> Option<mpsc::Sender<PlaybackCommand>> {
        self.worker
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|worker| worker.commands.clone()))
    }

    fn stop_worker(&self) {
        if let Ok(mut guard) = self.worker.lock() {
            if let Some(mut worker) = guard.take() {
                worker.shutdown();
            }
        }
    }

    fn stop_worker_detached(&self) {
        self.stop_worker();
    }

    fn cancel_pending_load(&self) {
        self.load_seq.fetch_add(1, Ordering::SeqCst);
        if let Ok(guard) = self.load_interrupt.lock() {
            if let Some(interrupt) = guard.as_ref() {
                interrupt.store(true, Ordering::SeqCst);
            }
        }
    }

    fn loop_enabled(&self) -> bool {
        self.config
            .lock()
            .map(|config| config.loop_file == "inf")
            .unwrap_or(false)
    }
}

fn normalize_device_name(device_name: &str) -> String {
    let trimmed = device_name.trim();
    if trimmed.is_empty() {
        "auto".to_string()
    } else {
        trimmed.to_string()
    }
}

fn switch_active_output_device(
    output_slot: &Arc<Mutex<Option<AudioOutput>>>,
    device_name: &str,
    exclusive: bool,
    volume: f64,
    paused: bool,
    spectrum_sink: Option<Arc<Mutex<crate::spectrum::SampleRing>>>,
) -> PlayerResult<bool> {
    let output = output_slot
        .lock()
        .map_err(|err| PlayerError::State(format!("failed to lock output slot: {err}")))?
        .as_ref()
        .cloned();
    let Some(output) = output else {
        return Ok(false);
    };
    output.reopen(device_name, exclusive)?;
    output.set_volume_percent(volume);
    output.set_paused(paused);
    output.set_spectrum_sink(spectrum_sink);
    Ok(true)
}

fn build_audio_filter(config: &PlayerConfig) -> String {
    let mut filters = Vec::new();
    if !config.impulse_response_path.is_empty() {
        filters.push(format!(
            "@irs:lavfi=graph=amovie='{}',afir,amix@irsmix=weights='1 {}'",
            escape_lavfi_path(&config.impulse_response_path),
            config.impulse_response_mix
        ));
    }
    for (index, gain) in config.equalizer_gains.iter().enumerate() {
        if gain.abs() > 0.001 {
            filters.push(format!(
                "equalizer=f={}:g={gain}:w=1",
                EQ_FREQUENCIES[index]
            ));
        }
    }
    if config.normalization_gain_db.abs() > 0.001 {
        filters.push(format!("volume={}dB", config.normalization_gain_db));
    }
    filters.join(",")
}

fn parse_ir_mix_weight(arg: &str) -> PlayerResult<f64> {
    let mix = arg
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| {
            PlayerError::InvalidInput("IR weights must include dry and wet values".to_string())
        })?
        .parse::<f64>()
        .map_err(|_| PlayerError::InvalidInput(format!("invalid IR weights: {arg}")))?;
    clamp_f64(mix, 0.0, 1.0)
}

fn escape_lavfi_path(path: &str) -> String {
    path.replace('\\', "/")
        .replace('\'', "\\'")
        .replace(':', "\\:")
}

impl DecoderWorker {
    fn start(
        decoder: FfmpegDecoder,
        output: AudioOutput,
        state: Arc<Mutex<PlayerState>>,
        config: Arc<Mutex<PlayerConfig>>,
        shutdown: Arc<AtomicBool>,
        interrupt: Arc<AtomicBool>,
        seek_seq: Arc<AtomicU64>,
        loop_file: bool,
    ) -> PlayerResult<Self> {
        let (command_tx, command_rx) = mpsc::channel();
        let interrupt_for_thread = interrupt.clone();
        let handle = thread::Builder::new()
            .name("echo-ffmpeg-decoder".to_string())
            .spawn(move || {
                run_decoder_worker(
                    decoder,
                    output,
                    state,
                    config,
                    shutdown,
                    interrupt_for_thread,
                    command_rx,
                    seek_seq,
                    loop_file,
                )
            })
            .map_err(|err| {
                PlayerError::Backend(format!("failed to spawn decoder worker: {err}"))
            })?;

        Ok(Self {
            commands: command_tx,
            handle: Some(handle),
            interrupt,
        })
    }

    fn shutdown(&mut self) {
        self.interrupt.store(true, Ordering::SeqCst);
        let _ = self.commands.send(PlaybackCommand::Shutdown);
        if let Some(handle) = self.handle.take() {
            let _ = thread::Builder::new()
                .name("echo-ffmpeg-decoder-reaper".to_string())
                .spawn(move || {
                    let _ = handle.join();
                });
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_decoder_worker(
    mut decoder: FfmpegDecoder,
    output: AudioOutput,
    state: Arc<Mutex<PlayerState>>,
    config: Arc<Mutex<PlayerConfig>>,
    shutdown: Arc<AtomicBool>,
    interrupt: Arc<AtomicBool>,
    commands: mpsc::Receiver<PlaybackCommand>,
    seek_seq: Arc<AtomicU64>,
    loop_file: bool,
) {
    let mut playing = false;
    let mut buffering = false;
    let mut buffering_resume_ms = REBUFFER_RESUME_MS;
    let mut dsp = DspProcessor::new();
    let mut last_time_event = Instant::now();

    loop {
        if shutdown.load(Ordering::SeqCst) || interrupt.load(Ordering::SeqCst) {
            break;
        }

        if !playing {
            match commands.recv() {
                Ok(command) => {
                    if !handle_decoder_command(
                        command,
                        &mut decoder,
                        &output,
                        &state,
                        &mut dsp,
                        &mut playing,
                        &mut buffering,
                        &mut buffering_resume_ms,
                        &seek_seq,
                    ) {
                        break;
                    }
                }
                Err(_) => break,
            }
            continue;
        }

        while let Ok(command) = commands.try_recv() {
            if !handle_decoder_command(
                command,
                &mut decoder,
                &output,
                &state,
                &mut dsp,
                &mut playing,
                &mut buffering,
                &mut buffering_resume_ms,
                &seek_seq,
            ) {
                return;
            }
            if !playing {
                break;
            }
        }
        if !playing {
            continue;
        }

        match decoder.read_chunk() {
            Ok(DecodeReadResult::Chunk(chunk)) => {
                if let Err(err) = push_chunk_with_backpressure(
                    &output,
                    &commands,
                    &mut decoder,
                    &state,
                    &config,
                    &mut dsp,
                    &mut playing,
                    &mut buffering,
                    &mut buffering_resume_ms,
                    &seek_seq,
                    chunk,
                ) {
                    output.set_paused(true);
                    if let Ok(mut state) = state.lock() {
                        state.playing = false;
                        state.paused = true;
                    }
                    crate::emit_event(PlayerEvent::error(err.to_string()));
                    break;
                }
                let now = Instant::now();
                if now.duration_since(last_time_event) >= Duration::from_millis(200) {
                    let time_pos = state.lock().map(|state| state.time_pos).unwrap_or_default();
                    crate::emit_event(PlayerEvent::time_update(time_pos));
                    last_time_event = now;
                }
            }
            Ok(DecodeReadResult::Buffering) => {
                if playing && output.buffered_frames() == 0 {
                    if !buffering {
                        buffering_resume_ms = REBUFFER_RESUME_MS;
                    }
                    buffering = true;
                    output.set_paused(true);
                }
                thread::sleep(BUFFERING_RETRY_DELAY);
            }
            Ok(DecodeReadResult::Eof) => {
                if loop_file && decoder.seek(0.0).is_ok() {
                    output.clear_blocking();
                    dsp.reset();
                    buffering = true;
                    buffering_resume_ms = START_PREBUFFER_MS;
                    output.set_paused(true);
                    continue;
                }
                if let Ok(mut state) = state.lock() {
                    state.playing = false;
                    state.paused = true;
                }
                output.set_paused(true);
                crate::emit_event(PlayerEvent::playback_end("eof"));
                playing = false;
            }
            Err(err) => {
                if interrupt.load(Ordering::SeqCst) || decoder.interrupted() {
                    break;
                }
                output.set_paused(true);
                if let Ok(mut state) = state.lock() {
                    state.playing = false;
                    state.paused = true;
                }
                crate::emit_event(PlayerEvent::error(err.to_string()));
                crate::emit_event(PlayerEvent::playback_end("error"));
                break;
            }
        }
    }

    output.set_paused(true);
}

#[allow(clippy::too_many_arguments)]
fn handle_decoder_command(
    command: PlaybackCommand,
    decoder: &mut FfmpegDecoder,
    output: &AudioOutput,
    state: &Arc<Mutex<PlayerState>>,
    dsp: &mut DspProcessor,
    playing: &mut bool,
    buffering: &mut bool,
    buffering_resume_ms: &mut usize,
    seek_seq: &Arc<AtomicU64>,
) -> bool {
    match command {
        PlaybackCommand::Play => {
            *playing = true;
            *buffering_resume_ms = START_PREBUFFER_MS;
            *buffering = output.buffered_frames() < prebuffer_frames(output, START_PREBUFFER_MS);
            output.set_paused(*buffering);
            if let Ok(mut state) = state.lock() {
                state.playing = true;
                state.paused = false;
            }
        }
        PlaybackCommand::Pause => {
            output.set_paused(true);
            *playing = false;
            *buffering = false;
            *buffering_resume_ms = REBUFFER_RESUME_MS;
            if let Ok(mut state) = state.lock() {
                state.playing = false;
                state.paused = true;
            }
        }
        PlaybackCommand::RefreshOutput => {
            let should_play = state
                .lock()
                .map(|state| state.playing && !state.paused)
                .unwrap_or(*playing);
            if should_play {
                *playing = true;
                *buffering_resume_ms = START_PREBUFFER_MS;
                *buffering =
                    output.buffered_frames() < prebuffer_frames(output, START_PREBUFFER_MS);
                output.set_paused(*buffering);
            } else {
                *playing = false;
                *buffering = false;
                *buffering_resume_ms = REBUFFER_RESUME_MS;
                output.set_paused(true);
            }
        }
        PlaybackCommand::Seek { time, seq } => {
            if seek_seq.load(Ordering::SeqCst) != seq {
                return true;
            }
            output.clear_blocking();
            dsp.reset();
            if *playing {
                *buffering = true;
                *buffering_resume_ms = SEEK_RESUME_MS;
                output.set_paused(true);
            }
            if let Err(err) = decoder.seek(time) {
                crate::emit_event(PlayerEvent::error(err.to_string()));
                *playing = false;
                output.set_paused(true);
            }
            if let Ok(mut state) = state.lock() {
                state.time_pos = time.max(0.0);
            }
            crate::emit_event(PlayerEvent::time_update(time.max(0.0)));
        }
        PlaybackCommand::Shutdown => {
            output.clear_blocking();
            output.set_paused(true);
            dsp.reset();
            *buffering = false;
            *buffering_resume_ms = REBUFFER_RESUME_MS;
            return false;
        }
    }
    true
}

#[allow(clippy::too_many_arguments)]
fn push_chunk_with_backpressure(
    output: &AudioOutput,
    commands: &mpsc::Receiver<PlaybackCommand>,
    decoder: &mut FfmpegDecoder,
    state: &Arc<Mutex<PlayerState>>,
    config: &Arc<Mutex<PlayerConfig>>,
    dsp: &mut DspProcessor,
    playing: &mut bool,
    buffering: &mut bool,
    buffering_resume_ms: &mut usize,
    seek_seq: &Arc<AtomicU64>,
    mut chunk: decode::DecodedAudioChunk,
) -> PlayerResult<()> {
    if let Ok(mut state) = state.lock() {
        state.time_pos = chunk.time_pos;
    }

    let settings = config
        .lock()
        .ok()
        .and_then(|config| config.dsp_settings().ok())
        .unwrap_or_default();
    dsp.process(&mut chunk.samples, &chunk.format, &settings)?;

    let mut offset = 0usize;
    while offset < chunk.samples.len() && *playing {
        while let Ok(command) = commands.try_recv() {
            let discard_current_chunk = matches!(command, PlaybackCommand::Seek { .. });
            if !handle_decoder_command(
                command,
                decoder,
                output,
                state,
                dsp,
                playing,
                buffering,
                buffering_resume_ms,
                seek_seq,
            ) {
                return Ok(());
            }
            if !*playing {
                return Ok(());
            }
            if discard_current_chunk {
                return Ok(());
            }
        }

        let remaining = &chunk.samples[offset..];
        let push_len = output_push_sample_count(remaining.len(), chunk.format.channels);
        let written = output.push_interleaved(&remaining[..push_len]);
        if written == 0 {
            maybe_resume_after_prebuffer(output, buffering, *buffering_resume_ms);
            thread::sleep(Duration::from_millis(4));
        } else {
            offset += written;
            maybe_resume_after_prebuffer(output, buffering, *buffering_resume_ms);
        }
    }
    Ok(())
}

fn output_push_sample_count(remaining_samples: usize, channels: usize) -> usize {
    if remaining_samples == 0 {
        return 0;
    }
    let channels = channels.max(1);
    let max_samples = MAX_OUTPUT_PUSH_FRAMES
        .saturating_mul(channels)
        .max(channels);
    let limit = remaining_samples.min(max_samples);
    let aligned = limit - (limit % channels);
    if aligned == 0 {
        remaining_samples.min(channels)
    } else {
        aligned
    }
}

fn maybe_resume_after_prebuffer(output: &AudioOutput, buffering: &mut bool, resume_ms: usize) {
    if !*buffering {
        return;
    }
    let target = prebuffer_frames(output, resume_ms);
    if output.buffered_frames() >= target {
        output.set_paused(false);
        *buffering = false;
    }
}

fn prebuffer_frames(output: &AudioOutput, millis: usize) -> usize {
    (output.sample_rate() as usize)
        .saturating_mul(millis)
        .saturating_div(1000)
        .max(1)
}

#[cfg(test)]
mod tests {
    use super::{output_push_sample_count, MAX_OUTPUT_PUSH_FRAMES};

    #[test]
    fn output_push_chunks_are_bounded_and_frame_aligned() {
        assert_eq!(output_push_sample_count(0, 2), 0);
        assert_eq!(output_push_sample_count(1, 2), 1);
        assert_eq!(output_push_sample_count(4095, 2), 4094);
        assert_eq!(
            output_push_sample_count(MAX_OUTPUT_PUSH_FRAMES * 2 + 1024, 2),
            MAX_OUTPUT_PUSH_FRAMES * 2
        );
        assert_eq!(
            output_push_sample_count(MAX_OUTPUT_PUSH_FRAMES * 6 + 5, 6),
            MAX_OUTPUT_PUSH_FRAMES * 6
        );
    }
}
