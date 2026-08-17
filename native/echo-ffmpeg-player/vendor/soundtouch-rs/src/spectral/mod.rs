// SPDX-License-Identifier: MIT
// Portions adapted from Signalsmith Stretch.
// Copyright (c) 2022 Geraint Luff / Signalsmith Audio Ltd.
// See LICENSE-SIGNALSMITH.md in this directory.

mod stft;
mod stretch;
mod utils;
mod vocoder;
mod windows;

pub use stretch::{SpectralPreset, SpectralStretch, SpectralStretchBuilder};
pub use windows::SpectralWindowShape;
