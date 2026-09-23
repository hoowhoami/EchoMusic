//! Audio equalizer with configurable biquad filter bands.
//!
//! Provides a multi-band parametric equalizer using cascaded biquad filters
//! for real-time audio processing.

use biquad::{Biquad, Coefficients, DirectForm2Transposed, ToHertz, Type};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Arc;

/// Gain range in dB for each band.
pub const MAX_GAIN_DB: f32 = 12.0;
pub const MIN_GAIN_DB: f32 = -12.0;

/// Default Q factor for peaking EQ bands (provides smooth overlap).
const DEFAULT_Q: f32 = 1.4;

/// Configuration for the equalizer bands.
#[derive(Debug, Clone)]
pub struct EqConfig {
    /// Center frequencies in Hz for each band.
    pub frequencies: Vec<f32>,
    /// UI labels for each band.
    pub labels: Vec<String>,
}

impl EqConfig {
    /// Create a standard 5-band equalizer configuration.
    pub fn five_band() -> Self {
        Self {
            frequencies: vec![60.0, 250.0, 1000.0, 4000.0, 12000.0],
            labels: vec![
                "Bass".to_string(),
                "Low-Mid".to_string(),
                "Mid".to_string(),
                "High-Mid".to_string(),
                "Treble".to_string(),
            ],
        }
    }

    /// Create a 10-band equalizer configuration.
    pub fn ten_band() -> Self {
        Self {
            frequencies: vec![
                31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
            ],
            labels: vec![
                "31Hz".to_string(),
                "62Hz".to_string(),
                "125Hz".to_string(),
                "250Hz".to_string(),
                "500Hz".to_string(),
                "1kHz".to_string(),
                "2kHz".to_string(),
                "4kHz".to_string(),
                "8kHz".to_string(),
                "16kHz".to_string(),
            ],
        }
    }

    /// Number of bands in this configuration.
    pub fn num_bands(&self) -> usize {
        self.frequencies.len()
    }
}

impl Default for EqConfig {
    fn default() -> Self {
        Self::five_band()
    }
}

/// Shared EQ parameters that can be updated atomically from the UI thread.
///
/// Gains are stored as i32 with 0.1 dB precision (multiply by 10).
/// For example, +6.0 dB is stored as 60.
#[derive(Debug)]
pub struct EqParams {
    /// Gain values for each band in tenths of a dB (atomic for lock-free updates).
    gains: Vec<AtomicI32>,
    /// Whether the EQ is bypassed.
    pub bypass: AtomicBool,
}

impl EqParams {
    /// Create new EQ parameters with all gains at 0 dB.
    pub fn new(num_bands: usize) -> Self {
        let gains = (0..num_bands).map(|_| AtomicI32::new(0)).collect();
        Self {
            gains,
            bypass: AtomicBool::new(false),
        }
    }

    /// Get the number of bands.
    pub fn num_bands(&self) -> usize {
        self.gains.len()
    }

    /// Get the gain in dB for a specific band.
    pub fn get_gain_db(&self, band: usize) -> f32 {
        if band < self.gains.len() {
            self.gains[band].load(Ordering::Relaxed) as f32 / 10.0
        } else {
            0.0
        }
    }

    /// Set the gain in dB for a specific band (clamped to valid range).
    pub fn set_gain_db(&self, band: usize, gain_db: f32) {
        if band < self.gains.len() {
            let clamped = gain_db.clamp(MIN_GAIN_DB, MAX_GAIN_DB);
            let scaled = (clamped * 10.0) as i32;
            self.gains[band].store(scaled, Ordering::Relaxed);
        }
    }

    /// Adjust the gain for a band by a delta (in dB).
    pub fn adjust_gain_db(&self, band: usize, delta_db: f32) {
        let current = self.get_gain_db(band);
        self.set_gain_db(band, current + delta_db);
    }

    /// Reset all gains to 0 dB.
    pub fn reset(&self) {
        for gain in &self.gains {
            gain.store(0, Ordering::Relaxed);
        }
    }

    /// Get all gains as a vector of dB values.
    pub fn get_all_gains_db(&self) -> Vec<f32> {
        self.gains
            .iter()
            .map(|g| g.load(Ordering::Relaxed) as f32 / 10.0)
            .collect()
    }

    /// Check if EQ is bypassed.
    pub fn is_bypassed(&self) -> bool {
        self.bypass.load(Ordering::Relaxed)
    }

    /// Set bypass state.
    pub fn set_bypass(&self, bypass: bool) {
        self.bypass.store(bypass, Ordering::Relaxed);
    }

    /// Toggle bypass state.
    pub fn toggle_bypass(&self) {
        let current = self.bypass.load(Ordering::Relaxed);
        self.bypass.store(!current, Ordering::Relaxed);
    }
}

impl Default for EqParams {
    fn default() -> Self {
        Self::new(5)
    }
}

