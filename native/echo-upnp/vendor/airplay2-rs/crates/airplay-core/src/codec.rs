//! Audio codec and format definitions for AirPlay streaming.

/// Supported audio codecs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioCodec {
    /// Linear PCM (uncompressed).
    Pcm,
    /// Apple Lossless Audio Codec.
    Alac,
    /// Advanced Audio Coding.
    Aac,
    /// AAC Enhanced Low Delay.
    AacEld,
    /// Opus codec.
    Opus,
}

/// Supported sample rates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleRate {
    Hz44100,
    Hz48000,
}

/// Complete audio format specification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioFormat {
    pub codec: AudioCodec,
    pub sample_rate: SampleRate,
    pub bit_depth: u8,
    pub channels: u8,
    pub frames_per_packet: u32,
}

impl AudioCodec {
    /// Get the compression type value for RTSP SETUP.
    ///
    /// Values from owntone/AirPlay protocol:
    /// - PCM: 1
    /// - ALAC: 2
    /// - AAC: 3
    /// - AAC-ELD: 4
    /// - OPUS: 32
    pub fn compression_type(&self) -> u8 {
        match self {
            Self::Pcm => 1,
            Self::Alac => 2,
            Self::Aac => 3,
            Self::AacEld => 4,
            Self::Opus => 32,
        }
    }

    /// Get the audioFormat value for RTSP SETUP.
    ///
    /// Values from AirPlay spec:
    /// - ALAC 44100/16-bit: 0x40000 (262144)
    /// - AAC 44100/2ch: 0x400000
    /// - AAC-ELD 44100/2ch: 0x1000000
    pub fn audio_format_value(&self) -> u32 {
        match self {
            Self::Pcm => 0,            // PCM doesn't have a specific audioFormat value
            Self::Alac => 0x40000,     // 262144
            Self::Aac => 0x400000,     // 4194304
            Self::AacEld => 0x1000000, // 16777216
            Self::Opus => 0x2000000,   // 33554432 (estimated)
        }
    }

    /// Parse from compression type value.
    pub fn from_compression_type(ct: u8) -> Option<Self> {
        match ct {
            1 => Some(Self::Pcm),
            2 => Some(Self::Alac),
            3 => Some(Self::Aac),
            4 => Some(Self::AacEld),
            32 => Some(Self::Opus),
            _ => None,
        }
    }
}

impl SampleRate {
    pub fn as_hz(&self) -> u32 {
        match self {
            Self::Hz44100 => 44100,
            Self::Hz48000 => 48000,
        }
    }
}

impl Default for AudioFormat {
    fn default() -> Self {
        Self {
            codec: AudioCodec::Alac,
            sample_rate: SampleRate::Hz44100,
            bit_depth: 16,
            channels: 2,
            frames_per_packet: 352,
        }
    }
}

impl AudioFormat {
    /// Create format for real-time streaming (type 96).
    pub fn realtime_default() -> Self {
        Self::default()
    }

    /// Create format for buffered streaming (type 103).
    pub fn buffered_default() -> Self {
        Self {
            codec: AudioCodec::Aac,
            sample_rate: SampleRate::Hz44100,
            bit_depth: 16,
            channels: 2,
            frames_per_packet: 1024,
        }
    }

    /// Calculate bytes per frame (per sample across all channels).
    ///
    /// For 16-bit stereo audio: 16 bits * 2 channels / 8 = 4 bytes per frame.
    pub fn bytes_per_frame(&self) -> usize {
        (self.bit_depth as usize * self.channels as usize) / 8
    }

