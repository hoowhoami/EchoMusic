use crate::mpv_ffi::*;
use crate::types::{AudioSpectrumFrame, AudioSpectrumOptions, AudioSpectrumStatus, PlayerState};
use std::collections::VecDeque;
use std::ffi::{CStr, CString};
use std::fs::{remove_file, File};
use std::io::{Read, Seek, SeekFrom};
use std::os::raw::{c_char, c_int, c_void};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: usize = 2;
const BYTES_PER_SAMPLE: usize = 2;
const FRAME_POLL_MS: u64 = 16;
const STATE_SYNC_MS: u64 = 250;
const MAX_PCM_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RING_FACTOR: usize = 4;
const SIDECAR_CACHE_SECS: &str = "15";
const SIDECAR_DEMUXER_MAX_BYTES: &str = "16MiB";
const SIDECAR_DEMUXER_MAX_BACK_BYTES: &str = "4MiB";
const DEFAULT_FPS: f64 = 30.0;
const DEFAULT_BIN_COUNT: u32 = 128;
const DEFAULT_FFT_SIZE: u32 = 2048;
const DEFAULT_SMOOTHING: f64 = 0.72;
const DEFAULT_MIN_FREQ: f64 = 20.0;
const DEFAULT_MAX_FREQ: f64 = 20_000.0;

#[derive(Clone, Debug)]
struct SpectrumOptions {
    fps: f64,
    bin_count: usize,
    fft_size: usize,
    smoothing: f64,
    min_frequency: f64,
    max_frequency: f64,
    scale: String,
    include_waveform: bool,
}

#[derive(Clone, Copy, Debug)]
struct Complex {
    re: f64,
    im: f64,
}

impl SpectrumOptions {
    fn from_input(input: AudioSpectrumOptions) -> Self {
        let min_frequency = input
            .min_frequency
            .unwrap_or(DEFAULT_MIN_FREQ)
            .clamp(1.0, SAMPLE_RATE as f64 / 2.0 - 1.0);
        let max_frequency = input
            .max_frequency
            .unwrap_or(DEFAULT_MAX_FREQ)
            .clamp(min_frequency + 1.0, SAMPLE_RATE as f64 / 2.0);
        let fft_size =
            normalize_power_of_two(input.fft_size.unwrap_or(DEFAULT_FFT_SIZE), 256, 8192);

        Self {
            fps: input.fps.unwrap_or(DEFAULT_FPS).clamp(1.0, 60.0),
            bin_count: input.bin_count.unwrap_or(DEFAULT_BIN_COUNT).clamp(8, 512) as usize,
            fft_size: fft_size as usize,
            smoothing: input
                .smoothing
                .unwrap_or(DEFAULT_SMOOTHING)
                .clamp(0.0, 0.95),
            min_frequency,
            max_frequency,
            scale: match input.scale.as_deref() {
                Some("linear") => "linear".to_string(),
                Some("mel") => "mel".to_string(),
                _ => "log".to_string(),
            },
            include_waveform: input.include_waveform.unwrap_or(false),
        }
    }
}

pub struct SpectrumAnalyzer {
    options: Arc<Mutex<SpectrumOptions>>,
    latest_frame: Arc<Mutex<Option<AudioSpectrumFrame>>>,
    status: Arc<Mutex<AudioSpectrumStatus>>,
    shutdown: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

struct SidecarMpv {
    lib: Arc<MpvLib>,
    handle: *mut MpvHandle,
    pcm_path: PathBuf,
    loaded_path: String,
    audio_track_id: i64,
    read_offset: u64,
    leftover: Vec<u8>,
}

impl Drop for SidecarMpv {
    fn drop(&mut self) {
        unsafe {
            (self.lib.mpv_terminate_destroy)(self.handle);
        }
        let _ = remove_file(&self.pcm_path);
    }
}

impl SpectrumAnalyzer {
    pub fn new() -> Self {
        Self {
            options: Arc::new(Mutex::new(SpectrumOptions::from_input(
                AudioSpectrumOptions {
                    fps: None,
                    bin_count: None,
                    fft_size: None,
                    smoothing: None,
                    min_frequency: None,
                    max_frequency: None,
                    scale: None,
                    include_waveform: None,
                },
            ))),
            latest_frame: Arc::new(Mutex::new(None)),
            status: Arc::new(Mutex::new(AudioSpectrumStatus {
                available: true,
                running: false,
                provider: "native-mpv".to_string(),
                reason: None,
                subscriber_count: None,
            })),
            shutdown: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
        }
    }

