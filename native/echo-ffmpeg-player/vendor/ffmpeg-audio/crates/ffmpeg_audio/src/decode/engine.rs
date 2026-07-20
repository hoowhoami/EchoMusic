use std::time::Duration;

use crate::{
    AudioError,
    AudioFrame,
    Decoder,
    Demuxer,
    PacketCacheOptions,
    Result,
    TimeBase,
    decode::{PacketCache, SeekMode},
    sys,
};

/// Specifies the strategy used to scan an audio stream to determine its exact duration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanMode {
    /// Rapidly scans the stream by reading demuxer packet timestamps without decoding them.
    ///
    /// This mode is extremely fast and relies entirely on the container's metadata.
    /// However, it may fail or return inaccurate results for raw formats or highly
    /// corrupted streams that lack valid timestamp information.
    Packet,

    /// Fully decodes the stream into raw physical audio frames to calculate the duration.
    ///
    /// This mode is the most accurate fallback method, as it calculates time based purely
    /// on the actual number of generated audio samples and the stream's sample rate.
    /// Because it requires full decompression, it consumes significantly more CPU
    /// and takes much longer to complete.
    Frame,
}

/// A decode engine that orchestrates the extraction and decoding of audio data.
///
/// This engine acts as a unified abstraction over FFmpeg's underlying parsing (`Demuxer`)
/// and decompression (`Decoder`) stages. It encapsulates the complex send/receive
/// state machines, timestamp alignments, and buffering required to safely yield raw audio frames.
pub struct DecodeEngine {
    /// Background demux packet cache. This mirrors mpv's default demuxer-thread path.
    packet_cache: PacketCache,

    /// The underlying component responsible for decompressing raw packets into audio frames.
    decoder: Decoder,

    /// The fundamental unit of time representation for the current stream.
    time_base: TimeBase,

    /// Raw stream PTS that maps to the public zero-based timeline.
    timeline_origin_pts: i64,

    /// The presentation timestamp (PTS) of the most recently decoded frame, if available.
    current_pts: Option<Duration>,

    /// Indicates whether the internal stream has reached the End Of File (EOF).
    is_exhausted: bool,

    /// Indicates whether a valid frame was decoded and buffered during a seek operation,
    /// waiting to be consumed by the next read invocation.
    has_buffered_seek_frame: bool,
    /// Stores the calculated sample offset for the buffered seek frame
    buffered_seek_offset: usize,
}

impl DecodeEngine {
    pub(crate) fn from_parts(
        demuxer: Demuxer,
        decoder: Decoder,
        time_base: TimeBase,
        timeline_origin_pts: i64,
        packet_cache_options: PacketCacheOptions,
    ) -> Result<Self> {
        Ok(Self {
            packet_cache: PacketCache::new(demuxer, time_base, packet_cache_options),
            decoder,
            time_base,
            timeline_origin_pts,
            current_pts: None,
            is_exhausted: false,
            has_buffered_seek_frame: false,
            buffered_seek_offset: 0,
        })
    }

    fn debug_verify(&self) {
        debug_assert!(
            !(self.is_exhausted && self.has_buffered_seek_frame),
            "Stream is marked as exhausted, but a buffered seek frame is present."
        );

        let tb = self.time_base.as_rational();

        debug_assert!(tb.den > 0, "Time base denominator is zero or negative.");

        debug_assert!(tb.num > 0, "Time base numerator is zero or negative.");
    }

    /// Pulls and decodes the next available audio frame from the underlying stream.
    ///
    /// # Returns
    /// * `Ok(Some(AudioFrame))` containing the decompressed audio data ready for consumption.
    /// * `Ok(None)` if the stream has reached the End Of File (EOF).
    /// * `Err(AudioError)` if an I/O failure or a fatal FFmpeg decoding error occurs.
    pub fn receive_frame(&mut self) -> Result<Option<AudioFrame<'_>>> {
        self.debug_verify();

        if self.is_exhausted {
            return Ok(None);
        }

        if self.has_buffered_seek_frame {
            self.has_buffered_seek_frame = false;
            let frame_ptr = self.decoder.current_frame();
            let audio_frame = AudioFrame::new(frame_ptr, self.time_base)
                .with_timeline_origin(self.timeline_origin_pts)
                .with_offset(self.buffered_seek_offset);

            self.buffered_seek_offset = 0;
            self.current_pts = audio_frame.pts();

            self.debug_verify();
            return Ok(Some(audio_frame));
        }

