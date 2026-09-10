//! Two-point linear interpolation.

use super::fixed_phase::FixedPhase;

/// Mono-channel linear (two-point) sample-rate transposition.
///
/// For each output sample, computes:
///
/// ```text
/// y = (1 - f) * src[i] + f * src[i + 1]
/// ```
///
/// where `f` is the fractional phase and `i` is the integer index.
///
/// Phase is tracked in fixed-point ([`FixedPhase`]) to avoid `f64::floor()`
/// calls in the hot loop.
///
/// # Returns
/// `(frames_consumed, frames_produced, new_fract)`
pub fn linear_transpose_mono(
    dest: &mut [f32],
    src: &[f32],
    mut phase: FixedPhase,
) -> (usize, usize, FixedPhase) {
    if src.len() < 2 || dest.is_empty() {
        return (0, 0, phase);
    }

    let mut src_idx = 0;
    let mut dest_idx = 0;

    for out_sample in dest.iter_mut() {
        if src_idx + 1 >= src.len() {
            break;
        }

        let f = phase.fract_f32();
        // Lerp: y = src[i] + (src[i+1] - src[i]) * f
        *out_sample = (src[src_idx + 1] - src[src_idx]).mul_add(f, src[src_idx]);
        dest_idx += 1;

        src_idx += phase.advance();
    }

    (src_idx, dest_idx, phase)
}
