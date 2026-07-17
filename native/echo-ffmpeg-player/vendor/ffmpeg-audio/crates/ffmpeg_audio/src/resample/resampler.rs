use std::{
    mem::{
        self,
        MaybeUninit,
    },
    ptr,
};

use crate::{
    AudioFrame,
    core::{
        format::AudioSample,
        layout::ChannelLayout,
    },
    error::{
        AudioError,
        Result,
    },
    resample::SwrContext,
    sys,
};

/// Configuration options for the audio resampler.
///
/// Use the builder pattern to construct resampling parameters such as
/// target sample rate, number of channels, and audio data format.
#[derive(Debug, Clone)]
pub struct ResampleOptions {
    pub target_sample_rate: i32,
    pub target_channels: i32,
    pub target_sample_fmt: sys::AVSampleFormat,
}

impl Default for ResampleOptions {
    fn default() -> Self {
        Self {
            target_sample_rate: 44100,
            target_channels: 2,
            target_sample_fmt: sys::AVSampleFormat_AV_SAMPLE_FMT_FLT,
        }
    }
}

impl ResampleOptions {
    /// Creates a new [`ResampleOptions`] builder with default settings
    /// (44100 Hz, Stereo, 32-bit Float).
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Validate the configuration.
    pub fn validate(&self) -> Result<()> {
        if self.target_sample_rate <= 0 {
            return Err(AudioError::InvalidParameter(
                "Target sample rate must be greater than 0".to_string(),
            ));
        }
        if self.target_channels <= 0 {
            return Err(AudioError::InvalidParameter(
                "Target channels must be greater than 0".to_string(),
            ));
        }
        Ok(())
    }

    /// Sets the target sample rate (in Hz).
    #[must_use]
    pub const fn sample_rate(mut self, rate: i32) -> Self {
        self.target_sample_rate = rate;
        self
    }

    /// Sets the target number of audio channels.
    ///
    /// For example, `1` for Mono, `2` for Stereo.
    #[must_use]
    pub const fn channels(mut self, channels: i32) -> Self {
        self.target_channels = channels;
        self
    }

    /// Sets the target audio sample format as Packed (Interleaved).
    ///
    /// For example, `[L, R, L, R]`
    #[must_use]
    pub const fn format<T: AudioSample>(mut self) -> Self {
        self.target_sample_fmt = T::PACKED_FORMAT;
        self
    }

    /// Sets the target audio sample format as Planar.
    ///
    /// For example, `[L, L, L]` and `[R, R, R]` in separate continuous blocks.
    #[must_use]
    pub const fn format_planar<T: AudioSample>(mut self) -> Self {
        self.target_sample_fmt = T::PLANAR_FORMAT;
        self
    }
}

/// The high-level audio resampler pipeline.
///
/// This struct manages the format verification, buffer allocation, and
/// interaction with the underlying FFmpeg `SwrContext`. It is strictly
/// non-generic to prevent generic viral spread, applying type parameters
/// only at the boundaries of data processing (`process`) and extraction (`output_as`).
pub struct Resampler {
    swr: SwrContext,
    options: ResampleOptions,
    in_sample_fmt: sys::AVSampleFormat,
    in_sample_rate: i32,
    in_layout: ChannelLayout,
    in_channels: usize,
    buffer: RawAudioBuffer,
    in_ptrs_scratch: Vec<*const u8>,
    actual_samples_per_channel: usize,
    stride_samples_per_channel: usize,
}

// SAFETY:
// 1. FFmpeg components (`SwrContext`, `ChannelLayout`) are thread-safe and uniquely owned by
//    `Resampler`.
// 2. `in_ptrs_scratch` contains raw pointers, but they are transient buffers strictly scoped to
//    `process()` and never escape the method or persist across threads.
unsafe impl Send for Resampler {}

impl Resampler {
    /// Creates a resampler from a valid FFmpeg input layout.
    ///
    /// # Safety
    /// `in_layout_ptr` must refer to a fully initialized `AVChannelLayout`; any pointer owned by
    /// a custom layout must remain readable for the duration of this call.
    pub unsafe fn new(
        in_layout_ptr: &sys::AVChannelLayout,
        in_sample_fmt: sys::AVSampleFormat,
        in_sample_rate: i32,
        options: ResampleOptions,
    ) -> Result<Self> {
        options.validate()?;

        let out_layout = ChannelLayout::from_default(options.target_channels);
        let in_layout = ChannelLayout::from_existing(in_layout_ptr)?;

        let swr = SwrContext::new(
            out_layout.as_layout(),
            options.target_sample_fmt,
            options.target_sample_rate,
            in_layout.as_layout(),
            in_sample_fmt,
            in_sample_rate,
        )?;

        let in_channels = in_layout.channels();

        Ok(Self {
            swr,
            options,
            in_sample_fmt,
            in_sample_rate,
            in_layout,
            in_channels,
            buffer: RawAudioBuffer::default(),
            in_ptrs_scratch: Vec::with_capacity(in_channels),
            actual_samples_per_channel: 0,
            stride_samples_per_channel: 0,
        })
    }

