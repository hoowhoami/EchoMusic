use std::{
    mem::MaybeUninit,
    ptr,
};

use crate::{
    error::{
        AudioError,
        FfErrorExt as _,
        Result,
    },
    sys,
};

/// A low-level, safe wrapper around FFmpeg's `SwrContext`.
///
/// This struct focuses strictly on Resource Acquisition Is Initialization (RAII)
/// and physical boundary validation for FFI calls. It is completely decoupled
/// from high-level business logic or custom configuration structs.
pub struct SwrContext {
    ctx: *mut sys::SwrContext,
    out_channels: usize,
    out_bytes_per_sample: usize,
    planar_ptrs_scratch: Vec<*mut u8>,
}

unsafe impl Send for SwrContext {}

impl SwrContext {
    /// Initializes the resampling context using raw FFmpeg FFI types.
    ///
    /// This constructor allocates and initializes the underlying `SwrContext`.
    /// It requires explicit channel layouts, sample formats, and sample rates
    /// for both input and output streams.
    ///
    /// # Arguments
    /// * `out_layout` - The target channel layout.
    /// * `out_sample_fmt` - The target audio sample format.
    /// * `out_sample_rate` - The target sample rate in Hz.
    /// * `in_layout` - The source channel layout.
    /// * `in_sample_fmt` - The source audio sample format.
    /// * `in_sample_rate` - The source sample rate in Hz.
    ///
    /// # Errors
    /// Returns an [`AudioError`] if memory allocation fails, initialization fails,
    /// or if the output sample format is invalid/unknown.
    pub fn new(
        out_layout: &sys::AVChannelLayout,
        out_sample_fmt: sys::AVSampleFormat,
        out_sample_rate: i32,
        in_layout: &sys::AVChannelLayout,
        in_sample_fmt: sys::AVSampleFormat,
        in_sample_rate: i32,
    ) -> Result<Self> {
        unsafe {
            let mut ctx = ptr::null_mut();

            sys::swr_alloc_set_opts2(
                &raw mut ctx,
                out_layout,
                out_sample_fmt,
                out_sample_rate,
                in_layout,
                in_sample_fmt,
                in_sample_rate,
                0,
                ptr::null_mut(),
            )
            .into_ff_result()?;

            if ctx.is_null() {
                return Err(AudioError::from_ffmpeg(sys::AVERROR_ENOMEM));
            }

            if let Err(e) = sys::swr_init(ctx).into_ff_result() {
                sys::swr_free(&raw mut ctx);
                return Err(e);
            }

            let out_channels = out_layout.nb_channels as usize;
            let out_bytes_per_sample = sys::av_get_bytes_per_sample(out_sample_fmt) as usize;

            if out_bytes_per_sample == 0 {
                sys::swr_free(&raw mut ctx);
                return Err(AudioError::InvalidParameter(
                    "Unknown or unsupported output sample format".to_string(),
                ));
            }

            Ok(Self {
                ctx,
                out_channels,
                out_bytes_per_sample,
                planar_ptrs_scratch: Vec::with_capacity(out_channels),
            })
        }
    }

    /// Calculates the maximum number of output samples that will be generated
    /// for a given number of input samples.
    ///
    /// This takes into account any internally buffered samples from previous conversions.
    ///
    /// # Arguments
    /// * `in_samples` - The number of input samples per channel.
    ///
    /// # Errors
    /// Returns an [`AudioError`] if the underlying FFmpeg calculation fails.
    pub fn get_out_samples(&self, in_samples: i32) -> Result<i32> {
        unsafe {
            let ret = sys::swr_get_out_samples(self.ctx, in_samples).into_ff_result()?;
            Ok(ret)
        }
    }

    /// Flushes and resets the internal state and buffers of the resampler.
    ///
    /// This is typically called after a seek operation or when starting a new stream
    /// to ensure stale data does not bleed into the new output.
    ///
    /// # Errors
    /// Returns an [`AudioError`] if re-initialization fails.
    pub fn flush(&mut self) -> Result<()> {
        unsafe {
            sys::swr_init(self.ctx).into_ff_result()?;
            Ok(())
        }
    }

