use crate::device::normalize_device_name;
use crate::events::SpectrumOptions;
use crate::stream::{self, StreamOptions};
use ffmpeg_audio::PacketCacheOptions;
use napi_derive::napi;
use std::time::Duration;

const DEFAULT_BUFFER_SECS: f64 = 0.2;
const MAX_BUFFER_SECS: f64 = 10.0;
const DEFAULT_DEMUXER_READAHEAD_SECS: f64 = 1.0;
const DEFAULT_CACHE_SECS: f64 = 3_600_000.0;
const MAX_CACHE_SECS: f64 = 3_600_000.0;
const DEFAULT_CACHE_PAUSE: bool = true;
const DEFAULT_CACHE_PAUSE_WAIT_SECS: f64 = 1.0;
const DEFAULT_DEMUXER_MAX_BYTES: usize = 150 * 1024 * 1024;
const DEFAULT_DEMUXER_MAX_BACK_BYTES: usize = 50 * 1024 * 1024;
const MAX_DEMUXER_BYTES: usize = 4 * 1024 * 1024 * 1024;
const DEFAULT_NETWORK_TIMEOUT_SECS: f64 = 60.0;
const DEFAULT_PLAYBACK_STALL_TIMEOUT_SECS: f64 = 8.0;

#[napi(object)]
pub struct PlayerConfigOptions {
    pub audio_buffer_secs: Option<f64>,
    pub demuxer_readahead_secs: Option<f64>,
    pub cache: Option<String>,
    pub cache_secs: Option<f64>,
    pub cache_pause: Option<bool>,
    pub cache_pause_wait_secs: Option<f64>,
    pub demuxer_max_bytes: Option<f64>,
    pub demuxer_max_back_bytes: Option<f64>,
    pub network_timeout_secs: Option<f64>,
    pub playback_stall_timeout_secs: Option<f64>,
    pub http_proxy: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CacheMode {
    Auto,
    Yes,
    No,
}

impl CacheMode {
    fn from_option(value: Option<String>) -> Self {
        match value.as_deref().map(str::trim).map(str::to_ascii_lowercase) {
            Some(value) if value == "yes" || value == "true" || value == "1" => Self::Yes,
            Some(value) if value == "no" || value == "false" || value == "0" => Self::No,
            _ => Self::Auto,
        }
    }
}

#[derive(Clone, Debug)]
pub struct PlayerConfig {
    pub audio_buffer_secs: f64,
    pub demuxer_readahead_secs: f64,
    pub cache: CacheMode,
    pub cache_secs: f64,
    pub cache_pause: bool,
    pub cache_pause_wait_secs: f64,
    pub demuxer_max_bytes: usize,
    pub demuxer_max_back_bytes: usize,
    pub network_timeout_secs: f64,
    pub playback_stall_timeout_secs: f64,
    pub http_proxy: Option<String>,
    pub audio_device: String,
    pub exclusive_output: bool,
}

impl Default for PlayerConfig {
    fn default() -> Self {
        Self {
            audio_buffer_secs: DEFAULT_BUFFER_SECS,
            demuxer_readahead_secs: DEFAULT_DEMUXER_READAHEAD_SECS,
            cache: CacheMode::Auto,
            cache_secs: DEFAULT_CACHE_SECS,
            cache_pause: DEFAULT_CACHE_PAUSE,
            cache_pause_wait_secs: DEFAULT_CACHE_PAUSE_WAIT_SECS,
            demuxer_max_bytes: DEFAULT_DEMUXER_MAX_BYTES,
            demuxer_max_back_bytes: DEFAULT_DEMUXER_MAX_BACK_BYTES,
            network_timeout_secs: DEFAULT_NETWORK_TIMEOUT_SECS,
            playback_stall_timeout_secs: DEFAULT_PLAYBACK_STALL_TIMEOUT_SECS,
            http_proxy: None,
            audio_device: "auto".to_string(),
            exclusive_output: false,
        }
    }
}

impl PlayerConfig {
    pub fn from_options(options: Option<PlayerConfigOptions>) -> Self {
        let mut config = Self::default();
        if let Some(options) = options {
            if let Some(value) = options.audio_buffer_secs {
                config.audio_buffer_secs = value.clamp(0.0, MAX_BUFFER_SECS);
            }
            if let Some(value) = options.demuxer_readahead_secs {
                config.demuxer_readahead_secs = value.clamp(0.0, MAX_CACHE_SECS);
            }
            config.cache = CacheMode::from_option(options.cache);
            if let Some(value) = options.cache_secs {
                config.cache_secs = value.clamp(0.0, MAX_CACHE_SECS);
            }
            if let Some(value) = options.cache_pause {
                config.cache_pause = value;
            }
            if let Some(value) = options.cache_pause_wait_secs {
                config.cache_pause_wait_secs = value.clamp(0.0, MAX_CACHE_SECS);
            }
            if let Some(value) = options.demuxer_max_bytes {
                config.demuxer_max_bytes = bytes_from_number(value);
            }
            if let Some(value) = options.demuxer_max_back_bytes {
                config.demuxer_max_back_bytes = bytes_from_number(value);
            }
            if let Some(value) = options.network_timeout_secs {
                config.network_timeout_secs = value.clamp(1.0, 300.0);
            }
            if let Some(value) = options.playback_stall_timeout_secs {
                config.playback_stall_timeout_secs = if value <= 0.0 {
                    0.0
                } else {
                    value.clamp(1.0, 60.0)
                };
            }
            if let Some(value) = options.http_proxy {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    config.http_proxy = Some(trimmed.to_string());
                }
            }
        }
        config
    }