        loop {
            match self.decoder.receive_frame() {
                Ok(Some(frame)) => {
                    let mut audio_frame = AudioFrame::new(frame, self.time_base)
                        .with_timeline_origin(self.timeline_origin_pts);

                    if let (Some(start_us), Some(end_us)) =
                        (audio_frame.pts_micros(), audio_frame.end_micros())
                    {
                        if end_us <= 0 {
                            #[cfg(feature = "tracing")]
                            tracing::debug!(
                                "Dropped preroll frame (start: {start_us} us, end: {end_us} us)"
                            );
                            continue;
                        }

                        if start_us < 0 && audio_frame.offset() == 0 {
                            let delta_us = 0 - start_us;
                            let offset_samples = audio_frame.calc_samples(delta_us);

                            if offset_samples < audio_frame.samples() {
                                audio_frame = audio_frame.with_offset(offset_samples);
                            } else {
                                continue;
                            }
                        }
                    }

                    self.current_pts = audio_frame.pts();
                    self.debug_verify();
                    return Ok(Some(audio_frame));
                }
                Err(AudioError::Eagain) => {
                    if let Some(packet) = self.read_packet()? {
                        self.decoder.send_packet(packet.as_ptr())?;
                    } else {
                        if self.decoder.is_flushing() {
                            self.is_exhausted = true;
                            self.debug_verify();
                            return Ok(None);
                        }

                        self.decoder.send_eof_flush()?;
                    }
                }
                Ok(None) => {
                    self.is_exhausted = true;
                    self.debug_verify();
                    return Ok(None);
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// Seeks the underlying audio stream to the specified target presentation time.
    ///
    /// # Arguments
    /// * `target` - The exact chronological point in the audio stream to seek to.
    ///
    /// # Errors
    /// Returns an `AudioError` if the underlying demuxer fails to seek, or if a decoding
    /// error occurs during the frame alignment process.
    pub fn seek(&mut self, target: Duration, mode: SeekMode) -> Result<()> {
        self.debug_verify();

        self.packet_cache.seek_to(target);
        self.decoder.flush();

        self.is_exhausted = false;
        self.current_pts = None;
        self.has_buffered_seek_frame = false;
        self.buffered_seek_offset = 0;

        if mode == SeekMode::Coarse {
            self.debug_verify();
            return Ok(());
        }

        let target_us = i64::try_from(target.as_micros()).unwrap_or(i64::MAX);

        loop {
            match self.receive_frame() {
                Ok(Some(frame)) => {
                    if let Some(pts_us) = frame.pts_micros() {
                        if pts_us.saturating_add(frame.duration_micros()) >= target_us {
                            let delta_us = target_us.saturating_sub(pts_us).max(0);

                            let offset_samples = frame.calc_samples(delta_us);

                            if offset_samples >= frame.samples() {
                                continue;
                            }

                            self.has_buffered_seek_frame = true;
                            self.buffered_seek_offset = offset_samples;
                            break;
                        }
                    } else {
                        return Err(AudioError::InvalidData(
                            "Cannot perform accurate seek on a stream lacking valid timestamps."
                                .to_string(),
                        ));
                    }
                }
                Ok(None) => break,
                Err(e) => return Err(e),
            }
        }

        self.current_pts = None;
        self.debug_verify();
        Ok(())
    }

    /// Returns the position from which the next `receive_frame` call should resume.
    fn next_read_position(&self) -> Duration {
        if self.has_buffered_seek_frame {
            let frame_ptr = self.decoder.current_frame();
            return AudioFrame::new(frame_ptr, self.time_base)
                .with_timeline_origin(self.timeline_origin_pts)
                .with_offset(self.buffered_seek_offset)
                .pts()
                .unwrap_or(Duration::ZERO);
        }

        if self.current_pts.is_none() {
            return Duration::ZERO;
        }

        let frame_ptr = self.decoder.current_frame();
        let frame = AudioFrame::new(frame_ptr, self.time_base)
            .with_timeline_origin(self.timeline_origin_pts);

        frame
            .pts()
            .map_or(Duration::ZERO, |pts| pts.saturating_add(frame.duration()))
    }

    /// Scans the audio stream to determine its exact total duration.
    ///
    /// This operation performs internal seeking and state resets. It is recommended to
    /// call this method before establishing a continuous reading pipeline to prevent
    /// disrupting the primary playback flow.
    ///
    /// # Arguments
    /// * `mode` - The strategy ([`ScanMode`]) to employ during the scanning process.
    ///
    /// # Returns
    /// * `Ok(Some(Duration))` representing the accurate total length of the audio stream.
    /// * `Ok(None)` if the file is completely empty or lacks valid timestamp data.
    /// * `Err(AudioError)` if an I/O or parsing failure halts the scanning process.
    pub fn scan_duration(&mut self, mode: ScanMode) -> Result<Option<Duration>> {
        let was_exhausted = self.is_exhausted;
        let original_current_pts = self.current_pts;

        let original_position = self.next_read_position();

        self.seek(Duration::ZERO, SeekMode::Coarse)?;

        let mut min_start_us: Option<i64> = None;
        let mut max_end_us: Option<i64> = None;
        let mut total_duration_us_fallback: i64 = 0;
        let mut scan_error = None;

        match mode {
            ScanMode::Packet => loop {
                match self.read_packet() {
                    Ok(Some(packet)) => unsafe {
                        let pts = (*packet.as_ptr()).pts;
                        if pts == sys::AV_NOPTS_VALUE {
                            continue;
                        }

                        if let Some(start_us) = self.time_base.calc_micros(pts) {
                            let duration = (*packet.as_ptr()).duration;
                            let end_pts = if duration > 0 {
                                pts.saturating_add(duration)
                            } else {
                                pts
                            };
                            let end_us = self.time_base.calc_micros(end_pts).unwrap_or(start_us);

                            let safe_start = start_us.max(0);
                            let safe_end = end_us.max(0);

                            min_start_us =
                                Some(min_start_us.map_or(safe_start, |m| m.min(safe_start)));
                            max_end_us = Some(max_end_us.map_or(safe_end, |m| m.max(safe_end)));
                        }
                    },
                    Ok(None) => break,
                    Err(e) => {
                        scan_error = Some(e);
                        break;
                    }
                }
            },
            ScanMode::Frame => loop {
                match self.receive_frame() {
                    Ok(Some(frame)) => {
                        total_duration_us_fallback =
                            total_duration_us_fallback.saturating_add(frame.duration_micros());

                        if let (Some(start_us), Some(end_us)) =
                            (frame.pts_micros(), frame.end_micros())
                        {
                            min_start_us = Some(min_start_us.map_or(start_us, |m| m.min(start_us)));
                            max_end_us = Some(max_end_us.map_or(end_us, |m| m.max(end_us)));
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        scan_error = Some(e);
                        break;
                    }
                }
            },
        }

        let seek_result = if was_exhausted {
            self.is_exhausted = true;
            self.current_pts = original_current_pts;
            self.has_buffered_seek_frame = false;
            self.buffered_seek_offset = 0;
            Ok(())
        } else {
            self.seek(original_position, SeekMode::Accurate)
        };

        if let Some(e) = scan_error {
            return Err(e);
        }
        seek_result?;

        if let (Some(start), Some(end)) = (min_start_us, max_end_us) {
            let duration_us = end.saturating_sub(start).max(0).cast_unsigned();
            Ok(Some(Duration::from_micros(duration_us)))
        } else if mode == ScanMode::Frame && total_duration_us_fallback > 0 {
            let safe_duration = total_duration_us_fallback.max(0).cast_unsigned();
            Ok(Some(Duration::from_micros(safe_duration)))
        } else {
            Ok(None)
        }
    }

    /// Returns a shared, immutable reference to the underlying demuxer.
    /// Returns a shared, immutable reference to the underlying decoder.
    pub(crate) const fn decoder(&self) -> &Decoder {
        &self.decoder
    }

    /// Returns the presentation timestamp of the most recently decoded audio frame.
    ///
    /// # Returns
    /// * `Some(Duration)` representing the current playback position.
    /// * `None` if no frames have been successfully decoded yet, or immediately after a seek.
    pub const fn stream_position(&self) -> Option<Duration> {
        self.current_pts
    }

    fn read_packet(&mut self) -> Result<Option<crate::decode::demuxer::CachedPacket>> {
        self.packet_cache.read_packet()
    }
}
