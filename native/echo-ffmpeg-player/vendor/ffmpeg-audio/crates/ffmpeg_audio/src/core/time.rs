use crate::{
    AudioError,
    Result,
    sys,
};

/// The time base of an audio stream.
///
/// A wrapper around FFmpeg's `AVRational` that encapsulates the logic for
/// time timestamp conversions.
#[derive(Debug, Clone, Copy)]
pub struct TimeBase(sys::AVRational);

impl TimeBase {
    /// Creates a new `TimeBase` from a raw FFmpeg `AVRational`.
    pub fn try_new(tb: sys::AVRational) -> Result<Self> {
        if tb.den <= 0 || tb.num <= 0 {
            return Err(AudioError::InvalidParameter(format!(
                "Invalid stream time base encountered: {}/{}",
                tb.num, tb.den
            )));
        }
        Ok(Self(tb))
    }

    /// Extracts the underlying raw FFmpeg `AVRational`.
    ///
    /// This is useful when the raw fraction needs to be passed back into
    /// pure FFI interfaces (such as initializing a resampler context).
    #[must_use]
    pub const fn as_rational(self) -> sys::AVRational {
        self.0
    }

    /// Converts a PTS into signed microseconds.
    ///
    /// This method is primarily designed for internal low-level algorithms (like
    /// precise duration scanning or handling encoder pre-roll padding) where
    /// retaining negative timestamps is mathematically necessary.
    ///
    /// # Returns
    /// - `Some(i64)` representing the exact physical time in microseconds.
    /// - `None` if the provided PTS is invalid (`sys::AV_NOPTS_VALUE`).
    ///
    /// # Note
    /// The resulting value **can be negative** if the frame represents
    /// encoder delay or padding before the physical start of the track (0.0s).
    #[must_use]
    pub(crate) fn calc_micros(self, pts: i64) -> Option<i64> {
        if pts == sys::AV_NOPTS_VALUE {
            return None;
        }

        unsafe { Some(sys::av_rescale_q(pts, self.0, sys::MICROSECONDS_Q)) }
    }
}
