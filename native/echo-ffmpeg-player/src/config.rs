use crate::device::normalize_device_name;
use crate::events::SpectrumOptions;
use napi_derive::napi;

const DEFAULT_BUFFER_SECS: f64 = 2.0;
const DEFAULT_NETWORK_TIMEOUT_SECS: f64 = 60.0;

#[napi(object)]
pub struct PlayerConfigOptions {
    pub audio_buffer_secs: Option<f64>,
    pub network_timeout_secs: Option<f64>,
    pub http_proxy: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PlayerConfig {
    pub audio_buffer_secs: f64,
    pub network_timeout_secs: f64,
    pub http_proxy: Option<String>,
    pub audio_device: String,
    pub exclusive_output: bool,
}

impl Default for PlayerConfig {
    fn default() -> Self {
        Self {
            audio_buffer_secs: DEFAULT_BUFFER_SECS,
            network_timeout_secs: DEFAULT_NETWORK_TIMEOUT_SECS,
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
                config.audio_buffer_secs = value.clamp(0.2, 30.0);
            }
            if let Some(value) = options.network_timeout_secs {
                config.network_timeout_secs = value.clamp(1.0, 300.0);
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
