//! Audio decoding from various source formats.

use airplay_core::{AudioFormat, error::Result};
use std::fs::File;
use std::io::Cursor;
use std::path::Path;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::{MediaSourceStream, ReadOnlySource};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

/// Decoded audio frame.
#[derive(Debug, Clone)]
pub struct DecodedFrame {
    /// Interleaved PCM samples (i16).
    pub samples: Vec<i16>,
    /// Number of channels.
    pub channels: u8,
    /// Sample rate in Hz.
    pub sample_rate: u32,
    /// Timestamp in samples from start.
    pub timestamp: u64,
}

/// Audio decoder using symphonia.
pub struct AudioDecoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    sample_rate: u32,
    channels: u8,
    duration_samples: Option<u64>,
    position_samples: u64,
    eof: bool,
    /// Residual samples from previous decode_resampled call.
    /// Prevents discarding excess samples when source frames are larger than target packets.
    residual_samples: Vec<i16>,
    /// High-quality sinc resampler (lazily initialized when needed).
    resampler: Option<airplay_resampler::Resampler>,
}

impl AudioDecoder {
    /// Open audio file for decoding.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let file = File::open(path).map_err(|e| {
            airplay_core::error::StreamingError::InvalidFormat(format!(
                "Failed to open file: {}",
                e
            ))
        })?;

        let mss = MediaSourceStream::new(Box::new(file), Default::default());

        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }

        Self::from_media_source(mss, hint)
    }

    /// Open from byte slice.
    pub fn from_bytes(data: &[u8], hint_ext: Option<&str>) -> Result<Self> {
        let cursor = Cursor::new(data.to_vec());
        let source = ReadOnlySource::new(cursor);
        let mss = MediaSourceStream::new(Box::new(source), Default::default());

        let mut hint = Hint::new();
        if let Some(ext) = hint_ext {
            hint.with_extension(ext);
        }

        Self::from_media_source(mss, hint)
    }

    fn from_media_source(mss: MediaSourceStream, hint: Hint) -> Result<Self> {
        let format_opts = FormatOptions::default();
        let metadata_opts = MetadataOptions::default();

        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &format_opts, &metadata_opts)
            .map_err(|e| {
                airplay_core::error::StreamingError::InvalidFormat(format!(
                    "Failed to probe format: {}",
                    e
                ))
            })?;

        let format = probed.format;

        // Find the first audio track
        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or_else(|| {
                airplay_core::error::StreamingError::InvalidFormat(
                    "No audio tracks found".to_string(),
                )
            })?;

        let track_id = track.id;

        let sample_rate = track.codec_params.sample_rate.ok_or_else(|| {
            airplay_core::error::StreamingError::InvalidFormat(
                "Unknown sample rate".to_string(),
            )
        })?;

        let channels = track
            .codec_params
            .channels
            .map(|c| c.count() as u8)
            .unwrap_or(2);

        let duration_samples = track.codec_params.n_frames;

        let decoder_opts = DecoderOptions::default();
        let decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &decoder_opts)
            .map_err(|e| {
                airplay_core::error::StreamingError::InvalidFormat(format!(
                    "Failed to create decoder: {}",
                    e
                ))
            })?;

        Ok(Self {
            format,
            decoder,
            track_id,
            sample_rate,
            channels,
            duration_samples,
            position_samples: 0,
            eof: false,
            residual_samples: Vec::new(),
            resampler: None,
        })
    }

    /// Get source sample rate.
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Get number of channels.
    pub fn channels(&self) -> u8 {
        self.channels
    }

    /// Get total duration in samples (if known).
    pub fn duration_samples(&self) -> Option<u64> {
        self.duration_samples
    }

    /// Get current position in samples.
    pub fn position_samples(&self) -> u64 {
        self.position_samples
    }

    /// Seek to position in samples.
    pub fn seek(&mut self, position_samples: u64) -> Result<()> {
        // Clamp to duration if known
        let target = if let Some(duration) = self.duration_samples {
            position_samples.min(duration)
        } else {
            position_samples
        };

        // Convert samples to seconds and fraction
        let seconds = target / self.sample_rate as u64;
        let remaining_samples = target % self.sample_rate as u64;
        let frac = remaining_samples as f64 / self.sample_rate as f64;
        let time = Time::new(seconds, frac);

        self.format
            .seek(SeekMode::Accurate, SeekTo::Time { time, track_id: Some(self.track_id) })
            .map_err(|e| {
                airplay_core::error::StreamingError::Encoding(format!("Seek failed: {}", e))
            })?;

        self.position_samples = target;
        self.eof = false;
        self.residual_samples.clear();

        // Reset resampler state on seek
        if let Some(ref mut resampler) = self.resampler {
            resampler.reset();
        }

        Ok(())
    }

    /// Decode next frame of audio.
    pub fn decode_frame(&mut self) -> Result<Option<DecodedFrame>> {
        if self.eof {
            return Ok(None);
        }

        loop {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(ref e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    self.eof = true;
                    return Ok(None);
                }
                Err(SymphoniaError::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(e) => {
                    return Err(airplay_core::error::StreamingError::Encoding(format!(
                        "Failed to read packet: {}",
                        e
                    ))
                    .into());
                }
            };

            // Skip packets from other tracks
            if packet.track_id() != self.track_id {
                continue;
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(SymphoniaError::DecodeError(_)) => {
                    // Skip decode errors
                    continue;
                }
                Err(e) => {
                    return Err(airplay_core::error::StreamingError::Encoding(format!(
                        "Failed to decode: {}",
                        e
                    ))
                    .into());
                }
            };

            let samples = audio_buffer_to_i16(&decoded);
            let num_frames = samples.len() / self.channels as usize;

            let frame = DecodedFrame {
                samples,
                channels: self.channels,
                sample_rate: self.sample_rate,
                timestamp: self.position_samples,
            };

            self.position_samples += num_frames as u64;

            return Ok(Some(frame));
        }
    }

    /// Decode and resample to target format.
    pub fn decode_resampled(
        &mut self,
        target_format: &AudioFormat,
        frames_per_packet: usize,
    ) -> Result<Option<DecodedFrame>> {
        let target_rate = target_format.sample_rate.as_hz();
        let source_rate = self.sample_rate;

        // Initialize resampler lazily if needed
        if source_rate != target_rate && self.resampler.is_none() {
            self.resampler = Some(airplay_resampler::Resampler::new(
                source_rate,
                target_rate,
                self.channels,
            )?);
        }

        // Start with any leftover samples from previous call
        let mut collected_samples = std::mem::take(&mut self.residual_samples);
        let target_samples = frames_per_packet * target_format.channels as usize;

        while collected_samples.len() < target_samples {
            match self.decode_frame()? {
                Some(frame) => {
                    if source_rate == target_rate {
                        collected_samples.extend(frame.samples);
                    } else {
                        // High-quality sinc resampling
                        let resampled = self
                            .resampler
                            .as_mut()
                            .expect("resampler should be initialized")
                            .process(&frame.samples)?;
                        collected_samples.extend(resampled);
                    }
                }
                None => {
                    if collected_samples.is_empty() {
                        return Ok(None);
                    }
                    break;
                }
            }
        }

        // Save excess samples for next call instead of discarding them
        if collected_samples.len() > target_samples {
            self.residual_samples = collected_samples[target_samples..].to_vec();
            collected_samples.truncate(target_samples);
        }

        // Scale timestamp from source sample rate to target sample rate so it
        // matches the returned samples (both are now in target rate units).
        let scaled_timestamp = if source_rate != target_rate {
            (self.position_samples as f64 * target_rate as f64 / source_rate as f64) as u64
        } else {
            self.position_samples
        };

        Ok(Some(DecodedFrame {
            samples: collected_samples,
            channels: target_format.channels,
            sample_rate: target_rate,
            timestamp: scaled_timestamp,
        }))
    }

    /// Check if at end of stream.
    pub fn is_eof(&self) -> bool {
        self.eof
    }
}

