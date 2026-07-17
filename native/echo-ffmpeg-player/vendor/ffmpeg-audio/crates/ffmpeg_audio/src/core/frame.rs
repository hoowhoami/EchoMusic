use std::{
    marker::PhantomData,
    ptr::NonNull,
    time::Duration,
};

use crate::{
    AudioError,
    AudioSample,
    Result,
    TimeBase,
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

/// A safe, zero-copy wrapper around FFmpeg's raw `AVFrame`.
///
/// This wrapper is useful for 1-to-N zero-copy dispatching to multiple downstream
/// `Resampler` instances simultaneously.
pub struct AudioFrame<'a> {
    ptr: NonNull<sys::AVFrame>,
    time_base: TimeBase,
    timeline_origin_pts: i64,
    sample_offset: usize,
    _marker: PhantomData<&'a mut ()>,
}

impl<'a> AudioFrame<'a> {
    /// Creates a new `AudioFrame` wrapper.
    ///
    /// # Safety
    /// This method is for internal crate use. The caller ensures that the provided
    /// `ptr` is a valid FFmpeg `AVFrame` and that its memory remains valid for the
    /// duration of the lifetime.
    pub(crate) const fn new(ptr: *const sys::AVFrame, time_base: TimeBase) -> Self {
        Self {
            ptr: NonNull::new(ptr.cast_mut()).expect("FFmpeg returned a null AVFrame pointer"),
            time_base,
            timeline_origin_pts: 0,
            sample_offset: 0,
            _marker: PhantomData,
        }
    }

    /// Injects a sample offset for sample-accurate seeking.
    pub(crate) const fn with_offset(mut self, offset: usize) -> Self {
        self.sample_offset = offset;
        self
    }

    /// Defines the stream timestamp that corresponds to the public timeline origin.
    pub(crate) const fn with_timeline_origin(mut self, origin_pts: i64) -> Self {
        self.timeline_origin_pts = origin_pts;
        self
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
        let raw_samples = unsafe { (*self.ptr.as_ptr()).nb_samples as usize };
        raw_samples.saturating_sub(self.sample_offset)
    }

    /// Returns the offset applied to the beginning of the frame's payload.
    pub(crate) const fn offset(&self) -> usize {
        self.sample_offset
    }

    /// Returns the actual sample format of this specific frame.
    pub(crate) fn sample_fmt(&self) -> sys::AVSampleFormat {
        unsafe { (*self.ptr.as_ptr()).format }
    }

    /// Returns a reference to the actual channel layout of this specific frame.
    pub(crate) fn channel_layout(&self) -> &sys::AVChannelLayout {
        unsafe { &(*self.ptr.as_ptr()).ch_layout }
    }

    /// Returns the actual sample rate of this specific frame.
    pub(crate) fn frame_sample_rate(&self) -> i32 {
        unsafe { (*self.ptr.as_ptr()).sample_rate }
    }

    /// Converts a time span in microseconds to the corresponding number of samples based on the
    /// current frame sample rate
    pub(crate) fn calc_samples(&self, micros: i64) -> usize {
        let sample_rate = i64::from(self.frame_sample_rate());

        if sample_rate > 0 && micros > 0 {
            let samples_i64 = ((micros * sample_rate) + 999_999) / 1_000_000;
            samples_i64 as usize
        } else {
            0
        }
    }

    /// Returns the exact physical duration of this frame in microseconds.
    pub(crate) fn duration_micros(&self) -> i64 {
        let sample_rate = i64::from(self.frame_sample_rate());
        if sample_rate > 0 {
            (self.samples() as i64 * 1_000_000) / sample_rate
        } else {
            0
        }
    }

    /// Returns the physical end time of this frame in microseconds.
    ///
    /// Returns None if the frame lacks a valid start PTS.
    pub(crate) fn end_micros(&self) -> Option<i64> {
        self.pts_micros()
            .map(|start| start.saturating_add(self.duration_micros()))
    }

    /// Returns the PTS in microseconds relative to the stream timeline origin, if available.
    pub(crate) fn pts_micros(&self) -> Option<i64> {
        let raw_pts = unsafe { (*self.ptr.as_ptr()).pts };
        if raw_pts == sys::AV_NOPTS_VALUE {
            return None;
        }
        let relative_pts = raw_pts.saturating_sub(self.timeline_origin_pts);

        self.time_base.calc_micros(relative_pts).map(|mut micros| {
            let sample_rate = self.frame_sample_rate();

            if self.sample_offset > 0 && sample_rate > 0 {
                let offset_micros =
                    (self.sample_offset as i64 * 1_000_000) / i64::from(sample_rate);
                micros = micros.saturating_add(offset_micros);
            }
            micros
        })
    }