    pub fn set_audio_device(&mut self, value: &str) {
        self.audio_device = normalize_device_name(value);
    }

    pub fn packet_cache_options(&self) -> PacketCacheOptions {
        self.packet_cache_options_for_duration(self.demuxer_readahead_secs, false)
    }

    pub fn packet_cache_options_for_url(&self, url: &str) -> PacketCacheOptions {
        let cache_enabled = self.cache_enabled_for_url(url);
        self.packet_cache_options_for_duration(self.readahead_secs_for_url(url), cache_enabled)
    }

    pub fn cache_pause_for_url(&self, url: &str) -> bool {
        self.cache_pause && self.cache_enabled_for_url(url)
    }

    fn readahead_secs_for_url(&self, url: &str) -> f64 {
        if self.cache_enabled_for_url(url) {
            self.cache_secs.max(self.demuxer_readahead_secs)
        } else {
            self.demuxer_readahead_secs
        }
    }

    fn cache_enabled_for_url(&self, url: &str) -> bool {
        match self.cache {
            CacheMode::Auto => stream::is_network_url(url),
            CacheMode::Yes => true,
            CacheMode::No => false,
        }
    }

    fn packet_cache_options_for_duration(
        &self,
        cache_secs: f64,
        cache_enabled: bool,
    ) -> PacketCacheOptions {
        let max_back_bytes = if cache_enabled {
            self.demuxer_max_back_bytes
        } else {
            0
        };
        PacketCacheOptions::new(
            self.demuxer_max_bytes,
            max_back_bytes,
            Duration::from_secs_f64(cache_secs.max(0.0)),
        )
        .with_donate_forward_budget(cache_enabled)
    }

    pub fn stream_options(&self) -> StreamOptions {
        StreamOptions {
            network_timeout: Duration::from_secs_f64(self.network_timeout_secs.max(1.0)),
            http_proxy: self.http_proxy.clone(),
        }
    }
}

