mod bindings;
mod consts;

pub use bindings::*;
pub use consts::*;

/// Returns a negative error code from a POSIX error code, to return from library functions.
#[must_use]
pub const fn averror(e: i32) -> i32 {
    // This is actually unnecessary, as the purpose of AVERROR is simply to ensure the error code is
    // negative. We could just check if the provided error code is negative and convert it
    // accordingly. However, to match FFmpeg's original behavior, we still use EDOM for the
    // check here.
    if libc::EDOM > 0 { -e } else { e }
}

/// Returns a POSIX error code from a library function error return value.
#[must_use]
pub const fn avunerror(e: i32) -> i32 {
    if libc::EDOM > 0 { -e } else { e }
}
