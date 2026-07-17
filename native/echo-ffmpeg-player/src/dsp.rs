use crate::config::SpectrumConfig;
use crate::events::SpectrumFrame;
use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const SPECTRUM_FFT_SIZE: usize = 2048;
const SPECTRUM_FLOOR_DB: f64 = -80.0;
const SPECTRUM_CEILING_DB: f64 = -12.0;

#[derive(Debug)]
pub struct SampleRing {
    samples: Vec<f32>,
    cursor: usize,
    filled: bool,
}

impl SampleRing {
    pub fn new(capacity: usize) -> Self {
        Self {
            samples: vec![0.0; capacity.max(2)],
            cursor: 0,
            filled: false,
        }
    }

    pub fn push_interleaved(&mut self, input: &[f32], channels: usize) {
        let channels = channels.max(1);
        for frame in input.chunks(channels) {
            self.samples[self.cursor] = downmix_for_spectrum(frame);
            self.cursor += 1;
            if self.cursor >= self.samples.len() {
                self.cursor = 0;
                self.filled = true;
            }
        }
    }

    pub fn latest(&self, count: usize) -> Vec<f32> {
        let available = if self.filled {
            self.samples.len()
        } else {
            self.cursor
        };
        let count = count.min(available);
        if count == 0 {
            return vec![];
        }
        let start = (self.cursor + self.samples.len() - count) % self.samples.len();
        (0..count)
            .map(|index| self.samples[(start + index) % self.samples.len()])
            .collect()
    }
}

fn downmix_for_spectrum(frame: &[f32]) -> f32 {
    frame
        .iter()
        .copied()
        .max_by(|left, right| {
            left.abs()
                .partial_cmp(&right.abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(0.0)
}

pub struct SpectrumAnalyzer {
    config: SpectrumConfig,
    previous: Vec<f64>,
    fft: Arc<dyn Fft<f32>>,
    buffer: Vec<Complex32>,
}

impl SpectrumAnalyzer {
    pub fn new(config: SpectrumConfig) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(SPECTRUM_FFT_SIZE);
        Self {
            previous: vec![0.0; config.bands],
            config,
            fft,
            buffer: vec![Complex32::ZERO; SPECTRUM_FFT_SIZE],
        }
    }

    pub fn analyze(&mut self, ring: &SampleRing, sample_rate: u32) -> SpectrumFrame {
        let window = ring.latest(SPECTRUM_FFT_SIZE);
        let mut bins = vec![0.0; self.config.bands];
        if !window.is_empty() {
            self.prepare_fft_buffer(&window);
            self.fft.process(&mut self.buffer);
            for (bin, value) in bins.iter_mut().enumerate() {
                let magnitude = self.band_magnitude(bin, sample_rate);
                let smoothed = self.previous[bin] * self.config.smoothing
                    + magnitude * (1.0 - self.config.smoothing);
                *value = smoothed.clamp(0.0, 1.0);
                self.previous[bin] = *value;
            }
        }
        let peak = window.iter().copied().map(f32::abs).fold(0.0f32, f32::max) as f64;
        let rms = if window.is_empty() {
            0.0
        } else {
            (window
                .iter()
                .map(|v| (*v as f64) * (*v as f64))
                .sum::<f64>()
                / window.len() as f64)
                .sqrt()
        };
        SpectrumFrame {
            bins,
            peak,
            rms,
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_secs_f64())
                .unwrap_or_default(),
        }
    }

    fn prepare_fft_buffer(&mut self, window: &[f32]) {
        self.buffer.fill(Complex32::ZERO);
        let offset = SPECTRUM_FFT_SIZE.saturating_sub(window.len());
        for (index, sample) in window.iter().copied().enumerate() {
            let target = offset + index;
            let phase = target as f32 / (SPECTRUM_FFT_SIZE.saturating_sub(1).max(1)) as f32;
            let hann = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * phase).cos();
            self.buffer[target].re = sample * hann;
        }
    }

    fn band_magnitude(&self, bin: usize, sample_rate: u32) -> f64 {
        if sample_rate == 0 {
            return 0.0;
        }
        let (min_freq, max_freq) = self.band_frequency_range(bin);
        let nyquist = sample_rate as f64 * 0.5;
        let min_freq = min_freq.clamp(1.0, nyquist);
        let max_freq = max_freq.clamp(min_freq + 1.0, nyquist);
        let start = frequency_to_fft_bin(min_freq, sample_rate);
        let end = frequency_to_fft_bin(max_freq, sample_rate).max(start + 1);
        let max_bin = (SPECTRUM_FFT_SIZE / 2).saturating_sub(1);
        let mut magnitude = 0.0f64;
        for index in start.min(max_bin)..=end.min(max_bin) {
            let value = self.buffer[index].norm() as f64 / (SPECTRUM_FFT_SIZE as f64 * 0.5);
            magnitude = magnitude.max(value);
        }
        magnitude_to_unit(magnitude)
    }

    fn band_frequency_range(&self, bin: usize) -> (f64, f64) {
        let bands = self.config.bands.max(1);
        let min_frequency = self.config.min_frequency.max(1.0);
        let max_frequency = self.config.max_frequency.max(min_frequency + 1.0);
        let lower_t = bin as f64 / bands as f64;
        let upper_t = (bin + 1) as f64 / bands as f64;
        let ratio = max_frequency / min_frequency;
        (
            min_frequency * ratio.powf(lower_t),
            min_frequency * ratio.powf(upper_t),
        )
    }
}

