use std::{marker::PhantomData, ptr::NonNull, time::Duration};

use crate::{
    AudioError, AudioSample, Result,
    core::timeline::{FramePlacement, FrameTiming},
    sys,
};

/// A safe enum representing the memory layout of underlying FFmpeg PCM data.
#[derive(Debug, Clone)]
pub enum RawAudioData<'a, T> {
    /// Packed (Interleaved) layout.
    /// All channel data is interleaved in a single contiguous memory block, e.g., `[L, R, L, R, L,
    /// R]`.
    Packed(&'a [T]),

    /// Planar layout.
    /// Data for each channel is stored in independent, contiguous memory blocks, e.g., `[L, L, L]`
    /// and `[R, R, R]`. The length of the outer Vec represents the number of channels.
    Planar(Vec<&'a [T]>),
}

/// Reads the timing FFmpeg reported for a decoded frame.
///
/// # Safety
/// `frame` must point to a valid FFmpeg `AVFrame`.
pub(crate) unsafe fn frame_timing(frame: *const sys::AVFrame) -> FrameTiming {
    unsafe {
        FrameTiming {
            pts: (*frame).pts,
            samples: (*frame).nb_samples.max(0) as usize,
            sample_rate: (*frame).sample_rate,
        }
    }
}

/// A safe, zero-copy wrapper around FFmpeg's raw `AVFrame`.
///
/// This wrapper is useful for 1-to-N zero-copy dispatching to multiple downstream
/// `Resampler` instances simultaneously.
pub struct AudioFrame<'a> {
    ptr: NonNull<sys::AVFrame>,
    placement: FramePlacement,
    _marker: PhantomData<&'a mut ()>,
}

impl<'a> AudioFrame<'a> {
    /// Creates a new `AudioFrame` wrapper.
    ///
    /// # Safety
    /// This method is for internal crate use. The caller ensures that the provided
    /// `ptr` is a valid FFmpeg `AVFrame` whose memory remains valid for the
    /// duration of the lifetime, and that `placement` was computed from this frame.
    pub(crate) const fn new(ptr: *const sys::AVFrame, placement: FramePlacement) -> Self {
        Self {
            ptr: NonNull::new(ptr.cast_mut()).expect("FFmpeg returned a null AVFrame pointer"),
            placement,
            _marker: PhantomData,
        }
    }

    /// Extracts the underlying raw FFmpeg `AVFrame` pointer.
    ///
    /// This is used internally to pass the raw frame data into FFmpeg's FFI functions
    /// (such as the resampling context).
    pub(crate) const fn as_ptr(&self) -> *const sys::AVFrame {
        self.ptr.as_ptr()
    }

    /// Returns the number of available audio samples (per channel) contained in this frame.
    ///
    /// For example, if a stereo frame contains 1024 samples and has an offset of 100,
    /// this will return `924`.
    #[must_use]
    pub const fn samples(&self) -> usize {
        self.placement.samples()
    }

    /// Returns the offset applied to the beginning of the frame's payload.
    pub(crate) const fn offset(&self) -> usize {
        self.placement.offset()
    }

    /// Returns the actual sample format of this specific frame.
    pub fn sample_fmt(&self) -> sys::AVSampleFormat {
        unsafe { (*self.ptr.as_ptr()).format }
    }

    /// Returns the number of channels in this frame's actual channel layout.
    #[must_use]
    pub fn channels(&self) -> usize {
        unsafe { (*self.ptr.as_ptr()).ch_layout.nb_channels.max(0) as usize }
    }

    /// Returns a reference to the actual channel layout of this specific frame.
    pub(crate) fn channel_layout(&self) -> &sys::AVChannelLayout {
        unsafe { &(*self.ptr.as_ptr()).ch_layout }
    }

    /// Returns the actual sample rate of this specific frame.
    pub fn frame_sample_rate(&self) -> i32 {
        unsafe { (*self.ptr.as_ptr()).sample_rate }
    }

    /// Returns the precise playback duration of this audio frame, rounded down to whole
    /// nanoseconds.
    #[must_use]
    pub const fn duration(&self) -> Duration {
        self.placement.duration()
    }

    /// Returns the position of this frame's first sample on the public timeline, rounded down to
    /// whole nanoseconds.
    ///
    /// Samples trimmed from the beginning of the frame (preroll, or samples before a seek
    /// target) are already accounted for.
    ///
    /// # Returns
    /// - `Some(Duration)` representing the exact playback time of the frame.
    /// - `None` if the underlying frame lacks a valid PTS (`AV_NOPTS_VALUE`).
    #[must_use]
    pub const fn pts(&self) -> Option<Duration> {
        self.placement.pts()
    }

    /// Returns the public time right after this frame's last sample, if the frame has a PTS.
    pub(crate) const fn end(&self) -> Option<Duration> {
        self.placement.end()
    }

    /// Zero-copy extraction of raw PCM audio data directly from the underlying FFmpeg AVFrame.
    ///
    /// # Returns
    /// * `Ok(RawAudioData)` - The corresponding memory slice enum.
    /// * `Err(AudioError::FormatMismatch)` - The requested `T` does not match the type actually
    ///   output by the underlying decoder.
    pub fn raw_data<T: AudioSample>(&self) -> Result<RawAudioData<'_, T>> {
        let fmt = self.sample_fmt();
        let is_packed = fmt == T::PACKED_FORMAT;
        let is_planar = fmt == T::PLANAR_FORMAT;

        if !is_packed && !is_planar {
            return Err(AudioError::FormatMismatch);
        }

        let logical_samples = self.samples();
        let channels = unsafe { (*self.ptr.as_ptr()).ch_layout.nb_channels } as usize;
        let offset = self.offset();
        let extended_data = unsafe { (*self.ptr.as_ptr()).extended_data };

        if logical_samples == 0 || extended_data.is_null() {
            return if is_packed {
                Ok(RawAudioData::Packed(&[]))
            } else {
                Ok(RawAudioData::Planar(vec![&[]; channels]))
            };
        }

        if is_packed {
            unsafe {
                let base_ptr = (*extended_data).cast::<T>();
                let adjusted_ptr = base_ptr.add(offset * channels);
                let slice = std::slice::from_raw_parts(adjusted_ptr, logical_samples * channels);

                Ok(RawAudioData::Packed(slice))
            }
        } else {
            let mut planes = Vec::with_capacity(channels);
            unsafe {
                for ch in 0..channels {
                    let base_ptr = (*extended_data.add(ch)).cast::<T>();
                    let adjusted_ptr = base_ptr.add(offset);
                    let slice = std::slice::from_raw_parts(adjusted_ptr, logical_samples);

                    planes.push(slice);
                }
            }
            Ok(RawAudioData::Planar(planes))
        }
    }
}
