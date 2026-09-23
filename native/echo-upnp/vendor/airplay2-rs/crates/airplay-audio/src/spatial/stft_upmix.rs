//! Frequency-domain stereo-to-5.1 upmixer using STFT.
//!
//! Analyzes per-bin correlation and amplitude to steer each frequency band
//! to the appropriate 5.1 channel:
//! - Highly correlated content → Center
//! - Decorrelated / panned content → Left / Right
//! - Low frequency (<120Hz) → LFE
//! - Ambient / reverberant → Rear L/R (with decorrelation)
//!
//! The upmixer is **stateful**: it accumulates input samples across calls,
//! maintains overlap-add accumulators, and uses ring buffer delay lines for
//! rear channels.  This allows correct STFT processing even when called with
//! buffers smaller than the FFT size (e.g. 352-sample ALAC frames with a
//! 2048-point FFT).

use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::f64::consts::PI;
use std::sync::Arc;

/// Output channels from the frequency-domain upmixer.
#[derive(Debug, Clone)]
pub struct Channels51 {
    pub front_left: Vec<f64>,
    pub front_right: Vec<f64>,
    pub front_center: Vec<f64>,
    pub lfe: Vec<f64>,
    pub rear_left: Vec<f64>,
    pub rear_right: Vec<f64>,
}

/// Configuration for the STFT upmixer.
#[derive(Debug, Clone)]
pub struct StftUpmixConfig {
    pub sample_rate: f64,
    /// FFT size (must be power of 2). 2048 is a good balance.
    pub fft_size: usize,
    /// Hop size (typically fft_size / 4 for good overlap-add reconstruction).
    pub hop_size: usize,
    /// LFE crossover frequency in Hz.
    pub lfe_crossover_hz: f64,
    /// Center extraction threshold: correlation above this steers to center.
    /// Range 0.0-1.0, typical 0.5-0.8.
    pub center_threshold: f64,
    /// How aggressively to extract center (0.0-1.0).
    pub center_strength: f64,
    /// Rear channel level relative to front (0.0-1.0).
    pub rear_level: f64,
    /// Rear decorrelation delay in samples.
    pub rear_delay_samples: usize,
}

impl Default for StftUpmixConfig {
    fn default() -> Self {
        Self {
            sample_rate: 48000.0,
            fft_size: 2048,
            hop_size: 512, // 2048/4
            lfe_crossover_hz: 120.0,
            center_threshold: 0.5,
            center_strength: 0.7,
            rear_level: 0.5,
            rear_delay_samples: 720, // ~15ms at 48kHz
        }
    }
}

/// STFT-based 5.1 upmixer with stateful overlap-add processing.
pub struct StftUpmixer {
    config: StftUpmixConfig,
    fft_size: usize,
    hop_size: usize,
    window: Vec<f64>,
    // All-pass coefficients for rear decorrelation (per-bin random phase)
    rear_allpass_phase_l: Vec<f64>,
    rear_allpass_phase_r: Vec<f64>,

    // Cached FFT plans
    fft_fwd: Arc<dyn Fft<f64>>,
    fft_inv: Arc<dyn Fft<f64>>,

    // Input ring buffers (length = fft_size)
    in_l: Vec<f64>,
    in_r: Vec<f64>,
    in_pos: usize,   // write position in ring buffer
    in_count: usize,  // total samples written (saturates at fft_size)
    hop_counter: usize, // samples since last frame was processed

    // Overlap-add accumulators (length = fft_size each)
    ola_fl: Vec<f64>,
    ola_fr: Vec<f64>,
    ola_fc: Vec<f64>,
    ola_lfe: Vec<f64>,
    ola_rl: Vec<f64>,
    ola_rr: Vec<f64>,

    // Pending output (length = hop_size each)
    pending_fl: Vec<f64>,
    pending_fr: Vec<f64>,
    pending_fc: Vec<f64>,
    pending_lfe: Vec<f64>,
    pending_rl: Vec<f64>,
    pending_rr: Vec<f64>,
    pending_pos: usize,   // read position in pending buffers
    pending_avail: usize, // number of samples available in pending

