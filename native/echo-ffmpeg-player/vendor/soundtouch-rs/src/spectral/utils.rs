// SPDX-License-Identifier: MIT
// Portions adapted from Signalsmith Stretch.
// Copyright (c) 2022 Geraint Luff / Signalsmith Audio Ltd.
// See LICENSE-SIGNALSMITH.md in this directory.

use realfft::num_complex::Complex;

/// Xorshift32 Pseudo-Random Number Generator
#[derive(Debug, Clone)]
pub struct Xorshift32 {
    state: u32,
}

impl Xorshift32 {
    pub const fn new(seed: u32) -> Self {
        Self {
            state: if seed == 0 { 0x1234_5678 } else { seed },
        }
    }

    pub const fn next_u32(&mut self) -> u32 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.state = x;
        x
    }

    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() as f32) / (u32::MAX as f32)
    }

    pub fn next_range(&mut self, min: f32, max: f32) -> f32 {
        (max - min).mul_add(self.next_f32(), min)
    }
}

impl Default for Xorshift32 {
    fn default() -> Self {
        Self::new(0x1234_5678)
    }
}

pub fn mul_complex(a: Complex<f32>, b: Complex<f32>, conjugate_second: bool) -> Complex<f32> {
    if conjugate_second {
        Complex::new(
            b.im.mul_add(a.im, b.re * a.re),
            b.im.mul_add(-a.re, b.re * a.im),
        )
    } else {
        Complex::new(
            a.im.mul_add(-b.im, a.re * b.re),
            a.im.mul_add(b.re, a.re * b.im),
        )
    }
}

pub fn norm_complex(a: Complex<f32>) -> f32 {
    a.im.mul_add(a.im, a.re * a.re)
}
