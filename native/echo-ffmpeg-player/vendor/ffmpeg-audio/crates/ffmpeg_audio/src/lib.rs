pub mod core;
pub mod decode;
pub mod error;
pub mod log;
pub mod resample;

#[cfg(feature = "http")]
pub use core::http::HttpAudioSource;
pub use core::{
    format::AudioSample,
    frame::{
        AudioFrame,
        RawAudioData,
    },
    info::{
        AudioStreamInfo,
        SourceAudioInfo,
    },
    time::TimeBase,
};
use std::{
    collections::HashMap,
    io::{
        Read,
        Seek,
    },
    time::Duration,
};

pub use decode::{
    PacketCacheOptions,
    ScanMode,
    SeekMode,
};
pub use error::{
    AudioError,
    FfErrorExt,
    Result,
};
pub use ffmpeg_audio_sys as sys;
pub use resample::{
    ResampleOptions,
    Resampler,
};

use crate::{
    decode::{
        DecodeEngine,
        Decoder,
        Demuxer,
        io::IoContext,
    },
    log::init_ffmpeg_logging,
};

#[derive(Debug, Clone)]
pub struct AudioCover {
    pub data: Vec<u8>,
    pub mime_type: Option<String>,
}

pub struct AudioReader {
    engine: DecodeEngine,
    source_info: SourceAudioInfo,
    metadata: HashMap<String, String>,
    audio_streams: Vec<AudioStreamInfo>,
    duration: Option<Duration>,
    cover: Option<AudioCover>,
}

#[allow(clippy::non_send_fields_in_send_ty)]
unsafe impl Send for AudioReader {}

impl AudioReader {
    pub fn new<T>(source: T) -> Result<Self>
    where
        T: Read + Seek + Send + 'static,
    {
        Self::new_with_audio_stream(source, None)
    }

    pub fn new_with_audio_stream<T>(
        source: T,
        audio_stream_ordinal: Option<usize>,
    ) -> Result<Self>
    where
        T: Read + Seek + Send + 'static,
    {
        Self::new_with_audio_stream_and_packet_cache(
            source,
            audio_stream_ordinal,
            PacketCacheOptions::default(),
        )
    }

    pub fn new_with_audio_stream_and_packet_cache<T>(
        source: T,
        audio_stream_ordinal: Option<usize>,
        packet_cache_options: PacketCacheOptions,
    ) -> Result<Self>
    where
        T: Read + Seek + Send + 'static,
    {
        init_ffmpeg_logging();

        let io_ctx = IoContext::new(source)?;
        let demuxer = Demuxer::new_with_audio_stream(io_ctx, audio_stream_ordinal)?;
        let codec_params = demuxer.stream_codec_params();
        let decoder = Decoder::new(codec_params)?;
        let time_base = demuxer.time_base()?;
        let timeline_origin_pts = demuxer.timeline_origin_pts();
        let source_info = SourceAudioInfo::probe_parts(&demuxer, &decoder);
        let metadata = demuxer.metadata();
        let audio_streams = demuxer.audio_streams();
        let duration = demuxer.duration();
        let cover = demuxer.cover();
        let engine = DecodeEngine::from_parts(
            demuxer,
            decoder,
            time_base,
            timeline_origin_pts,
            packet_cache_options,
        )?;

        Ok(Self {
            engine,
            source_info,
            metadata,
            audio_streams,
            duration,
            cover,
        })
    }