    pub fn start(
        &self,
        lib: Arc<MpvLib>,
        player_state: Arc<Mutex<PlayerState>>,
        input: AudioSpectrumOptions,
    ) -> AudioSpectrumStatus {
        if let Ok(mut options) = self.options.lock() {
            *options = SpectrumOptions::from_input(input);
        }

        let needs_spawn = self
            .worker
            .lock()
            .map(|worker| worker.is_none())
            .unwrap_or(false);

        if needs_spawn {
            self.shutdown.store(false, Ordering::SeqCst);
            let options = self.options.clone();
            let latest_frame = self.latest_frame.clone();
            let status = self.status.clone();
            let shutdown = self.shutdown.clone();
            let handle = std::thread::Builder::new()
                .name("mpv-spectrum".to_string())
                .spawn(move || {
                    run_worker(lib, player_state, options, latest_frame, status, shutdown)
                });

            match handle {
                Ok(handle) => {
                    if let Ok(mut worker) = self.worker.lock() {
                        *worker = Some(handle);
                    }
                }
                Err(err) => {
                    let status = AudioSpectrumStatus {
                        available: false,
                        running: false,
                        provider: "unavailable".to_string(),
                        reason: Some(format!("failed to spawn spectrum worker: {err}")),
                        subscriber_count: None,
                    };
                    if let Ok(mut current) = self.status.lock() {
                        *current = status.clone();
                    }
                    return status;
                }
            }
        }

        self.current_status()
    }

    pub fn stop(&self) -> AudioSpectrumStatus {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(handle) = worker.take() {
                let _ = handle.join();
            }
        }
        if let Ok(mut frame) = self.latest_frame.lock() {
            *frame = None;
        }
        let status = AudioSpectrumStatus {
            available: true,
            running: false,
            provider: "native-mpv".to_string(),
            reason: None,
            subscriber_count: None,
        };
        if let Ok(mut current) = self.status.lock() {
            *current = status.clone();
        }
        status
    }

    pub fn snapshot(&self) -> Option<AudioSpectrumFrame> {
        self.latest_frame
            .lock()
            .ok()
            .and_then(|frame| frame.clone())
    }

    pub fn current_status(&self) -> AudioSpectrumStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| AudioSpectrumStatus {
                available: false,
                running: false,
                provider: "unavailable".to_string(),
                reason: Some("spectrum status lock poisoned".to_string()),
                subscriber_count: None,
            })
    }
}

