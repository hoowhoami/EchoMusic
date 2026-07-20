//! Mono-channel sample-rate interpolation algorithms.
//!
//! Provides three interpolation strategies ([`InterpolationAlgorithm`]):
//!
//! | Algorithm | Quality | Latency (frames)  | Method                 |
//! |-----------|---------|-------------------|------------------------|
//! | Linear    | Low     | 0                 | Two-point linear blend |
//! | Cubic     | Medium  | 1                 | 4-point Hermite spline |
//! | Shannon   | High    | 3                 | Windowed 16-tap sinc   |

mod cubic;
mod fixed_phase;
mod linear;
mod shannon;

use cubic::cubic_transpose_mono;
use linear::linear_transpose_mono;
use shannon::shannon_transpose_mono;

#[rustfmt::skip]
pub use fixed_phase::FixedPhase as InterpolatorState;

/// Interpolation algorithm selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InterpolationAlgorithm {
    /// Two-point linear blend. Lowest latency, lowest quality.
    Linear,

    /// 4-point Hermite spline. Good balance of performance and quality.
    #[default]
    Cubic,

    /// Windowed 16-tap sinc filter. Highest quality, highest computational cost.
    Shannon,
}

/// Interpolator dispatch layer.
#[derive(Clone, Copy, Default)]
pub struct Interpolator {
    /// The active interpolation algorithm.
    pub algo: InterpolationAlgorithm,
}

impl Interpolator {
    /// Creates a new interpolator with the given algorithm.
    #[must_use]
    pub const fn new(algo: InterpolationAlgorithm) -> Self {
        Self { algo }
    }

    /// Returns the inherent latency of the current algorithm.
    ///
    /// This represents the number of context frames needed before producing the first output
    /// sample.
    #[must_use]
    pub const fn latency(self) -> usize {
        match self.algo {
            InterpolationAlgorithm::Linear => 0,
            InterpolationAlgorithm::Cubic => 1,
            InterpolationAlgorithm::Shannon => 3,
        }
    }

    /// Performs stateless mono-channel sample-rate conversion.
    ///
    /// Reads from a contiguous `src` buffer and writes resampled output into
    /// `dest`. Phase continuity is preserved across calls by passing the
    /// returned `new_fract` back as `start_fract` in the next invocation.
    ///
    /// # Arguments
    /// * `rate` — Time-step ratio (`output_rate` / `input_rate`).
    /// * `dest` — Destination slice for interpolated output samples.
    /// * `src` — Source slice of input samples.
    /// * `start_fract` — Initial fractional phase offset for this batch.
    ///
    /// # Returns
    /// `(frames_consumed, frames_produced, new_fract)`
    pub fn transpose_mono(
        self,
        dest: &mut [f32],
        src: &[f32],
        phase: InterpolatorState,
    ) -> (usize, usize, InterpolatorState) {
        match self.algo {
            InterpolationAlgorithm::Linear => linear_transpose_mono(dest, src, phase),
            InterpolationAlgorithm::Cubic => cubic_transpose_mono(dest, src, phase),
            InterpolationAlgorithm::Shannon => shannon_transpose_mono(dest, src, phase),
        }
    }
}