fn frequency_to_fft_bin(frequency: f64, sample_rate: u32) -> usize {
    ((frequency / sample_rate as f64) * SPECTRUM_FFT_SIZE as f64).round() as usize
}

fn magnitude_to_unit(magnitude: f64) -> f64 {
    if magnitude <= f64::EPSILON {
        return 0.0;
    }
    let db = 20.0 * magnitude.log10();
    ((db - SPECTRUM_FLOOR_DB) / (SPECTRUM_CEILING_DB - SPECTRUM_FLOOR_DB)).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_ring_keeps_latest_mono_samples() {
        let mut ring = SampleRing::new(4);
        ring.push_interleaved(&[1.0, 0.0, 0.5, -0.5], 2);
        ring.push_interleaved(&[0.25, -0.25], 2);

        assert_eq!(ring.latest(3), vec![1.0, -0.5, -0.25]);
    }

    #[test]
    fn sample_ring_does_not_cancel_opposite_phase_channels() {
        let mut ring = SampleRing::new(2);
        ring.push_interleaved(&[0.75, -0.75], 2);

        assert_eq!(ring.latest(1), vec![-0.75]);
    }

    #[test]
    fn analyzer_outputs_nonzero_bins_for_tone() {
        let sample_rate = 48_000;
        let mut ring = SampleRing::new(SPECTRUM_FFT_SIZE);
        let mut samples = Vec::with_capacity(SPECTRUM_FFT_SIZE * 2);
        for index in 0..SPECTRUM_FFT_SIZE {
            let phase = 2.0 * std::f32::consts::PI * 1_000.0 * index as f32 / sample_rate as f32;
            let sample = phase.sin() * 0.5;
            samples.push(sample);
            samples.push(sample);
        }
        ring.push_interleaved(&samples, 2);

        let mut analyzer = SpectrumAnalyzer::new(SpectrumConfig {
            bands: 64,
            min_frequency: 40.0,
            max_frequency: 16_000.0,
            smoothing: 0.0,
            ..SpectrumConfig::default()
        });
        let frame = analyzer.analyze(&ring, sample_rate);

        assert!(frame.peak > 0.4);
        assert!(frame.rms > 0.2);
        assert!(frame.bins.iter().any(|value| *value > 0.2));
    }
}
