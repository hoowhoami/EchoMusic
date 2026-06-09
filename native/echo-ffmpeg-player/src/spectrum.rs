use crate::types::PlayerState;
use napi_derive::napi;
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PROVIDER_PLAYER_CORE: &str = "player-core";
const PROVIDER_UNAVAILABLE: &str = "unavailable";
const DEFAULT_FPS: u32 = 30;
const MAX_FPS: u32 = 60;
const DEFAULT_BIN_COUNT: u32 = 128;
const MAX_BIN_COUNT: u32 = 512;
const DEFAULT_FFT_SIZE: u32 = 2048;
const MIN_FFT_SIZE: u32 = 512;
const MAX_FFT_SIZE: u32 = 8192;
const DEFAULT_MIN_FREQUENCY: f64 = 20.0;
const DEFAULT_MAX_FREQUENCY: f64 = 20_000.0;

#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct SpectrumOptions {
    pub fps: Option<u32>,
    pub bin_count: Option<u32>,
    pub fft_size: Option<u32>,
    pub smoothing: Option<f64>,
    pub min_frequency: Option<f64>,
    pub max_frequency: Option<f64>,
    pub scale: Option<String>,
    pub include_waveform: Option<bool>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct SpectrumStatus {
    pub available: bool,
    pub running: bool,
    pub provider: String,
    pub reason: Option<String>,
    pub subscriber_count: Option<u32>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct SpectrumFrame {
    pub source: String,
    pub state: String,
    pub timestamp: f64,
    pub time_pos: Option<f64>,
    pub sample_rate: u32,
    pub fft_size: u32,
    pub min_frequency: f64,
    pub max_frequency: f64,
    pub bins: Vec<u32>,
    pub waveform: Option<Vec<f64>>,
    pub rms: f64,
    pub peak: f64,
}

pub struct SpectrumTap {
    inner: Arc<Mutex<SpectrumTapInner>>,
}

struct SpectrumTapInner {
    session: Option<SpectrumSession>,
    last_status: SpectrumStatus,
}

struct SpectrumSession {
    ring: Arc<Mutex<SampleRing>>,
    latest_frame: Arc<Mutex<Option<SpectrumFrame>>>,
    stop_flag: Arc<AtomicBool>,
    analyzer_thread: Option<JoinHandle<()>>,
}

impl SpectrumTap {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(SpectrumTapInner {
                session: None,
                last_status: stopped_status(),
            })),
        }
    }

    pub fn start(
        &self,
        options: Option<SpectrumOptions>,
        sample_rate: u32,
        state: Arc<Mutex<PlayerState>>,
    ) -> SpectrumStatus {
        let sample_rate = sample_rate.max(1);
        let mut inner = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        inner.stop_session();

        let analyzer_options = AnalyzerOptions::from_napi(options, sample_rate);
        let ring_capacity = sample_rate as usize * 2;
        let ring = Arc::new(Mutex::new(SampleRing::new(ring_capacity)));
        let latest_frame = Arc::new(Mutex::new(None));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let analyzer_thread = spawn_analyzer(
            analyzer_options,
            sample_rate,
            ring.clone(),
            latest_frame.clone(),
            stop_flag.clone(),
            state,
        );

        inner.session = Some(SpectrumSession {
            ring,
            latest_frame,
            stop_flag,
            analyzer_thread: Some(analyzer_thread),
        });
        inner.last_status = running_status();
        inner.last_status.clone()
    }

    pub fn stop(&self) -> SpectrumStatus {
        let mut inner = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        inner.stop_session();
        inner.last_status = stopped_status();
        inner.last_status.clone()
    }

    pub fn status(&self) -> SpectrumStatus {
        let inner = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        if inner.session.is_some() {
            return running_status();
        }
        inner.last_status.clone()
    }

    pub fn snapshot(&self) -> Option<SpectrumFrame> {
        let inner = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        inner
            .session
            .as_ref()
            .and_then(|session| session.latest_frame.lock().ok()?.clone())
    }

    pub fn sink(&self) -> Option<Arc<Mutex<SampleRing>>> {
        let inner = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        inner
            .session
            .as_ref()
            .map(|session| Arc::clone(&session.ring))
    }
}