fn run_worker(
    lib: Arc<MpvLib>,
    player_state: Arc<Mutex<PlayerState>>,
    options: Arc<Mutex<SpectrumOptions>>,
    latest_frame: Arc<Mutex<Option<AudioSpectrumFrame>>>,
    status: Arc<Mutex<AudioSpectrumStatus>>,
    shutdown: Arc<AtomicBool>,
) {
    let mut sidecar: Option<SidecarMpv> = None;
    let mut sample_ring: VecDeque<f64> = VecDeque::new();
    let mut previous_bins: Vec<f64> = Vec::new();
    let mut last_frame = Instant::now() - Duration::from_secs(1);
    let mut last_sync = Instant::now() - Duration::from_secs(1);

    set_status(&status, true, true, None);

    while !shutdown.load(Ordering::SeqCst) {
        let state = player_state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_else(|err| err.into_inner().clone());
        let current_options = options
            .lock()
            .map(|options| options.clone())
            .unwrap_or_else(|err| err.into_inner().clone());

        if state.path.is_empty() {
            sidecar = None;
            sample_ring.clear();
            previous_bins.clear();
            maybe_publish_silence(
                &latest_frame,
                &current_options,
                &state,
                &mut last_frame,
                "idle",
            );
            std::thread::sleep(Duration::from_millis(FRAME_POLL_MS));
            continue;
        }

        let should_reload = sidecar
            .as_ref()
            .map(|sidecar| sidecar.loaded_path != state.path)
            .unwrap_or(true);

        if should_reload {
            sidecar = None;
            sample_ring.clear();
            previous_bins.clear();
            match SidecarMpv::new(
                lib.clone(),
                &state.path,
                state.paused,
                state.time_pos,
                state.audio_track_id,
            ) {
                Ok(next) => {
                    sidecar = Some(next);
                    set_status(&status, true, true, None);
                }
                Err(reason) => {
                    set_status(&status, false, false, Some(reason));
                    maybe_publish_silence(
                        &latest_frame,
                        &current_options,
                        &state,
                        &mut last_frame,
                        "unavailable",
                    );
                    std::thread::sleep(Duration::from_millis(250));
                    continue;
                }
            }
        }

        if let Some(active) = sidecar.as_mut() {
            if last_sync.elapsed() >= Duration::from_millis(STATE_SYNC_MS) {
                let _ = active.set_pause(state.paused);
                if active.audio_track_id != state.audio_track_id {
                    let _ = active.set_audio_track(state.audio_track_id);
                }
                if !state.paused {
                    if let Ok(sidecar_time) = active.get_time_pos() {
                        if (sidecar_time - state.time_pos).abs() > 1.25 {
                            let _ = active.seek(state.time_pos);
                            sample_ring.clear();
                            previous_bins.clear();
                        }
                    }
                }
                last_sync = Instant::now();
            }

            if active.read_offset >= MAX_PCM_FILE_BYTES {
                sidecar = None;
                continue;
            }

            if let Err(reason) = active.read_samples(&mut sample_ring, current_options.fft_size) {
                set_status(&status, false, false, Some(reason));
                sidecar = None;
                continue;
            }
        }

        let frame_interval = Duration::from_secs_f64(1.0 / current_options.fps);
        if state.paused {
            maybe_publish_silence(
                &latest_frame,
                &current_options,
                &state,
                &mut last_frame,
                "paused",
            );
        } else if sample_ring.len() >= current_options.fft_size
            && last_frame.elapsed() >= frame_interval
        {
            let samples = latest_samples(&sample_ring, current_options.fft_size);
            let frame = build_frame(&samples, &current_options, &state, &mut previous_bins);
            if let Ok(mut latest) = latest_frame.lock() {
                *latest = Some(frame);
            }
            last_frame = Instant::now();
        }

        std::thread::sleep(Duration::from_millis(FRAME_POLL_MS));
    }

    sidecar = None;
    let _ = sidecar;
    set_status(&status, true, false, None);
}

