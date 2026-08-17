// SPDX-License-Identifier: MIT
// Portions adapted from Signalsmith Stretch.
// Copyright (c) 2022 Geraint Luff / Signalsmith Audio Ltd.
// See LICENSE-SIGNALSMITH.md in this directory.

use std::sync::Arc;

use realfft::{ComplexToReal, RealFftPlanner, RealToComplex, num_complex::Complex};

/// Short-Time Fourier Transform (STFT) operator based on `realfft`.
pub struct StftOperator {
    block_samples: usize,
    fft_samples: usize,
    fft_bins: usize,
    r2c: Arc<dyn RealToComplex<f32>>,
    c2r: Arc<dyn ComplexToReal<f32>>,
    time_buf: Vec<f32>,
    scratch_r2c: Vec<Complex<f32>>,
    scratch_c2r: Vec<Complex<f32>>,
}

/// Calculates the smallest fast composite FFT size >= `size` using mixed-radix 4x composite sizing.
pub const fn fast_size_above(size: usize) -> usize {
    let mut pow2 = 1;
    while pow2 < 16 && pow2 < size {
        pow2 *= 2;
    }
    while pow2 * 8 < size {
        pow2 *= 2;
    }
    let mut multiple = size.div_ceil(pow2);
    if multiple == 7 {
        multiple += 1;
    }
    multiple * pow2
}

impl StftOperator {
    /// Creates a new `StftOperator` for a given block size and optional FFT size.
    ///
    /// If `fft_min_size` is 0 or less than `block_samples`, `block_samples` is used.
    pub fn new(block_samples: usize, fft_min_size: usize) -> Self {
        let min_size = fft_min_size.max(block_samples);
        let half1 = min_size.div_ceil(2);
        let half2 = half1.div_ceil(2);
        let fft_samples = (fast_size_above(half2) * 4).max(16);

        let mut planner = RealFftPlanner::<f32>::new();
        let r2c = planner.plan_fft_forward(fft_samples);
        let c2r = planner.plan_fft_inverse(fft_samples);

        let fft_bins = fft_samples / 2 + 1;
        let scratch_r2c = r2c.make_scratch_vec();
        let scratch_c2r = c2r.make_scratch_vec();

        Self {
            block_samples,
            fft_samples,
            fft_bins,
            r2c,
            c2r,
            time_buf: vec![0.0; fft_samples],
            scratch_r2c,
            scratch_c2r,
        }
    }

    /// Returns the total FFT size.
    pub const fn fft_samples(&self) -> usize {
        self.fft_samples
    }

    /// Returns the number of positive frequency bins (including DC and Nyquist).
    pub const fn bands(&self) -> usize {
        self.fft_bins
    }

    /// Performs forward STFT on `input_time` multiplied by `analysis_window`,
    /// outputting the positive frequency complex spectrum into `output_spectrum`.
    pub fn analyse(
        &mut self,
        input_time: &[f32],
        analysis_window: &[f32],
        output_spectrum: &mut [Complex<f32>],
    ) {
        let n = self
            .block_samples
            .min(input_time.len())
            .min(analysis_window.len());
        let offset = self.block_samples / 2;

        self.time_buf.fill(0.0);

        let split = offset.min(n);
        let (in_p1, in_p2) = input_time[..n].split_at(split);
        let (w_p1, w_p2) = analysis_window[..n].split_at(split);

        let start_p1 = self.fft_samples - offset;
        let tb_p1 = &mut self.time_buf[start_p1..start_p1 + split];
        for ((dst, &x), &w) in tb_p1.iter_mut().zip(in_p1).zip(w_p1) {
            *dst = x * w;
        }

        let tb_p2 = &mut self.time_buf[..n - split];
        for ((dst, &x), &w) in tb_p2.iter_mut().zip(in_p2).zip(w_p2) {
            *dst = x * w;
        }

        // Process forward Real-to-Complex FFT
        let _ = self.r2c.process_with_scratch(
            &mut self.time_buf,
            &mut output_spectrum[..self.fft_bins],
            &mut self.scratch_r2c,
        );

        // Sanitize DC and Nyquist bin imaginary components
        output_spectrum[0].im = 0.0;
        if self.fft_bins > 1 {
            output_spectrum[self.fft_bins - 1].im = 0.0;
        }
    }

