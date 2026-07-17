use std::{
    ffi::CStr,
    io::{
        Error as IoError,
        ErrorKind as IoErrorKind,
    },
    os::raw::c_int,
};

use thiserror::Error;

use crate::sys;

#[derive(Debug, Error)]
pub enum HttpError {
    #[error("Server does not support Range requests")]
    UnsupportedRange,

    #[error("Unknown stream length (no valid Content-Range or Content-Length found)")]
    UnknownLength,

    #[error("HTTP error status: {0}")]
    Status(u16),

    #[error("Operation cancelled by user")]
    Cancelled,

    #[error("Max network retries reached or required retry delay exceeds safety limit")]
    Timeout,

    #[error("Transport error: {0}")]
    Transport(String),
}

#[derive(Debug, Error)]
pub enum AudioError {
    #[error("End of file")]
    Eof,

    #[error("Resource temporarily unavailable")]
    Eagain,

    #[error("FFmpeg error {0}: {1}")]
    FFmpeg(i32, String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Audio format mismatch: requested type does not match resampler output format")]
    FormatMismatch,

    #[error("Invalid parameter: {0}")]
    InvalidParameter(String),

    #[error("Invalid or corrupted media data encountered: {0}")]
    InvalidData(String),

    #[error("Memory allocation or layout calculation failed: {0}")]
    AllocationFailed(String),

    #[error("HTTP error: {0}")]
    Http(#[from] HttpError),
}

impl AudioError {
    #[must_use]
    pub fn from_ffmpeg(code: i32) -> Self {
        match code {
            sys::AVERROR_EOF => Self::Eof,
            sys::AVERROR_EAGAIN => Self::Eagain,
            _ => {
                let mut buf = [0u8; sys::AV_ERROR_MAX_STRING_SIZE as usize];

                unsafe {
                    sys::av_strerror(code, buf.as_mut_ptr().cast::<libc::c_char>(), buf.len());
                }

                let error_message = CStr::from_bytes_until_nul(&buf).map_or_else(
                    |_| "Unknown FFmpeg error when parsing C string".to_string(),
                    |c_str| c_str.to_string_lossy().into_owned(),
                );

                Self::FFmpeg(code, error_message)
            }
        }
    }
}

impl From<AudioError> for IoError {
    fn from(err: AudioError) -> Self {
        match err {
            AudioError::Io(e) => e,
            AudioError::Eof => Self::new(IoErrorKind::UnexpectedEof, err.to_string()),
            AudioError::Http(HttpError::Cancelled) => {
                Self::new(IoErrorKind::Interrupted, err.to_string())
            }
            AudioError::Http(HttpError::Timeout) => {
                Self::new(IoErrorKind::TimedOut, err.to_string())
            }
            AudioError::Http(HttpError::Status(status)) if (401..=403).contains(&status) => {
                Self::new(IoErrorKind::PermissionDenied, err.to_string())
            }
            _ => Self::other(err.to_string()),
        }
    }
}

pub type Result<T> = std::result::Result<T, AudioError>;

/// An extension trait for FFmpeg's `c_int` return codes.
///
/// This trait provides convenient methods to convert raw FFmpeg integer
/// return values into idiomatic Rust `Result` types, automatically
/// handling error mapping and common control flow states like EOF.
pub trait FfErrorExt {
    fn into_ff_result(self) -> Result<c_int>;
    fn into_ff_opt(self) -> Result<Option<c_int>>;
}

impl FfErrorExt for c_int {
    /// Converts an FFmpeg return code into a `Result<c_int>`.
    ///
    /// Values greater than or equal to `0` are considered successful and are
    /// returned as `Ok(val)`. Negative values are treated as errors and are
    /// mapped to [`AudioError`].
    ///
    /// # Errors
    ///
    /// Returns an [`AudioError`] if the underlying FFmpeg operation returns a
    /// negative error code.
    fn into_ff_result(self) -> Result<c_int> {
        if self < 0 {
            Err(AudioError::from_ffmpeg(self))
        } else {
            Ok(self)
        }
    }

    /// Converts an FFmpeg return code into a `Result<Option<c_int>>`
    ///
    /// This method handles the [`AVERROR_EOF`](sys::AVERROR_EOF) state by mapping it to `Ok(None)`,
    /// distinguishing expected end-of-stream states from actual fatal errors.
    ///
    /// # Returns
    ///
    /// - `Ok(None)` if the return code is [`AVERROR_EOF`](sys::AVERROR_EOF).
    /// - `Ok(Some(val))` if the return code is greater than or equal to `0`.
    /// - `Err(AudioError)` for any other negative return code.
    ///
    /// # Errors
    ///
    /// Returns an [`AudioError`] if the underlying FFmpeg operation fails with an
    /// error code other than `AVERROR_EOF`.
    fn into_ff_opt(self) -> Result<Option<c_int>> {
        if self == sys::AVERROR_EOF {
            Ok(None)
        } else if self < 0 {
            Err(AudioError::from_ffmpeg(self))
        } else {
            Ok(Some(self))
        }
    }
}