impl SidecarMpv {
    fn new(
        lib: Arc<MpvLib>,
        path: &str,
        paused: bool,
        time_pos: f64,
        audio_track_id: i64,
    ) -> Result<Self, String> {
        let handle = unsafe { (lib.mpv_create)() };
        if handle.is_null() {
            return Err("spectrum sidecar mpv_create returned null".to_string());
        }

        let pcm_path = make_pcm_path();
        let mut sidecar = Self {
            lib,
            handle,
            pcm_path,
            loaded_path: path.to_string(),
            audio_track_id: 0,
            read_offset: 0,
            leftover: Vec::new(),
        };

        sidecar.set_option("idle", "yes")?;
        sidecar.set_option("pause", "yes")?;
        sidecar.set_option("video", "no")?;
        sidecar.set_option("terminal", "no")?;
        sidecar.set_option("config", "no")?;
        sidecar.set_option("audio-display", "no")?;
        sidecar.set_option("ao", "pcm")?;
        sidecar.set_option("ao-pcm-file", &sidecar.pcm_path.to_string_lossy())?;
        sidecar.set_option("ao-pcm-waveheader", "no")?;
        sidecar.set_option("ao-pcm-append", "no")?;
        sidecar.set_option("audio-format", "s16")?;
        sidecar.set_option("audio-samplerate", &SAMPLE_RATE.to_string())?;
        sidecar.set_option("audio-channels", "stereo")?;
        sidecar.set_option("af", "lavfi=[arealtime]")?;
        sidecar.set_option("user-agent", "Mozilla/5.0")?;
        sidecar.set_option("cache", "yes")?;
        sidecar.set_option("cache-secs", SIDECAR_CACHE_SECS)?;
        sidecar.set_option("demuxer-readahead-secs", SIDECAR_CACHE_SECS)?;
        sidecar.set_option("demuxer-max-bytes", SIDECAR_DEMUXER_MAX_BYTES)?;
        sidecar.set_option("demuxer-max-back-bytes", SIDECAR_DEMUXER_MAX_BACK_BYTES)?;

        let rc = unsafe { (sidecar.lib.mpv_initialize)(sidecar.handle) };
        if rc < 0 {
            return Err(format!(
                "spectrum sidecar initialize failed: {}",
                sidecar.error_string(rc)
            ));
        }

        sidecar.command(&["loadfile", path, "replace"])?;
        if audio_track_id > 0 {
            let _ = sidecar.set_audio_track(audio_track_id);
        }
        sidecar.set_pause(paused)?;
        if time_pos > 0.25 {
            let _ = sidecar.seek(time_pos);
        }
        Ok(sidecar)
    }

    fn set_option(&self, name: &str, value: &str) -> Result<(), String> {
        let c_name = CString::new(name).unwrap();
        let c_value = CString::new(value).unwrap();
        let rc = unsafe {
            (self.lib.mpv_set_option_string)(self.handle, c_name.as_ptr(), c_value.as_ptr())
        };
        if rc < 0 {
            Err(format!(
                "spectrum sidecar option {name}={value} failed: {}",
                self.error_string(rc)
            ))
        } else {
            Ok(())
        }
    }

    fn set_pause(&self, paused: bool) -> Result<(), String> {
        let c_name = CString::new("pause").unwrap();
        let mut flag: c_int = if paused { 1 } else { 0 };
        let rc = unsafe {
            (self.lib.mpv_set_property)(
                self.handle,
                c_name.as_ptr(),
                MPV_FORMAT_FLAG,
                &mut flag as *mut c_int as *mut c_void,
            )
        };
        if rc < 0 {
            Err(format!(
                "spectrum sidecar pause sync failed: {}",
                self.error_string(rc)
            ))
        } else {
            Ok(())
        }
    }

    fn get_time_pos(&self) -> Result<f64, String> {
        let c_name = CString::new("time-pos").unwrap();
        let mut value = 0.0;
        let rc = unsafe {
            (self.lib.mpv_get_property)(
                self.handle,
                c_name.as_ptr(),
                MPV_FORMAT_DOUBLE,
                &mut value as *mut f64 as *mut c_void,
            )
        };
        if rc < 0 {
            Err(format!(
                "spectrum sidecar time-pos failed: {}",
                self.error_string(rc)
            ))
        } else {
            Ok(value)
        }
    }

    fn seek(&self, time_pos: f64) -> Result<(), String> {
        self.command(&["seek", &time_pos.to_string(), "absolute+exact"])
    }

    fn set_audio_track(&mut self, track_id: i64) -> Result<(), String> {
        if track_id <= 0 {
            self.audio_track_id = track_id;
            return Ok(());
        }

        let c_name = CString::new("aid").unwrap();
        let mut value = track_id;
        let rc = unsafe {
            (self.lib.mpv_set_property)(
                self.handle,
                c_name.as_ptr(),
                MPV_FORMAT_INT64,
                &mut value as *mut i64 as *mut c_void,
            )
        };
        if rc < 0 {
            Err(format!(
                "spectrum sidecar audio track sync failed: {}",
                self.error_string(rc)
            ))
        } else {
            self.audio_track_id = track_id;
            Ok(())
        }
    }