/// Multi-band equalizer processor.
///
/// Uses cascaded biquad filters (one per band per channel) for real-time
/// audio processing. The filter coefficients are updated when gains change.
pub struct Equalizer {
    /// Left channel filters (one per band).
    bands_l: Vec<DirectForm2Transposed<f32>>,
    /// Right channel filters (one per band).
    bands_r: Vec<DirectForm2Transposed<f32>>,
    /// EQ configuration.
    config: EqConfig,
    /// Shared parameters (gains, bypass).
    params: Arc<EqParams>,
    /// Sample rate in Hz.
    sample_rate: f32,
    /// Cached gains to detect when coefficients need updating.
    cached_gains: Vec<i32>,
}

impl Equalizer {
    /// Create a new equalizer with the given configuration and shared parameters.
    pub fn new(config: EqConfig, params: Arc<EqParams>, sample_rate: u32) -> Self {
        let num_bands = config.num_bands();
        let sample_rate_f = sample_rate as f32;

        // Initialize filters with flat response (0 dB gain)
        let mut bands_l = Vec::with_capacity(num_bands);
        let mut bands_r = Vec::with_capacity(num_bands);

        for freq in &config.frequencies {
            let coeffs = Self::compute_coefficients(*freq, 0.0, sample_rate_f);
            bands_l.push(DirectForm2Transposed::<f32>::new(coeffs));
            bands_r.push(DirectForm2Transposed::<f32>::new(coeffs));
        }

        let cached_gains = vec![0i32; num_bands];

        Self {
            bands_l,
            bands_r,
            config,
            params,
            sample_rate: sample_rate_f,
            cached_gains,
        }
    }

    /// Compute biquad coefficients for a peaking EQ filter.
    fn compute_coefficients(freq_hz: f32, gain_db: f32, sample_rate: f32) -> Coefficients<f32> {
        // Use peaking EQ filter type for each band
        Coefficients::<f32>::from_params(
            Type::PeakingEQ(gain_db),
            sample_rate.hz(),
            freq_hz.hz(),
            DEFAULT_Q,
        )
        .unwrap_or_else(|_| {
            // Fallback to unity gain if computation fails
            Coefficients::<f32>::from_params(
                Type::PeakingEQ(0.0),
                sample_rate.hz(),
                freq_hz.hz(),
                DEFAULT_Q,
            )
            .unwrap()
        })
    }

    /// Update filter coefficients if gains have changed.
    fn update_coefficients_if_needed(&mut self) {
        let num_bands = self.config.num_bands();
        let mut needs_update = false;

        // Check if any gains have changed
        for band in 0..num_bands {
            let current = (self.params.get_gain_db(band) * 10.0) as i32;
            if self.cached_gains[band] != current {
                needs_update = true;
                break;
            }
        }

        if needs_update {
            for band in 0..num_bands {
                let gain_db = self.params.get_gain_db(band);
                let freq = self.config.frequencies[band];
                let coeffs = Self::compute_coefficients(freq, gain_db, self.sample_rate);

                self.bands_l[band].update_coefficients(coeffs);
                self.bands_r[band].update_coefficients(coeffs);
                self.cached_gains[band] = (gain_db * 10.0) as i32;
            }
        }
    }

    /// Process audio samples in-place (interleaved stereo i16).
    ///
    /// This method updates filter coefficients if gains have changed,
    /// then processes each sample through the filter cascade.
    pub fn process(&mut self, samples: &mut [i16]) {
        // Skip processing if bypassed
        if self.params.is_bypassed() {
            return;
        }

        // Update coefficients if gains changed
        self.update_coefficients_if_needed();

        // Process stereo samples (interleaved: L, R, L, R, ...)
        for chunk in samples.chunks_exact_mut(2) {
            // Convert to float
            let mut left = chunk[0] as f32 / 32768.0;
            let mut right = chunk[1] as f32 / 32768.0;

            // Process through each band
            for band_idx in 0..self.bands_l.len() {
                left = self.bands_l[band_idx].run(left);
                right = self.bands_r[band_idx].run(right);
            }

            // Soft clipping to prevent harsh distortion
            left = soft_clip(left);
            right = soft_clip(right);

            // Convert back to i16
            chunk[0] = (left * 32767.0).round() as i16;
            chunk[1] = (right * 32767.0).round() as i16;
        }
    }

    /// Reset all filter states (call after seek or flush).
    pub fn reset(&mut self) {
        for filter in &mut self.bands_l {
            filter.reset_state();
        }
        for filter in &mut self.bands_r {
            filter.reset_state();
        }
    }

    /// Get a reference to the EQ configuration.
    pub fn config(&self) -> &EqConfig {
        &self.config
    }

    /// Get a reference to the shared parameters.
    pub fn params(&self) -> &Arc<EqParams> {
        &self.params
    }
}

