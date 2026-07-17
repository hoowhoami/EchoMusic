use std::sync::Once;

use ffmpeg_audio_sys::LogLevel;

use crate::sys;

static INIT_LOGGING: Once = Once::new();

/// Set the log level for FFmpeg
pub fn set_log_level(level: LogLevel) {
    init_ffmpeg_logging();

    unsafe {
        sys::av_log_set_level(level.into());
    }
}

pub fn init_ffmpeg_logging() {
    INIT_LOGGING.call_once(|| unsafe {
        #[cfg(feature = "tracing")]
        {
            sys::av_log_set_level(sys::AV_LOG_TRACE.cast_signed());
            sys::av_log_set_callback(Some(ffmpeg_log_callback));
        }
        #[cfg(not(feature = "tracing"))]
        {
            sys::av_log_set_level(sys::AV_LOG_WARNING.cast_signed());
        }
    });
}

#[cfg(feature = "tracing")]
unsafe extern "C" fn ffmpeg_log_callback(
    avcl: *mut std::os::raw::c_void,
    level: std::os::raw::c_int,
    fmt: *const std::os::raw::c_char,
    vl: sys::VaList,
) {
    use std::ffi::{
        CStr,
        c_int,
    };

    let mut buf = [0u8; 1024];
    let mut print_prefix: c_int = 1;

    unsafe {
        sys::av_log_format_line2(
            avcl,
            level,
            fmt,
            vl,
            buf.as_mut_ptr().cast(),
            buf.len() as c_int,
            &raw mut print_prefix,
        )
    };

    let msg = unsafe { CStr::from_ptr(buf.as_ptr().cast()).to_string_lossy() };
    let msg = msg.trim_end();
    if msg.is_empty() {
        return;
    }

    match level {
        l if l <= sys::AV_LOG_ERROR.cast_signed() => tracing::error!(target: "ffmpeg", "{msg}"),
        l if l <= sys::AV_LOG_WARNING.cast_signed() => tracing::warn!(target: "ffmpeg", "{msg}"),
        l if l <= sys::AV_LOG_INFO.cast_signed() => tracing::info!(target: "ffmpeg", "{msg}"),
        l if l <= sys::AV_LOG_VERBOSE.cast_signed() => tracing::debug!(target: "ffmpeg", "{msg}"),
        _ => tracing::trace!(target: "ffmpeg", "{msg}"),
    }
}
