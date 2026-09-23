//! Stream type and configuration for RTSP SETUP.

use crate::codec::AudioFormat;

/// RTP payload/stream type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamType {
    /// Real-time audio (payload type 96).
    Realtime = 96,
    /// Buffered audio for AirPlay 2 (payload type 103).
    Buffered = 103,
    /// Screen mirroring (payload type 110).
    Mirror = 110,
}

/// Timing protocol selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimingProtocol {
    /// Legacy NTP-like timing.
    Ntp,
    /// PTP (IEEE 1588) for AirPlay 2 multi-room.
    Ptp,
}

/// PTP clock role (only used when timing_protocol is Ptp).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtpMode {
    /// Sender acts as PTP master - sends Sync/Announce, receives Delay_Req.
    /// Use for third-party receivers (Shairport-sync, etc.)
    Master,
    /// Sender acts as PTP slave - receives Sync/Announce from receiver (HomePod), sends Delay_Req.
    /// Use for HomePod multi-room where HomePod is timing master.
    Slave,
}

/// Stream configuration for RTSP SETUP request.
#[derive(Debug, Clone)]
pub struct StreamConfig {
    pub stream_type: StreamType,
    pub audio_format: AudioFormat,
    pub timing_protocol: TimingProtocol,
    /// PTP clock role (only used when timing_protocol is Ptp)
    pub ptp_mode: PtpMode,
    pub latency_min: u32,
    pub latency_max: u32,
    pub supports_dynamic_stream_id: bool,
    /// Audio Stream Configuration (ASC) - codec-specific config blob.
    /// For AAC: 2-byte AudioSpecificConfig
    /// For ALAC: 24-byte magic cookie from encoder
    pub asc: Option<Vec<u8>>,
}

impl Default for StreamConfig {
    fn default() -> Self {
        Self {
            stream_type: StreamType::Realtime,
            audio_format: AudioFormat::default(),
            timing_protocol: TimingProtocol::Ntp,
            ptp_mode: PtpMode::Master, // Default to master for backward compatibility
            latency_min: 11025, // ~250ms at 44.1kHz
            latency_max: 88200, // ~2s at 44.1kHz
            supports_dynamic_stream_id: true,
            asc: None,
        }
    }
}

impl StreamConfig {
    /// Create config for AirPlay 2 buffered streaming with PTP timing.
    pub fn airplay2_buffered() -> Self {
        Self {
            stream_type: StreamType::Buffered,
            audio_format: AudioFormat::buffered_default(),
            timing_protocol: TimingProtocol::Ptp,
            ptp_mode: PtpMode::Master,
            latency_min: 22050,  // ~500ms
            latency_max: 132300, // ~3s
            supports_dynamic_stream_id: true,
            asc: None,
        }
    }

    /// Create config for AirPlay 2 buffered streaming with NTP timing.
    /// Use this if PTP timing is not working - we run an NTP server that the receiver syncs to.
    pub fn airplay2_buffered_ntp() -> Self {
        Self {
            stream_type: StreamType::Buffered,
            audio_format: AudioFormat::buffered_default(),
            timing_protocol: TimingProtocol::Ntp,
            ptp_mode: PtpMode::Master, // Doesn't matter for NTP, but set for consistency
            latency_min: 22050,  // ~500ms
            latency_max: 132300, // ~3s
            supports_dynamic_stream_id: true,
            asc: None,
        }
    }

    /// Create config for legacy AirPlay 1 streaming.
    pub fn airplay1_realtime() -> Self {
        Self::default()
    }

    /// Convert minimum latency from samples to milliseconds.
    ///
    /// latency_ms = latency_samples * 1000 / sample_rate
    pub fn latency_min_ms(&self) -> u32 {
        (self.latency_min as u64 * 1000 / self.audio_format.sample_rate.as_hz() as u64) as u32
    }

    /// Convert maximum latency from samples to milliseconds.
    ///
    /// latency_ms = latency_samples * 1000 / sample_rate
    pub fn latency_max_ms(&self) -> u32 {
        (self.latency_max as u64 * 1000 / self.audio_format.sample_rate.as_hz() as u64) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{AudioCodec, SampleRate};

    mod stream_type {
        use super::*;

        #[test]
        fn realtime_is_96() {
            assert_eq!(StreamType::Realtime as u8, 96);
        }

        #[test]
        fn buffered_is_103() {
            assert_eq!(StreamType::Buffered as u8, 103);
        }

        #[test]
        fn mirror_is_110() {
            assert_eq!(StreamType::Mirror as u8, 110);
        }
    }

    mod stream_config {
        use super::*;

        #[test]
        fn default_is_realtime_ntp() {
            let config = StreamConfig::default();
            assert_eq!(config.stream_type, StreamType::Realtime);
            assert_eq!(config.timing_protocol, TimingProtocol::Ntp);
        }

        #[test]
        fn airplay2_buffered_uses_ptp() {
            let config = StreamConfig::airplay2_buffered();
            assert_eq!(config.stream_type, StreamType::Buffered);
            assert_eq!(config.timing_protocol, TimingProtocol::Ptp);
        }

        #[test]
        fn airplay2_buffered_uses_aac() {
            let config = StreamConfig::airplay2_buffered();
            assert_eq!(config.audio_format.codec, AudioCodec::Aac);
        }

        #[test]
        fn latency_min_ms_calculation() {
            let config = StreamConfig::default();
            // Default: 11025 samples at 44100Hz = 250ms
            assert_eq!(config.latency_min_ms(), 250);
        }

        #[test]
        fn latency_max_ms_calculation() {
            let config = StreamConfig::default();
            // Default: 88200 samples at 44100Hz = 2000ms
            assert_eq!(config.latency_max_ms(), 2000);
        }

        #[test]
        fn latency_ms_varies_with_sample_rate() {
            // Same number of samples, different sample rate
            let config_44100 = StreamConfig {
                audio_format: AudioFormat {
                    sample_rate: SampleRate::Hz44100,
                    ..AudioFormat::default()
                },
                latency_min: 48000, // Use a round number
                latency_max: 96000,
                ..StreamConfig::default()
            };

            let config_48000 = StreamConfig {
                audio_format: AudioFormat {
                    sample_rate: SampleRate::Hz48000,
                    ..AudioFormat::default()
                },
                latency_min: 48000,
                latency_max: 96000,
                ..StreamConfig::default()
            };

            // 48000 samples at 44100Hz = ~1088ms
            // 48000 samples at 48000Hz = 1000ms
            assert_eq!(config_44100.latency_min_ms(), 1088);
            assert_eq!(config_48000.latency_min_ms(), 1000);

            // 96000 samples at 44100Hz = ~2176ms
            // 96000 samples at 48000Hz = 2000ms
            assert_eq!(config_44100.latency_max_ms(), 2176);
            assert_eq!(config_48000.latency_max_ms(), 2000);
        }
    }
}
