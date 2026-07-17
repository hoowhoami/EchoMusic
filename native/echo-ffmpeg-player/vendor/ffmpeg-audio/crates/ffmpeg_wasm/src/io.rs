use std::io::{
    self,
    Read,
    Seek,
    SeekFrom,
};

unsafe extern "C" {
    /// Read data from a local file
    ///
    /// # Parameters
    /// * `file_id`: File ID; reserved for future support of multi-file decoding
    /// * `offset`: Starting offset within the file
    /// * `buffer_ptr`: Pointer to the memory buffer where results will be stored
    /// * `length`: Number of bytes to read
    ///
    /// # Returns
    /// The actual number of bytes read
    ///
    /// # Errors
    /// Returns -1 on error
    unsafe fn js_read_file(file_id: u32, offset: f64, buffer_ptr: *mut u8, length: u32) -> i32;

    /// Get the total file size
    ///
    /// # Returns
    /// File size in bytes
    ///
    /// # Errors
    /// Returns -1.0 on error
    unsafe fn js_get_file_size(file_id: u32) -> f64;
}

pub struct JsFileAccess {
    file_id: u32,
    offset: u64,
    size: u64,
}

impl JsFileAccess {
    pub fn new(file_id: u32) -> io::Result<Self> {
        let size = unsafe { js_get_file_size(file_id) };
        if size < 0.0 {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Failed to get file size from JS",
            ));
        }

        Ok(Self {
            file_id,
            offset: 0,
            size: size as u64,
        })
    }
}

impl Read for JsFileAccess {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.offset >= self.size {
            return Ok(0);
        }

        let max_read = (self.size - self.offset).min(buf.len() as u64) as u32;
        if max_read == 0 {
            return Ok(0);
        }

        let bytes_read =
            unsafe { js_read_file(self.file_id, self.offset as f64, buf.as_mut_ptr(), max_read) };

        if bytes_read < 0 {
            return Err(io::Error::other("JS SyncAccessHandle read failed"));
        }

        let bytes_read = bytes_read as usize;
        self.offset += bytes_read as u64;

        Ok(bytes_read)
    }
}

impl Seek for JsFileAccess {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let new_offset = match pos {
            SeekFrom::Start(offset) => offset.cast_signed(),
            SeekFrom::Current(delta) => self.offset.cast_signed() + delta,
            SeekFrom::End(delta) => self.size.cast_signed() + delta,
        };

        if new_offset < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Seek before byte 0",
            ));
        }

        self.offset = new_offset.cast_unsigned();
        Ok(self.offset)
    }
}