    /// Reads and decodes the next available audio frame from the source stream.
    ///
    /// This method pulls a packet from the underlying demuxer, sends it to the decoder,
    /// retrieves the decoded raw frame, and finally returns a safe, zero-copy
    /// [`AudioFrame`] wrapper. You can pass its reference to multiple independent
    /// [`Resampler`] pipelines simultaneously without cloning the underlying audio data.
    ///
    /// # Returns
    /// - `Ok(Some(AudioFrame))` if a frame was successfully decoded and is ready for use.
    /// - `Ok(None)` if the end of the audio stream (EOF) has been reached.
    /// - `Err(AudioError)` if an underlying I/O or FFmpeg decoding error occurs.
    pub fn receive_frame(&mut self) -> Result<Option<AudioFrame<'_>>> {
        self.engine.receive_frame()
    }

    /// Seeks the underlying audio stream to the specified target duration.
    ///
    /// # Arguments
    /// * `target` - The target duration to seek to.
    /// * `mode` - The strategy ([`SeekMode`]) to employ for resolving the exact position.
    pub fn seek(&mut self, target: Duration, mode: SeekMode) -> Result<()> {
        self.engine.seek(target, mode)
    }

    /// Scans the entire audio stream to calculate its exact duration.
    pub fn scan_exact_duration(&mut self, mode: ScanMode) -> Result<Option<Duration>> {
        self.engine.scan_duration(mode)
    }

    /// Builds a [`Resampler`] pipeline tailored to this audio stream.
    ///
    /// This helper method automatically extracts the native channel layout, sample
    /// format, and sample rate from the underlying decoder, using them as the input
    /// configuration for the newly created resampler.
    ///
    /// This is an advanced API specifically designed for **1-to-N zero-copy dispatching**.
    /// It allows you to instantiate multiple distinct resamplers (e.g., one for audio
    /// playback, one for FFT spectrum analysis) and feed them the exact same safely
    /// borrowed [`AudioFrame`] without incurring any redundant decoding or memory
    /// allocation overhead.
    ///
    /// # Arguments
    /// * `options` - The target `ResampleOptions` specifying the desired output sample rate,
    ///   channel count, and data format.
    ///
    /// # Returns
    /// * `Ok(Resampler)` - A fully initialized resampler ready to process frames.
    ///
    /// # Errors
    /// Returns an [`AudioError`] if the provided `options` are invalid, or if the
    /// internal FFmpeg `SwrContext` allocation and initialization fail.
    pub fn build_resampler(&self, options: ResampleOptions) -> Result<Resampler> {
        let decoder = self.engine.decoder();
        // Decoder-derived FFmpeg layouts are initialized and remain valid for this call.
        unsafe {
            Resampler::new(
                &decoder.channel_layout(),
                decoder.sample_fmt(),
                decoder.sample_rate(),
                options,
            )
        }
    }

    /// Consumes the current [`AudioReader`] and wraps it in a [`ResampledReader`]
    /// using the provided resampling configuration.
    ///
    /// This establishes a pipeline from decoding to resampling, ready for data extraction.
    pub fn into_resampled(self, options: ResampleOptions) -> Result<ResampledReader> {
        let resampler = self.build_resampler(options)?;
        Ok(ResampledReader {
            reader: self,
            resampler,
        })
    }

    /// Returns the presentation timestamp of the most recently decoded audio frame.
    ///
    /// # Returns
    /// * `Some(Duration)` representing the current decode position.
    /// * `None` if no frames have been successfully decoded yet, or immediately after a seek.
    #[must_use]
    pub const fn stream_position(&self) -> Option<Duration> {
        self.engine.stream_position()
    }

    #[must_use]
    pub const fn source_info(&self) -> &SourceAudioInfo {
        &self.source_info
    }

    #[must_use]
    pub fn metadata(&self) -> HashMap<String, String> {
        self.metadata.clone()
    }

    #[must_use]
    pub fn audio_streams(&self) -> Vec<AudioStreamInfo> {
        self.audio_streams.clone()
    }

    #[must_use]
    pub fn duration(&self) -> Option<Duration> {
        self.duration
    }

    #[must_use]
    pub fn cover(&self) -> Option<AudioCover> {
        self.cover.clone()
    }
}

/// A wrapper combining an [`AudioReader`] and a [`Resampler`].
///
/// This provides a streamlined pipeline that automatically handles
/// packet reading, decoding, and format conversion on the fly.
pub struct ResampledReader {
    reader: AudioReader,
    resampler: Resampler,
}