    /// Calculate buffer size in bytes for given duration in milliseconds.
    ///
    /// buffer_size = sample_rate * bytes_per_frame * ms / 1000
    pub fn buffer_size_for_duration_ms(&self, ms: u32) -> usize {
        let samples = (self.sample_rate.as_hz() as u64 * ms as u64) / 1000;
        samples as usize * self.bytes_per_frame()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod audio_codec {
        use super::*;

        #[test]
        fn compression_type_pcm() {
            assert_eq!(AudioCodec::Pcm.compression_type(), 1);
        }

        #[test]
        fn compression_type_alac() {
            assert_eq!(AudioCodec::Alac.compression_type(), 2);
        }

        #[test]
        fn compression_type_aac() {
            assert_eq!(AudioCodec::Aac.compression_type(), 3);
        }

        #[test]
        fn compression_type_aac_eld() {
            assert_eq!(AudioCodec::AacEld.compression_type(), 4);
        }

        #[test]
        fn compression_type_opus() {
            assert_eq!(AudioCodec::Opus.compression_type(), 32);
        }

        #[test]
        fn audio_format_value_alac() {
            assert_eq!(AudioCodec::Alac.audio_format_value(), 0x40000);
        }

        #[test]
        fn audio_format_value_aac() {
            assert_eq!(AudioCodec::Aac.audio_format_value(), 0x400000);
        }

        #[test]
        fn from_compression_type_roundtrip() {
            for codec in [
                AudioCodec::Pcm,
                AudioCodec::Alac,
                AudioCodec::Aac,
                AudioCodec::AacEld,
                AudioCodec::Opus,
            ] {
                let ct = codec.compression_type();
                let parsed = AudioCodec::from_compression_type(ct).unwrap();
                assert_eq!(parsed, codec);
            }
        }

        #[test]
        fn from_compression_type_invalid() {
            assert!(AudioCodec::from_compression_type(0).is_none());
            assert!(AudioCodec::from_compression_type(8).is_none());
            assert!(AudioCodec::from_compression_type(16).is_none());
            assert!(AudioCodec::from_compression_type(255).is_none());
        }
    }

    mod audio_format {
        use super::*;

        #[test]
        fn default_is_alac_44100_16bit_stereo() {
            let format = AudioFormat::default();
            assert_eq!(format.codec, AudioCodec::Alac);
            assert_eq!(format.sample_rate, SampleRate::Hz44100);
            assert_eq!(format.bit_depth, 16);
            assert_eq!(format.channels, 2);
            assert_eq!(format.frames_per_packet, 352);
        }

        #[test]
        fn realtime_default_352_frames() {
            let format = AudioFormat::realtime_default();
            assert_eq!(format.frames_per_packet, 352);
            assert_eq!(format.codec, AudioCodec::Alac);
        }

        #[test]
        fn buffered_default_is_aac() {
            let format = AudioFormat::buffered_default();
            assert_eq!(format.codec, AudioCodec::Aac);
            assert_eq!(format.frames_per_packet, 1024);
        }

        #[test]
        fn bytes_per_frame_stereo_16bit() {
            let format = AudioFormat {
                codec: AudioCodec::Alac,
                sample_rate: SampleRate::Hz44100,
                bit_depth: 16,
                channels: 2,
                frames_per_packet: 352,
            };
            // 16 bits * 2 channels / 8 = 4 bytes
            assert_eq!(format.bytes_per_frame(), 4);
        }

        #[test]
        fn bytes_per_frame_mono_16bit() {
            let format = AudioFormat {
                codec: AudioCodec::Alac,
                sample_rate: SampleRate::Hz44100,
                bit_depth: 16,
                channels: 1,
                frames_per_packet: 352,
            };
            // 16 bits * 1 channel / 8 = 2 bytes
            assert_eq!(format.bytes_per_frame(), 2);
        }

        #[test]
        fn buffer_size_for_100ms() {
            let format = AudioFormat::default(); // 44100Hz, 16-bit, stereo
                                                 // 44100 * 100 / 1000 = 4410 samples
                                                 // 4410 * 4 bytes = 17640 bytes
            assert_eq!(format.buffer_size_for_duration_ms(100), 17640);
        }

        #[test]
        fn buffer_size_for_2000ms() {
            let format = AudioFormat::default(); // 44100Hz, 16-bit, stereo
                                                 // 44100 * 2000 / 1000 = 88200 samples
                                                 // 88200 * 4 bytes = 352800 bytes
            assert_eq!(format.buffer_size_for_duration_ms(2000), 352800);
        }
    }
}