impl Drop for SpectrumTap {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

impl SpectrumTapInner {
    fn stop_session(&mut self) {
        if let Some(mut session) = self.session.take() {
            session.stop_flag.store(true, Ordering::Release);
            if let Some(handle) = session.analyzer_thread.take() {
                let _ = handle.join();
            }
        }
    }
}

pub struct SampleRing {
    buffer: Vec<f32>,
    write_index: usize,
    written: usize,
}

impl SampleRing {
    fn new(capacity: usize) -> Self {
        Self {
            buffer: vec![0.0; capacity.max(1)],
            write_index: 0,
            written: 0,
        }
    }

    pub fn push(&mut self, sample: f32) {
        self.buffer[self.write_index] = sample.clamp(-1.0, 1.0);
        self.write_index = (self.write_index + 1) % self.buffer.len();
        self.written = self.written.saturating_add(1);
    }

    fn latest_into(&self, output: &mut [f32]) {
        let len = output.len();
        if len == 0 {
            return;
        }

        output.fill(0.0);
        let available = self.written.min(self.buffer.len()).min(len);
        let start_output = len - available;
        let start_ring = (self.write_index + self.buffer.len() - available) % self.buffer.len();
        for index in 0..available {
            output[start_output + index] = self.buffer[(start_ring + index) % self.buffer.len()];
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum SpectrumScale {
    Linear,
    Log,
    Mel,
}

impl SpectrumScale {
    fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("log").to_ascii_lowercase().as_str() {
            "linear" => Self::Linear,
            "mel" => Self::Mel,
            _ => Self::Log,
        }
    }
}

#[derive(Clone, Debug)]
struct AnalyzerOptions {
    fps: u32,
    bin_count: usize,
    fft_size: usize,
    smoothing: f32,
    min_frequency: f32,
    max_frequency: f32,
    scale: SpectrumScale,
    include_waveform: bool,
}

impl AnalyzerOptions {
    fn from_napi(options: Option<SpectrumOptions>, sample_rate: u32) -> Self {
        let options = options.unwrap_or_default();
        let fps = clamp_u32(options.fps.unwrap_or(DEFAULT_FPS), 1, MAX_FPS);
        let bin_count = clamp_u32(
            options.bin_count.unwrap_or(DEFAULT_BIN_COUNT),
            8,
            MAX_BIN_COUNT,
        ) as usize;
        let fft_size = sanitize_fft_size(options.fft_size.unwrap_or(DEFAULT_FFT_SIZE)) as usize;
        let smoothing = options.smoothing.unwrap_or(0.65).clamp(0.0, 0.95) as f32;
        let nyquist = (sample_rate as f64 * 0.5).max(1.0);
        let min_frequency = options
            .min_frequency
            .unwrap_or(DEFAULT_MIN_FREQUENCY)
            .clamp(1.0, nyquist) as f32;
        let mut max_frequency = options
            .max_frequency
            .unwrap_or(DEFAULT_MAX_FREQUENCY)
            .clamp(min_frequency as f64 + 1.0, nyquist) as f32;
        if max_frequency <= min_frequency {
            max_frequency = (min_frequency + 1.0).min(nyquist as f32);
        }

        Self {
            fps,
            bin_count,
            fft_size,
            smoothing,
            min_frequency,
            max_frequency,
            scale: SpectrumScale::parse(options.scale.as_deref()),
            include_waveform: options.include_waveform.unwrap_or(false),
        }
    }
}

struct SpectrumAnalyzer {
    options: AnalyzerOptions,
    sample_rate: u32,
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    window_sum: f32,
    fft_buffer: Vec<Complex<f32>>,
    scratch: Vec<f32>,
    previous_bins: Vec<f32>,
}

impl SpectrumAnalyzer {
    fn new(options: AnalyzerOptions, sample_rate: u32) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(options.fft_size);
        let window = hann_window(options.fft_size);
        let window_sum = window.iter().sum::<f32>().max(1.0);
        let fft_buffer = vec![Complex::new(0.0, 0.0); options.fft_size];
        let scratch = vec![0.0; options.fft_size];
        let previous_bins = vec![0.0; options.bin_count];

        Self {
            options,
            sample_rate,
            fft,
            window,
            window_sum,
            fft_buffer,
            scratch,
            previous_bins,
        }
    }

    fn scratch_mut(&mut self) -> &mut [f32] {
        &mut self.scratch
    }

    fn analyze(&mut self, playback: PlayerState) -> SpectrumFrame {
        let mut peak = 0.0f32;
        let mut square_sum = 0.0f32;

        for (index, sample) in self.scratch.iter().copied().enumerate() {
            let clamped = sample.clamp(-1.0, 1.0);
            peak = peak.max(clamped.abs());
            square_sum += clamped * clamped;
            self.fft_buffer[index] = Complex::new(clamped * self.window[index], 0.0);
        }

        let rms = (square_sum / self.scratch.len().max(1) as f32).sqrt();
        self.fft.process(&mut self.fft_buffer);

        let bins = self.build_bins();
        let waveform = if self.options.include_waveform {
            Some(self.build_waveform())
        } else {
            None
        };
        let state = if playback.idle {
            "idle"
        } else if playback.paused {
            "paused"
        } else if rms > 0.0005 || peak > 0.002 {
            "playing"
        } else {
            "idle"
        };

        SpectrumFrame {
            source: PROVIDER_PLAYER_CORE.to_string(),
            state: state.to_string(),
            timestamp: now_ms(),
            time_pos: (!playback.idle).then_some(playback.time_pos),
            sample_rate: self.sample_rate,
            fft_size: self.options.fft_size as u32,
            min_frequency: self.options.min_frequency as f64,
            max_frequency: self.options.max_frequency as f64,
            bins,
            waveform,
            rms: rms as f64,
            peak: peak as f64,
        }
    }

    fn build_bins(&mut self) -> Vec<u32> {
        let half = self.options.fft_size / 2;
        let bin_count = self.options.bin_count;
        let mut output = Vec::with_capacity(bin_count);

        for band in 0..bin_count {
            let start_freq = self.band_frequency(band as f32 / bin_count as f32);
            let end_freq = self.band_frequency((band + 1) as f32 / bin_count as f32);
            let mut start_index = ((start_freq / self.sample_rate as f32)
                * self.options.fft_size as f32)
                .floor() as usize;
            let mut end_index = ((end_freq / self.sample_rate as f32)
                * self.options.fft_size as f32)
                .ceil() as usize;

            start_index = start_index.clamp(1, half);
            end_index = end_index.clamp(start_index + 1, half + 1);

            let mut energy = 0.0f32;
            let mut count = 0usize;
            for index in start_index..end_index {
                let mag = self.fft_buffer[index].norm() * (2.0 / self.window_sum);
                energy += mag * mag;
                count += 1;
            }

            let magnitude = (energy / count.max(1) as f32).sqrt();
            let db = 20.0 * magnitude.max(1.0e-9).log10();
            let normalized = ((db + 80.0) / 80.0).clamp(0.0, 1.0);
            let smoothed = self.previous_bins[band] * self.options.smoothing
                + normalized * (1.0 - self.options.smoothing);
            self.previous_bins[band] = smoothed;
            output.push((smoothed * 255.0).round().clamp(0.0, 255.0) as u32);
        }

        output
    }

    fn build_waveform(&self) -> Vec<f64> {
        const WAVEFORM_POINTS: usize = 128;
        if self.scratch.is_empty() {
            return vec![0.0; WAVEFORM_POINTS];
        }

        (0..WAVEFORM_POINTS)
            .map(|index| {
                let source_index = index * (self.scratch.len() - 1) / (WAVEFORM_POINTS - 1);
                self.scratch[source_index].clamp(-1.0, 1.0) as f64
            })
            .collect()
    }

    fn band_frequency(&self, t: f32) -> f32 {
        let min = self.options.min_frequency.max(1.0);
        let max = self.options.max_frequency.max(min + 1.0);
        let t = t.clamp(0.0, 1.0);

        match self.options.scale {
            SpectrumScale::Linear => min + (max - min) * t,
            SpectrumScale::Log => {
                let min_ln = min.ln();
                let max_ln = max.ln();
                (min_ln + (max_ln - min_ln) * t).exp()
            }
            SpectrumScale::Mel => {
                let min_mel = hz_to_mel(min);
                let max_mel = hz_to_mel(max);
                mel_to_hz(min_mel + (max_mel - min_mel) * t)
            }
        }
    }
}

fn spawn_analyzer(
    options: AnalyzerOptions,
    sample_rate: u32,
    ring: Arc<Mutex<SampleRing>>,
    latest_frame: Arc<Mutex<Option<SpectrumFrame>>>,
    stop_flag: Arc<AtomicBool>,
    state: Arc<Mutex<PlayerState>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let fps = options.fps.max(1);
        let frame_interval = Duration::from_millis((1000 / fps as u64).max(1));
        let mut analyzer = SpectrumAnalyzer::new(options, sample_rate);

        while !stop_flag.load(Ordering::Acquire) {
            if let Ok(guard) = ring.lock() {
                guard.latest_into(analyzer.scratch_mut());
            }
            let playback = state
                .lock()
                .map(|state| state.clone())
                .unwrap_or_else(|err| err.into_inner().clone());
            let frame = analyzer.analyze(playback);
            if let Ok(mut guard) = latest_frame.lock() {
                *guard = Some(frame);
            }
            thread::sleep(frame_interval);
        }
    })
}