    // Rear delay ring buffers
    rear_dl_l: Vec<f64>,
    rear_dl_r: Vec<f64>,
    rear_dl_pos: usize,

    // Precomputed LFE bin cutoff
    lfe_bin: usize,
}

impl StftUpmixer {
    pub fn new(config: StftUpmixConfig) -> Self {
        let fft_size = config.fft_size;
        let hop_size = config.hop_size;

        // Hann window
        let window: Vec<f64> = (0..fft_size)
            .map(|i| 0.5 * (1.0 - (2.0 * PI * i as f64 / fft_size as f64).cos()))
            .collect();

        // Generate pseudo-random all-pass phase shifts for rear decorrelation.
        // Using a simple deterministic hash so results are reproducible.
        let num_bins = fft_size / 2 + 1;
        let rear_allpass_phase_l: Vec<f64> = (0..num_bins)
            .map(|i| {
                let seed = (i as f64 * 7.31 + 0.13).sin() * 43758.5453;
                (seed - seed.floor()) * 2.0 * PI
            })
            .collect();
        let rear_allpass_phase_r: Vec<f64> = (0..num_bins)
            .map(|i| {
                let seed = (i as f64 * 11.97 + 0.71).sin() * 28461.7129;
                (seed - seed.floor()) * 2.0 * PI
            })
            .collect();

        // Create cached FFT plans
        let mut planner = FftPlanner::<f64>::new();
        let fft_fwd = planner.plan_fft_forward(fft_size);
        let fft_inv = planner.plan_fft_inverse(fft_size);

        let lfe_bin =
            (config.lfe_crossover_hz * fft_size as f64 / config.sample_rate).ceil() as usize;

        let rear_delay_len = config.rear_delay_samples.max(1);

        Self {
            fft_size,
            hop_size,
            window,
            rear_allpass_phase_l,
            rear_allpass_phase_r,
            fft_fwd,
            fft_inv,

            in_l: vec![0.0; fft_size],
            in_r: vec![0.0; fft_size],
            in_pos: 0,
            in_count: 0,
            hop_counter: 0,

            ola_fl: vec![0.0; fft_size],
            ola_fr: vec![0.0; fft_size],
            ola_fc: vec![0.0; fft_size],
            ola_lfe: vec![0.0; fft_size],
            ola_rl: vec![0.0; fft_size],
            ola_rr: vec![0.0; fft_size],

            pending_fl: vec![0.0; hop_size],
            pending_fr: vec![0.0; hop_size],
            pending_fc: vec![0.0; hop_size],
            pending_lfe: vec![0.0; hop_size],
            pending_rl: vec![0.0; hop_size],
            pending_rr: vec![0.0; hop_size],
            pending_pos: 0,
            pending_avail: 0,

            rear_dl_l: vec![0.0; rear_delay_len],
            rear_dl_r: vec![0.0; rear_delay_len],
            rear_dl_pos: 0,

            lfe_bin,
            config,
        }
    }