    fn command(&self, args: &[&str]) -> Result<(), String> {
        let c_args: Vec<CString> = args.iter().map(|arg| CString::new(*arg).unwrap()).collect();
        let mut ptrs: Vec<*const c_char> = c_args.iter().map(|arg| arg.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        let rc = unsafe { (self.lib.mpv_command)(self.handle, ptrs.as_ptr()) };
        if rc < 0 {
            Err(format!(
                "spectrum sidecar command {:?} failed: {}",
                args,
                self.error_string(rc)
            ))
        } else {
            Ok(())
        }
    }

    fn read_samples(
        &mut self,
        sample_ring: &mut VecDeque<f64>,
        fft_size: usize,
    ) -> Result<(), String> {
        let Ok(metadata) = std::fs::metadata(&self.pcm_path) else {
            return Ok(());
        };
        if metadata.len() <= self.read_offset {
            return Ok(());
        }

        let mut file =
            File::open(&self.pcm_path).map_err(|err| format!("open spectrum pcm failed: {err}"))?;
        file.seek(SeekFrom::Start(self.read_offset))
            .map_err(|err| format!("seek spectrum pcm failed: {err}"))?;
        let mut chunk = Vec::new();
        file.read_to_end(&mut chunk)
            .map_err(|err| format!("read spectrum pcm failed: {err}"))?;
        self.read_offset += chunk.len() as u64;

        if !self.leftover.is_empty() {
            let mut merged = Vec::with_capacity(self.leftover.len() + chunk.len());
            merged.extend_from_slice(&self.leftover);
            merged.extend_from_slice(&chunk);
            chunk = merged;
            self.leftover.clear();
        }

        let frame_bytes = CHANNELS * BYTES_PER_SAMPLE;
        let complete_len = chunk.len() - (chunk.len() % frame_bytes);
        if complete_len < chunk.len() {
            self.leftover.extend_from_slice(&chunk[complete_len..]);
        }

        for frame in chunk[..complete_len].chunks_exact(frame_bytes) {
            let left = i16::from_le_bytes([frame[0], frame[1]]) as f64 / 32768.0;
            let right = i16::from_le_bytes([frame[2], frame[3]]) as f64 / 32768.0;
            sample_ring.push_back((left + right) * 0.5);
        }

        let max_len = fft_size * MAX_RING_FACTOR;
        while sample_ring.len() > max_len {
            sample_ring.pop_front();
        }
        Ok(())
    }

    fn error_string(&self, code: c_int) -> String {
        unsafe {
            let ptr = (self.lib.mpv_error_string)(code);
            if ptr.is_null() {
                return format!("error code {code}");
            }
            CStr::from_ptr(ptr).to_string_lossy().into_owned()
        }
    }
}

fn normalize_power_of_two(value: u32, min: u32, max: u32) -> u32 {
    let mut power = 1;
    while power < value {
        power *= 2;
    }
    power.clamp(min, max)
}

fn make_pcm_path() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("echo-mpv-spectrum-{nonce}.raw"))
}

fn set_status(
    status: &Arc<Mutex<AudioSpectrumStatus>>,
    available: bool,
    running: bool,
    reason: Option<String>,
) {
    if let Ok(mut current) = status.lock() {
        *current = AudioSpectrumStatus {
            available,
            running,
            provider: if available {
                "native-mpv".to_string()
            } else {
                "unavailable".to_string()
            },
            reason,
            subscriber_count: None,
        };
    }
}