fn running_status() -> SpectrumStatus {
    SpectrumStatus {
        available: true,
        running: true,
        provider: PROVIDER_PLAYER_CORE.to_string(),
        reason: None,
        subscriber_count: None,
    }
}

fn stopped_status() -> SpectrumStatus {
    SpectrumStatus {
        available: true,
        running: false,
        provider: PROVIDER_PLAYER_CORE.to_string(),
        reason: None,
        subscriber_count: None,
    }
}

pub fn unavailable_status(reason: impl Into<String>) -> SpectrumStatus {
    SpectrumStatus {
        available: false,
        running: false,
        provider: PROVIDER_UNAVAILABLE.to_string(),
        reason: Some(reason.into()),
        subscriber_count: None,
    }
}

fn clamp_u32(value: u32, min: u32, max: u32) -> u32 {
    value.max(min).min(max)
}

fn sanitize_fft_size(value: u32) -> u32 {
    let mut size = value.clamp(MIN_FFT_SIZE, MAX_FFT_SIZE).next_power_of_two();
    if size > MAX_FFT_SIZE {
        size = MAX_FFT_SIZE;
    }
    size
}

fn hann_window(size: usize) -> Vec<f32> {
    if size <= 1 {
        return vec![1.0; size];
    }

    let denom = (size - 1) as f32;
    (0..size)
        .map(|index| {
            let phase = std::f32::consts::TAU * index as f32 / denom;
            0.5 - 0.5 * phase.cos()
        })
        .collect()
}

