use super::{
    AV_TIME_BASE,
    AVRational,
    averror,
};

#[must_use]
pub const fn fferr(tag: &[u8; 4]) -> i32 {
    -u32::from_le_bytes(*tag).cast_signed()
}

#[must_use]
pub const fn fferr_f8(tag: &[u8; 3]) -> i32 {
    let bytes = [0xF8, tag[0], tag[1], tag[2]];
    -u32::from_le_bytes(bytes).cast_signed()
}

/// End of file
pub const AVERROR_EOF: i32 = fferr(b"EOF ");

/// Invalid data found when processing input
pub const AVERROR_INVALIDDATA: i32 = fferr(b"INDA");

/// Resource temporarily unavailable
pub const AVERROR_EAGAIN: i32 = averror(libc::EAGAIN);

/// Not enough space
pub const AVERROR_ENOMEM: i32 = averror(libc::ENOMEM);

/// Decoder not found
pub const AVERROR_DECODER_NOT_FOUND: i32 = fferr_f8(b"DEC");

/// Undefined timestamp value
///
/// Usually reported by demuxer that work on containers that do not provide
/// either pts or dts.
pub const AV_NOPTS_VALUE: i64 = i64::MIN;

/// Internal time base represented as fractional value
pub const MICROSECONDS_Q: AVRational = AVRational {
    num: 1,
    den: AV_TIME_BASE.cast_signed(),
};

/// FFmpeg Logging Constants
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    /// Print no output.
    Quiet,

    /// Something went really wrong and we will crash now.
    Panic,

    /// Something went wrong and recovery is not possible.
    ///
    /// For example, no header was found for a format which depends
    /// on headers or an illegal combination of parameters is used.
    Fatal,

    /// Something went wrong and cannot losslessly be recovered.
    ///
    /// However, not all future data is affected.
    Error,

    /// Something somehow does not look correct.
    ///
    /// This may or may not lead to problems. An example would be the use of
    /// `-vstrict -2`.
    Warning,

    /// Standard information.
    Info,

    /// Detailed information.
    Verbose,

    /// Stuff which is only useful for libav* developers.
    Debug,

    /// Extremely verbose debugging, useful for libav* development.
    Trace,
}

#[rustfmt::skip]
impl From<LogLevel> for i32 {
    fn from(level: LogLevel) -> Self {
        match level {
            LogLevel::Quiet   => super::AV_LOG_QUIET,
            LogLevel::Panic   => super::AV_LOG_PANIC.cast_signed(),
            LogLevel::Fatal   => super::AV_LOG_FATAL.cast_signed(),
            LogLevel::Error   => super::AV_LOG_ERROR.cast_signed(),
            LogLevel::Warning => super::AV_LOG_WARNING.cast_signed(),
            LogLevel::Info    => super::AV_LOG_INFO.cast_signed(),
            LogLevel::Verbose => super::AV_LOG_VERBOSE.cast_signed(),
            LogLevel::Debug   => super::AV_LOG_DEBUG.cast_signed(),
            LogLevel::Trace   => super::AV_LOG_TRACE.cast_signed(),
        }
    }
}
