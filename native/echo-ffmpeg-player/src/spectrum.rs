use crate::config::SpectrumConfig;
use crate::events::SpectrumFrame;
use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const SPECTRUM_FFT_SIZE: usize = 2048;
const SPECTRUM_FLOOR_DB: f64 = -74.0;
// Keep the pre-calibration visual threshold: a 0.5-amplitude bin-centered sine is near full scale.
const SPECTRUM_CEILING_DB: f64 = -6.0;
const HANN_COHERENT_GAIN: f64 = 0.5;

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

    pub fn clear(&mut self) {
        self.cursor = 0;
        self.filled = false;
    }

    #[cfg(test)]
    pub fn latest(&self, count: usize) -> Vec<f32> {
        let mut output = Vec::with_capacity(count.min(self.samples.len()));
        self.latest_into(count, &mut output);
        output
    }

    pub fn latest_into(&self, count: usize, output: &mut Vec<f32>) {
        output.clear();
        let available = if self.filled {
            self.samples.len()
        } else {
            self.cursor
        };
        let count = count.min(available);
        if count == 0 {
            return;
        }
        let start = (self.cursor + self.samples.len() - count) % self.samples.len();
        let first_count = count.min(self.samples.len() - start);
        output.extend_from_slice(&self.samples[start..start + first_count]);
        let remaining = count - first_count;
        if remaining > 0 {
            output.extend_from_slice(&self.samples[..remaining]);
        }
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
    snapshot: Vec<f32>,
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
            snapshot: Vec::with_capacity(SPECTRUM_FFT_SIZE),
        }
    }

    #[cfg(test)]
    pub fn analyze(&mut self, ring: &SampleRing, sample_rate: u32) -> SpectrumFrame {
        self.snapshot_ring(ring);
        self.analyze_snapshot(sample_rate)
    }

    pub fn snapshot_ring(&mut self, ring: &SampleRing) {
        ring.latest_into(SPECTRUM_FFT_SIZE, &mut self.snapshot);
    }

    pub fn analyze_snapshot(&mut self, sample_rate: u32) -> SpectrumFrame {
        let snapshot = std::mem::take(&mut self.snapshot);
        let frame = self.analyze_samples(&snapshot, sample_rate);
        self.snapshot = snapshot;
        frame
    }

    pub fn analyze_samples(&mut self, window: &[f32], sample_rate: u32) -> SpectrumFrame {
        let mut bins = vec![0.0; self.config.bands];
        if !window.is_empty() {
            self.prepare_fft_buffer(window);
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
        let waveform = self
            .config
            .include_waveform
            .then(|| sample_waveform(window));
        SpectrumFrame {
            bins,
            waveform,
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
            let value = self.fft_bin_amplitude(index);
            magnitude = magnitude.max(value);
        }
        magnitude_to_unit(magnitude)
    }

    fn fft_bin_amplitude(&self, index: usize) -> f64 {
        self.buffer[index].norm() as f64 / (SPECTRUM_FFT_SIZE as f64 * HANN_COHERENT_GAIN * 0.5)
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

fn sample_waveform(window: &[f32]) -> Vec<f64> {
    window
        .iter()
        .map(|sample| f64::from(sample.clamp(-1.0, 1.0)))
        .collect()
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
    fn sample_ring_latest_into_reuses_capacity_across_wrap() {
        let mut ring = SampleRing::new(4);
        ring.push_interleaved(&[1.0, 2.0, 3.0, 4.0, 5.0], 1);
        let mut output = Vec::with_capacity(4);
        let capacity = output.capacity();

        ring.latest_into(4, &mut output);

        assert_eq!(output, vec![2.0, 3.0, 4.0, 5.0]);
        assert_eq!(output.capacity(), capacity);
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
        assert!(frame.waveform.is_none());
    }

    #[test]
    fn analyzer_includes_bounded_waveform_only_when_requested() {
        let window = (0..SPECTRUM_FFT_SIZE)
            .map(|index| if index % 2 == 0 { 1.5 } else { -1.5 })
            .collect::<Vec<_>>();
        let mut analyzer = SpectrumAnalyzer::new(SpectrumConfig {
            include_waveform: true,
            ..SpectrumConfig::default()
        });

        let frame = analyzer.analyze_samples(&window, 48_000);
        let waveform = frame.waveform.expect("waveform should be present");

        assert_eq!(waveform.len(), SPECTRUM_FFT_SIZE);
        assert!(waveform.iter().all(|value| (-1.0..=1.0).contains(value)));
        assert_eq!(waveform[0], 1.0);
        assert_eq!(waveform[1], -1.0);
    }

    #[test]
    fn hann_window_reports_bin_centered_tone_amplitude() {
        let mut analyzer = SpectrumAnalyzer::new(SpectrumConfig::default());
        let bin = 43usize;
        let amplitude = 0.5f32;
        let window = (0..SPECTRUM_FFT_SIZE)
            .map(|index| {
                let phase = 2.0 * std::f32::consts::PI * bin as f32 * index as f32
                    / SPECTRUM_FFT_SIZE as f32;
                phase.sin() * amplitude
            })
            .collect::<Vec<_>>();

        analyzer.prepare_fft_buffer(&window);
        analyzer.fft.process(&mut analyzer.buffer);

        assert!((analyzer.fft_bin_amplitude(bin) - f64::from(amplitude)).abs() < 0.002);
        assert!(magnitude_to_unit(f64::from(amplitude)) > 0.99);
        assert!(magnitude_to_unit(f64::from(amplitude) * 0.5) < 0.95);
    }

    #[test]
    fn calibrated_spectrum_keeps_the_pre_compensation_visual_range() {
        let floor_magnitude = 10.0_f64.powf(SPECTRUM_FLOOR_DB / 20.0);
        let ceiling_magnitude = 10.0_f64.powf(SPECTRUM_CEILING_DB / 20.0);

        assert!(magnitude_to_unit(floor_magnitude).abs() < f64::EPSILON);
        assert!((magnitude_to_unit(ceiling_magnitude) - 1.0).abs() < f64::EPSILON);
    }
}
