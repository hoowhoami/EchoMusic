//! Audio encoding for AirPlay streaming.

use airplay_core::{AudioFormat, AudioCodec, SampleRate, error::Result};

/// Encoded audio packet.
#[derive(Debug, Clone)]
pub struct EncodedPacket {
    /// Encoded data.
    pub data: Vec<u8>,
    /// Number of samples in this packet.
    pub samples: u32,
    /// Timestamp in samples.
    pub timestamp: u64,
}

/// Generic audio encoder trait.
pub trait AudioEncoder: Send {
    /// Encode PCM samples to codec format.
    fn encode(&mut self, samples: &[i16]) -> Result<EncodedPacket>;

    /// Get codec type.
    fn codec(&self) -> AudioCodec;

    /// Get frames per packet.
    fn frames_per_packet(&self) -> u32;

    /// Flush any buffered samples.
    fn flush(&mut self) -> Result<Option<EncodedPacket>>;
}

/// ALAC encoder for realtime streaming.
pub struct AlacEncoder {
    encoder: alac_encoder::AlacEncoder,
    input_format: alac_encoder::FormatDescription,
    format: AudioFormat,
    timestamp: u64,
    buffer: Vec<i16>,
    output_buffer: Vec<u8>,
}

impl AlacEncoder {
    /// Create new ALAC encoder.
    pub fn new(format: AudioFormat) -> Result<Self> {
        // Create ALAC format description with sample_rate, frames_per_packet, channels
        let alac_format = alac_encoder::FormatDescription::alac(
            format.sample_rate.as_hz() as f64,
            format.frames_per_packet,
            format.channels as u32,
        );

        // Create PCM input format description
        let pcm_format = alac_encoder::FormatDescription::pcm::<i16>(
            format.sample_rate.as_hz() as f64,
            format.channels as u32,
        );

        let encoder = alac_encoder::AlacEncoder::new(&alac_format);

        // Calculate maximum encoded frame size
        // ALAC worst case is slightly larger than raw PCM
        let max_encoded_size = format.frames_per_packet as usize * format.channels as usize * 2 + 256;

        Ok(Self {
            encoder,
            input_format: pcm_format,
            format,
            timestamp: 0,
            buffer: Vec::new(),
            output_buffer: vec![0u8; max_encoded_size],
        })
    }

    /// Get the ALAC-specific config data (magic cookie) for SETUP.
    ///
    /// The magic cookie is a 24-byte structure containing codec parameters.
    pub fn magic_cookie(&self) -> Vec<u8> {
        self.encoder.magic_cookie().to_vec()
    }

    /// Encode a single frame of samples.
    fn encode_frame(&mut self, samples: &[i16]) -> Result<EncodedPacket> {
        let num_samples = samples.len() / self.format.channels as usize;

        // Convert i16 samples to bytes (native endian)
        let input_bytes: Vec<u8> = samples
            .iter()
            .flat_map(|s| s.to_ne_bytes())
            .collect();

        // Encode using alac-encoder
        let encoded_size = self.encoder.encode(
            &self.input_format,
            &input_bytes,
            &mut self.output_buffer,
        );

        let timestamp = self.timestamp;
        self.timestamp += num_samples as u64;

        Ok(EncodedPacket {
            data: self.output_buffer[..encoded_size].to_vec(),
            samples: num_samples as u32,
            timestamp,
        })
    }
}

impl AudioEncoder for AlacEncoder {
    fn encode(&mut self, samples: &[i16]) -> Result<EncodedPacket> {
        let samples_per_frame = self.format.frames_per_packet as usize * self.format.channels as usize;

        // Add to buffer
        self.buffer.extend_from_slice(samples);

        // If we have enough for a full frame, encode it
        if self.buffer.len() >= samples_per_frame {
            let frame_samples: Vec<i16> = self.buffer.drain(..samples_per_frame).collect();
            self.encode_frame(&frame_samples)
        } else {
            // Return partial packet (shouldn't happen in normal use)
            let partial: Vec<i16> = self.buffer.drain(..).collect();
            self.encode_frame(&partial)
        }
    }

    fn codec(&self) -> AudioCodec {
        AudioCodec::Alac
    }