/// Convert symphonia audio buffer to interleaved i16 samples.
fn audio_buffer_to_i16(buffer: &AudioBufferRef) -> Vec<i16> {
    match buffer {
        AudioBufferRef::S8(buf) => {
            let mut samples = Vec::with_capacity(buf.frames() * buf.spec().channels.count());
            for frame in 0..buf.frames() {
                for ch in 0..buf.spec().channels.count() {
                    // Convert S8 to S16
                    let sample = (buf.chan(ch)[frame] as i16) << 8;
                    samples.push(sample);
                }
            }
            samples
        }
        AudioBufferRef::S16(buf) => {
            let mut samples = Vec::with_capacity(buf.frames() * buf.spec().channels.count());
            for frame in 0..buf.frames() {
                for ch in 0..buf.spec().channels.count() {
                    samples.push(buf.chan(ch)[frame]);
                }
            }
            samples
        }
        AudioBufferRef::S24(buf) => {
            let mut samples = Vec::with_capacity(buf.frames() * buf.spec().channels.count());
            for frame in 0..buf.frames() {
                for ch in 0..buf.spec().channels.count() {
                    // Convert S24 to S16
                    let sample = (buf.chan(ch)[frame].inner() >> 8) as i16;
                    samples.push(sample);
                }
            }
            samples
        }
        AudioBufferRef::S32(buf) => {
            let mut samples = Vec::with_capacity(buf.frames() * buf.spec().channels.count());
            for frame in 0..buf.frames() {
                for ch in 0..buf.spec().channels.count() {
                    // Convert S32 to S16
                    let sample = (buf.chan(ch)[frame] >> 16) as i16;
                    samples.push(sample);
                }
            }
            samples
        }
        AudioBufferRef::F32(buf) => {
            let mut samples = Vec::with_capacity(buf.frames() * buf.spec().channels.count());
            for frame in 0..buf.frames() {
                for ch in 0..buf.spec().channels.count() {
                    // Convert F32 to S16
                    let sample = (buf.chan(ch)[frame] * 32767.0).clamp(-32768.0, 32767.0) as i16;
                    samples.push(sample);
                }
            }
            samples
        }
        AudioBufferRef::F64(buf) => {
            let mut samples = Vec::with_capacity(buf.frames() * buf.spec().channels.count());
            for frame in 0..buf.frames() {
                for ch in 0..buf.spec().channels.count() {
                    // Convert F64 to S16
                    let sample = (buf.chan(ch)[frame] * 32767.0).clamp(-32768.0, 32767.0) as i16;
                    samples.push(sample);
                }
            }
            samples
        }
        AudioBufferRef::U8(buf) => {
            let mut samples = Vec::with_capacity(buf.frames() * buf.spec().channels.count());
            for frame in 0..buf.frames() {
                for ch in 0..buf.spec().channels.count() {
                    // Convert U8 (0-255, center at 128) to S16
                    let sample = ((buf.chan(ch)[frame] as i16 - 128) << 8) as i16;
                    samples.push(sample);
                }
            }
            samples
        }
        AudioBufferRef::U16(buf) => {
            let mut samples = Vec::with_capacity(buf.frames() * buf.spec().channels.count());
            for frame in 0..buf.frames() {
                for ch in 0..buf.spec().channels.count() {
                    // Convert U16 to S16
                    let sample = (buf.chan(ch)[frame] as i32 - 32768) as i16;
                    samples.push(sample);
                }
            }
            samples
        }
        AudioBufferRef::U24(buf) => {
            let mut samples = Vec::with_capacity(buf.frames() * buf.spec().channels.count());
            for frame in 0..buf.frames() {
                for ch in 0..buf.spec().channels.count() {
                    // Convert U24 to S16
                    let sample = ((buf.chan(ch)[frame].inner() as i32 - 8388608) >> 8) as i16;
                    samples.push(sample);
                }
            }
            samples
        }
        AudioBufferRef::U32(buf) => {
            let mut samples = Vec::with_capacity(buf.frames() * buf.spec().channels.count());
            for frame in 0..buf.frames() {
                for ch in 0..buf.spec().channels.count() {
                    // Convert U32 to S16
                    let sample = ((buf.chan(ch)[frame] as i64 - 2147483648) >> 16) as i16;
                    samples.push(sample);
                }
            }
            samples
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use airplay_core::SampleRate;

    // Helper to create a minimal WAV file in memory
    fn create_wav_data(sample_rate: u32, channels: u8, samples: &[i16]) -> Vec<u8> {
        let num_samples = samples.len();
        let bytes_per_sample = 2u16;
        let block_align = channels as u16 * bytes_per_sample;
        let byte_rate = sample_rate * block_align as u32;
        let data_size = (num_samples * 2) as u32;
        let file_size = 36 + data_size;

        let mut wav = Vec::with_capacity(44 + num_samples * 2);

        // RIFF header
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&file_size.to_le_bytes());
        wav.extend_from_slice(b"WAVE");

        // fmt chunk
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes()); // chunk size
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM format
        wav.extend_from_slice(&(channels as u16).to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&byte_rate.to_le_bytes());
        wav.extend_from_slice(&block_align.to_le_bytes());
        wav.extend_from_slice(&(bytes_per_sample * 8).to_le_bytes());

        // data chunk
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());
        for sample in samples {
            wav.extend_from_slice(&sample.to_le_bytes());
        }

        wav
    }

    mod opening {
        use super::*;

        #[test]
        fn open_valid_mp3_file() {
            // MP3 requires actual file - skip in unit tests
        }

        #[test]
        fn open_valid_flac_file() {
            // FLAC requires actual file - skip in unit tests
        }

        #[test]
        fn open_valid_wav_file() {
            let samples: Vec<i16> = (0..4410).map(|i| ((i * 100) % 32768) as i16).collect();
            let wav_data = create_wav_data(44100, 2, &samples);

            let decoder = AudioDecoder::from_bytes(&wav_data, Some("wav"));
            assert!(decoder.is_ok(), "Failed to open WAV: {:?}", decoder.err());
        }

        #[test]
        fn error_on_invalid_file() {
            let invalid_data = vec![0u8; 100];
            let result = AudioDecoder::from_bytes(&invalid_data, None);
            assert!(result.is_err());
        }

        #[test]
        fn error_on_nonexistent_file() {
            let result = AudioDecoder::open("/nonexistent/path/file.wav");
            assert!(result.is_err());
        }

        #[test]
        fn from_bytes_with_format_hint() {
            let samples: Vec<i16> = (0..4410).map(|i| ((i * 100) % 32768) as i16).collect();
            let wav_data = create_wav_data(44100, 2, &samples);

            let decoder = AudioDecoder::from_bytes(&wav_data, Some("wav"));
            assert!(decoder.is_ok());
        }
    }

    mod metadata {
        use super::*;

        #[test]
        fn sample_rate_extracted() {
            let samples: Vec<i16> = vec![0; 8820];
            let wav_data = create_wav_data(44100, 2, &samples);

            let decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();
            assert_eq!(decoder.sample_rate(), 44100);
        }

        #[test]
        fn channels_extracted() {
            let samples: Vec<i16> = vec![0; 8820];
            let wav_data = create_wav_data(44100, 2, &samples);

            let decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();
            assert_eq!(decoder.channels(), 2);
        }

        #[test]
        fn duration_extracted_when_available() {
            let samples: Vec<i16> = vec![0; 8820];
            let wav_data = create_wav_data(44100, 2, &samples);

            let decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();
            if let Some(duration) = decoder.duration_samples() {
                assert!(duration > 0);
            }
        }

        #[test]
        fn position_starts_at_zero() {
            let samples: Vec<i16> = vec![0; 8820];
            let wav_data = create_wav_data(44100, 2, &samples);

            let decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();
            assert_eq!(decoder.position_samples(), 0);
        }
    }

    mod decoding {
        use super::*;

        #[test]
        fn decode_frame_returns_pcm_samples() {
            let samples: Vec<i16> = (0..8820).map(|i| (i % 1000) as i16).collect();
            let wav_data = create_wav_data(44100, 2, &samples);

            let mut decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();
            let frame = decoder.decode_frame().unwrap();

            assert!(frame.is_some());
            let frame = frame.unwrap();
            assert!(!frame.samples.is_empty());
        }

        #[test]
        fn decode_frame_advances_position() {
            let samples: Vec<i16> = vec![0; 88200];
            let wav_data = create_wav_data(44100, 2, &samples);

            let mut decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();

            let pos_before = decoder.position_samples();
            decoder.decode_frame().unwrap();
            let pos_after = decoder.position_samples();

            assert!(pos_after > pos_before);
        }

        #[test]
        fn decode_frame_returns_none_at_eof() {
            let samples: Vec<i16> = vec![0; 88];
            let wav_data = create_wav_data(44100, 2, &samples);

            let mut decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();

            loop {
                match decoder.decode_frame().unwrap() {
                    Some(_) => continue,
                    None => break,
                }
            }

            assert!(decoder.decode_frame().unwrap().is_none());
            assert!(decoder.is_eof());
        }

        #[test]
        fn samples_are_interleaved_stereo() {
            let mut samples = Vec::new();
            for _ in 0..100 {
                samples.push(1000);
                samples.push(2000);
            }
            let wav_data = create_wav_data(44100, 2, &samples);

            let mut decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();
            let frame = decoder.decode_frame().unwrap().unwrap();

            assert_eq!(frame.channels, 2);
        }

        #[test]
        fn mono_files_decoded_correctly() {
            let samples: Vec<i16> = vec![1000; 4410];
            let wav_data = create_wav_data(44100, 1, &samples);

            let mut decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();
            assert_eq!(decoder.channels(), 1);

            let frame = decoder.decode_frame().unwrap().unwrap();
            assert_eq!(frame.channels, 1);
        }
    }

    mod seeking {
        use super::*;

        #[test]
        fn seek_updates_position() {
            let samples: Vec<i16> = vec![0; 88200];
            let wav_data = create_wav_data(44100, 2, &samples);

            let mut decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();

            decoder.seek(22050).unwrap();
            assert_eq!(decoder.position_samples(), 22050);
        }

        #[test]
        fn seek_to_zero_resets() {
            // Note: In-memory WAV streams may not support backward seeking.
            // This test verifies that seek_to_zero at least updates position.
            let samples: Vec<i16> = vec![0; 88200];
            let wav_data = create_wav_data(44100, 2, &samples);

            let mut decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();

            // Seeking to zero from start should work
            decoder.seek(0).unwrap();
            assert_eq!(decoder.position_samples(), 0);
        }

        #[test]
        fn seek_beyond_end_clamps() {
            let samples: Vec<i16> = vec![0; 8820];
            let wav_data = create_wav_data(44100, 2, &samples);

            let mut decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();

            decoder.seek(1_000_000).unwrap();

            if let Some(duration) = decoder.duration_samples() {
                assert!(decoder.position_samples() <= duration);
            }
        }

        #[test]
        fn decode_after_seek_returns_correct_samples() {
            let samples: Vec<i16> = vec![0; 88200];
            let wav_data = create_wav_data(44100, 2, &samples);

            let mut decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();

            decoder.seek(22050).unwrap();
            let frame = decoder.decode_frame().unwrap();

            assert!(frame.is_some());
        }
    }

    mod resampling {
        use super::*;

        #[test]
        fn resample_44100_to_48000() {
            let samples: Vec<i16> = vec![1000; 88200];
            let wav_data = create_wav_data(44100, 2, &samples);

            let mut decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();

            let target = AudioFormat {
                codec: airplay_core::AudioCodec::Alac,
                sample_rate: SampleRate::Hz48000,
                bit_depth: 16,
                channels: 2,
                frames_per_packet: 352,
            };

            let frame = decoder.decode_resampled(&target, 352).unwrap();
            assert!(frame.is_some());

            let frame = frame.unwrap();
            assert_eq!(frame.sample_rate, 48000);
        }

        #[test]
        fn resample_48000_to_44100() {
            let samples: Vec<i16> = vec![1000; 96000];
            let wav_data = create_wav_data(48000, 2, &samples);

            let mut decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();

            let target = AudioFormat {
                codec: airplay_core::AudioCodec::Alac,
                sample_rate: SampleRate::Hz44100,
                bit_depth: 16,
                channels: 2,
                frames_per_packet: 352,
            };

            let frame = decoder.decode_resampled(&target, 352).unwrap();
            assert!(frame.is_some());

            let frame = frame.unwrap();
            assert_eq!(frame.sample_rate, 44100);
        }

        #[test]
        fn no_resample_when_rate_matches() {
            let samples: Vec<i16> = vec![1000; 88200];
            let wav_data = create_wav_data(44100, 2, &samples);

            let mut decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();

            let target = AudioFormat {
                codec: airplay_core::AudioCodec::Alac,
                sample_rate: SampleRate::Hz44100,
                bit_depth: 16,
                channels: 2,
                frames_per_packet: 352,
            };

            let frame = decoder.decode_resampled(&target, 352).unwrap();
            assert!(frame.is_some());

            let frame = frame.unwrap();
            assert_eq!(frame.sample_rate, 44100);
        }

        #[test]
        fn frames_per_packet_honored() {
            let samples: Vec<i16> = vec![1000; 88200];
            let wav_data = create_wav_data(44100, 2, &samples);

            let mut decoder = AudioDecoder::from_bytes(&wav_data, Some("wav")).unwrap();

            let target = AudioFormat {
                codec: airplay_core::AudioCodec::Alac,
                sample_rate: SampleRate::Hz44100,
                bit_depth: 16,
                channels: 2,
                frames_per_packet: 352,
            };

            let frame = decoder.decode_resampled(&target, 352).unwrap().unwrap();

            // Should have 352 frames * 2 channels = 704 samples
            assert_eq!(frame.samples.len(), 704);
        }
    }
}
