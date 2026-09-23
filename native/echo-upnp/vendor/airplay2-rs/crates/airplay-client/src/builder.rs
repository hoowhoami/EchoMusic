//! Client builder for configuration.

use airplay_core::{StreamConfig, AudioFormat};
use crate::{AirPlayClient, EventHandler, Result};

/// Builder for configuring AirPlayClient.
pub struct ClientBuilder {
    stream_config: StreamConfig,
    event_handler: Option<Box<dyn EventHandler>>,
    auto_reconnect: bool,
    buffer_duration_ms: u32,
    /// Render delay in ms for retransmit headroom.
    render_delay_ms: u32,
}

impl ClientBuilder {
    /// Create new builder with defaults.
    pub fn new() -> Self {
        Self {
            stream_config: StreamConfig::default(),
            event_handler: None,
            auto_reconnect: false,
            buffer_duration_ms: 2000,
            render_delay_ms: 200, // 200ms default for reliable playback over WiFi
        }
    }

    /// Set stream configuration.
    pub fn stream_config(mut self, config: StreamConfig) -> Self {
        self.stream_config = config;
        self
    }

    /// Set audio format.
    pub fn audio_format(mut self, format: AudioFormat) -> Self {
        self.stream_config.audio_format = format;
        self
    }

    /// Use AirPlay 2 with NTP realtime streaming.
    ///
    /// Note: Uses realtime mode with NTP timing which is reliable.
    /// Buffered mode and PTP timing are currently not working with HomePod devices.
    pub fn airplay2(mut self) -> Self {
        self.stream_config = StreamConfig::airplay1_realtime();
        self
    }

    /// Use AirPlay 1 realtime streaming.
    pub fn airplay1(mut self) -> Self {
        self.stream_config = StreamConfig::airplay1_realtime();
        self
    }

    /// Set event handler.
    pub fn event_handler(mut self, handler: impl EventHandler + 'static) -> Self {
        self.event_handler = Some(Box::new(handler));
        self
    }

    /// Enable auto-reconnect on disconnect.
    pub fn auto_reconnect(mut self, enabled: bool) -> Self {
        self.auto_reconnect = enabled;
        self
    }

    /// Set audio buffer duration in milliseconds.
    pub fn buffer_duration_ms(mut self, ms: u32) -> Self {
        self.buffer_duration_ms = ms;
        self
    }

    /// Set render delay in milliseconds.
    ///
    /// Shifts NTP timestamps in sync packets into the future, telling the
    /// receiver to buffer audio longer before rendering. This gives more
    /// headroom for retransmit recovery of lost packets over lossy WiFi.
    ///
    /// Default is 200ms. Typical values: 100-500ms.
    pub fn render_delay_ms(mut self, ms: u32) -> Self {
        self.render_delay_ms = ms;
        self
    }

    /// Build the client.
    pub fn build(self) -> Result<AirPlayClient> {
        let mut client = AirPlayClient::with_config(self.stream_config, self.event_handler)?;
        client.set_render_delay_ms(self.render_delay_ms);
        Ok(client)
    }
}

impl Default for ClientBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use airplay_core::{StreamType, stream::TimingProtocol};

    mod builder {
        use super::*;

        #[test]
        fn new_has_defaults() {
            let builder = ClientBuilder::new();
            assert_eq!(builder.stream_config.stream_type, StreamType::Realtime);
            assert!(!builder.auto_reconnect);
            assert_eq!(builder.buffer_duration_ms, 2000);
        }

        #[test]
        fn stream_config_sets_config() {
            let config = StreamConfig::airplay2_buffered();
            let builder = ClientBuilder::new().stream_config(config.clone());
            assert_eq!(builder.stream_config.stream_type, StreamType::Buffered);
        }

        #[test]
        fn airplay2_sets_realtime_ntp_config() {
            let builder = ClientBuilder::new().airplay2();
            assert_eq!(builder.stream_config.stream_type, StreamType::Realtime);
            assert_eq!(builder.stream_config.timing_protocol, TimingProtocol::Ntp);
        }

        #[test]
        fn airplay1_sets_realtime_config() {
            let builder = ClientBuilder::new().airplay1();
            assert_eq!(builder.stream_config.stream_type, StreamType::Realtime);
            assert_eq!(builder.stream_config.timing_protocol, TimingProtocol::Ntp);
        }

        #[test]
        fn auto_reconnect_sets_flag() {
            let builder = ClientBuilder::new().auto_reconnect(true);
            assert!(builder.auto_reconnect);
        }

        #[test]
        fn buffer_duration_sets_value() {
            let builder = ClientBuilder::new().buffer_duration_ms(5000);
            assert_eq!(builder.buffer_duration_ms, 5000);
        }

        #[test]
        fn build_creates_client() {
            // Note: This test may fail if mDNS daemon isn't available
            if let Ok(client) = ClientBuilder::new().build() {
                assert!(!client.is_connected());
            }
        }
    }
}
