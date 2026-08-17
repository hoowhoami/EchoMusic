// SPDX-License-Identifier: MIT
// Portions adapted from Signalsmith Stretch.
// Copyright (c) 2022 Geraint Luff / Signalsmith Audio Ltd.
// See LICENSE-SIGNALSMITH.md in this directory.

use std::f64::consts::PI;

/// Window function shapes supported for STFT spectral analysis and synthesis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SpectralWindowShape {
    /// Optimal sidelobe suppression using Kaiser-Bessel window (default).
    #[default]
    Kaiser,

    /// Time-frequency optimal Approximate Confined Gaussian window.
    ConfinedGaussian,
}

/// Zero-order modified Bessel function of the first kind $I_0(x)$.
pub fn bessel_0(x: f64) -> f64 {
    const SIGNIFICANCE_LIMIT: f64 = 1e-12;
    let mut result = 0.0;
    let mut term = 1.0;
    let mut m = 0.0;

    loop {
        if term <= SIGNIFICANCE_LIMIT {
            break;
        }
        result += term;
        m += 1.0;
        term *= (x * x) / (4.0 * m * m);
    }

    result
}

/// Kaiser Window generator for STFT analysis and synthesis.
#[derive(Debug, Clone, Copy)]
pub struct KaiserWindow {
    beta: f64,
    inv_b0: f64,
}

impl KaiserWindow {
    /// Creates a Kaiser window from a beta value.
    pub fn new(beta: f64) -> Self {
        let b0 = bessel_0(beta);
        Self {
            beta,
            inv_b0: 1.0 / b0,
        }
    }

    fn heuristic_bandwidth(bandwidth: f64) -> f64 {
        0.25f64.mul_add(
            (3.0 - bandwidth).max(0.0),
            bandwidth + 8.0 / ((bandwidth + 3.0) * (bandwidth + 3.0)),
        )
    }

    /// Converts bandwidth parameter to beta parameter.
    pub fn bandwidth_to_beta(mut bandwidth: f64, heuristic_optimal: bool) -> f64 {
        if heuristic_optimal {
            bandwidth = Self::heuristic_bandwidth(bandwidth);
        }
        bandwidth = bandwidth.max(2.0);
        let alpha = (bandwidth * bandwidth).mul_add(0.25, -1.0).sqrt();
        alpha * PI
    }

    /// Creates a Kaiser window from a target bandwidth.
    pub fn with_bandwidth(bandwidth: f64, heuristic_optimal: bool) -> Self {
        Self::new(Self::bandwidth_to_beta(bandwidth, heuristic_optimal))
    }

    /// Fills target slice with Kaiser window coefficients.
    pub fn fill(&self, data: &mut [f32], warp: f64, is_for_synthesis: bool) {
        let size = data.len();
        if size == 0 {
            return;
        }

        let inv_size = 1.0 / (size as f64);
        let offset_i = if size & 1 != 0 {
            1
        } else if is_for_synthesis {
            0
        } else {
            2
        };

        for (i, val) in data.iter_mut().enumerate() {
            let mut r = ((2 * i + offset_i) as f64).mul_add(inv_size, -1.0);
            if warp != 0.0 {
                r = (r + warp) / r.mul_add(warp, 1.0);
            }
            let arg = r.mul_add(-r, 1.0).max(0.0).sqrt();
            *val = (bessel_0(self.beta * arg) * self.inv_b0) as f32;
        }

        if warp != 0.0 {
            for val in data.iter_mut() {
                let v = f64::from(*val);
                let scale = ((warp + 1.0) / warp.mul_add(2.0f64.mul_add(v, -1.0), 1.0)).sqrt();
                *val = (v * scale) as f32;
            }
        }
    }
}

/// Approximate Confined Gaussian (ACG) Window generator.
#[derive(Debug, Clone, Copy)]
pub struct ApproximateConfinedGaussianWindow {
    gaussian_factor: f64,
}

impl ApproximateConfinedGaussianWindow {
    fn gaussian(self, x: f64) -> f64 {
        (-x * x * self.gaussian_factor).exp()
    }

    pub fn bandwidth_to_sigma(bandwidth: f64) -> f64 {
        0.3 / bandwidth.sqrt()
    }

    pub fn with_bandwidth(bandwidth: f64) -> Self {
        let sigma = Self::bandwidth_to_sigma(bandwidth);
        Self {
            gaussian_factor: 0.0625 / (sigma * sigma),
        }
    }

