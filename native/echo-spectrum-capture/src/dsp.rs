use crate::types::{AnalyzerOptions, SpectrumFrame, SpectrumScale, PROVIDER_SYSTEM_LOOPBACK};
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct SampleRing {
    buffer: Vec<f32>,
    write_index: usize,
    written: usize,
}

impl SampleRing {
    pub fn new(capacity: usize) -> Self {
        Self {
            buffer: vec![0.0; capacity.max(1)],
            write_index: 0,
            written: 0,
        }
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    pub fn push(&mut self, sample: f32) {
        self.buffer[self.write_index] = sample.clamp(-1.0, 1.0);
        self.write_index = (self.write_index + 1) % self.buffer.len();
        self.written = self.written.saturating_add(1);
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    pub fn push_interleaved<T: ToF32Sample>(&mut self, input: &[T], channels: usize) {
        if channels == 0 {
            return;
        }

        for frame in input.chunks_exact(channels) {
            let mut mono = 0.0f32;
            for sample in frame {
                mono += sample.to_f32_sample();
            }
            self.push(mono / channels as f32);
        }
    }

    pub fn latest_into(&self, output: &mut [f32]) {
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

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub trait ToF32Sample: Copy + Send + 'static {
    fn to_f32_sample(self) -> f32;
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl ToF32Sample for f32 {
    fn to_f32_sample(self) -> f32 {
        self.clamp(-1.0, 1.0)
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl ToF32Sample for f64 {
    fn to_f32_sample(self) -> f32 {
        (self as f32).clamp(-1.0, 1.0)
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl ToF32Sample for i8 {
    fn to_f32_sample(self) -> f32 {
        (self as f32 / i8::MAX as f32).clamp(-1.0, 1.0)
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl ToF32Sample for i16 {
    fn to_f32_sample(self) -> f32 {
        (self as f32 / i16::MAX as f32).clamp(-1.0, 1.0)
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl ToF32Sample for i32 {
    fn to_f32_sample(self) -> f32 {
        (self as f32 / i32::MAX as f32).clamp(-1.0, 1.0)
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl ToF32Sample for i64 {
    fn to_f32_sample(self) -> f32 {
        (self as f64 / i64::MAX as f64).clamp(-1.0, 1.0) as f32
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl ToF32Sample for u8 {
    fn to_f32_sample(self) -> f32 {
        ((self as f32 - 128.0) / 128.0).clamp(-1.0, 1.0)
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl ToF32Sample for u16 {
    fn to_f32_sample(self) -> f32 {
        ((self as f32 - 32768.0) / 32768.0).clamp(-1.0, 1.0)
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl ToF32Sample for u32 {
    fn to_f32_sample(self) -> f32 {
        ((self as f64 - 2_147_483_648.0) / 2_147_483_648.0).clamp(-1.0, 1.0) as f32
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl ToF32Sample for u64 {
    fn to_f32_sample(self) -> f32 {
        ((self as f64 - 9_223_372_036_854_775_808.0) / 9_223_372_036_854_775_808.0).clamp(-1.0, 1.0)
            as f32
    }
}

pub struct SpectrumAnalyzer {
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
    pub fn new(options: AnalyzerOptions, sample_rate: u32) -> Self {
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

    pub fn scratch_mut(&mut self) -> &mut [f32] {
        &mut self.scratch
    }

    pub fn analyze(&mut self) -> SpectrumFrame {
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
        let state = if rms > 0.0005 || peak > 0.002 {
            "playing"
        } else {
            "idle"
        };

        SpectrumFrame {
            source: PROVIDER_SYSTEM_LOOPBACK.to_string(),
            state: state.to_string(),
            timestamp: now_ms(),
            time_pos: None,
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