    /// Performs inverse STFT on `input_spectrum`, multiplies by `synthesis_window`,
    /// and adds the resulting time-domain samples into `output_time`.
    pub fn synthesise(
        &mut self,
        input_spectrum: &mut [Complex<f32>],
        synthesis_window: &[f32],
        output_time: &mut [f32],
    ) {
        input_spectrum[0].im = 0.0;
        if self.fft_bins > 1 {
            input_spectrum[self.fft_bins - 1].im = 0.0;
        }

        self.time_buf.fill(0.0);

        let _ = self.c2r.process_with_scratch(
            &mut input_spectrum[..self.fft_bins],
            &mut self.time_buf,
            &mut self.scratch_c2r,
        );

        let inv_scale = 1.0 / (self.fft_samples as f32);
        let n = self
            .block_samples
            .min(output_time.len())
            .min(synthesis_window.len());
        let offset = self.block_samples / 2;

        let split = offset.min(n);
        let (out_p1, out_p2) = output_time[..n].split_at_mut(split);
        let (w_p1, w_p2) = synthesis_window[..n].split_at(split);

        let start_p1 = self.fft_samples - offset;
        let tb_p1 = &self.time_buf[start_p1..start_p1 + split];
        for ((out, &s), &w) in out_p1.iter_mut().zip(tb_p1).zip(w_p1) {
            let sample = s * inv_scale;
            *out = sample.mul_add(w, *out);
        }

        let tb_p2 = &self.time_buf[..n - split];
        for ((out, &s), &w) in out_p2.iter_mut().zip(tb_p2).zip(w_p2) {
            let sample = s * inv_scale;
            *out = sample.mul_add(w, *out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spectral::windows::{KaiserWindow, force_perfect_reconstruction};

    #[test]
    fn test_stft_parseval_energy_conservation() {
        let block_samples = 64;
        let mut stft = StftOperator::new(block_samples, block_samples);
        let win = vec![1.0f32; block_samples];

        let time_in: Vec<f32> = (0..block_samples)
            .map(|i| (2.0 * std::f32::consts::PI * i as f32 / 8.0).sin())
            .collect();

        let time_energy: f32 = time_in.iter().map(|x| x * x).sum();

        let mut spectrum = vec![Complex::new(0.0, 0.0); stft.bands()];
        stft.analyse(&time_in, &win, &mut spectrum);

        let mut freq_energy = spectrum[0].re * spectrum[0].re;
        if stft.bands() > 1 {
            let last = stft.bands() - 1;
            freq_energy = spectrum[last].re.mul_add(spectrum[last].re, freq_energy);
        }
        for comp in spectrum.iter().skip(1).take(stft.bands().saturating_sub(2)) {
            let comp = *comp;
            freq_energy = 2.0f32.mul_add(comp.im.mul_add(comp.im, comp.re * comp.re), freq_energy);
        }

        let n = stft.fft_samples() as f32;
        let ratio = freq_energy / (n * time_energy);
        assert!(
            (ratio - 1.0).abs() < 1e-4,
            "Parseval's theorem must hold: ratio = {ratio}"
        );
    }

    #[test]
    fn test_stft_roundtrip_reconstruction() {
        let block_samples = 64;
        let interval_samples = 16;
        let mut stft = StftOperator::new(block_samples, block_samples);

        let mut win = vec![0.0f32; block_samples];
        let kaiser =
            KaiserWindow::with_bandwidth(block_samples as f64 / interval_samples as f64, true);
        kaiser.fill(&mut win, 0.0, true);
        force_perfect_reconstruction(&mut win, interval_samples);

        let input_signal: Vec<f32> = (0..block_samples)
            .map(|i| (2.0 * std::f32::consts::PI * i as f32 / 16.0).sin())
            .collect();

        let mut spectrum = vec![Complex::new(0.0, 0.0); stft.bands()];
        stft.analyse(&input_signal, &win, &mut spectrum);

        let mut reconstructed = vec![0.0f32; block_samples];
        stft.synthesise(&mut spectrum, &win, &mut reconstructed);

        assert!(reconstructed[block_samples / 2].abs() > 0.0);
    }

    #[test]
    fn test_fast_size_above_and_mixed_radix() {
        assert_eq!(fast_size_above(16), 16);
        assert_eq!(fast_size_above(64), 64);
        assert_eq!(fast_size_above(1323), 1536);

        let stft = StftOperator::new(5292, 5292);
        assert_eq!(stft.fft_samples(), 6144);
        assert_eq!(stft.bands(), 3073);
    }
}
