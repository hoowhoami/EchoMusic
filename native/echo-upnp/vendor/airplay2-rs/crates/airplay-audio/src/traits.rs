//! Traits for audio source and encoder abstraction.

use airplay_core::{AudioCodec, AudioFormat, error::Result};
use crate::{AudioFrame, encoder::EncodedPacket};
use async_trait::async_trait;

/// Trait for audio sources (enables testing with mocks).
#[async_trait]
#[cfg_attr(test, mockall::automock)]
pub trait AudioSource: Send + Sync {
    /// Get audio format.
    fn format(&self) -> AudioFormat;

    /// Get duration in samples (if known).
    fn duration_samples(&self) -> Option<u64>;

    /// Read next frame of audio.
    async fn read_frame(&mut self) -> Result<Option<AudioFrame>>;

    /// Seek to position in samples.
    async fn seek(&mut self, position: u64) -> Result<()>;

    /// Check if at end of stream.
    fn is_eof(&self) -> bool;
}

/// Trait for encoders (enables testing with mocks).
#[cfg_attr(test, mockall::automock)]
pub trait EncoderTrait: Send {
    /// Encode PCM samples.
    fn encode(&mut self, samples: &[i16]) -> Result<EncodedPacket>;

    /// Get codec type.
    fn codec(&self) -> AudioCodec;

    /// Get frames per packet.
    fn frames_per_packet(&self) -> u32;

    /// Flush remaining samples.
    fn flush(&mut self) -> Result<Option<EncodedPacket>>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use airplay_core::SampleRate;
    use std::sync::Arc;

    mod mock_audio_source {
        use super::*;

        #[tokio::test]
        async fn mock_returns_configured_frames() {
            let mut mock = MockAudioSource::new();

            let format = AudioFormat {
                codec: AudioCodec::Alac,
                sample_rate: SampleRate::Hz44100,
                bit_depth: 16,
                channels: 2,
                frames_per_packet: 352,
            };
            let format_clone = format.clone();

            mock.expect_format()
                .return_const(format_clone);

            mock.expect_read_frame()
                .times(1)
                .returning(|| Box::pin(async {
                    Ok(Some(AudioFrame {
                        samples: Arc::new(vec![0i16; 704]),
                        timestamp: 0,
                    }))
                }));

            let frame = mock.read_frame().await.unwrap();
            assert!(frame.is_some());
            assert_eq!(frame.unwrap().samples.len(), 704);
        }

        #[tokio::test]
        async fn mock_returns_eof_after_frames() {
            let mut mock = MockAudioSource::new();

            mock.expect_read_frame()
                .times(1)
                .returning(|| Box::pin(async { Ok(None) }));

            mock.expect_is_eof()
                .return_const(true);

            let frame = mock.read_frame().await.unwrap();
            assert!(frame.is_none());
            assert!(mock.is_eof());
        }
    }

    mod mock_encoder {
        use super::*;

        #[test]
        fn mock_encodes_samples() {
            let mut mock = MockEncoderTrait::new();

            mock.expect_encode()
                .times(1)
                .returning(|samples| {
                    Ok(EncodedPacket {
                        data: vec![0u8; 100],
                        samples: (samples.len() / 2) as u32,
                        timestamp: 0,
                    })
                });

            let result = mock.encode(&[0i16; 704]);
            assert!(result.is_ok());
            let packet = result.unwrap();
            assert_eq!(packet.samples, 352);
        }

        #[test]
        fn mock_returns_configured_codec() {
            let mut mock = MockEncoderTrait::new();

            mock.expect_codec()
                .return_const(AudioCodec::Alac);

            assert_eq!(mock.codec(), AudioCodec::Alac);
        }
    }
}
