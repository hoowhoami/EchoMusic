mod aa_filter;
pub mod bpm_detect;
mod error;
mod fifo;
mod interpolate;
mod peak_finder;
mod rate_transposer;
mod soundtouch;
#[cfg(feature = "spectral")]
mod spectral;
mod td_stretch;

pub use bpm_detect::{Beat, BpmDetect};
pub use error::{Result, SoundTouchError};
pub use interpolate::InterpolationAlgorithm;
pub use soundtouch::{SoundTouch, SoundTouchPreset};
#[cfg(feature = "spectral")]
pub use spectral::{SpectralPreset, SpectralStretch, SpectralStretchBuilder, SpectralWindowShape};
