//! Resource-oriented input for demuxers which open additional URLs (HLS).
//! Every AVIO allocation stays owned here until FFmpeg closes it; the opener
//! and its cancellation/session context outlive avformat_close_input.
use super::io::{IoContext, ReadSeek};
use crate::{AudioError, Result, sys};
use std::{
    collections::HashMap,
    ffi::{CStr, CString},
    sync::{Arc, atomic::AtomicBool},
};

pub struct OpenedResource {
    pub source: Box<dyn ReadSeek>,
    pub effective_url: String,
    pub is_playlist: bool,
}

pub trait ResourceOpener: Send + Sync {
    fn timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(60)
    }
    fn open(&self, url: &str, offset: u64, end: Option<u64>) -> Result<OpenedResource>;
}

pub(crate) struct ResourceIo {
    pub opener: Arc<dyn ResourceOpener>,
    pub interrupt: Arc<AtomicBool>,
    resources: HashMap<usize, IoContext>,
    deadline: std::time::Instant,
}
// FFmpeg calls resource callbacks on its single demux worker, never concurrently.
unsafe impl Send for ResourceIo {}
impl ResourceIo {
    pub fn new(opener: Arc<dyn ResourceOpener>, interrupt: Arc<AtomicBool>) -> Self {
        let deadline = std::time::Instant::now() + opener.timeout();
        Self {
            opener,
            interrupt,
            resources: HashMap::new(),
            deadline,
        }
    }
    pub fn begin_read(&mut self) {
        self.deadline = std::time::Instant::now() + self.opener.timeout();
    }
    pub unsafe extern "C" fn interrupted(opaque: *mut std::ffi::c_void) -> i32 {
        let io = unsafe { &*opaque.cast::<Self>() };
        i32::from(
            io.interrupt.load(std::sync::atomic::Ordering::Acquire)
                || std::time::Instant::now() >= io.deadline,
        )
    }
    pub unsafe extern "C" fn open(
        s: *mut sys::AVFormatContext,
        pb: *mut *mut sys::AVIOContext,
        url: *const std::ffi::c_char,
        flags: i32,
        options: *mut *mut sys::AVDictionary,
    ) -> i32 {
        // No panic may unwind through FFmpeg.
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            if s.is_null()
                || pb.is_null()
                || url.is_null()
                || flags & sys::AVIO_FLAG_WRITE as i32 != 0
            {
                return sys::averror(libc::EINVAL);
            }
            let io = &mut *(*s).opaque.cast::<Self>();
            let url = CStr::from_ptr(url).to_string_lossy();
            let value = |key: &CStr| -> Option<u64> {
                if options.is_null() || (*options).is_null() {
                    return None;
                }
                let entry = sys::av_dict_get(*options, key.as_ptr(), std::ptr::null(), 0);
                if entry.is_null() {
                    None
                } else {
                    CStr::from_ptr((*entry).value).to_str().ok()?.parse().ok()
                }
            };
            let offset = value(c"offset").unwrap_or(0);
            let end = value(c"end_offset");
            let result = io.opener.open(&url, offset, end).and_then(|resource| {
                // Stream-info discovery may span several live refresh cycles.
                // Actual media arrival extends its wait; reloading an unchanged
                // playlist alone must never keep a broken input alive forever.
                if !resource.is_playlist { io.begin_read(); }

                IoContext::new_with_interrupt(resource.source, io.interrupt.clone())?
                    .with_location(&resource.effective_url)
            });
            match result {
                Ok(context) => {
                    (*context.ctx).pos = offset as i64;
                    *pb = context.ctx;
                    io.resources.insert(context.ctx as usize, context);
                    0
                }
                Err(_) if io.interrupt.load(std::sync::atomic::Ordering::Acquire) => {
                    sys::AVERROR_EXIT
                }
                Err(error) => {
                    if let Ok(message) = CString::new(format!("custom media IO failed: {error} (offset={offset}, end={end:?})\n")) {
                        sys::av_log(s.cast(), sys::AV_LOG_WARNING as i32, c"%s".as_ptr(), message.as_ptr());
                    }
                    sys::averror(libc::EIO)
                },
            }
        }))
        .unwrap_or(sys::averror(libc::EIO))
    }
    pub unsafe extern "C" fn close(s: *mut sys::AVFormatContext, pb: *mut sys::AVIOContext) -> i32 {
        unsafe {
            (&mut *(*s).opaque.cast::<Self>())
                .resources
                .remove(&(pb as usize));
        }
        0
    }
}

pub(crate) fn input_url(url: &str) -> Result<CString> {
    CString::new(url).map_err(|_| AudioError::InvalidParameter("URL contains NUL".into()))
}