fn hz_to_mel(hz: f32) -> f32 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

fn mel_to_hz(mel: f32) -> f32 {
    700.0 * (10.0f32.powf(mel / 2595.0) - 1.0)
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::{AnalyzerOptions, SampleRing, SpectrumOptions};

    #[test]
    fn sample_ring_returns_latest_samples() {
        let mut ring = SampleRing::new(4);
        ring.push(0.1);
        ring.push(0.2);
        ring.push(0.3);
        ring.push(0.4);
        ring.push(0.5);

        let mut output = [0.0; 4];
        ring.latest_into(&mut output);
        assert_eq!(output, [0.2, 0.3, 0.4, 0.5]);
    }

    #[test]
    fn analyzer_options_sanitize_ranges() {
        let options = AnalyzerOptions::from_napi(
            Some(SpectrumOptions {
                fps: Some(999),
                bin_count: Some(2),
                fft_size: Some(777),
                smoothing: Some(2.0),
                min_frequency: Some(0.0),
                max_frequency: Some(99_999.0),
                scale: Some("mel".to_string()),
                include_waveform: Some(true),
            }),
            48_000,
        );

        assert_eq!(options.fps, 60);
        assert_eq!(options.bin_count, 8);
        assert_eq!(options.fft_size, 1024);
        assert!((options.smoothing - 0.95).abs() < f32::EPSILON);
        assert_eq!(options.min_frequency, 1.0);
        assert_eq!(options.max_frequency, 24_000.0);
        assert!(options.include_waveform);
    }
}