    /// Returns the precise playback duration of this audio frame.
    #[must_use]
    pub fn duration(&self) -> Duration {
        Duration::from_micros(self.duration_micros().cast_unsigned())
    }

    /// Returns the Presentation Timestamp (PTS) of this frame relative to the stream timeline
    /// origin, if available.
    ///
    /// The timestamp is automatically adjusted forward by the internal sample offset.
    ///
    /// # Returns
    /// - `Some(Duration)` representing the exact playback time of the frame.
    /// - `None` if the underlying frame lacks a valid PTS (`AV_NOPTS_VALUE`).
    #[must_use]
    pub fn pts(&self) -> Option<Duration> {
        self.pts_micros()
            .map(|micros| Duration::from_micros(micros.max(0).cast_unsigned()))
    }

    /// Zero-copy extraction of raw PCM audio data directly from the underlying FFmpeg AVFrame.
    ///
    /// # Returns
    /// * `Ok(RawAudioData)` - The corresponding memory slice enum.
    /// * `Err(AudioError::FormatMismatch)` - The requested `T` does not match the type actually
    ///   output by the underlying decoder.
    pub fn raw_data<T: AudioSample>(&self) -> Result<RawAudioData<'a, T>> {
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

#[cfg(test)]
mod tests {
    use std::{
        mem,
        time::Duration,
    };

    use ffmpeg_audio_sys::MICROSECONDS_Q;

    use super::*;

    #[test]
    fn pts_is_relative_to_the_timeline_origin() {
        let mut raw_frame = unsafe { mem::zeroed::<sys::AVFrame>() };
        raw_frame.pts = 10_000_000;
        raw_frame.nb_samples = 1_024;
        raw_frame.sample_rate = 48_000;

        let time_base = TimeBase::try_new(MICROSECONDS_Q).unwrap();
        let frame = AudioFrame::new(&raw const raw_frame, time_base)
            .with_timeline_origin(10_000_000)
            .with_offset(48);

        assert_eq!(frame.pts_micros(), Some(1_000));
        assert_eq!(frame.pts(), Some(Duration::from_micros(1_000)));

        raw_frame.pts = sys::AV_NOPTS_VALUE;
        let no_pts_frame =
            AudioFrame::new(&raw const raw_frame, time_base).with_timeline_origin(-1);
        assert_eq!(no_pts_frame.pts_micros(), None);
        assert_eq!(no_pts_frame.pts(), None);
    }

    #[test]
    fn test_frame_time_boundary_calculations() {
        let mut raw_frame = unsafe { mem::zeroed::<sys::AVFrame>() };
        raw_frame.pts = 10_000;
        raw_frame.nb_samples = 480;
        raw_frame.sample_rate = 48_000;

        let time_base = TimeBase::try_new(MICROSECONDS_Q).unwrap();
        let frame = AudioFrame::new(&raw const raw_frame, time_base).with_timeline_origin(0);

        assert_eq!(frame.duration_micros(), 10_000);
        assert_eq!(frame.end_micros(), Some(20_000));
    }

    #[test]
    fn test_calc_samples_for_micros_with_ceiling() {
        let mut raw_frame = unsafe { mem::zeroed::<sys::AVFrame>() };
        raw_frame.sample_rate = 44_100;
        let time_base = TimeBase::try_new(sys::AVRational { num: 1, den: 1 }).unwrap();
        let frame = AudioFrame::new(&raw const raw_frame, time_base);

        assert_eq!(frame.calc_samples(1_000_000), 44_100);
        assert_eq!(frame.calc_samples(1), 1);
        assert_eq!(frame.calc_samples(12), 1);
    }

    #[test]
    fn test_frame_fallback_on_invalid_sample_rate() {
        let mut raw_frame = unsafe { mem::zeroed::<sys::AVFrame>() };
        raw_frame.nb_samples = 1024;
        raw_frame.pts = 1000;
        raw_frame.sample_rate = 0;

        let time_base = TimeBase::try_new(MICROSECONDS_Q).unwrap();
        let frame = AudioFrame::new(&raw const raw_frame, time_base);

        assert_eq!(frame.duration_micros(), 0);
        assert_eq!(frame.end_micros(), Some(1000));
        assert_eq!(frame.calc_samples(5_000_000), 0);
    }
}
