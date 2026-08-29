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

struct IoOpaque {
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
            Err(_) => sys::averror(libc::EIO),
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