impl ResampledReader {
    /// Returns a shared, immutable reference to the underlying `AudioReader`.
    ///
    /// This method provides access to the stream's static metadata (e.g.,
    /// duration, cover art, source audio properties)
    #[must_use]
    pub const fn source(&self) -> &AudioReader {
        &self.reader
    }

    /// Pulls the next frame of audio data, automatically decoded and
    /// resampled to the target configuration.
    ///
    /// # Type Safety
    /// The generic type `T` MUST exactly match the format specified in
    /// `ResampleOptions` (e.g., `f32`, `i16`). Otherwise, an
    /// [`AudioError::FormatMismatch`] will be returned.
    pub fn receive_frame_as<T: AudioSample>(&mut self) -> Result<Option<&[T]>> {
        if self.resampler.target_sample_fmt() != T::PACKED_FORMAT {
            return Err(AudioError::FormatMismatch);
        }

        loop {
            let frame = self.reader.receive_frame()?;

            let has_output = self.resampler.process::<T>(frame.as_ref())?;

            if has_output {
                return Ok(Some(self.resampler.output_as::<T>()));
            }

            if frame.is_none() {
                return Ok(None);
            }
        }
    }

    /// Pulls the next frame of audio data, automatically decoded and
    /// resampled into a planar memory layout.
    ///
    /// # Returns
    /// * `Ok(Some(Vec<&[T]>))` where each slice in the vector represents a discrete channel.
    ///
    /// # Type Safety
    /// The target `ResampleOptions` must have been configured using `format_planar::<T>()`.
    /// Otherwise, an [`AudioError::FormatMismatch`] is returned.
    pub fn receive_planar_as<T: AudioSample>(&mut self) -> Result<Option<Vec<&[T]>>> {
        if self.resampler.target_sample_fmt() != T::PLANAR_FORMAT {
            return Err(AudioError::FormatMismatch);
        }

        loop {
            let frame = self.reader.receive_frame()?;

            let has_output = self.resampler.process::<T>(frame.as_ref())?;

            if has_output {
                return Ok(Some(self.resampler.output_planar_as::<T>()));
            }

            if frame.is_none() {
                return Ok(None);
            }
        }
    }

    /// Seeks the underlying audio stream to the specified target duration.
    ///
    /// Also flushes both the decoder and the resampler.
    ///
    /// # Arguments
    /// * `target` - The target duration to seek to.
    /// * `mode` - The strategy ([`SeekMode`]) to employ for resolving the exact position.
    pub fn seek(&mut self, target: Duration, mode: SeekMode) -> Result<()> {
        self.reader.seek(target, mode)?;
        self.resampler.flush()?;
        Ok(())
    }

    /// Scans the entire audio stream to calculate its exact duration.
    ///
    /// Unlike the quick estimate provided by [`AudioReader::duration`], this method
    /// processes the stream to find the true end timestamp. This is useful for
    /// files or formats with no duration information.
    ///
    /// # Performance
    /// Because this method performs seeking and flushes the underlying
    /// decoder and resampler states, it is **highly recommended** to call this
    /// method **before** you start pulling frames in your main processing loop.
    /// Calling it mid-playback may cause glitches due to the flushing.
    ///
    /// # Parameters
    /// - `fast_mode`:
    ///   - `true` (Packet-level scan): Rapidly reads raw packets from the demuxer without
    ///     decompressing them. Extremely fast, but relies on the container's timestamps.
    ///   - `false` (Frame-level scan): Fully decodes the audio into raw frames (equivalent to
    ///     `ffmpeg -f null -`). This is the most accurate method, but consumes significantly more
    ///     CPU and time.
    pub fn scan_exact_duration(&mut self, mode: ScanMode) -> Result<Option<Duration>> {
        let duration = self.reader.scan_exact_duration(mode)?;
        self.resampler.flush()?;

        Ok(duration)
    }
}
