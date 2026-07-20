use std::f64::consts::PI;

use wide::f32x8;

use crate::error::{
    Result,
    SoundTouchError,
};

/// Anti-aliasing low-pass filter (FIR Filter).
///
/// Used to cut off high frequencies and prevent aliasing noise when reducing the sampling rate.
pub struct AaFilter {
    /// Filter coefficients, typically 64 or 128.
    coeffs: Vec<f32>,

    /// Filter length (number of taps), must be a multiple of 4.
    length: usize,

    /// Normalized cutoff frequency (between 0.0 and 0.5, where 0.5 represents the Nyquist
    /// frequency).
    cutoff_freq: f64,
}

impl AaFilter {
    /// Creates a new anti-aliasing filter.
    ///
    /// `max_length` is used to pre-allocate memory capacity, ensuring zero memory allocation
    /// when the length is changed dynamically later.
    pub fn new(max_length: usize) -> Result<Self> {
        if max_length == 0 || !max_length.is_multiple_of(4) {
            return Err(SoundTouchError::FilterLengthNotMultipleOf4 {
                provided: max_length,
            });
        }

        let mut filter = Self {
            coeffs: Vec::with_capacity(max_length),
            length: max_length,
            cutoff_freq: 0.5,
        };

        filter.coeffs.resize(max_length, 0.0);
        filter.calculate_coeffs();
        Ok(filter)
    }

    /// Sets a new cutoff frequency and recalculates the coefficients.
    pub fn set_cutoff_freq(&mut self, new_cutoff: f64) {
        let clamped_cutoff = new_cutoff.clamp(1e-5, 0.5);

        if (self.cutoff_freq - clamped_cutoff).abs() > 1e-6 {
            self.cutoff_freq = clamped_cutoff;
            self.calculate_coeffs();
        }
    }

    /// Sets a new filter length and recalculates the coefficients.
    pub fn set_length(&mut self, new_length: usize) -> Result<()> {
        if new_length == 0 || !new_length.is_multiple_of(4) {
            return Err(SoundTouchError::FilterLengthNotMultipleOf4 {
                provided: new_length,
            });
        }
        if new_length > self.coeffs.capacity() {
            return Err(SoundTouchError::FilterCapacityExceeded {
                provided: new_length,
                capacity: self.coeffs.capacity(),
            });
        }

        if self.length != new_length {
            self.length = new_length;
            self.calculate_coeffs();
        }
        Ok(())
    }

    /// Returns the active length (number of taps) of the filter.
    #[must_use]
    pub const fn length(&self) -> usize {
        self.length
    }

    /// Calculates Hamming window and Sinc Function coefficients.
    fn calculate_coeffs(&mut self) {
        if self.length == 0 {
            return;
        }

        let mut sum = 0.0;
        let wc = 2.0 * PI * self.cutoff_freq;
        let temp_coeff = 2.0 * PI / (self.length as f64);
        let half_len = (self.length / 2) as f64;

        for i in 0..self.length {
            let cnt_temp = (i as f64) - half_len;
            let temp = cnt_temp * wc;

            // Sinc function: sin(x) / x
            let h = if temp == 0.0 { 1.0 } else { temp.sin() / temp };

            // Hamming window
            let w = 0.46f64.mul_add((temp_coeff * cnt_temp).cos(), 0.54);

            let val = (w * h) as f32;
            self.coeffs[i] = val;
            sum += val;
        }

        let scale = 1.0 / sum;
        for coeff in self.coeffs.iter_mut().take(self.length) {
            *coeff *= scale;
        }
    }

    /// Performs mono FIR filtering (Mono 1D core data plane method).
    ///
    /// Reads data from the physically contiguous single-channel `src` slice, filters it,
    /// and writes it directly to the single-channel `dest` slice.
    ///
    /// Due to the length of the FIR filter, the number of frames generated into `dest`
    /// will be `self.length` fewer than the number of frames provided by `src`.
    ///
    /// # Returns
    /// The number of output frames generated.
    pub fn evaluate_mono(&self, dest: &mut [f32], src: &[f32]) -> usize {
        if src.len() < self.length {
            return 0;
        }

        let out_frames = src.len() - self.length;
        let frames_to_process = out_frames.min(dest.len());

        if frames_to_process == 0 {
            return 0;
        }

        let coeffs = &self.coeffs[..self.length];
        assert!(
            coeffs.len().is_multiple_of(8),
            "Coeffs length must be multiple of 8"
        );

        let mut i = 0;

        // Process 8 output samples simultaneously to maximize SIMD throughput and avoid cross-lane
        // penalties.
        while i + 8 <= frames_to_process {
            let src_window = &src[i..i + coeffs.len() + 7];

            // 4 independent accumulators to break instruction dependency chains
            let mut acc = [f32x8::ZERO; 4];

            let c_chunks = coeffs.chunks_exact(8);
            let s_chunks = src_window.windows(15).step_by(8);

            for (c, s) in c_chunks.zip(s_chunks) {
                for j in 0..8 {
                    let c_val = f32x8::splat(c[j]);
                    let s_val = f32x8::new(s[j..j + 8].try_into().unwrap());

                    acc[j % 4] = s_val.mul_add(c_val, acc[j % 4]);
                }
            }

            let final_acc = acc[0] + acc[1] + acc[2] + acc[3];
            let acc_arr: [f32; 8] = final_acc.into();
            dest[i..i + 8].copy_from_slice(&acc_arr);

            i += 8;
        }

        // Process the remaining samples (< 8) sequentially
        for k in i..frames_to_process {
            let src_window = &src[k..k + coeffs.len()];
            let mut sum_vec = f32x8::ZERO;

            for (s, c) in src_window.chunks_exact(8).zip(coeffs.chunks_exact(8)) {
                let s_val = f32x8::new(s.try_into().unwrap());
                let c_val = f32x8::new(c.try_into().unwrap());
                sum_vec = s_val.mul_add(c_val, sum_vec);
            }

            dest[k] = sum_vec.reduce_add();
        }

        frames_to_process
    }
}