    /// Process stereo buffers (left and right, same length) into 5.1 channels.
    ///
    /// This is a streaming interface: input is accumulated across calls and
    /// STFT frames are processed with proper overlap-add whenever enough data
    /// is available.  The output length always equals the input length.
    ///
    /// There is an initial latency of `fft_size - hop_size` samples during
    /// which zeros are output (the OLA pipeline is filling).
    pub fn process(&mut self, left: &[f64], right: &[f64]) -> Channels51 {
        assert_eq!(left.len(), right.len(), "L/R must be same length");
        let n = left.len();

        let mut out_fl = Vec::with_capacity(n);
        let mut out_fr = Vec::with_capacity(n);
        let mut out_fc = Vec::with_capacity(n);
        let mut out_lfe = Vec::with_capacity(n);
        let mut out_rl = Vec::with_capacity(n);
        let mut out_rr = Vec::with_capacity(n);

        for i in 0..n {
            // 1. Push sample into input ring buffer
            self.in_l[self.in_pos] = left[i];
            self.in_r[self.in_pos] = right[i];
            self.in_pos = (self.in_pos + 1) % self.fft_size;
            if self.in_count < self.fft_size {
                self.in_count += 1;
            }
            self.hop_counter += 1;

            // 2. When we have a full window and a hop's worth of new data: process frame
            if self.in_count >= self.fft_size && self.hop_counter >= self.hop_size {
                self.process_frame();
                self.hop_counter = 0;
            }

            // 3. Pop one sample from pending output (or 0.0 during initial latency)
            let (fl, fr, fc, lfe, rl_raw, rr_raw) = if self.pending_avail > 0 {
                let p = self.pending_pos;
                let vals = (
                    self.pending_fl[p],
                    self.pending_fr[p],
                    self.pending_fc[p],
                    self.pending_lfe[p],
                    self.pending_rl[p],
                    self.pending_rr[p],
                );
                self.pending_pos += 1;
                self.pending_avail -= 1;
                vals
            } else {
                (0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
            };

            // 4. Apply rear delay via ring buffer
            let rear_delay_len = self.rear_dl_l.len();
            let delayed_rl = self.rear_dl_l[self.rear_dl_pos];
            let delayed_rr = self.rear_dl_r[self.rear_dl_pos];
            self.rear_dl_l[self.rear_dl_pos] = rl_raw;
            self.rear_dl_r[self.rear_dl_pos] = rr_raw;
            self.rear_dl_pos = (self.rear_dl_pos + 1) % rear_delay_len;

            out_fl.push(fl);
            out_fr.push(fr);
            out_fc.push(fc);
            out_lfe.push(lfe);
            out_rl.push(delayed_rl);
            out_rr.push(delayed_rr);
        }

        Channels51 {
            front_left: out_fl,
            front_right: out_fr,
            front_center: out_fc,
            lfe: out_lfe,
            rear_left: out_rl,
            rear_right: out_rr,
        }
    }

    /// Process one STFT frame from the input ring buffer into the OLA accumulators,
    /// then drain `hop_size` samples from the OLA into the pending output buffers.
    fn process_frame(&mut self) {
        let fft_size = self.fft_size;
        let hop_size = self.hop_size;
        let num_bins = fft_size / 2 + 1;

        // Extract fft_size samples from ring buffer (unwrap circular), apply window, convert to complex
        let mut left_fft: Vec<Complex<f64>> = Vec::with_capacity(fft_size);
        let mut right_fft: Vec<Complex<f64>> = Vec::with_capacity(fft_size);

        // in_pos points to the NEXT write position, so the oldest sample is at in_pos
        // (since we only call this when in_count == fft_size, the entire buffer is full)
        for k in 0..fft_size {
            let idx = (self.in_pos + k) % fft_size;
            let w = self.window[k];
            left_fft.push(Complex::new(self.in_l[idx] * w, 0.0));
            right_fft.push(Complex::new(self.in_r[idx] * w, 0.0));
        }

        // Forward FFT
        self.fft_fwd.process(&mut left_fft);
        self.fft_fwd.process(&mut right_fft);

        // Allocate output spectra
        let mut fl_spec = vec![Complex::new(0.0, 0.0); fft_size];
        let mut fr_spec = vec![Complex::new(0.0, 0.0); fft_size];
        let mut fc_spec = vec![Complex::new(0.0, 0.0); fft_size];
        let mut lfe_spec = vec![Complex::new(0.0, 0.0); fft_size];
        let mut rl_spec = vec![Complex::new(0.0, 0.0); fft_size];
        let mut rr_spec = vec![Complex::new(0.0, 0.0); fft_size];

        // Per-bin analysis and steering (identical algorithm to the original)
        for bin in 0..num_bins {
            let l = left_fft[bin];
            let r = right_fft[bin];

            let l_mag = l.norm();
            let r_mag = r.norm();

            // --- Correlation: Re(L * conj(R)) / (|L| * |R|) ---
            let denom = (l_mag * r_mag).max(1e-12);
            let correlation = (l * r.conj()).re / denom; // -1.0 to 1.0

            // --- Energy-preserving steering weights ---
            // Center extraction: proportional to correlation
            let cw = if correlation > self.config.center_threshold {
                let excess = (correlation - self.config.center_threshold)
                    / (1.0 - self.config.center_threshold);
                excess * self.config.center_strength
            } else {
                0.0
            };

            // Rear level: proportional to decorrelation
            let rw = self.config.rear_level * (1.0 - correlation.max(0.0));

            // LFE weight for low bins
            let lfe_w: f64 = if bin <= self.lfe_bin { 0.3 } else { 0.0 };

            // Remaining energy stays in front L/R.
            let extraction_per_channel = ((cw + rw + lfe_w) * 0.5).min(0.475);
            let lr_w = 1.0 - extraction_per_channel;

            // Sum and difference for center/rear derivation
            let sum = (l + r) * 0.5;
            let diff = (l - r) * 0.5;

            // Center gets correlated sum
            let center_signal = sum * cw;

            // Front L/R get the residual
            let fl_signal = l * lr_w;
            let fr_signal = r * lr_w;

            // LFE gets low-frequency mono sum
            if bin <= self.lfe_bin {
                lfe_spec[bin] = sum * lfe_w;
                if bin > 0 && bin < fft_size / 2 {
                    lfe_spec[fft_size - bin] = lfe_spec[bin].conj();
                }
            }

            // Rear channels: difference signal with all-pass decorrelation.
            let ambient_l = diff * rw;
            let ambient_r = diff * rw;

            // Apply all-pass phase rotation for spatial decorrelation
            let phase_l = Complex::from_polar(1.0, self.rear_allpass_phase_l[bin]);
            let phase_r = Complex::from_polar(1.0, self.rear_allpass_phase_r[bin]);
            let rl_signal = ambient_l * phase_l;
            let rr_signal = ambient_r * phase_r;

            // Store positive frequency bins
            fl_spec[bin] = fl_signal;
            fr_spec[bin] = fr_signal;
            fc_spec[bin] = center_signal;
            rl_spec[bin] = rl_signal;
            rr_spec[bin] = rr_signal;

            // Mirror for negative frequencies (conjugate symmetry for real output)
            if bin > 0 && bin < fft_size / 2 {
                let mirror = fft_size - bin;
                fl_spec[mirror] = fl_spec[bin].conj();
                fr_spec[mirror] = fr_spec[bin].conj();
                fc_spec[mirror] = fc_spec[bin].conj();
                rl_spec[mirror] = rl_spec[bin].conj();
                rr_spec[mirror] = rr_spec[bin].conj();
            }
        }

        // Inverse FFT all channels
        self.fft_inv.process(&mut fl_spec);
        self.fft_inv.process(&mut fr_spec);
        self.fft_inv.process(&mut fc_spec);
        self.fft_inv.process(&mut lfe_spec);
        self.fft_inv.process(&mut rl_spec);
        self.fft_inv.process(&mut rr_spec);

        // IFFT scale: rustfft doesn't normalize, so divide by fft_size
        let scale = 1.0 / fft_size as f64;

        // COLA normalization factor for Hann^2 with 75% overlap
        let cola_norm = 1.5;

        let norm = scale / cola_norm;

        // Add windowed IFFT output to OLA accumulators
        for k in 0..fft_size {
            let w = self.window[k] * norm;
            self.ola_fl[k] += fl_spec[k].re * w;
            self.ola_fr[k] += fr_spec[k].re * w;
            self.ola_fc[k] += fc_spec[k].re * w;
            self.ola_lfe[k] += lfe_spec[k].re * w;
            self.ola_rl[k] += rl_spec[k].re * w;
            self.ola_rr[k] += rr_spec[k].re * w;
        }

        // Copy first hop_size samples from OLA to pending output buffers
        self.pending_fl[..hop_size].copy_from_slice(&self.ola_fl[..hop_size]);
        self.pending_fr[..hop_size].copy_from_slice(&self.ola_fr[..hop_size]);
        self.pending_fc[..hop_size].copy_from_slice(&self.ola_fc[..hop_size]);
        self.pending_lfe[..hop_size].copy_from_slice(&self.ola_lfe[..hop_size]);
        self.pending_rl[..hop_size].copy_from_slice(&self.ola_rl[..hop_size]);
        self.pending_rr[..hop_size].copy_from_slice(&self.ola_rr[..hop_size]);
        self.pending_pos = 0;
        self.pending_avail = hop_size;

        // Shift OLA left by hop_size, zero the tail
        for ch in [
            &mut self.ola_fl,
            &mut self.ola_fr,
            &mut self.ola_fc,
            &mut self.ola_lfe,
            &mut self.ola_rl,
            &mut self.ola_rr,
        ] {
            ch.copy_within(hop_size..fft_size, 0);
            ch[fft_size - hop_size..].fill(0.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rms(signal: &[f64]) -> f64 {
        if signal.is_empty() {
            return 0.0;
        }
        (signal.iter().map(|s| s * s).sum::<f64>() / signal.len() as f64).sqrt()
    }

    fn generate_tone(freq: f64, sample_rate: f64, num_samples: usize, amplitude: f64) -> Vec<f64> {
        (0..num_samples)
            .map(|i| amplitude * (2.0 * PI * freq * i as f64 / sample_rate).sin())
            .collect()
    }

    /// Helper: skip the initial latency region (fft_size - hop_size samples)
    /// and the rear delay, returning only the steady-state portion.
    fn steady_state(ch: &Channels51, config: &StftUpmixConfig) -> Channels51 {
        let skip = config.fft_size; // conservative: skip fft_size samples
        let rear_skip = skip + config.rear_delay_samples;
        let n = ch.front_left.len();
        if skip >= n {
            return Channels51 {
                front_left: vec![],
                front_right: vec![],
                front_center: vec![],
                lfe: vec![],
                rear_left: vec![],
                rear_right: vec![],
            };
        }
        let rear_start = rear_skip.min(n);
        Channels51 {
            front_left: ch.front_left[skip..].to_vec(),
            front_right: ch.front_right[skip..].to_vec(),
            front_center: ch.front_center[skip..].to_vec(),
            lfe: ch.lfe[skip..].to_vec(),
            rear_left: ch.rear_left[rear_start..].to_vec(),
            rear_right: ch.rear_right[rear_start..].to_vec(),
        }
    }

    #[test]
    fn test_mono_signal_goes_to_center() {
        let config = StftUpmixConfig {
            sample_rate: 48000.0,
            center_threshold: 0.3,
            center_strength: 0.8,
            ..Default::default()
        };
        let mut upmixer = StftUpmixer::new(config.clone());

        let tone = generate_tone(440.0, 48000.0, 48000, 0.8);
        let result = upmixer.process(&tone, &tone);
        let ss = steady_state(&result, &config);

        let fc_rms = rms(&ss.front_center);
        let fl_rms = rms(&ss.front_left);
        let fr_rms = rms(&ss.front_right);

        assert!(
            fc_rms > fl_rms,
            "center should be louder than FL for mono: FC={fc_rms}, FL={fl_rms}"
        );
        assert!(
            fc_rms > fr_rms,
            "center should be louder than FR for mono: FC={fc_rms}, FR={fr_rms}"
        );
    }

    #[test]
    fn test_hard_panned_stays_in_lr() {
        let config = StftUpmixConfig::default();
        let mut upmixer = StftUpmixer::new(config.clone());

        let tone = generate_tone(440.0, 48000.0, 48000, 0.8);
        let silence = vec![0.0; 48000];
        let result = upmixer.process(&tone, &silence);
        let ss = steady_state(&result, &config);

        let fl_rms = rms(&ss.front_left);
        let fr_rms = rms(&ss.front_right);
        let fc_rms = rms(&ss.front_center);

        assert!(
            fl_rms > fc_rms,
            "FL should dominate for left-only: FL={fl_rms}, FC={fc_rms}"
        );
        assert!(
            fl_rms > fr_rms * 2.0,
            "FL should be much louder than FR: FL={fl_rms}, FR={fr_rms}"
        );
    }

    #[test]
    fn test_lfe_has_bass_content() {
        let config = StftUpmixConfig {
            sample_rate: 48000.0,
            lfe_crossover_hz: 120.0,
            ..Default::default()
        };
        let mut upmixer = StftUpmixer::new(config.clone());

        let bass = generate_tone(60.0, 48000.0, 48000, 0.8);
        let result = upmixer.process(&bass, &bass);
        let ss = steady_state(&result, &config);

        let lfe_rms = rms(&ss.lfe);
        assert!(lfe_rms > 0.01, "LFE should have bass content: {lfe_rms}");
    }

    #[test]
    fn test_lfe_rejects_high_frequency() {
        let config = StftUpmixConfig {
            sample_rate: 48000.0,
            lfe_crossover_hz: 120.0,
            ..Default::default()
        };

        let mut upmixer_high = StftUpmixer::new(config.clone());
        let high = generate_tone(5000.0, 48000.0, 48000, 0.8);
        let result_high = upmixer_high.process(&high, &high);
        let ss_high = steady_state(&result_high, &config);

        let mut upmixer_low = StftUpmixer::new(config.clone());
        let low = generate_tone(60.0, 48000.0, 48000, 0.8);
        let result_low = upmixer_low.process(&low, &low);
        let ss_low = steady_state(&result_low, &config);

        let lfe_high = rms(&ss_high.lfe);
        let lfe_low = rms(&ss_low.lfe);

        assert!(
            lfe_low > lfe_high * 5.0,
            "LFE should strongly prefer bass: low={lfe_low}, high={lfe_high}"
        );
    }

    #[test]
    fn test_silence_produces_silence() {
        let config = StftUpmixConfig::default();
        let mut upmixer = StftUpmixer::new(config);

        let silence = vec![0.0; 48000];
        let result = upmixer.process(&silence, &silence);

        assert!(rms(&result.front_left) < 1e-10);
        assert!(rms(&result.front_right) < 1e-10);
        assert!(rms(&result.front_center) < 1e-10);
        assert!(rms(&result.lfe) < 1e-10);
        assert!(rms(&result.rear_left) < 1e-10);
        assert!(rms(&result.rear_right) < 1e-10);
    }

    #[test]
    fn test_output_length_matches_input() {
        let config = StftUpmixConfig::default();
        let mut upmixer = StftUpmixer::new(config);

        let signal = generate_tone(440.0, 48000.0, 12345, 0.5);
        let result = upmixer.process(&signal, &signal);

        assert_eq!(result.front_left.len(), 12345);
        assert_eq!(result.front_right.len(), 12345);
        assert_eq!(result.front_center.len(), 12345);
        assert_eq!(result.lfe.len(), 12345);
        assert_eq!(result.rear_left.len(), 12345);
        assert_eq!(result.rear_right.len(), 12345);
    }

    #[test]
    fn test_energy_conservation() {
        let config = StftUpmixConfig::default();
        let mut upmixer = StftUpmixer::new(config.clone());

        let tone = generate_tone(440.0, 48000.0, 48000, 0.8);
        let result = upmixer.process(&tone, &tone);
        let ss = steady_state(&result, &config);

        let input_rms = rms(&tone);
        let input_energy = input_rms * input_rms * ss.front_left.len() as f64;
        let output_energy: f64 = ss.front_left.iter().map(|s| s * s).sum::<f64>()
            + ss.front_right.iter().map(|s| s * s).sum::<f64>()
            + ss.front_center.iter().map(|s| s * s).sum::<f64>()
            + ss.lfe.iter().map(|s| s * s).sum::<f64>()
            + ss.rear_left.iter().map(|s| s * s).sum::<f64>()
            + ss.rear_right.iter().map(|s| s * s).sum::<f64>();

        let ratio = output_energy / (2.0 * input_energy);
        assert!(
            ratio > 0.3 && ratio < 2.0,
            "energy ratio should be reasonable (0.3-2.0): ratio={ratio}"
        );
    }

    #[test]
    fn test_energy_conservation_panned() {
        let config = StftUpmixConfig::default();
        let mut upmixer = StftUpmixer::new(config.clone());

        // Hard-panned left signal
        let tone = generate_tone(440.0, 48000.0, 48000, 0.8);
        let silence = vec![0.0; 48000];
        let result = upmixer.process(&tone, &silence);
        let ss = steady_state(&result, &config);

        let input_rms = rms(&tone);
        let input_energy = input_rms * input_rms * ss.front_left.len() as f64;
        let output_energy: f64 = ss.front_left.iter().map(|s| s * s).sum::<f64>()
            + ss.front_right.iter().map(|s| s * s).sum::<f64>()
            + ss.front_center.iter().map(|s| s * s).sum::<f64>()
            + ss.lfe.iter().map(|s| s * s).sum::<f64>()
            + ss.rear_left.iter().map(|s| s * s).sum::<f64>()
            + ss.rear_right.iter().map(|s| s * s).sum::<f64>();

        let ratio = output_energy / input_energy;
        assert!(
            ratio > 0.3 && ratio < 2.0,
            "panned energy ratio should be reasonable (0.3-2.0): ratio={ratio}"
        );
    }

    #[test]
    fn test_front_lr_not_crushed_for_mono() {
        // Regression test: front L/R should retain significant energy
        // when input is mono. Previously lr_w was as low as 0.3.
        let config = StftUpmixConfig::default();
        let mut upmixer = StftUpmixer::new(config.clone());

        let tone = generate_tone(440.0, 48000.0, 48000, 0.8);
        let result = upmixer.process(&tone, &tone);
        let ss = steady_state(&result, &config);

        let fl_rms = rms(&ss.front_left);
        let fc_rms = rms(&ss.front_center);
        let input_rms = rms(&tone);

        // Front L should retain at least 40% of input amplitude
        assert!(
            fl_rms > input_rms * 0.4,
            "front L should not be crushed: FL_rms={fl_rms:.4}, input_rms={input_rms:.4}, ratio={:.2}",
            fl_rms / input_rms
        );

        // Center should not be more than 2x the front L/R
        assert!(
            fc_rms < fl_rms * 2.0,
            "center should not overwhelm fronts: FC={fc_rms:.4}, FL={fl_rms:.4}"
        );
    }

    #[test]
    fn test_front_lr_not_crushed_for_panned() {
        // Hard-panned left: front L should retain most energy
        let config = StftUpmixConfig::default();
        let mut upmixer = StftUpmixer::new(config.clone());

        let tone = generate_tone(440.0, 48000.0, 48000, 0.8);
        let silence = vec![0.0; 48000];
        let result = upmixer.process(&tone, &silence);
        let ss = steady_state(&result, &config);

        let fl_rms = rms(&ss.front_left);
        let input_rms = rms(&tone);

        // Front L should retain at least 50% of input amplitude for panned signal
        assert!(
            fl_rms > input_rms * 0.5,
            "front L should retain energy for panned input: FL_rms={fl_rms:.4}, input_rms={input_rms:.4}, ratio={:.2}",
            fl_rms / input_rms
        );
    }

    #[test]
    fn test_rear_channels_decorrelated() {
        // Rear L and R should be decorrelated (different phase content)
        let config = StftUpmixConfig::default();
        let mut upmixer = StftUpmixer::new(config.clone());

        // Use a signal with decorrelated L/R to produce rear content
        let left = generate_tone(440.0, 48000.0, 48000, 0.8);
        let right = generate_tone(440.0 * 1.01, 48000.0, 48000, 0.8); // slightly detuned
        let result = upmixer.process(&left, &right);
        let ss = steady_state(&result, &config);

        let rl_rms = rms(&ss.rear_left);
        let rr_rms = rms(&ss.rear_right);

        // Both rears should have content
        assert!(rl_rms > 0.01, "rear left should have content: {rl_rms}");
        assert!(rr_rms > 0.01, "rear right should have content: {rr_rms}");

        // Cross-correlation should be low (decorrelated)
        let n = ss.rear_left.len().min(ss.rear_right.len());
        let cross: f64 = (0..n)
            .map(|i| ss.rear_left[i] * ss.rear_right[i])
            .sum::<f64>()
            / n as f64;
        let auto_l: f64 = (0..n)
            .map(|i| ss.rear_left[i] * ss.rear_left[i])
            .sum::<f64>()
            / n as f64;
        let auto_r: f64 = (0..n)
            .map(|i| ss.rear_right[i] * ss.rear_right[i])
            .sum::<f64>()
            / n as f64;
        let norm_cross = cross / (auto_l.sqrt() * auto_r.sqrt()).max(1e-12);

        assert!(
            norm_cross.abs() < 0.95,
            "rear channels should be decorrelated: normalized cross-corr={norm_cross:.4}"
        );
    }

    #[test]
    fn test_stereo_image_preserved() {
        // A left-panned signal should stay mostly in front left,
        // and a right-panned signal mostly in front right.
        let config = StftUpmixConfig::default();
        let mut upmixer = StftUpmixer::new(config.clone());

        // Left-panned: 80% left, 20% right
        let left = generate_tone(440.0, 48000.0, 48000, 0.8);
        let right = generate_tone(440.0, 48000.0, 48000, 0.2);
        let result = upmixer.process(&left, &right);
        let ss = steady_state(&result, &config);

        let fl_rms = rms(&ss.front_left);
        let fr_rms = rms(&ss.front_right);

        assert!(
            fl_rms > fr_rms,
            "FL should be louder than FR for left-panned input: FL={fl_rms:.4}, FR={fr_rms:.4}"
        );
    }

    // --- Streaming-specific tests ---

    #[test]
    fn test_small_buffer_streaming() {
        // Verify that feeding 352-sample chunks (ALAC frame size) produces
        // the same result as feeding the entire signal at once.
        let config = StftUpmixConfig::default();
        let n = 48000;
        let tone = generate_tone(440.0, 48000.0, n, 0.8);

        // Single-shot
        let mut upmixer_batch = StftUpmixer::new(config.clone());
        let batch = upmixer_batch.process(&tone, &tone);

        // Streaming in 352-sample chunks
        let mut upmixer_stream = StftUpmixer::new(config);
        let chunk_size = 352;
        let mut stream_fl = Vec::with_capacity(n);
        let mut stream_fr = Vec::with_capacity(n);
        let mut stream_fc = Vec::with_capacity(n);
        let mut stream_lfe = Vec::with_capacity(n);
        let mut stream_rl = Vec::with_capacity(n);
        let mut stream_rr = Vec::with_capacity(n);

        let mut pos = 0;
        while pos < n {
            let end = (pos + chunk_size).min(n);
            let ch = upmixer_stream.process(&tone[pos..end], &tone[pos..end]);
            stream_fl.extend_from_slice(&ch.front_left);
            stream_fr.extend_from_slice(&ch.front_right);
            stream_fc.extend_from_slice(&ch.front_center);
            stream_lfe.extend_from_slice(&ch.lfe);
            stream_rl.extend_from_slice(&ch.rear_left);
            stream_rr.extend_from_slice(&ch.rear_right);
            pos = end;
        }

        assert_eq!(stream_fl.len(), batch.front_left.len());

        // They should be sample-identical since the state machine is deterministic
        for i in 0..n {
            assert!(
                (stream_fl[i] - batch.front_left[i]).abs() < 1e-10,
                "FL mismatch at {i}: stream={}, batch={}",
                stream_fl[i], batch.front_left[i]
            );
            assert!(
                (stream_rl[i] - batch.rear_left[i]).abs() < 1e-10,
                "RL mismatch at {i}: stream={}, batch={}",
                stream_rl[i], batch.rear_left[i]
            );
        }
    }

    #[test]
    fn test_single_sample_streaming() {
        // Feed one sample at a time — extreme case
        let config = StftUpmixConfig::default();
        let n = 4096;
        let tone = generate_tone(440.0, 48000.0, n, 0.8);

        let mut upmixer_batch = StftUpmixer::new(config.clone());
        let batch = upmixer_batch.process(&tone, &tone);

        let mut upmixer_stream = StftUpmixer::new(config);
        let mut stream_fl = Vec::with_capacity(n);
        for i in 0..n {
            let ch = upmixer_stream.process(&tone[i..i + 1], &tone[i..i + 1]);
            stream_fl.extend_from_slice(&ch.front_left);
        }

        for i in 0..n {
            assert!(
                (stream_fl[i] - batch.front_left[i]).abs() < 1e-10,
                "FL mismatch at {i}: stream={}, batch={}",
                stream_fl[i], batch.front_left[i]
            );
        }
    }
}