    /// Executes the audio conversion and writes the resampled data into the provided
    /// uninitialized buffer.
    ///
    /// This method is specifically designed for **Packed (Interleaved)** output formats.
    ///
    /// # Safety
    /// * `in_data` must be a valid double pointer to the input audio data, and its layout must
    ///   strictly match the `in_sample_fmt` and `in_layout` provided during initialization.
    /// * `in_samples` must accurately reflect the number of samples per channel available in
    ///   `in_data`.
    /// * To flush the remaining internal buffers (EOF), `in_data` can be `null()` while
    ///   `in_samples` is `0`.
    ///
    /// # Errors
    /// Returns an [`AudioError`] if the output buffer (`out_buf`) is too small to hold
    /// the resampled data, or if the underlying FFmpeg conversion fails.
    pub unsafe fn convert_packed(
        &mut self,
        in_data: *const *const u8,
        in_samples: i32,
        out_buf: &mut [MaybeUninit<u8>],
    ) -> Result<usize> {
        let expected_samples = self.get_out_samples(in_samples)?;
        if expected_samples <= 0 {
            return Ok(0);
        }

        let required_bytes =
            (expected_samples as usize) * self.out_channels * self.out_bytes_per_sample;

        if out_buf.len() < required_bytes {
            return Err(AudioError::InvalidParameter(
                "Output buffer is too small to hold the resampled data".to_string(),
            ));
        }

        let out_ptr = out_buf.as_mut_ptr().cast::<u8>();
        let mut out_ptrs = [out_ptr];

        let actual_samples = unsafe {
            sys::swr_convert(
                self.ctx,
                out_ptrs.as_mut_ptr(),
                expected_samples,
                in_data,
                in_samples,
            )
        }
        .into_ff_result()?;

        Ok(actual_samples as usize)
    }

    /// Executes the audio conversion and writes the resampled data into the provided
    /// uninitialized buffer, specifically designed for planar output formats.
    ///
    /// # Safety
    /// * `in_data` must be a valid double pointer to the input audio data.
    /// * `out_buf` must be large enough to hold `expected_samples * channels * bytes_per_sample`.
    ///
    /// # Memory Layout
    /// This method writes planar data sequentially into a single continuous buffer. It
    /// dynamically constructs the required array of pointers internally to instruct FFmpeg
    /// where each channel's block begins.
    pub unsafe fn convert_planar(
        &mut self,
        in_data: *const *const u8,
        in_samples: i32,
        out_buf: &mut [MaybeUninit<u8>],
        expected_samples: i32,
    ) -> Result<usize> {
        if expected_samples <= 0 {
            return Ok(0);
        }

        let required_bytes =
            (expected_samples as usize) * self.out_channels * self.out_bytes_per_sample;

        if out_buf.len() < required_bytes {
            return Err(AudioError::InvalidParameter(
                "Output buffer is too small to hold the resampled planar data".to_string(),
            ));
        }

        let base_ptr = out_buf.as_mut_ptr().cast::<u8>();
        let stride_bytes = (expected_samples as usize) * self.out_bytes_per_sample;

        self.planar_ptrs_scratch.clear();
        for ch in 0..self.out_channels {
            self.planar_ptrs_scratch
                .push(unsafe { base_ptr.add(ch * stride_bytes) });
        }

        let actual_samples = unsafe {
            sys::swr_convert(
                self.ctx,
                self.planar_ptrs_scratch.as_mut_ptr(),
                expected_samples,
                in_data,
                in_samples,
            )
        }
        .into_ff_result()?;

        Ok(actual_samples as usize)
    }
}

impl Drop for SwrContext {
    fn drop(&mut self) {
        unsafe {
            if !self.ctx.is_null() {
                sys::swr_free(&raw mut self.ctx);
            }
        }
    }
}