    /// Returns the target sample format configured for this resampler.
    #[must_use]
    pub const fn target_sample_fmt(&self) -> sys::AVSampleFormat {
        self.options.target_sample_fmt
    }

    pub fn flush(&mut self) -> Result<()> {
        self.actual_samples_per_channel = 0;
        self.stride_samples_per_channel = 0;
        self.swr.flush()
    }

    /// Processes a single raw audio frame and writes the converted samples
    /// into the internal buffer.
    ///
    /// Passing `None` as the frame will flush any remaining buffered samples
    /// at the end of the stream.
    ///
    /// # Returns
    /// - `Ok(true)` if valid data was generated and is ready to be read.
    /// - `Ok(false)` if more input frames are needed to produce an output.
    /// - `Err` if a format mismatch or FFmpeg internal error occurs.
    pub fn process<T: AudioSample>(&mut self, frame: Option<&AudioFrame<'_>>) -> Result<bool> {
        let is_packed = self.options.target_sample_fmt == T::PACKED_FORMAT;
        let is_planar = self.options.target_sample_fmt == T::PLANAR_FORMAT;

        if !is_packed && !is_planar {
            return Err(AudioError::FormatMismatch);
        }

        self.actual_samples_per_channel = 0;
        self.stride_samples_per_channel = 0;

        unsafe {
            if let Some(f) = frame {
                self.check_and_hot_reload(f)?;
            }

            let raw_ptr = frame.map_or(ptr::null(), AudioFrame::as_ptr);
            let (frame_offset, logical_samples) =
                frame.map_or((0, 0), |f| (f.offset(), f.samples()));

            let in_data = Self::calculate_adjusted_pointers(
                raw_ptr,
                frame_offset,
                self.in_sample_fmt,
                self.in_channels,
                &mut self.in_ptrs_scratch,
            );

            let in_samples_i32 = logical_samples as i32;
            let expected_out_samples = self.swr.get_out_samples(in_samples_i32)?;

            debug_assert!(
                in_samples_i32 == 0 || !in_data.is_null(),
                "in_data is null but in_samples is > 0."
            );
            debug_assert!(in_samples_i32 >= 0, "in_samples cannot be negative.");

            if expected_out_samples <= 0 {
                return Ok(false);
            }

            let out_channels = self.options.target_channels as usize;

            let expected_out_usize = expected_out_samples as usize;
            let bytes_needed = expected_out_usize
                .checked_mul(out_channels)
                .and_then(|m| m.checked_mul(mem::size_of::<T>()))
                .ok_or_else(|| {
                    AudioError::AllocationFailed("Buffer size calculation overflowed".to_string())
                })?;

            self.buffer.reserve_bytes(bytes_needed)?;

            let out_buf_slice = self.buffer.as_uninit_bytes_mut();
            let actual_samples = if is_planar {
                self.swr.convert_planar(
                    in_data,
                    in_samples_i32,
                    out_buf_slice,
                    expected_out_samples,
                )?
            } else {
                self.swr
                    .convert_packed(in_data, in_samples_i32, out_buf_slice)?
            };

            self.stride_samples_per_channel = expected_out_usize;
            self.actual_samples_per_channel = actual_samples;

            Ok(self.actual_samples_per_channel > 0)
        }
    }

    /// Dynamically rebuilds the underlying SwrContext if the incoming frame's
    /// layout, format, or sample rate differs from the currently cached configuration.
    ///
    /// # Safety
    /// Must only be called with a valid `AudioFrame`.
    fn check_and_hot_reload(&mut self, frame: &AudioFrame<'_>) -> Result<()> {
        let frame_fmt = frame.sample_fmt();
        let frame_rate = frame.frame_sample_rate();
        let frame_layout_ptr = frame.channel_layout();

        let needs_reload = frame_fmt != self.in_sample_fmt
            || frame_rate != self.in_sample_rate
            || !self.in_layout.is_identical_to(frame_layout_ptr);

        if needs_reload {
            #[cfg(feature = "tracing")]
            tracing::info!("Audio format changed mid-stream. Rebuilding resampler pipeline.");

            let out_layout = ChannelLayout::from_default(self.options.target_channels);
            let temp_in_layout = ChannelLayout::from_existing(frame_layout_ptr)?;

            let new_swr = SwrContext::new(
                out_layout.as_layout(),
                self.options.target_sample_fmt,
                self.options.target_sample_rate,
                temp_in_layout.as_layout(),
                frame_fmt,
                frame_rate,
            )?;

            self.in_layout = temp_in_layout;
            self.swr = new_swr;
            self.in_sample_fmt = frame_fmt;
            self.in_sample_rate = frame_rate;
            self.in_channels = self.in_layout.channels();
        }

        Ok(())
    }