fn maybe_publish_silence(
    latest_frame: &Arc<Mutex<Option<AudioSpectrumFrame>>>,
    options: &SpectrumOptions,
    state: &PlayerState,
    last_frame: &mut Instant,
    playback_state: &str,
) {
    let frame_interval = Duration::from_secs_f64(1.0 / options.fps.min(4.0));
    if last_frame.elapsed() < frame_interval {
        return;
    }

    let frame = AudioSpectrumFrame {
        source: if playback_state == "unavailable" {
            "unavailable".to_string()
        } else {
            "silence".to_string()
        },
        state: playback_state.to_string(),
        timestamp: now_ms(),
        time_pos: Some(state.time_pos),
        sample_rate: SAMPLE_RATE,
        fft_size: options.fft_size as u32,
        min_frequency: options.min_frequency,
        max_frequency: options.max_frequency,
        bins: vec![0; options.bin_count],
        waveform: options.include_waveform.then(|| vec![0.0; 256]),
        rms: 0.0,
        peak: 0.0,
    };
    if let Ok(mut latest) = latest_frame.lock() {
        *latest = Some(frame);
    }
    *last_frame = Instant::now();
}

fn latest_samples(sample_ring: &VecDeque<f64>, len: usize) -> Vec<f64> {
    let start = sample_ring.len().saturating_sub(len);
    sample_ring.iter().skip(start).copied().collect()
}

fn build_frame(
    samples: &[f64],
    options: &SpectrumOptions,
    state: &PlayerState,
    previous_bins: &mut Vec<f64>,
) -> AudioSpectrumFrame {
    let mut frequency_bins = apply_hann(samples, options.fft_size);
    let mut bins = Vec::with_capacity(options.bin_count);
    let window_sum = hann_window_sum(options.fft_size).max(1.0);
    fft_in_place(&mut frequency_bins);

    if previous_bins.len() != options.bin_count {
        previous_bins.clear();
        previous_bins.resize(options.bin_count, 0.0);
    }

    for index in 0..options.bin_count {
        let freq = bin_center_frequency(index, options);
        let magnitude = fft_magnitude(&frequency_bins, freq, window_sum);
        let db = 20.0 * (magnitude + 1e-9).log10();
        let normalized = ((db + 80.0) / 80.0).clamp(0.0, 1.0);
        let smoothed =
            previous_bins[index] * options.smoothing + normalized * (1.0 - options.smoothing);
        previous_bins[index] = smoothed;
        bins.push((smoothed * 255.0).round().clamp(0.0, 255.0) as u32);
    }

    let rms = (samples.iter().map(|sample| sample * sample).sum::<f64>()
        / samples.len().max(1) as f64)
        .sqrt()
        .clamp(0.0, 1.0);
    let peak = samples
        .iter()
        .map(|sample| sample.abs())
        .fold(0.0, f64::max)
        .clamp(0.0, 1.0);

    AudioSpectrumFrame {
        source: "mpv".to_string(),
        state: "playing".to_string(),
        timestamp: now_ms(),
        time_pos: Some(state.time_pos),
        sample_rate: SAMPLE_RATE,
        fft_size: options.fft_size as u32,
        min_frequency: options.min_frequency,
        max_frequency: options.max_frequency,
        bins,
        waveform: options.include_waveform.then(|| build_waveform(samples)),
        rms,
        peak,
    }
}

fn apply_hann(samples: &[f64], fft_size: usize) -> Vec<Complex> {
    let mut values = Vec::with_capacity(fft_size);
    for index in 0..fft_size {
        let sample = samples.get(index).copied().unwrap_or(0.0);
        let window = if fft_size > 1 {
            0.5 - 0.5 * ((2.0 * std::f64::consts::PI * index as f64) / (fft_size - 1) as f64).cos()
        } else {
            1.0
        };
        values.push(Complex {
            re: sample * window,
            im: 0.0,
        });
    }
    values
}

fn hann_window_sum(fft_size: usize) -> f64 {
    if fft_size <= 1 {
        return 1.0;
    }
    (0..fft_size)
        .map(|index| {
            0.5 - 0.5 * ((2.0 * std::f64::consts::PI * index as f64) / (fft_size - 1) as f64).cos()
        })
        .sum()
}

