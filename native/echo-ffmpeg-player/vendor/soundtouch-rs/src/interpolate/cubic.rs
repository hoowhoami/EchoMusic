//! Four-point cubic Hermite spline interpolation.

use super::fixed_phase::FixedPhase;

/// Mono-channel cubic (4-point Hermite) sample-rate transposition.
///
/// Uses the four surrounding source samples `[p0, p1, p2, p3]` to compute:
///
/// ```text
/// y = a*f³ + b*f² + c*f + p1
/// ```
///
/// where the Hermite coefficients are:
///
/// ```text
/// a = p3/2 - p0/2 + 1.5*(p1 - p2)
/// b = p0 - 2.5*p1 + 2*p2 - p3/2
/// c = p2/2 - p0/2
/// ```
///
/// Horner evaluation via `fma` keeps the latency chain to 3 FMAs.
///
/// # Returns
/// `(frames_consumed, frames_produced, new_fract)`
pub fn cubic_transpose_mono(
    dest: &mut [f32],
    src: &[f32],
    mut phase: FixedPhase,
) -> (usize, usize, FixedPhase) {
    if src.len() < 4 || dest.is_empty() {
        return (0, 0, phase);
    }

    let mut src_idx = 0;
    let mut dest_idx = 0;

    for out_sample in dest.iter_mut() {
        if let Some(&[p0, p1, p2, p3, ..]) = src.get(src_idx..) {
            let f = phase.fract_f32();

            // Pre-compute halves to reduce repeated multiplications.
            let half_p0 = 0.5 * p0;
            let half_p3 = 0.5 * p3;

            // Hermite basis coefficients.
            let c = 0.5f32.mul_add(p2, -half_p0);
            let a = 1.5f32.mul_add(p1 - p2, half_p3 - half_p0);
            let b = 2.0f32.mul_add(p2, 2.5f32.mul_add(-p1, p0)) - half_p3;

            // Horner evaluation: ((a*f + b)*f + c)*f + p1 — 3 FMAs.
            *out_sample = a.mul_add(f, b).mul_add(f, c).mul_add(f, p1);
            dest_idx += 1;

            src_idx += phase.advance();
        } else {
            break;
        }
    }

    (src_idx, dest_idx, phase)
}