    /// Calculates and returns an array of pointers adjusted by `offset`.
    ///
    /// Extracted as a stateless associated function to guarantee testability
    /// without mocking FFI contexts.
    ///
    /// # Safety
    /// `raw_ptr` must be a valid `AVFrame` pointer or null.
    unsafe fn calculate_adjusted_pointers(
        raw_ptr: *const sys::AVFrame,
        offset: usize,
        in_sample_fmt: sys::AVSampleFormat,
        in_channels: usize,
        scratch: &mut Vec<*const u8>,
    ) -> *const *const u8 {
        if raw_ptr.is_null() {
            return ptr::null();
        }

        unsafe {
            let original_data = (*raw_ptr).extended_data as *const *const u8;
            if offset == 0 {
                return original_data;
            }

            let bytes_per_sample = sys::av_get_bytes_per_sample(in_sample_fmt) as usize;
            let is_in_planar = sys::av_sample_fmt_is_planar(in_sample_fmt) == 1;

            scratch.clear();

            if is_in_planar {
                for ch in 0..in_channels {
                    let orig_ptr = *original_data.add(ch);
                    let new_ptr = orig_ptr.add(offset * bytes_per_sample);
                    scratch.push(new_ptr);
                }
            } else {
                let orig_ptr = *original_data;
                let new_ptr = orig_ptr.add(offset * in_channels * bytes_per_sample);
                scratch.push(new_ptr);
            }

            scratch.as_ptr()
        }
    }

    /// Exposes the internally processed audio data as a typed slice.
    ///
    /// This method should only be called immediately after `process`
    /// returns `Ok(true)`. If there is no valid data, it returns an empty slice.
    ///
    /// # Panics
    /// Panics if the requested type `T` does not match the resampler's configured
    /// packed target sample format (`T::PACKED_FORMAT`).
    #[must_use]
    pub const fn output_as<T: AudioSample>(&self) -> &[T] {
        assert!(
            self.options.target_sample_fmt == T::PACKED_FORMAT,
            "Attempted to extract packed data using a type that does not match the Resampler's target format."
        );
        if self.actual_samples_per_channel == 0 {
            return &[];
        }
        unsafe {
            self.buffer.as_typed_slice::<T>(
                self.actual_samples_per_channel * self.options.target_channels as usize,
            )
        }
    }

    /// Exposes the internally processed Planar audio data as a collection of slices.
    ///
    /// # Returns
    /// A `Vec` where each element is a slice representing one audio channel.
    ///
    /// # Panics
    /// Panics if the requested type `T` does not match the resampler's configured
    /// planar target sample format (`T::PLANAR_FORMAT`).
    #[must_use]
    pub fn output_planar_as<T: AudioSample>(&self) -> Vec<&[T]> {
        assert!(
            self.options.target_sample_fmt == T::PLANAR_FORMAT,
            "Attempted to extract planar data using a type that does not match the Resampler's target format."
        );
        if self.actual_samples_per_channel == 0 {
            return vec![];
        }

        let channels_count = self.options.target_channels as usize;
        let mut channels = Vec::with_capacity(channels_count);

        let base_ptr = self.buffer.as_ptr::<T>();

        for ch in 0..channels_count {
            unsafe {
                let ch_start_ptr = base_ptr.add(ch * self.stride_samples_per_channel);

                let ch_slice =
                    std::slice::from_raw_parts(ch_start_ptr, self.actual_samples_per_channel);

                channels.push(ch_slice);
            }
        }

        channels
    }
}

/// A type-erased, low-level audio buffer designed for safe FFI interactions.
///
/// This buffer internally uses `Vec<MaybeUninit<f64>>` to guarantee strict
/// 8-byte memory alignment, which safely accommodates all standard FFmpeg
/// audio sample formats without triggering UB.
#[derive(Default)]
pub struct RawAudioBuffer {
    inner: Vec<MaybeUninit<f64>>,
}

impl RawAudioBuffer {
    /// Returns a raw pointer to the underlying memory, cast to `T`.
    ///
    /// This is useful for performing pointer arithmetic to skip over uninitialized
    /// memory gaps (e.g., in planar audio layouts) without triggering UB by creating
    /// a typed slice over uninitialized bytes.
    pub const fn as_ptr<T: AudioSample>(&self) -> *const T {
        self.inner.as_ptr().cast::<T>()
    }