fn fft_in_place(values: &mut [Complex]) {
    let len = values.len();
    if len <= 1 {
        return;
    }

    let mut target = 0;
    for source in 1..len {
        let mut bit = len >> 1;
        while target & bit != 0 {
            target ^= bit;
            bit >>= 1;
        }
        target ^= bit;
        if source < target {
            values.swap(source, target);
        }
    }

    let mut step = 2;
    while step <= len {
        let half_step = step / 2;
        let angle = -2.0 * std::f64::consts::PI / step as f64;
        let phase_step_re = angle.cos();
        let phase_step_im = angle.sin();

        for start in (0..len).step_by(step) {
            let mut phase_re = 1.0;
            let mut phase_im = 0.0;

            for offset in 0..half_step {
                let even_index = start + offset;
                let odd_index = even_index + half_step;
                let odd = values[odd_index];
                let rotated = Complex {
                    re: odd.re * phase_re - odd.im * phase_im,
                    im: odd.re * phase_im + odd.im * phase_re,
                };
                let even = values[even_index];

                values[even_index] = Complex {
                    re: even.re + rotated.re,
                    im: even.im + rotated.im,
                };
                values[odd_index] = Complex {
                    re: even.re - rotated.re,
                    im: even.im - rotated.im,
                };

                let next_phase_re = phase_re * phase_step_re - phase_im * phase_step_im;
                let next_phase_im = phase_re * phase_step_im + phase_im * phase_step_re;
                phase_re = next_phase_re;
                phase_im = next_phase_im;
            }
        }

        step *= 2;
    }
}

fn fft_magnitude(frequency_bins: &[Complex], frequency: f64, window_sum: f64) -> f64 {
    if frequency_bins.is_empty() {
        return 0.0;
    }

    let max_index = frequency_bins.len() / 2;
    let position = (frequency / SAMPLE_RATE as f64) * frequency_bins.len() as f64;
    if position <= 0.0 {
        return normalized_fft_magnitude(frequency_bins[0], window_sum);
    }

    let lower_index = position.floor().clamp(0.0, max_index as f64) as usize;
    let upper_index = (lower_index + 1).min(max_index);
    let mix = (position - lower_index as f64).clamp(0.0, 1.0);
    let lower = normalized_fft_magnitude(frequency_bins[lower_index], window_sum);
    let upper = normalized_fft_magnitude(frequency_bins[upper_index], window_sum);
    (lower + (upper - lower) * mix).clamp(0.0, 1.0)
}

fn normalized_fft_magnitude(value: Complex, window_sum: f64) -> f64 {
    (2.0 * (value.re * value.re + value.im * value.im).sqrt() / window_sum).clamp(0.0, 1.0)
}

fn bin_center_frequency(index: usize, options: &SpectrumOptions) -> f64 {
    let ratio = (index as f64 + 0.5) / options.bin_count as f64;
    match options.scale.as_str() {
        "linear" => options.min_frequency + (options.max_frequency - options.min_frequency) * ratio,
        "mel" => {
            let min_mel = hz_to_mel(options.min_frequency);
            let max_mel = hz_to_mel(options.max_frequency);
            mel_to_hz(min_mel + (max_mel - min_mel) * ratio)
        }
        _ => {
            let min = options.min_frequency.max(1.0).ln();
            let max = options.max_frequency.max(options.min_frequency + 1.0).ln();
            (min + (max - min) * ratio).exp()
        }
    }
}

fn hz_to_mel(value: f64) -> f64 {
    2595.0 * (1.0 + value / 700.0).log10()
}

fn mel_to_hz(value: f64) -> f64 {
    700.0 * (10_f64.powf(value / 2595.0) - 1.0)
}

fn build_waveform(samples: &[f64]) -> Vec<f64> {
    const POINTS: usize = 256;
    if samples.is_empty() {
        return vec![0.0; POINTS];
    }
    (0..POINTS)
        .map(|index| {
            let source_index = index * samples.len() / POINTS;
            samples
                .get(source_index)
                .copied()
                .unwrap_or(0.0)
                .clamp(-1.0, 1.0)
        })
        .collect()
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or(0.0)
}
