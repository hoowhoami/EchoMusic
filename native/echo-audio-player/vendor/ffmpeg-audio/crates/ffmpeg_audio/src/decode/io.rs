use std::{
    io::{ErrorKind, Read, Seek, SeekFrom},
    os::raw::{c_int, c_void},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::{AudioError, Result, sys};

pub trait ReadSeek: Read + Seek + Send {}
impl<T: Read + Seek + Send> ReadSeek for T {}

pub struct IoContext {
    pub ctx: *mut sys::AVIOContext,
    opaque_ptr: *mut IoOpaque,
    interrupt: Arc<AtomicBool>,
}

#[repr(C)]
struct IoOpaque {
    av_class: *const sys::AVClass,
    location: *mut std::ffi::c_char,
    source: Box<dyn ReadSeek>,
    interrupt: Arc<AtomicBool>,
}

impl IoContext {
    const IO_BUFFER_SIZE: usize = 32768;

    pub fn new<T>(source: T) -> Result<Self>
    where
        T: Read + Seek + Send + 'static,
    {
        Self::new_with_interrupt(source, Arc::new(AtomicBool::new(false)))
    }

    pub(crate) fn new_with_interrupt<T>(source: T, interrupt: Arc<AtomicBool>) -> Result<Self>
    where
        T: Read + Seek + Send + 'static,
    {
        let boxed_source: Box<dyn ReadSeek> = Box::new(source);
        let opaque_ptr = Box::into_raw(Box::new(IoOpaque {
            av_class: std::ptr::null(),
            location: std::ptr::null_mut(),
            source: boxed_source,
            interrupt: interrupt.clone(),
        }));

        unsafe {
            let buffer = sys::av_malloc(Self::IO_BUFFER_SIZE).cast::<u8>();
            if buffer.is_null() {
                let _ = Box::from_raw(opaque_ptr);
                return Err(AudioError::from_ffmpeg(sys::AVERROR_ENOMEM));
            }

            let ctx = sys::avio_alloc_context(
                buffer,
                Self::IO_BUFFER_SIZE as c_int,
                0,
                opaque_ptr.cast::<c_void>(),
                Some(Self::read_packet),
                None,
                Some(Self::seek),
            );

            if ctx.is_null() {
                sys::av_freep(buffer.cast::<c_void>());
                let _ = Box::from_raw(opaque_ptr);
                return Err(AudioError::from_ffmpeg(sys::AVERROR_ENOMEM));
            }

            Ok(Self {
                ctx,
                opaque_ptr,
                interrupt,
            })
        }
    }

    pub(crate) fn with_location(self, location: &str) -> Result<Self> {
        let location = std::ffi::CString::new(location)
            .map_err(|_| AudioError::InvalidParameter("URL contains NUL".into()))?;
        let class = location_class();
        unsafe {
            (*self.opaque_ptr).av_class = class;
            (*self.opaque_ptr).location = location.into_raw();
            (*self.ctx).av_class = io_class();
        }
        Ok(self)
    }

    pub(crate) fn interrupt_flag(&self) -> Arc<AtomicBool> {
        self.interrupt.clone()
    }

    pub(crate) unsafe extern "C" fn interrupt_callback(opaque: *mut c_void) -> c_int {
        if opaque.is_null() {
            return 0;
        }
        let interrupt = unsafe { &*opaque.cast::<AtomicBool>() };
        c_int::from(interrupt.load(Ordering::Acquire))
    }

    pub(crate) fn clear_read_error(&mut self) {
        unsafe {
            if !self.ctx.is_null() {
                (*self.ctx).error = 0;
                (*self.ctx).eof_reached = 0;
            }
        }
    }

    extern "C" fn read_packet(opaque: *mut c_void, buf: *mut u8, buf_size: c_int) -> c_int {
        if opaque.is_null() || buf.is_null() || buf_size <= 0 {
            return sys::AVERROR_EOF;
        }

        let opaque = unsafe { &mut *opaque.cast::<IoOpaque>() };
        if opaque.interrupt.load(Ordering::Acquire) {
            return sys::AVERROR_EXIT;
        }
        let slice = unsafe { std::slice::from_raw_parts_mut(buf, buf_size as usize) };

        match opaque.source.read(slice) {
            Ok(0) => sys::AVERROR_EOF,
            Ok(n) => n as c_int,
            Err(err) if err.kind() == ErrorKind::Interrupted => sys::AVERROR_EXIT,
            Err(error) => {
                if let Ok(message) = std::ffi::CString::new(format!("media input read failed: {error}\n")) {
                    unsafe { sys::av_log(std::ptr::null_mut(), sys::AV_LOG_WARNING as i32, c"%s".as_ptr(), message.as_ptr()); }
                }
                sys::averror(libc::EIO)
            },
        }
    }

    extern "C" fn seek(opaque: *mut c_void, offset: i64, whence: c_int) -> i64 {
        if opaque.is_null() {
            return i64::from(sys::averror(libc::EINVAL));
        }

        let opaque = unsafe { &mut *opaque.cast::<IoOpaque>() };
        if opaque.interrupt.load(Ordering::Acquire) {
            return i64::from(sys::AVERROR_EXIT);
        }
        let source = &mut opaque.source;

        if whence == sys::AVSEEK_SIZE.cast_signed() {
            let Ok(current) = source.stream_position() else {
                return i64::from(sys::averror(libc::ENOSYS));
            };

            let Ok(size) = source.seek(SeekFrom::End(0)) else {
                return i64::from(sys::averror(libc::ENOSYS));
            };

            if source.seek(SeekFrom::Start(current)).is_err() {
                return i64::from(sys::averror(libc::EIO));
            }

            return size.cast_signed();
        }

        let seek_from = match whence & (!sys::AVSEEK_FORCE.cast_signed()) {
            0 => SeekFrom::Start(offset.cast_unsigned()),
            1 => SeekFrom::Current(offset),
            2 => SeekFrom::End(offset),
            _ => return i64::from(sys::averror(libc::EINVAL)),
        };

        source
            .seek(seek_from)
            .map_or_else(|_| i64::from(sys::averror(libc::EIO)), u64::cast_signed)
    }
}

struct SharedClass(sys::AVClass);
unsafe impl Send for SharedClass {}
unsafe impl Sync for SharedClass {}
struct SharedOptions([sys::AVOption; 2]);
unsafe impl Send for SharedOptions {}
unsafe impl Sync for SharedOptions {}

fn location_class() -> *const sys::AVClass {
    static OPTIONS: std::sync::OnceLock<SharedOptions> = std::sync::OnceLock::new();
    static CLASS: std::sync::OnceLock<SharedClass> = std::sync::OnceLock::new();
    let options = OPTIONS.get_or_init(|| unsafe {
        let mut values: [sys::AVOption; 2] = std::mem::zeroed();
        values[0].name = c"location".as_ptr();
        values[0].offset = std::mem::offset_of!(IoOpaque, location) as i32;
        values[0].type_ = sys::AVOptionType_AV_OPT_TYPE_STRING;
        SharedOptions(values)
    });
    &CLASS
        .get_or_init(|| unsafe {
            let mut class: sys::AVClass = std::mem::zeroed();
            class.item_name = Some(sys::av_default_item_name);
            class.class_name = c"EchoResource".as_ptr();
            class.version = sys::avutil_version() as i32;
            class.option = options.0.as_ptr();
            SharedClass(class)
        })
        .0
}

unsafe extern "C" fn io_child(obj: *mut c_void, previous: *mut c_void) -> *mut c_void {
    if !previous.is_null() {
        return std::ptr::null_mut();
    }
    unsafe { (*obj.cast::<sys::AVIOContext>()).opaque }
}
fn io_class() -> *const sys::AVClass {
    static CLASS: std::sync::OnceLock<SharedClass> = std::sync::OnceLock::new();
    &CLASS
        .get_or_init(|| unsafe {
            let mut class: sys::AVClass = std::mem::zeroed();
            class.item_name = Some(sys::av_default_item_name);
            class.class_name = c"EchoIO".as_ptr();
            class.version = sys::avutil_version() as i32;
            class.child_next = Some(io_child);
            SharedClass(class)
        })
        .0
}

impl Drop for IoOpaque {
    fn drop(&mut self) {
        if !self.location.is_null() {
            unsafe {
                drop(std::ffi::CString::from_raw(self.location));
            }
        }
    }
}

impl Drop for IoContext {
    fn drop(&mut self) {
        unsafe {
            if !self.ctx.is_null() {
                if !(*self.ctx).buffer.is_null() {
                    let buffer_ptr = (&raw mut (*self.ctx).buffer).cast::<c_void>();
                    sys::av_freep(buffer_ptr);
                }

                sys::avio_context_free(&raw mut self.ctx);
            }

            if !self.opaque_ptr.is_null() {
                let _ = Box::from_raw(self.opaque_ptr);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn interrupt_flag_stops_custom_io_and_ffmpeg_callback() {
        let interrupt = Arc::new(AtomicBool::new(false));
        let io = IoContext::new_with_interrupt(Cursor::new(vec![1u8, 2, 3, 4]), interrupt.clone())
            .unwrap();
        let mut output = [0u8; 4];

        assert_eq!(
            unsafe { IoContext::interrupt_callback(Arc::as_ptr(&interrupt).cast_mut().cast()) },
            0
        );
        interrupt.store(true, Ordering::Release);
        assert_eq!(
            unsafe { IoContext::interrupt_callback(Arc::as_ptr(&interrupt).cast_mut().cast()) },
            1
        );
        assert_eq!(
            IoContext::read_packet(
                io.opaque_ptr.cast(),
                output.as_mut_ptr(),
                output.len() as c_int,
            ),
            sys::AVERROR_EXIT
        );
    }

    #[test]
    fn clear_read_error_resets_ffmpeg_avio_state() {
        let mut io = IoContext::new(Cursor::new(vec![0u8; 16])).unwrap();
        unsafe {
            (*io.ctx).error = sys::AVERROR_EXIT;
            (*io.ctx).eof_reached = 1;
        }

        io.clear_read_error();

        unsafe {
            assert_eq!((*io.ctx).error, 0);
            assert_eq!((*io.ctx).eof_reached, 0);
        }
    }
}