    /// Reserves minimum physical capacity to hold the requested number of bytes.
    ///
    /// This method only increases the underlying `capacity` of the allocator.
    /// The `len` of the internal vector remains perpetually `0`. It calculates
    /// the required number of `f64` blocks to satisfy the byte requirement
    /// while maintaining the 8-byte alignment constraint.
    ///
    /// # Arguments
    /// * `required_bytes` - The absolute minimum number of bytes needed for the upcoming FFI write
    ///   operation.
    pub fn reserve_bytes(&mut self, required_bytes: usize) -> Result<()> {
        let f64_count = required_bytes.div_ceil(mem::size_of::<f64>());
        self.inner
            .try_reserve(f64_count)
            .map_err(|e| AudioError::AllocationFailed(e.to_string()))
    }

    /// Exposes the entire allocated physical capacity as a mutable slice of
    /// uninitialized bytes.
    ///
    /// # Returns
    /// A mutable slice spanning the total reserved capacity, represented as
    /// `MaybeUninit<u8>`.
    pub const fn as_uninit_bytes_mut(&mut self) -> &mut [MaybeUninit<u8>] {
        let capacity_bytes = self.inner.capacity() * mem::size_of::<f64>();
        unsafe {
            std::slice::from_raw_parts_mut(
                self.inner.as_mut_ptr().cast::<MaybeUninit<u8>>(),
                capacity_bytes,
            )
        }
    }

    /// Casts the underlying memory and extracts a typed, initialized slice.
    ///
    /// # Safety
    /// This function performs unchecked type punning. The caller must guarantee
    /// all of the following:
    /// 1. **Initialization**: C side must have successfully written valid data spanning at least
    ///    `element_count` elements into the front of this buffer.
    /// 2. **Type Matching**: The physical bytes written by the FFI must exactly match the memory
    ///    layout and semantics of the requested Rust type `T`.
    /// 3. **Bounds**: `element_count * size_of::<T>()` must not exceed the previously reserved
    ///    capacity.
    pub const unsafe fn as_typed_slice<T: AudioSample>(&self, element_count: usize) -> &[T] {
        unsafe { std::slice::from_raw_parts(self.inner.as_ptr().cast::<T>(), element_count) }
    }
}

#[cfg(test)]
mod tests {
    use std::mem;

    use super::*;

    /// 验证偏移指针算术运算的正确性 (Planar 格式)
    #[test]
    fn test_pointer_arithmetic_planar() {
        unsafe {
            let ch0_data = [0u8; 100];
            let ch1_data = [1u8; 100];

            let mut data_ptrs: [*mut u8; 8] = [ptr::null_mut(); 8];
            data_ptrs[0] = ch0_data.as_ptr().cast_mut();
            data_ptrs[1] = ch1_data.as_ptr().cast_mut();

            let mut raw_frame = mem::zeroed::<sys::AVFrame>();
            raw_frame.extended_data = data_ptrs.as_mut_ptr();

            let mut scratch = Vec::with_capacity(2);
            let offset_samples = 10;

            let adjusted_ptrs = Resampler::calculate_adjusted_pointers(
                &raw const raw_frame,
                offset_samples,
                sys::AVSampleFormat_AV_SAMPLE_FMT_FLTP,
                2,
                &mut scratch,
            );

            let ptrs_slice = std::slice::from_raw_parts(adjusted_ptrs, 2);

            assert_eq!(ptrs_slice[0], ch0_data.as_ptr().add(40));
            assert_eq!(ptrs_slice[1], ch1_data.as_ptr().add(40));
        }
    }

    /// 验证偏移指针算术运算的正确性 (Packed 格式)
    #[test]
    fn test_pointer_arithmetic_packed() {
        unsafe {
            let packed_data = [0u8; 200];
            let mut data_ptrs: [*mut u8; 8] = [ptr::null_mut(); 8];
            data_ptrs[0] = packed_data.as_ptr().cast_mut();

            let mut raw_frame = mem::zeroed::<sys::AVFrame>();
            raw_frame.extended_data = data_ptrs.as_mut_ptr();

            let mut scratch = Vec::with_capacity(1);
            let offset_samples = 10;

            let adjusted_ptrs = Resampler::calculate_adjusted_pointers(
                &raw const raw_frame,
                offset_samples,
                sys::AVSampleFormat_AV_SAMPLE_FMT_S16,
                2,
                &mut scratch,
            );

            let ptrs_slice = std::slice::from_raw_parts(adjusted_ptrs, 1);
            assert_eq!(ptrs_slice[0], packed_data.as_ptr().add(40));
        }
    }
}
