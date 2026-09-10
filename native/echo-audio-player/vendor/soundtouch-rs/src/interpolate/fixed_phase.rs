//! Fixed-point phase tracker for sample-rate transposition.
//!
//! Uses 20 fractional bits (~1 ppm precision) to avoid expensive `f64::floor()`
//! calls inside hot loops.

/// Number of fractional bits in the fixed-point representation.
const FRACT_BITS: u32 = 20;

/// Scale factor: `2^FRACT_BITS`.
const FRACT_SCALE: f64 = (1 << FRACT_BITS) as f64;

/// Bit-mask for extracting the fractional part.
const FRACT_MASK: u32 = (1 << FRACT_BITS) - 1;

/// Pre-computed reciprocal `1 / 2^FRACT_BITS` for fast f32 conversion.
const FRACT_INV: f32 = 1.0 / (1 << FRACT_BITS) as f32;

/// Fixed-point phase tracker shared by all interpolation algorithms.
#[derive(Clone, Copy, PartialEq, Eq, Default, Debug)]
pub struct FixedPhase {
    /// Per-sample phase increment (fixed-point).
    rate: u32,
    /// Current phase accumulator (fixed-point).
    phase: u32,
}

impl FixedPhase {
    /// Creates a new phase tracker initialized to zero.
    #[must_use]
    pub const fn new() -> Self {
        Self { rate: 0, phase: 0 }
    }

    /// Updates the phase increment step based on the provided playback rate.
    pub const fn set_rate(&mut self, rate: f64) {
        self.rate = (rate * FRACT_SCALE) as u32;
    }

    /// Resets the accumulated fractional phase to zero, used when flushing the pipeline.
    pub const fn reset_phase(&mut self) {
        self.phase = 0;
    }

    /// Returns the current fractional part as `f32` in `[0, 1)`.
    #[must_use]
    pub const fn fract_f32(self) -> f32 {
        (self.phase & FRACT_MASK) as f32 * FRACT_INV
    }

    /// Advances the phase by one step and returns the number of integer source
    /// samples to skip.
    pub const fn advance(&mut self) -> usize {
        self.phase += self.rate;
        let skip = (self.phase >> FRACT_BITS) as usize;
        self.phase &= FRACT_MASK;
        skip
    }
}