fn bytes_from_number(value: f64) -> usize {
    if !value.is_finite() {
        return DEFAULT_DEMUXER_MAX_BYTES;
    }
    value.round().clamp(0.0, MAX_DEMUXER_BYTES as f64) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_config_defaults_follow_mpv_cache_shape() {
        let config = PlayerConfig::default();
        let packet_cache = config.packet_cache_options();

        assert_eq!(config.audio_buffer_secs, 0.2);
        assert_eq!(config.demuxer_readahead_secs, 1.0);
        assert_eq!(config.cache, CacheMode::Auto);
        assert_eq!(config.cache_secs, 3_600_000.0);
        assert!(config.cache_pause);
        assert_eq!(config.cache_pause_wait_secs, 1.0);
        assert_eq!(config.demuxer_max_bytes, 150 * 1024 * 1024);
        assert_eq!(config.demuxer_max_back_bytes, 50 * 1024 * 1024);
        assert_eq!(packet_cache.max_bytes, 150 * 1024 * 1024);
        assert_eq!(packet_cache.max_back_bytes, 0);
        assert_eq!(packet_cache.max_duration, Duration::from_secs(1));
        assert!(!packet_cache.donate_forward_budget);
        assert_eq!(
            config.stream_options().network_timeout,
            Duration::from_secs(60)
        );
    }

    #[test]
    fn player_config_uses_larger_packet_cache_for_network_sources() {
        let config = PlayerConfig::default();

        assert_eq!(
            config
                .packet_cache_options_for_url("file:///tmp/music.flac")
                .max_duration,
            Duration::from_secs(1),
        );
        assert_eq!(
            config
                .packet_cache_options_for_url("file:///tmp/music.flac")
                .max_back_bytes,
            0,
        );
        assert!(
            !config
                .packet_cache_options_for_url("file:///tmp/music.flac")
                .donate_forward_budget
        );
        assert_eq!(
            config
                .packet_cache_options_for_url("https://example.test/music.flac")
                .max_duration,
            Duration::from_secs(3_600_000),
        );
        assert_eq!(
            config
                .packet_cache_options_for_url("https://example.test/music.flac")
                .max_back_bytes,
            50 * 1024 * 1024,
        );
        assert!(
            config
                .packet_cache_options_for_url("https://example.test/music.flac")
                .donate_forward_budget
        );

        let disabled = PlayerConfig::from_options(Some(PlayerConfigOptions {
            audio_buffer_secs: None,
            demuxer_readahead_secs: None,
            cache: Some("no".to_string()),
            cache_secs: None,
            cache_pause: None,
            cache_pause_wait_secs: None,
            demuxer_max_bytes: None,
            demuxer_max_back_bytes: None,
            network_timeout_secs: None,
            playback_stall_timeout_secs: None,
            http_proxy: None,
        }));

        assert_eq!(
            disabled
                .packet_cache_options_for_url("https://example.test/music.flac")
                .max_duration,
            Duration::from_secs(1),
        );
        assert_eq!(
            disabled
                .packet_cache_options_for_url("https://example.test/music.flac")
                .max_back_bytes,
            0,
        );
        assert!(!disabled.cache_pause_for_url("https://example.test/music.flac"));
    }

    #[test]
    fn player_config_cache_yes_applies_cache_secs_to_local_sources() {
        let config = PlayerConfig::from_options(Some(PlayerConfigOptions {
            audio_buffer_secs: None,
            demuxer_readahead_secs: Some(2.0),
            cache: Some("yes".to_string()),
            cache_secs: Some(30.0),
            cache_pause: None,
            cache_pause_wait_secs: None,
            demuxer_max_bytes: None,
            demuxer_max_back_bytes: None,
            network_timeout_secs: None,
            playback_stall_timeout_secs: None,
            http_proxy: None,
        }));

        assert_eq!(
            config
                .packet_cache_options_for_url("file:///tmp/music.flac")
                .max_duration,
            Duration::from_secs(30),
        );
        assert_eq!(
            config
                .packet_cache_options_for_url("file:///tmp/music.flac")
                .max_back_bytes,
            50 * 1024 * 1024,
        );
        assert!(
            config
                .packet_cache_options_for_url("file:///tmp/music.flac")
                .donate_forward_budget
        );
        assert!(config.cache_pause_for_url("file:///tmp/music.flac"));
    }

    #[test]
    fn player_config_accepts_small_output_buffer_and_short_readahead() {
        let config = PlayerConfig::from_options(Some(PlayerConfigOptions {
            audio_buffer_secs: Some(0.01),
            demuxer_readahead_secs: Some(0.1),
            cache: Some("auto".to_string()),
            cache_secs: Some(0.1),
            cache_pause: Some(false),
            cache_pause_wait_secs: Some(0.01),
            demuxer_max_bytes: Some(2.0),
            demuxer_max_back_bytes: Some(999.0),
            network_timeout_secs: None,
            playback_stall_timeout_secs: None,
            http_proxy: None,
        }));

        assert_eq!(config.audio_buffer_secs, 0.01);
        assert_eq!(config.demuxer_readahead_secs, 0.1);
        assert_eq!(config.cache_secs, 0.1);
        assert!(!config.cache_pause);
        assert_eq!(config.cache_pause_wait_secs, 0.01);
        assert_eq!(config.demuxer_max_bytes, 2);
        assert_eq!(config.demuxer_max_back_bytes, 999);
        assert_eq!(config.packet_cache_options().max_back_bytes, 0);
    }

    #[test]
    fn player_config_allows_zero_readahead_like_mpv() {
        let config = PlayerConfig::from_options(Some(PlayerConfigOptions {
            audio_buffer_secs: Some(0.0),
            demuxer_readahead_secs: Some(0.0),
            cache: Some("no".to_string()),
            cache_secs: Some(0.0),
            cache_pause: Some(false),
            cache_pause_wait_secs: Some(0.0),
            demuxer_max_bytes: None,
            demuxer_max_back_bytes: None,
            network_timeout_secs: None,
            playback_stall_timeout_secs: None,
            http_proxy: None,
        }));

        assert_eq!(config.audio_buffer_secs, 0.0);
        assert_eq!(config.packet_cache_options().max_duration, Duration::ZERO);
        assert_eq!(
            config
                .packet_cache_options_for_url("https://example.test/music.flac")
                .max_duration,
            Duration::ZERO,
        );
    }

    #[test]
    fn player_config_allows_larger_output_buffer_for_high_latency_devices() {
        let config = PlayerConfig::from_options(Some(PlayerConfigOptions {
            audio_buffer_secs: Some(3.0),
            demuxer_readahead_secs: None,
            cache: None,
            cache_secs: None,
            cache_pause: None,
            cache_pause_wait_secs: None,
            demuxer_max_bytes: None,
            demuxer_max_back_bytes: None,
            network_timeout_secs: None,
            playback_stall_timeout_secs: None,
            http_proxy: None,
        }));

        assert_eq!(config.audio_buffer_secs, 3.0);

        let clamped = PlayerConfig::from_options(Some(PlayerConfigOptions {
            audio_buffer_secs: Some(30.0),
            demuxer_readahead_secs: None,
            cache: None,
            cache_secs: None,
            cache_pause: None,
            cache_pause_wait_secs: None,
            demuxer_max_bytes: None,
            demuxer_max_back_bytes: None,
            network_timeout_secs: None,
            playback_stall_timeout_secs: None,
            http_proxy: None,
        }));

        assert_eq!(clamped.audio_buffer_secs, MAX_BUFFER_SECS);
    }
}

#[derive(Clone, Debug)]
pub struct SpectrumConfig {
    pub bands: usize,
    pub fps: u32,
    pub min_frequency: f64,
    pub max_frequency: f64,
    pub smoothing: f64,
}

impl Default for SpectrumConfig {
    fn default() -> Self {
        Self {
            bands: 64,
            fps: 30,
            min_frequency: 40.0,
            max_frequency: 16_000.0,
            smoothing: 0.6,
        }
    }
}

impl SpectrumConfig {
    pub fn from_options(options: Option<SpectrumOptions>) -> Self {
        let mut config = Self::default();
        if let Some(options) = options {
            if let Some(value) = options.bands {
                config.bands = (value as usize).clamp(8, 256);
            }
            if let Some(value) = options.fps {
                config.fps = value.clamp(1, 120);
            }
            if let Some(value) = options.min_frequency {
                config.min_frequency = value.clamp(1.0, 20_000.0);
            }
            if let Some(value) = options.max_frequency {
                config.max_frequency = value.clamp(config.min_frequency + 1.0, 24_000.0);
            }
            if let Some(value) = options.smoothing {
                config.smoothing = value.clamp(0.0, 0.98);
            }
        }
        config
    }
}
