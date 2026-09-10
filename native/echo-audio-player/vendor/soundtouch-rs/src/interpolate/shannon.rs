//! Sample interpolation routine using 8-tap band-limited Shannon interpolation
//! with kaiser window.

use std::f64::consts::PI;

use wide::f32x8;

use crate::interpolate::fixed_phase::FixedPhase;

/// Number of filter taps for the sinc interpolator.
const TAP_COUNT: usize = 16;
/// Width of the SIMD register used for vectorized processing.
const SIMD_WIDTH: usize = 8;
/// Number of SIMD blocks processed per interpolated sample.
const NUM_BLOCKS: usize = TAP_COUNT / SIMD_WIDTH;

/// Kaiser window coefficients (beta = 6.0), scaled down by 5% to avoid overflow.
#[rustfmt::skip]
const KAISER16: [f64; 16] = [
    0.0141, 0.0686, 0.1710, 0.3221, 0.5067, 0.6953, 0.8506, 0.9385,
    0.9385, 0.8506, 0.6953, 0.5067, 0.3221, 0.1710, 0.0686, 0.0141,
];

/// Sinc weights incorporating the alternating sign pattern derived from the
/// identity: sin(pi * (k - f)) = -(-1)^k * sin(pi * f). Pre-divided by PI to
/// merge the sinc denominator normalization step into a single multiplication.
const KAISER_PI_BLOCKS: [[f32; SIMD_WIDTH]; NUM_BLOCKS] = {
    let mut blocks = [[0.0; SIMD_WIDTH]; NUM_BLOCKS];
    let mut i = 0;

    while i < 16 {
        let val = (KAISER16[i] / PI) as f32;
        blocks[i / 8][i % 8] = if i % 2 == 1 { -val } else { val };
        i += 1;
    }
    blocks
};

/// Fallback window weights applied when evaluating the limit as (k - f) approaches 0.
/// At perfect integer sample crossings, sinc(0) evaluates to 1.0, leaving only the window value.
const KAISER_FB_BLOCKS: [[f32; SIMD_WIDTH]; NUM_BLOCKS] = {
    let mut blocks = [[0.0; SIMD_WIDTH]; NUM_BLOCKS];
    let mut i = 0;

    while i < 16 {
        blocks[i / 8][i % 8] = KAISER16[i] as f32;
        i += 1;
    }
    blocks
};

/// Performs Whittaker-Shannon interpolation for mono audio signals.
///
/// This algorithm is remarkably much heavier than linear or cubic
/// interpolation, and not remarkably better than cubic algorithm. Thus mostly
/// for experimental purposes
///
/// # Arguments
///
/// * `rate` - The phase increment per output sample (e.g., 0.5 = half speed, 2.0 = double speed).
/// * `dest` - The destination buffer for the interpolated samples.
/// * `src` - The source audio buffer.
/// * `start_fract` - The initial fractional phase offset [0.0, 1.0).
///
/// # Returns
///
/// A tuple containing:
/// 1. The number of source samples consumed.
/// 2. The number of destination samples written.
/// 3. The remaining fractional phase offset for the next block.
pub fn shannon_transpose_mono(
    dest: &mut [f32],
    src: &[f32],
    mut phase: FixedPhase,
) -> (usize, usize, FixedPhase) {
    if src.len() < TAP_COUNT || dest.is_empty() {
        return (0, 0, phase);
    }

    // Integer time offsets (k) for the 16-tap window symmetric around the target center.
    let k_blocks = [
        f32x8::from([-7.0, -6.0, -5.0, -4.0, -3.0, -2.0, -1.0, 0.0]),
        f32x8::from([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]),
    ];

    let kaiser_pi_blocks = [
        f32x8::from(KAISER_PI_BLOCKS[0]),
        f32x8::from(KAISER_PI_BLOCKS[1]),
    ];

    let kaiser_fb_blocks = [
        f32x8::from(KAISER_FB_BLOCKS[0]),
        f32x8::from(KAISER_FB_BLOCKS[1]),
    ];

    // Singularity threshold to trap division-by-zero errors at integer sample alignments.
    let threshold_simd = f32x8::splat(1e-6);

    let mut src_idx = 0;
    let mut dest_idx = 0;

    // Bounds limit ensuring a complete 16-sample neighborhood is available for convolution.
    let src_end_limit = src.len() - (TAP_COUNT - 1);
    while src_idx < src_end_limit && dest_idx < dest.len() {
        let f = phase.fract_f32();
        let fract_simd = f32x8::splat(f);

        // Single periodic term shared across all 16 taps via trigonometric reduction.
        let sin_val = (std::f32::consts::PI * f).sin();
        let sin_simd = f32x8::splat(sin_val);

        let mut output_sample = 0.0;

        for i in 0..NUM_BLOCKS {
            let x_simd = k_blocks[i] - fract_simd;
            let mask = x_simd.abs().simd_lt(threshold_simd);

            // Sinc computation: window * (sin(pi * x) / (pi * x))
            let num = kaiser_pi_blocks[i] * sin_simd;
            let computed_weights = num * x_simd.recip();
            let weights = mask.blend(kaiser_fb_blocks[i], computed_weights);

            let in_slice = &src[src_idx + i * SIMD_WIDTH..src_idx + (i + 1) * SIMD_WIDTH];
            let in_array: [f32; 8] = in_slice.try_into().unwrap();
            let in_simd = f32x8::from(in_array);

            output_sample += (in_simd * weights).reduce_add();
        }

        dest[dest_idx] = output_sample;

        // Advance processing phase and normalize fractional tracking into the [0.0, 1.0) space.
        dest_idx += 1;
        src_idx += phase.advance();
    }

    (src_idx, dest_idx, phase)
}