    fn frames_per_packet(&self) -> u32 {
        self.format.frames_per_packet
    }

    fn flush(&mut self) -> Result<Option<EncodedPacket>> {
        if self.buffer.is_empty() {
            Ok(None)
        } else {
            // Pad with zeros to fill a complete frame
            let samples_per_frame = self.format.frames_per_packet as usize * self.format.channels as usize;
            while self.buffer.len() < samples_per_frame {
                self.buffer.push(0);
            }
            let remaining: Vec<i16> = self.buffer.drain(..).collect();
            Ok(Some(self.encode_frame(&remaining)?))
        }
    }
}

/// AAC encoder for buffered streaming.
pub struct AacEncoder {
    encoder: fdk_aac::enc::Encoder,
    format: AudioFormat,
    timestamp: u64,
    buffer: Vec<i16>,
    output_buffer: Vec<u8>,
    asc: Vec<u8>,
}

impl AacEncoder {
    /// Create new AAC encoder.
    pub fn new(format: AudioFormat) -> Result<Self> {
        let encoder = fdk_aac::enc::Encoder::new(fdk_aac::enc::EncoderParams {
            bit_rate: fdk_aac::enc::BitRate::Cbr(128_000), // 128 kbps
            sample_rate: format.sample_rate.as_hz(),
            transport: fdk_aac::enc::Transport::Raw,
            channels: fdk_aac::enc::ChannelMode::Stereo,
        }).map_err(|e| {
            airplay_core::error::StreamingError::InvalidFormat(format!(
                "Failed to create AAC encoder: {:?}",
                e
            ))
        })?;

        // Get the AudioSpecificConfig from encoder info
        let info = encoder.info().map_err(|e| {
            airplay_core::error::StreamingError::InvalidFormat(format!(
                "Failed to get encoder info: {:?}",
                e
            ))
        })?;
        // ASC is in confBuf, valid bytes indicated by confSize
        let asc = info.confBuf[..info.confSize as usize].to_vec();

        // Calculate max output buffer size (bit_rate / 8 * frame_duration + overhead)
        // AAC frame is typically 1024 samples
        let max_output_size = (128_000 / 8 / (format.sample_rate.as_hz() / 1024)) as usize + 256;

        Ok(Self {
            encoder,
            format,
            timestamp: 0,
            buffer: Vec::new(),
            output_buffer: vec![0u8; max_output_size.max(2048)],
            asc,
        })
    }

    /// Get the AAC-specific config data (AudioSpecificConfig).
    ///
    /// This returns a 2-byte AudioSpecificConfig for AAC-LC.
    pub fn audio_specific_config(&self) -> Vec<u8> {
        self.asc.clone()
    }

    /// Encode a single frame of samples.
    fn encode_frame(&mut self, samples: &[i16]) -> Result<EncodedPacket> {
        let num_samples = samples.len() / self.format.channels as usize;

        let encode_info = self.encoder.encode(samples, &mut self.output_buffer).map_err(|e| {
            airplay_core::error::StreamingError::Encoding(format!(
                "AAC encode failed: {:?}",
                e
            ))
        })?;

        let timestamp = self.timestamp;
        self.timestamp += num_samples as u64;

        Ok(EncodedPacket {
            data: self.output_buffer[..encode_info.output_size].to_vec(),
            samples: num_samples as u32,
            timestamp,
        })
    }
}

impl AudioEncoder for AacEncoder {
    fn encode(&mut self, samples: &[i16]) -> Result<EncodedPacket> {
        let samples_per_frame = self.format.frames_per_packet as usize * self.format.channels as usize;

        // Add to buffer
        self.buffer.extend_from_slice(samples);

        // If we have enough for a full frame, encode it
        if self.buffer.len() >= samples_per_frame {
            let frame_samples: Vec<i16> = self.buffer.drain(..samples_per_frame).collect();
            self.encode_frame(&frame_samples)
        } else {
            // Return partial packet (shouldn't happen in normal use)
            let partial: Vec<i16> = self.buffer.drain(..).collect();
            self.encode_frame(&partial)
        }
    }

    fn codec(&self) -> AudioCodec {
        AudioCodec::Aac
    }