/// Soft clipping function to prevent harsh digital clipping.
///
/// Uses a cubic soft clipper that saturates smoothly.
#[inline]
fn soft_clip(x: f32) -> f32 {
    if x >= 1.0 {
        2.0 / 3.0
    } else if x <= -1.0 {
        -2.0 / 3.0
    } else {
        x - (x * x * x) / 3.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod eq_config {
        use super::*;

        #[test]
        fn five_band_has_correct_frequencies() {
            let config = EqConfig::five_band();
            assert_eq!(config.num_bands(), 5);
            assert_eq!(config.frequencies, vec![60.0, 250.0, 1000.0, 4000.0, 12000.0]);
        }

        #[test]
        fn ten_band_has_correct_frequencies() {
            let config = EqConfig::ten_band();
            assert_eq!(config.num_bands(), 10);
            assert_eq!(config.frequencies.len(), 10);
        }
    }

    mod eq_params {
        use super::*;

        #[test]
        fn new_creates_flat_eq() {
            let params = EqParams::new(5);
            for i in 0..5 {
                assert_eq!(params.get_gain_db(i), 0.0);
            }
        }

        #[test]
        fn set_and_get_gain() {
            let params = EqParams::new(5);
            params.set_gain_db(0, 6.0);
            assert!((params.get_gain_db(0) - 6.0).abs() < 0.2);
        }

        #[test]
        fn gain_is_clamped() {
            let params = EqParams::new(5);
            params.set_gain_db(0, 20.0);
            assert_eq!(params.get_gain_db(0), MAX_GAIN_DB);

            params.set_gain_db(0, -20.0);
            assert_eq!(params.get_gain_db(0), MIN_GAIN_DB);
        }

        #[test]
        fn adjust_gain() {
            let params = EqParams::new(5);
            params.set_gain_db(0, 0.0);
            params.adjust_gain_db(0, 3.0);
            assert!((params.get_gain_db(0) - 3.0).abs() < 0.2);
        }

        #[test]
        fn reset_clears_all_gains() {
            let params = EqParams::new(5);
            for i in 0..5 {
                params.set_gain_db(i, (i as f32) * 2.0);
            }
            params.reset();
            for i in 0..5 {
                assert_eq!(params.get_gain_db(i), 0.0);
            }
        }

        #[test]
        fn bypass_toggle() {
            let params = EqParams::new(5);
            assert!(!params.is_bypassed());
            params.toggle_bypass();
            assert!(params.is_bypassed());
            params.toggle_bypass();
            assert!(!params.is_bypassed());
        }
    }

    mod equalizer {
        use super::*;

        #[test]
        fn process_does_not_crash() {
            let config = EqConfig::five_band();
            let params = Arc::new(EqParams::new(5));
            let mut eq = Equalizer::new(config, params, 44100);

            // Create test samples (stereo interleaved)
            let mut samples: Vec<i16> = (0..1024).map(|i| ((i % 256) as i16 - 128) * 100).collect();
            eq.process(&mut samples);
        }

        #[test]
        fn bypass_passes_through_unchanged() {
            let config = EqConfig::five_band();
            let params = Arc::new(EqParams::new(5));
            params.set_bypass(true);
            params.set_gain_db(0, 12.0); // Max boost on bass

            let mut eq = Equalizer::new(config, params, 44100);

            let original: Vec<i16> = (0..1024).map(|i| ((i % 256) as i16 - 128) * 100).collect();
            let mut samples = original.clone();
            eq.process(&mut samples);

            // With bypass, samples should be unchanged
            assert_eq!(samples, original);
        }

        #[test]
        fn reset_clears_filter_state() {
            let config = EqConfig::five_band();
            let params = Arc::new(EqParams::new(5));
            let mut eq = Equalizer::new(config, params, 44100);

            // Process some samples to build up filter state
            let mut samples: Vec<i16> = vec![10000; 1024];
            eq.process(&mut samples);

            // Reset should not crash
            eq.reset();
        }

        #[test]
        fn gain_change_updates_coefficients() {
            let config = EqConfig::five_band();
            let params = Arc::new(EqParams::new(5));
            let mut eq = Equalizer::new(config, params.clone(), 44100);

            // Process with flat EQ - create interleaved stereo pattern
            let mut samples1: Vec<i16> = (0..1024).map(|i| if i % 2 == 0 { 10000 } else { -10000 }).collect();
            eq.process(&mut samples1);

            // Change gain and process again
            params.set_gain_db(0, 12.0);
            let mut samples2: Vec<i16> = (0..1024).map(|i| if i % 2 == 0 { 10000 } else { -10000 }).collect();
            eq.process(&mut samples2);

            // Output should be different (bass boosted)
            assert_ne!(samples1, samples2);
        }
    }

    mod soft_clip {
        use super::*;

        #[test]
        fn passes_small_values_through() {
            let input = 0.5f32;
            let output = soft_clip(input);
            // Should be close to input for small values
            assert!((output - (input - input.powi(3) / 3.0)).abs() < 0.001);
        }

        #[test]
        fn clips_at_unity() {
            assert!((soft_clip(1.0) - 2.0 / 3.0).abs() < 0.001);
            assert!((soft_clip(-1.0) - (-2.0 / 3.0)).abs() < 0.001);
        }

        #[test]
        fn limits_over_unity() {
            assert_eq!(soft_clip(2.0), 2.0 / 3.0);
            assert_eq!(soft_clip(-2.0), -2.0 / 3.0);
        }
    }
}
