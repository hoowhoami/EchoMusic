use std::{
    io::{
        Read,
        Seek,
        SeekFrom,
    },
    os::raw::{
        c_int,
        c_void,
    },
};

use crate::{
    AudioError,
    Result,
    sys,
};

pub trait ReadSeek: Read + Seek + Send {}
impl<T: Read + Seek + Send> ReadSeek for T {}

pub struct IoContext {
    pub ctx: *mut sys::AVIOContext,
    opaque_ptr: *mut Box<dyn ReadSeek>,
}

impl IoContext {
    const IO_BUFFER_SIZE: usize = 32768;

    pub fn new<T>(source: T) -> Result<Self>
    where
        T: Read + Seek + Send + 'static,
    {
        let boxed_source: Box<dyn ReadSeek> = Box::new(source);
        let opaque_ptr = Box::into_raw(Box::new(boxed_source));

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

            Ok(Self { ctx, opaque_ptr })
        }
    }

    extern "C" fn read_packet(opaque: *mut c_void, buf: *mut u8, buf_size: c_int) -> c_int {
        if opaque.is_null() || buf.is_null() || buf_size <= 0 {
            return sys::AVERROR_EOF;
        }

        let source = unsafe { &mut *opaque.cast::<Box<dyn ReadSeek>>() };
        let slice = unsafe { std::slice::from_raw_parts_mut(buf, buf_size as usize) };

        match source.read(slice) {
            Ok(0) => sys::AVERROR_EOF,
            Ok(n) => n as c_int,
            Err(_) => sys::averror(libc::EIO),
        }
    }

    extern "C" fn seek(opaque: *mut c_void, offset: i64, whence: c_int) -> i64 {
        if opaque.is_null() {
            return i64::from(sys::averror(libc::EINVAL));
        }

        let source = unsafe { &mut *opaque.cast::<Box<dyn ReadSeek>>() };

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
