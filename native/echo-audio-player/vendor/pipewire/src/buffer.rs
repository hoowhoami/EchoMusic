use super::stream::Stream;

use spa::buffer::meta::Metadata;
use spa::buffer::Data;
use std::convert::TryFrom;
use std::ptr::NonNull;

pub struct Buffer<'s> {
    buf: NonNull<pw_sys::pw_buffer>,

    /// In Pipewire, buffers are owned by the stream that generated them.
    /// This reference ensures that this rule is respected.
    stream: &'s Stream,
}

impl Buffer<'_> {
    pub(crate) unsafe fn from_raw(
        buf: *mut pw_sys::pw_buffer,
        stream: &Stream,
    ) -> Option<Buffer<'_>> {
        NonNull::new(buf).map(|buf| Buffer { buf, stream })
    }

    pub fn datas_mut(&mut self) -> &mut [Data] {
        let buffer: *mut spa_sys::spa_buffer = unsafe { self.buf.as_ref().buffer };

        let slice_of_data = if !buffer.is_null()
            && unsafe { (*buffer).n_datas > 0 && !(*buffer).datas.is_null() }
        {
            unsafe {
                let datas = (*buffer).datas as *mut Data;
                std::slice::from_raw_parts_mut(datas, usize::try_from((*buffer).n_datas).unwrap())
            }
        } else {
            &mut []
        };

        slice_of_data
    }

    pub fn find_meta<T>(&self) -> Option<&T>
    where
        T: Metadata,
    {
        let buffer: *mut spa_sys::spa_buffer = unsafe { self.buf.as_ref().buffer };
        if !buffer.is_null() && unsafe { (*buffer).n_metas != 0 } {
            unsafe {
                match T::META_TYPE {
                    spa_sys::SPA_META_VideoDamage => {
                        let meta_data =
                            spa_sys::spa_buffer_find_meta(buffer, T::META_TYPE) as *const T;
                        if !meta_data.is_null() {
                            return Some(&*meta_data);
                        }
                    }
                    _ => {
                        let meta_data = spa_sys::spa_buffer_find_meta_data(
                            buffer,
                            T::META_TYPE,
                            std::mem::size_of::<T>(),
                        ) as *const T;
                        if !meta_data.is_null() {
                            return Some(&*meta_data);
                        }
                    }
                }
            }
        }
        None
    }

    #[cfg(feature = "v0_3_49")]
    pub fn requested(&self) -> u64 {
        let buffer: *mut spa_sys::spa_buffer = unsafe { self.buf.as_ref().buffer };
        if buffer.is_null() || unsafe { (*buffer).n_datas == 0 || (*buffer).datas.is_null() } {
            return 0;
        }

        let datas =
            unsafe { std::slice::from_raw_parts((*buffer).datas, (*buffer).n_datas as usize) };
        datas
            .iter()
            .map(|data| data.maxsize as u64)
            .max()
            .unwrap_or(0)
    }
}

impl Drop for Buffer<'_> {
    fn drop(&mut self) {
        unsafe {
            self.stream.queue_raw_buffer(self.buf.as_ptr());
        }
    }
}