    pub fn fill(self, data: &mut [f32], warp: f64, is_for_synthesis: bool) {
        let size = data.len();
        if size == 0 {
            return;
        }

        let inv_size = 1.0 / (size as f64);
        let offset_scale = self.gaussian(1.0) / (self.gaussian(3.0) + self.gaussian(-1.0));
        let norm = 1.0 / (2.0 * offset_scale).mul_add(-self.gaussian(2.0), self.gaussian(0.0));
        let offset_i = if size & 1 != 0 {
            1
        } else if is_for_synthesis {
            0
        } else {
            2
        };

        for (i, val) in data.iter_mut().enumerate() {
            let mut r = ((2 * i + offset_i) as f64).mul_add(inv_size, -1.0);
            if warp != 0.0 {
                r = (r + warp) / r.mul_add(warp, 1.0);
            }
            let g_r = self.gaussian(r);
            let g_r_minus_2 = self.gaussian(r - 2.0);
            let g_r_plus_2 = self.gaussian(r + 2.0);
            *val = (norm * offset_scale.mul_add(-(g_r_minus_2 + g_r_plus_2), g_r)) as f32;
        }

        if warp != 0.0 {
            for val in data.iter_mut() {
                let v = f64::from(*val);
                let scale = ((warp + 1.0) / warp.mul_add(2.0f64.mul_add(v, -1.0), 1.0)).sqrt();
                *val = (v * scale) as f32;
            }
        }
    }
}

/// Normalizes window coefficients so that Overlap-Add (OLA) with step `interval` produces
/// Perfect Reconstruction (PR) with constant gain 1.0.
pub fn force_perfect_reconstruction(data: &mut [f32], interval: usize) {
    if interval == 0 || data.is_empty() {
        return;
    }
    let window_length = data.len();

    for i in 0..interval {
        let mut sum2 = 0.0;
        let mut index = i;
        while index < window_length {
            let val = f64::from(data[index]);
            sum2 = val.mul_add(val, sum2);
            index += interval;
        }

        if sum2 > 0.0 {
            let factor = 1.0 / sum2.sqrt();
            let mut idx = i;
            while idx < window_length {
                data[idx] = (f64::from(data[idx]) * factor) as f32;
                idx += interval;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bessel_0_wide_range() {
        assert!((bessel_0(0.0) - 1.0).abs() < 1e-9);
        assert!((bessel_0(1.0) - 1.266_065_877_752_008_4).abs() < 1e-9);
        assert!((bessel_0(2.0) - 2.279_585_302_336_067_3).abs() < 1e-9);
    }

    #[test]
    fn test_perfect_reconstruction_property_all_hops() {
        let block_samples = 256;
        for interval in [16, 32, 64, 128] {
            let mut win = vec![0.0f32; block_samples];
            let kaiser = KaiserWindow::with_bandwidth(block_samples as f64 / interval as f64, true);
            kaiser.fill(&mut win, 0.0, true);
            force_perfect_reconstruction(&mut win, interval);

            for i in 0..interval {
                let mut sum2 = 0.0f64;
                let mut idx = i;
                while idx < block_samples {
                    let v = f64::from(win[idx]);
                    sum2 = v.mul_add(v, sum2);
                    idx += interval;
                }
                assert!(
                    (sum2 - 1.0).abs() < 1e-5,
                    "PR sum2 at offset {i} for interval {interval} must be 1.0"
                );
            }
        }
    }

    #[test]
    fn test_kaiser_and_pr_reference_values() {
        let block_samples = 256;
        let interval_samples = 64;

        let mut kaiser_win = vec![0.0f32; block_samples];
        let kaiser =
            KaiserWindow::with_bandwidth(block_samples as f64 / interval_samples as f64, true);
        kaiser.fill(&mut kaiser_win, 0.0, true);

        let ref_kaiser_0 = 0.018_920_025_f32;
        let ref_kaiser_128 = 1.0_f32;
        let ref_kaiser_255 = 0.021_419_346_f32;

        assert!((kaiser_win[0] - ref_kaiser_0).abs() < 1e-5);
        assert!((kaiser_win[128] - ref_kaiser_128).abs() < 1e-5);
        assert!((kaiser_win[255] - ref_kaiser_255).abs() < 1e-5);

        let mut pr_win = kaiser_win.clone();
        force_perfect_reconstruction(&mut pr_win, interval_samples);

        let ref_pr_0 = 0.015_441_185_f32;
        let ref_pr_64 = 0.408_469_53_f32;
        let ref_pr_128 = 0.816_129_2_f32;

        assert!((pr_win[0] - ref_pr_0).abs() < 1e-5);
        assert!((pr_win[64] - ref_pr_64).abs() < 1e-5);
        assert!((pr_win[128] - ref_pr_128).abs() < 1e-5);
    }

    #[test]
    fn test_acg_window_and_perfect_reconstruction() {
        let block_samples = 256;
        let interval_samples = 64;

        let mut acg_win = vec![0.0f32; block_samples];
        let acg = ApproximateConfinedGaussianWindow::with_bandwidth(
            block_samples as f64 / interval_samples as f64,
        );
        acg.fill(&mut acg_win, 0.0, true);

        assert!(acg_win[block_samples / 2] > 0.5);

        let mut pr_win = acg_win.clone();
        force_perfect_reconstruction(&mut pr_win, interval_samples);

        for i in 0..interval_samples {
            let mut sum2 = 0.0f64;
            let mut idx = i;
            while idx < block_samples {
                let v = f64::from(pr_win[idx]);
                sum2 = v.mul_add(v, sum2);
                idx += interval_samples;
            }
            assert!(
                (sum2 - 1.0).abs() < 1e-5,
                "ACG PR sum2 at offset {i} must be 1.0"
            );
        }
    }
}
