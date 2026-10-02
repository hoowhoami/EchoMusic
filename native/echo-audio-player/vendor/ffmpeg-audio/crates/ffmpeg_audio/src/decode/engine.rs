use std::time::Duration;

use crate::{
    AudioError, AudioFrame, Decoder, Demuxer, PacketCacheOptions, PacketCacheStats, Result,
    core::{
        frame::frame_timing,
        timeline::{FramePlacement, Timeline},
    },
    decode::{
        PacketCache, SeekMode,
        cursor::{ReadCursor, Resume},
        packet_cache::CachedPacket,
    },
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
/// state machines and buffering required to safely yield raw audio frames, and relies on the
/// [`Timeline`] for every timestamp decision.
pub struct DecodeEngine {
    /// Background demux packet cache owned by the native player.
    packet_cache: PacketCache,

    /// The underlying component responsible for decompressing raw packets into audio frames.
    decoder: Decoder,

    /// Maps the stream's raw timestamps onto the public timeline.
    timeline: Timeline,

    /// Where reading stands.
    cursor: ReadCursor,
}

impl DecodeEngine {
    pub(crate) fn from_parts(
        demuxer: Demuxer,
        decoder: Decoder,
        timeline: Timeline,
        packet_cache_options: PacketCacheOptions,
    ) -> Result<Self> {
        Ok(Self {
            packet_cache: PacketCache::new(demuxer, timeline, packet_cache_options),
            decoder,
            timeline,
            cursor: ReadCursor::default(),
        })
    }

    /// Pulls and decodes the next available audio frame from the underlying stream.
    ///
    /// # Returns
    /// * `Ok(Some(AudioFrame))` containing the decompressed audio data ready for consumption.
    /// * `Ok(None)` if the stream has reached the End Of File (EOF).
    /// * `Err(AudioError)` if an I/O failure or a fatal FFmpeg decoding error occurs.
    pub fn receive_frame(&mut self) -> Result<Option<AudioFrame<'_>>> {
        if self.cursor.is_exhausted() {
            return Ok(None);
        }

        let next = match self.cursor.pending() {
            Some(placement) => Some(placement),
            None => self.decode_next(Duration::ZERO)?,
        };
        let Some(placement) = next else {
            return Ok(None);
        };

        self.cursor.record_delivery(placement);

        Ok(Some(AudioFrame::new(
            self.decoder.current_frame(),
            placement,
        )))
    }

    /// Decodes until the decoder holds a frame with samples at or after `not_before`, and
    /// returns where that frame lands on the public timeline.
    ///
    /// Frames lying entirely before `not_before` are discarded. Returns `Ok(None)` once the
    /// stream is exhausted.
    fn decode_next(&mut self, not_before: Duration) -> Result<Option<FramePlacement>> {
        loop {
            match self.decoder.receive_frame() {
                Ok(Some(frame)) => {
                    // The decoder has just filled this frame, so it points to a valid AVFrame.
                    let timing = unsafe { frame_timing(frame) };

                    if let Some(placement) = self.timeline.place(timing, not_before) {
                        return Ok(Some(placement));
                    }

                    #[cfg(feature = "tracing")]
                    if not_before.is_zero() {
                        tracing::debug!("Dropped preroll frame (raw pts: {})", timing.pts);
                    }
                }
                Err(AudioError::Eagain) => {
                    if let Some(packet) = self.read_packet()? {
                        self.decoder.send_packet(packet.as_ptr())?;
                    } else {
                        if self.decoder.is_flushing() {
                            self.cursor.record_exhaustion();
                            return Ok(None);
                        }

                        self.decoder.send_eof_flush()?;
                    }
                }
                Ok(None) => {
                    self.cursor.record_exhaustion();
                    return Ok(None);
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// Seeks the underlying audio stream to the specified position on the public timeline.
    ///
    /// # Arguments
    /// * `target` - The position on the public timeline to seek to.
    /// * `mode` - The strategy ([`SeekMode`]) to employ for resolving the exact position.
    ///
    /// # Errors
    /// Returns an `AudioError` if the underlying demuxer fails to seek, or if a decoding
    /// error occurs during the frame alignment process.
    pub fn seek(&mut self, target: Duration, mode: SeekMode) -> Result<()> {
        self.packet_cache.seek_to(target)?;
        self.decoder.flush();
        self.cursor.record_coarse_seek(target);

        if mode == SeekMode::Accurate
            && let Some(placement) = self.decode_next(target)?
        {
            if placement.pts().is_none() {
                return Err(AudioError::InvalidData(
                    "Cannot perform accurate seek on a stream lacking valid timestamps."
                        .to_string(),
                ));
            }

            self.cursor.record_pending(
                Resume::Seek {
                    target,
                    mode: SeekMode::Accurate,
                },
                placement,
            );
        }

        Ok(())
    }

    /// Seeks so that reading continues with the frame following the one whose raw timestamp is
    /// `raw_pts`, which is expected to start around `next`.
    fn seek_after(&mut self, raw_pts: i64, next: Duration) -> Result<()> {
        self.packet_cache.seek_raw(raw_pts)?;
        self.decoder.flush();
        self.cursor.record_coarse_seek(next);

        while let Some(placement) = self.decode_next(Duration::ZERO)? {
            if placement.raw_pts().is_none_or(|pts| pts > raw_pts) {
                self.cursor
                    .record_pending(Resume::After { raw_pts, next }, placement);
                break;
            }
        }

        Ok(())
    }

    /// Scans the audio stream to determine its exact duration: the public time right after the
    /// last sample.
    ///
    /// Reading afterwards continues where it stood, as if the scan had not happened (see
    /// [`ReadCursor::resume`]).
    ///
    /// # Arguments
    /// * `mode` - The strategy ([`ScanMode`]) to employ during the scanning process.
    ///
    /// # Returns
    /// * `Ok(Some(Duration))` representing the exact duration of the audio stream.
    /// * `Ok(None)` if the file is completely empty or lacks valid timestamp data.
    /// * `Err(AudioError)` if an I/O or parsing failure halts the scanning process.
    pub fn scan_duration(&mut self, mode: ScanMode) -> Result<Option<Duration>> {
        // A cached seek and a physical demux seek can land on different frame boundaries.
        // Capture the actual next frame before scanning so restoration can reproduce it.
        if self.cursor.pending().is_none()
            && let Resume::Seek {
                mode: SeekMode::Coarse,
                ..
            } = self.cursor.resume()
        {
            let resume = self.cursor.resume();
            let position = self.cursor.stream_position();
            if let Some(placement) = self.decode_next(Duration::ZERO)? {
                self.cursor.record_pending(resume, placement);
                self.cursor.restore_position(position);
            }
        }
        let saved = self.cursor;

        self.seek(Duration::ZERO, SeekMode::Coarse)?;

        let mut exact_end: Option<Duration> = None;
        let mut total_duration_fallback = Duration::ZERO;
        let mut scan_error = None;

        match mode {
            ScanMode::Packet => loop {
                match self.read_packet() {
                    Ok(Some(packet)) => {
                        // The demuxer has just filled this packet, so it points to a valid
                        // AVPacket.
                        let (pts, duration) =
                            unsafe { ((*packet.as_ptr()).pts, (*packet.as_ptr()).duration) };
                        exact_end = exact_end.max(self.timeline.packet_end(pts, duration));
                    }
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
                        total_duration_fallback =
                            total_duration_fallback.saturating_add(frame.duration());
                        exact_end = exact_end.max(frame.end());
                    }
                    Ok(None) => break,
                    Err(e) => {
                        scan_error = Some(e);
                        break;
                    }
                }
            },
        }

        let restore_result = self.restore(saved);

        if let Some(e) = scan_error {
            return Err(e);
        }
        restore_result?;

        Ok(exact_end.or_else(|| {
            (mode == ScanMode::Frame && !total_duration_fallback.is_zero())
                .then_some(total_duration_fallback)
        }))
    }

    /// Puts reading back where `saved` stood, including the reported stream position.
    fn restore(&mut self, saved: ReadCursor) -> Result<()> {
        if let Some(frame) = saved.pending()
            && let Some(raw_pts) = frame.raw_pts()
        {
            self.packet_cache.seek_raw(raw_pts)?;
            self.decoder.flush();
            self.cursor
                .record_coarse_seek(frame.pts().unwrap_or_default());
            while let Some(placement) = self.decode_next(Duration::ZERO)? {
                if placement.raw_pts().is_none_or(|pts| pts >= raw_pts) {
                    // Restore the exact trim when the same frame is reachable. At an
                    // unreachable container start, report the actual later placement.
                    let placement = if placement.raw_pts() == Some(raw_pts) {
                        frame
                    } else {
                        placement
                    };
                    self.cursor.record_pending(saved.resume(), placement);
                    break;
                }
            }
            self.cursor.restore_position(saved.stream_position());
            return Ok(());
        }
        match saved.resume() {
            Resume::Exhausted => self.cursor = saved,
            Resume::Seek { target, mode } => self.seek(target, mode)?,
            Resume::After { raw_pts, next } => self.seek_after(raw_pts, next)?,
        }

        self.cursor.restore_position(saved.stream_position());
        Ok(())
    }

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
        self.cursor.stream_position()
    }

    pub fn packet_cache_stats(&self) -> PacketCacheStats {
        self.packet_cache.stats()
    }

    fn read_packet(&mut self) -> Result<Option<CachedPacket>> {
        self.packet_cache.read_packet()
    }
}