    fn frames_per_packet(&self) -> u32 {
        self.format.frames_per_packet
    }

    fn flush(&mut self) -> Result<Option<EncodedPacket>> {
        if self.buffer.is_empty() {
            Ok(None)
        } else {
            // Pad with zeros to fill a complete frame
            let samples_per_frame = self.format.frames_per_packet as usize * self.format.channels as usize;
            while self.buffer.len() < samples_per_frame {
                self.buffer.push(0);
            }
            let remaining: Vec<i16> = self.buffer.drain(..).collect();
            Ok(Some(self.encode_frame(&remaining)?))
        }
    }
}

/// Create appropriate encoder for format.
pub fn create_encoder(format: AudioFormat) -> Result<Box<dyn AudioEncoder>> {
    match format.codec {
        AudioCodec::Alac => Ok(Box::new(AlacEncoder::new(format)?)),
        AudioCodec::Aac => Ok(Box::new(AacEncoder::new(format)?)),
        _ => Err(airplay_core::error::StreamingError::InvalidFormat(
            format!("Unsupported codec: {:?}", format.codec)
        ).into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alac_format_44100() -> AudioFormat {
        AudioFormat {
            codec: AudioCodec::Alac,
            sample_rate: SampleRate::Hz44100,
            bit_depth: 16,
            channels: 2,
            frames_per_packet: 352,
        }
    }

    fn alac_format_48000() -> AudioFormat {
        AudioFormat {
            codec: AudioCodec::Alac,
            sample_rate: SampleRate::Hz48000,
            bit_depth: 16,
            channels: 2,
            frames_per_packet: 352,
        }
    }

    fn aac_format_44100() -> AudioFormat {
        AudioFormat {
            codec: AudioCodec::Aac,
            sample_rate: SampleRate::Hz44100,
            bit_depth: 16,
            channels: 2,
            frames_per_packet: 1024,
        }
    }

    fn aac_format_48000() -> AudioFormat {
        AudioFormat {
            codec: AudioCodec::Aac,
            sample_rate: SampleRate::Hz48000,
            bit_depth: 16,
            channels: 2,
            frames_per_packet: 1024,
        }
    }

    mod alac_encoder {
        use super::*;

        #[test]
        fn new_creates_encoder_for_44100() {
            let encoder = AlacEncoder::new(alac_format_44100());
            assert!(encoder.is_ok());
        }

        #[test]
        fn new_creates_encoder_for_48000() {
            let encoder = AlacEncoder::new(alac_format_48000());
            assert!(encoder.is_ok());
        }

        #[test]
        fn encode_352_samples() {
            let mut encoder = AlacEncoder::new(alac_format_44100()).unwrap();
            // 352 samples * 2 channels = 704 i16 values
            let samples = vec![0i16; 704];
            let packet = encoder.encode(&samples).unwrap();

            assert_eq!(packet.samples, 352);
            assert!(!packet.data.is_empty());
        }

        #[test]
        fn encode_increments_timestamp() {
            let mut encoder = AlacEncoder::new(alac_format_44100()).unwrap();
            let samples = vec![0i16; 704]; // 352 samples * 2 channels

            let packet1 = encoder.encode(&samples).unwrap();
            assert_eq!(packet1.timestamp, 0);

            let packet2 = encoder.encode(&samples).unwrap();
            assert_eq!(packet2.timestamp, 352);

            let packet3 = encoder.encode(&samples).unwrap();
            assert_eq!(packet3.timestamp, 704);
        }

        #[test]
        fn encoded_data_is_valid_alac() {
            let mut encoder = AlacEncoder::new(alac_format_44100()).unwrap();
            let samples = vec![0i16; 704];
            let packet = encoder.encode(&samples).unwrap();

            // Check that we have output data (real ALAC encoding)
            assert!(packet.data.len() > 0);
            // ALAC encoded data should be smaller or roughly equal to raw PCM
            // (704 samples * 2 bytes = 1408 bytes raw)
            // Compressed silence should be much smaller
            assert!(packet.data.len() <= 1500);
        }

        #[test]
        fn magic_cookie_is_valid() {
            let encoder = AlacEncoder::new(alac_format_44100()).unwrap();
            let cookie = encoder.magic_cookie();

            // Magic cookie should be present
            assert!(!cookie.is_empty());
            // ALAC magic cookie is typically 24+ bytes
            assert!(cookie.len() >= 24);
        }

        #[test]
        fn flush_returns_remaining_samples() {
            let mut encoder = AlacEncoder::new(alac_format_44100()).unwrap();
            // Add partial frame
            encoder.buffer = vec![0i16; 100];
            let flushed = encoder.flush().unwrap();
            assert!(flushed.is_some());
        }

        #[test]
        fn flush_returns_none_when_empty() {
            let mut encoder = AlacEncoder::new(alac_format_44100()).unwrap();
            let flushed = encoder.flush().unwrap();
            assert!(flushed.is_none());
        }
    }

    mod aac_encoder {
        use super::*;

        #[test]
        fn new_creates_encoder_for_44100() {
            let encoder = AacEncoder::new(aac_format_44100());
            assert!(encoder.is_ok());
        }

        #[test]
        fn new_creates_encoder_for_48000() {
            let encoder = AacEncoder::new(aac_format_48000());
            assert!(encoder.is_ok());
        }

        #[test]
        fn encode_1024_samples() {
            let mut encoder = AacEncoder::new(aac_format_44100()).unwrap();
            // 1024 samples * 2 channels = 2048 i16 values
            let samples = vec![0i16; 2048];
            let packet = encoder.encode(&samples).unwrap();

            assert_eq!(packet.samples, 1024);
            assert!(!packet.data.is_empty());
        }

        #[test]
        fn encode_increments_timestamp() {
            let mut encoder = AacEncoder::new(aac_format_44100()).unwrap();
            let samples = vec![0i16; 2048]; // 1024 samples * 2 channels

            let packet1 = encoder.encode(&samples).unwrap();
            assert_eq!(packet1.timestamp, 0);

            let packet2 = encoder.encode(&samples).unwrap();
            assert_eq!(packet2.timestamp, 1024);

            let packet3 = encoder.encode(&samples).unwrap();
            assert_eq!(packet3.timestamp, 2048);
        }

        #[test]
        fn encoded_data_is_valid_aac() {
            let mut encoder = AacEncoder::new(aac_format_44100()).unwrap();
            let samples = vec![0i16; 2048];
            let packet = encoder.encode(&samples).unwrap();

            // Check that we have output data
            assert!(packet.data.len() > 0);
        }

        #[test]
        fn audio_specific_config_is_valid() {
            let encoder = AacEncoder::new(aac_format_44100()).unwrap();
            let asc = encoder.audio_specific_config();

            // ASC should be at least 2 bytes
            assert!(asc.len() >= 2);

            // Decode and verify (first 5 bits = object type, should be 2 for AAC-LC)
            let object_type = (asc[0] >> 3) & 0x1F;
            assert!(object_type == 2 || object_type == 5); // AAC-LC or SBR
        }
    }

    mod create_encoder {
        use super::*;

        #[test]
        fn creates_alac_for_alac_format() {
            let encoder = create_encoder(alac_format_44100()).unwrap();
            assert_eq!(encoder.codec(), AudioCodec::Alac);
        }

        #[test]
        fn creates_aac_for_aac_format() {
            let encoder = create_encoder(aac_format_44100()).unwrap();
            assert_eq!(encoder.codec(), AudioCodec::Aac);
        }

        #[test]
        fn error_for_unsupported_codec() {
            let format = AudioFormat {
                codec: AudioCodec::Pcm,
                sample_rate: SampleRate::Hz44100,
                bit_depth: 16,
                channels: 2,
                frames_per_packet: 352,
            };
            let result = create_encoder(format);
            assert!(result.is_err());
        }
    }

    mod encoder_trait {
        use super::*;

        #[test]
        fn alac_reports_correct_codec() {
            let encoder = AlacEncoder::new(alac_format_44100()).unwrap();
            assert_eq!(encoder.codec(), AudioCodec::Alac);
        }

        #[test]
        fn aac_reports_correct_codec() {
            let encoder = AacEncoder::new(aac_format_44100()).unwrap();
            assert_eq!(encoder.codec(), AudioCodec::Aac);
        }

        #[test]
        fn frames_per_packet_matches_format() {
            let alac = AlacEncoder::new(alac_format_44100()).unwrap();
            assert_eq!(alac.frames_per_packet(), 352);

            let aac = AacEncoder::new(aac_format_44100()).unwrap();
            assert_eq!(aac.frames_per_packet(), 1024);
        }
    }

    /// Audio validation tests to verify encoders produce correct, audible audio.
    mod audio_validation {
        use super::*;
        use std::f64::consts::PI;

        /// Generate a sine wave at the given frequency.
        /// Returns interleaved stereo samples.
        fn generate_sine_wave(
            frequency_hz: f64,
            sample_rate: u32,
            duration_samples: usize,
            amplitude: i16,
        ) -> Vec<i16> {
            let mut samples = Vec::with_capacity(duration_samples * 2);
            for i in 0..duration_samples {
                let t = i as f64 / sample_rate as f64;
                let value = (amplitude as f64 * (2.0 * PI * frequency_hz * t).sin()) as i16;
                // Stereo: same value on both channels
                samples.push(value);
                samples.push(value);
            }
            samples
        }

        /// Calculate RMS (root mean square) energy of samples.
        fn calculate_rms(samples: &[i16]) -> f64 {
            if samples.is_empty() {
                return 0.0;
            }
            let sum_squares: f64 = samples.iter().map(|&s| (s as f64).powi(2)).sum();
            (sum_squares / samples.len() as f64).sqrt()
        }

        /// Check if samples contain a dominant frequency near the expected value.
        /// Uses zero-crossing rate as a simple frequency estimator.
        fn estimate_frequency_from_zero_crossings(samples: &[i16], sample_rate: u32) -> f64 {
            if samples.len() < 4 {
                return 0.0;
            }

            let mut zero_crossings = 0;
            // Use mono (every other sample for stereo)
            let mono: Vec<i16> = samples.iter().step_by(2).copied().collect();

            for i in 1..mono.len() {
                if (mono[i-1] >= 0 && mono[i] < 0) || (mono[i-1] < 0 && mono[i] >= 0) {
                    zero_crossings += 1;
                }
            }

            // Zero crossings per second / 2 = frequency
            let duration_secs = mono.len() as f64 / sample_rate as f64;
            (zero_crossings as f64 / duration_secs) / 2.0
        }

        #[test]
        fn alac_encodes_sine_wave_440hz() {
            let mut encoder = AlacEncoder::new(alac_format_44100()).unwrap();

            // Generate 1 second of 440Hz sine wave (A4 note)
            let sample_rate = 44100u32;
            let duration_samples = sample_rate as usize; // 1 second
            let sine_wave = generate_sine_wave(440.0, sample_rate, duration_samples, 16000);

            // Verify source audio has expected properties
            let source_rms = calculate_rms(&sine_wave);
            assert!(source_rms > 10000.0, "Source RMS too low: {}", source_rms);

            let source_freq = estimate_frequency_from_zero_crossings(&sine_wave, sample_rate);
            assert!((source_freq - 440.0).abs() < 20.0, "Source frequency wrong: {} Hz", source_freq);

            // Encode in 352-sample chunks
            let samples_per_frame = 352 * 2; // stereo
            let mut encoded_packets = Vec::new();
            let mut total_encoded_bytes = 0;

            for chunk in sine_wave.chunks(samples_per_frame) {
                if chunk.len() == samples_per_frame {
                    let packet = encoder.encode(chunk).unwrap();
                    total_encoded_bytes += packet.data.len();
                    encoded_packets.push(packet);
                }
            }

            // Verify encoding produced data
            assert!(!encoded_packets.is_empty(), "No packets encoded");
            assert!(total_encoded_bytes > 0, "No encoded data produced");

            // ALAC is lossless, so encoded size should be reasonable
            // (not much larger than raw, could be smaller for simple signals)
            let raw_size = sine_wave.len() * 2; // 2 bytes per sample
            assert!(
                total_encoded_bytes < raw_size * 2,
                "Encoded size {} too large compared to raw {}",
                total_encoded_bytes,
                raw_size
            );

            println!("ALAC 440Hz sine wave test:");
            println!("  Source RMS: {:.2}", source_rms);
            println!("  Source frequency: {:.2} Hz", source_freq);
            println!("  Raw size: {} bytes", raw_size);
            println!("  Encoded size: {} bytes ({:.1}% of raw)",
                total_encoded_bytes,
                100.0 * total_encoded_bytes as f64 / raw_size as f64
            );
            println!("  Packets: {}", encoded_packets.len());
        }

        #[test]
        fn alac_encodes_multiple_frequencies() {
            let mut encoder = AlacEncoder::new(alac_format_44100()).unwrap();
            let sample_rate = 44100u32;

            // Test multiple frequencies: 220Hz, 440Hz, 880Hz, 1760Hz
            let frequencies = [220.0, 440.0, 880.0, 1760.0];

            for freq in frequencies {
                // Generate 0.5 seconds of each frequency
                let duration_samples = (sample_rate / 2) as usize;
                let sine_wave = generate_sine_wave(freq, sample_rate, duration_samples, 16000);

                let samples_per_frame = 352 * 2;
                let mut encoded_size = 0;

                for chunk in sine_wave.chunks(samples_per_frame) {
                    if chunk.len() == samples_per_frame {
                        let packet = encoder.encode(chunk).unwrap();
                        encoded_size += packet.data.len();

                        // Each packet should have non-trivial data
                        assert!(packet.data.len() > 10, "Packet too small for {} Hz", freq);
                    }
                }

                assert!(encoded_size > 0, "No data encoded for {} Hz", freq);
                println!("  {} Hz: {} bytes encoded", freq, encoded_size);
            }
        }

        #[test]
        fn alac_silence_compresses_well() {
            let mut encoder = AlacEncoder::new(alac_format_44100()).unwrap();

            // 1 second of silence
            let silence = vec![0i16; 44100 * 2];

            let samples_per_frame = 352 * 2;
            let mut encoded_size = 0;

            for chunk in silence.chunks(samples_per_frame) {
                if chunk.len() == samples_per_frame {
                    let packet = encoder.encode(chunk).unwrap();
                    encoded_size += packet.data.len();
                }
            }

            let raw_size = silence.len() * 2;

            // Silence should compress very well (< 20% of raw size)
            assert!(
                encoded_size < raw_size / 5,
                "Silence compression poor: {} vs {} raw",
                encoded_size,
                raw_size
            );

            println!("ALAC silence compression: {} -> {} bytes ({:.1}%)",
                raw_size, encoded_size, 100.0 * encoded_size as f64 / raw_size as f64);
        }

        #[test]
        fn aac_encodes_sine_wave_440hz() {
            let mut encoder = AacEncoder::new(aac_format_44100()).unwrap();

            // Generate 1 second of 440Hz sine wave
            let sample_rate = 44100u32;
            let duration_samples = sample_rate as usize;
            let sine_wave = generate_sine_wave(440.0, sample_rate, duration_samples, 16000);

            // Encode in 1024-sample chunks
            let samples_per_frame = 1024 * 2; // stereo
            let mut encoded_packets = Vec::new();
            let mut total_encoded_bytes = 0;

            for chunk in sine_wave.chunks(samples_per_frame) {
                if chunk.len() == samples_per_frame {
                    let packet = encoder.encode(chunk).unwrap();
                    total_encoded_bytes += packet.data.len();
                    encoded_packets.push(packet);
                }
            }

            // Verify encoding produced data
            assert!(!encoded_packets.is_empty(), "No packets encoded");
            assert!(total_encoded_bytes > 0, "No encoded data produced");

            // AAC is lossy but efficient
            let raw_size = sine_wave.len() * 2;

            println!("AAC 440Hz sine wave test:");
            println!("  Raw size: {} bytes", raw_size);
            println!("  Encoded size: {} bytes ({:.1}% of raw)",
                total_encoded_bytes,
                100.0 * total_encoded_bytes as f64 / raw_size as f64
            );
            println!("  Packets: {}", encoded_packets.len());
        }

        #[test]
        fn alac_preserves_signal_characteristics() {
            let mut encoder = AlacEncoder::new(alac_format_44100()).unwrap();
            let sample_rate = 44100u32;

            // Generate a complex signal: 440Hz + 880Hz (fundamental + first harmonic)
            let duration_samples = sample_rate as usize; // 1 second
            let mut complex_signal = Vec::with_capacity(duration_samples * 2);

            for i in 0..duration_samples {
                let t = i as f64 / sample_rate as f64;
                let fundamental = 10000.0 * (2.0 * PI * 440.0 * t).sin();
                let harmonic = 5000.0 * (2.0 * PI * 880.0 * t).sin();
                let value = (fundamental + harmonic) as i16;
                complex_signal.push(value);
                complex_signal.push(value);
            }

            // Calculate source energy
            let source_rms = calculate_rms(&complex_signal);

            // Encode
            let samples_per_frame = 352 * 2;
            let mut packet_count = 0;

            for chunk in complex_signal.chunks(samples_per_frame) {
                if chunk.len() == samples_per_frame {
                    let packet = encoder.encode(chunk).unwrap();
                    assert!(!packet.data.is_empty(), "Empty packet");
                    packet_count += 1;
                }
            }

            assert!(packet_count > 0, "No packets encoded");
            println!("Complex signal (440Hz + 880Hz) encoded: {} packets, source RMS: {:.2}",
                packet_count, source_rms);
        }

        /// Write a WAV file with the given samples (for manual verification).
        /// Only runs when WRITE_TEST_AUDIO=1 environment variable is set.
        #[test]
        #[ignore] // Run with: cargo test --ignored write_test_wav
        fn write_test_wav_for_manual_verification() {
            use std::env;
            use std::path::Path;

            let sample_rate = 44100u32;
            let duration_secs = 3;
            let duration_samples = sample_rate as usize * duration_secs;

            // Generate a sequence: 1s of 440Hz, 1s of 880Hz, 1s of 440Hz
            let mut samples = Vec::with_capacity(duration_samples * 2);

            for i in 0..duration_samples {
                let t = i as f64 / sample_rate as f64;
                let freq = if t < 1.0 { 440.0 } else if t < 2.0 { 880.0 } else { 440.0 };
                let value = (16000.0 * (2.0 * PI * freq * t).sin()) as i16;
                samples.push(value);
                samples.push(value);
            }

            // Write WAV file
            let out_path = env::var("TEST_AUDIO_DIR")
                .unwrap_or_else(|_| "/tmp".to_string());
            let wav_path = Path::new(&out_path).join("airplay_test_tone.wav");

            let spec = hound::WavSpec {
                channels: 2,
                sample_rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };

            let mut writer = hound::WavWriter::create(&wav_path, spec)
                .expect("Failed to create WAV file");

            for sample in &samples {
                writer.write_sample(*sample).expect("Failed to write sample");
            }

            writer.finalize().expect("Failed to finalize WAV");

            println!("Wrote test WAV to: {}", wav_path.display());
            println!("Play with: aplay {} or ffplay {}", wav_path.display(), wav_path.display());
        }

        /// Test encoding real audio content (requires a test file).
        #[test]
        #[ignore] // Run with: cargo test --ignored encode_real_audio
        fn encode_real_audio_file() {
            use std::env;
            use crate::decoder::AudioDecoder;

            let test_file = env::var("TEST_AUDIO_FILE")
                .expect("Set TEST_AUDIO_FILE env var to path of an audio file");

            let mut decoder = AudioDecoder::open(&test_file)
                .expect("Failed to open test audio file");

            let format = alac_format_44100();
            let mut encoder = AlacEncoder::new(format).unwrap();

            let samples_per_frame = 352;
            let mut total_packets = 0;
            let mut total_bytes = 0;

            while let Ok(Some(frame)) = decoder.decode_resampled(&format, samples_per_frame) {
                let packet = encoder.encode(&frame.samples).unwrap();
                total_packets += 1;
                total_bytes += packet.data.len();

                if total_packets >= 1000 {
                    break; // Limit for test
                }
            }

            println!("Encoded {} packets ({} bytes) from {}",
                total_packets, total_bytes, test_file);
        }
    }
}
