use napi_derive::napi;

pub const PROVIDER_SYSTEM_LOOPBACK: &str = "system-loopback";
pub const PROVIDER_UNAVAILABLE: &str = "unavailable";

pub const DEFAULT_FPS: u32 = 30;
pub const MAX_FPS: u32 = 60;
pub const DEFAULT_BIN_COUNT: u32 = 128;
pub const MAX_BIN_COUNT: u32 = 512;
pub const DEFAULT_FFT_SIZE: u32 = 2048;
pub const MIN_FFT_SIZE: u32 = 512;
pub const MAX_FFT_SIZE: u32 = 8192;
pub const DEFAULT_MIN_FREQUENCY: f64 = 20.0;
pub const DEFAULT_MAX_FREQUENCY: f64 = 20_000.0;

#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct SpectrumOptions {
    pub fps: Option<u32>,
    pub bin_count: Option<u32>,
    pub fft_size: Option<u32>,
    pub smoothing: Option<f64>,
    pub min_frequency: Option<f64>,
    pub max_frequency: Option<f64>,
    pub scale: Option<String>,
    pub include_waveform: Option<bool>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct SpectrumStatus {
    pub available: bool,
    pub running: bool,
    pub provider: String,
    pub reason: Option<String>,
    pub subscriber_count: Option<u32>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct SpectrumFrame {
    pub source: String,
    pub state: String,
    pub timestamp: f64,
    pub time_pos: Option<f64>,
    pub sample_rate: u32,
    pub fft_size: u32,
    pub min_frequency: f64,
    pub max_frequency: f64,
    pub bins: Vec<u32>,
    pub waveform: Option<Vec<f64>>,
    pub rms: f64,
    pub peak: f64,
}

#[derive(Clone, Copy, Debug)]
pub enum SpectrumScale {
    Linear,
    Log,
    Mel,
}

impl SpectrumScale {
    pub fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("log").to_ascii_lowercase().as_str() {
            "linear" => Self::Linear,
            "mel" => Self::Mel,
            _ => Self::Log,
        }
    }
}

#[derive(Clone, Debug)]
pub struct AnalyzerOptions {
    pub fps: u32,
    pub bin_count: usize,
    pub fft_size: usize,
    pub smoothing: f32,
    pub min_frequency: f32,
    pub max_frequency: f32,
    pub scale: SpectrumScale,
    pub include_waveform: bool,
}

impl AnalyzerOptions {
    pub fn from_napi(options: Option<SpectrumOptions>, sample_rate: u32) -> Self {
        let options = options.unwrap_or_default();
        let fps = clamp_u32(options.fps.unwrap_or(DEFAULT_FPS), 1, MAX_FPS);
        let bin_count = clamp_u32(
            options.bin_count.unwrap_or(DEFAULT_BIN_COUNT),
            8,
            MAX_BIN_COUNT,
        ) as usize;
        let fft_size = sanitize_fft_size(options.fft_size.unwrap_or(DEFAULT_FFT_SIZE)) as usize;
        let smoothing = options.smoothing.unwrap_or(0.65).clamp(0.0, 0.95) as f32;
        let nyquist = (sample_rate as f64 * 0.5).max(1.0);
        let min_frequency = options
            .min_frequency
            .unwrap_or(DEFAULT_MIN_FREQUENCY)
            .clamp(1.0, nyquist) as f32;
        let mut max_frequency = options
            .max_frequency
            .unwrap_or(DEFAULT_MAX_FREQUENCY)
            .clamp(min_frequency as f64 + 1.0, nyquist) as f32;
        if max_frequency <= min_frequency {
            max_frequency = (min_frequency + 1.0).min(nyquist as f32);
        }

        Self {
            fps,
            bin_count,
            fft_size,
            smoothing,
            min_frequency,
            max_frequency,
            scale: SpectrumScale::parse(options.scale.as_deref()),
            include_waveform: options.include_waveform.unwrap_or(false),
        }
    }
}

pub fn unavailable_status(reason: impl Into<String>) -> SpectrumStatus {
    SpectrumStatus {
        available: false,
        running: false,
        provider: PROVIDER_UNAVAILABLE.to_string(),
        reason: Some(reason.into()),
        subscriber_count: None,
    }
}

pub fn stopped_status() -> SpectrumStatus {
    SpectrumStatus {
        available: supported_on_current_platform(),
        running: false,
        provider: if supported_on_current_platform() {
            PROVIDER_SYSTEM_LOOPBACK
        } else {
            PROVIDER_UNAVAILABLE
        }
        .to_string(),
        reason: if supported_on_current_platform() {
            None
        } else {
            Some(platform_unsupported_reason())
        },
        subscriber_count: None,
    }
}

pub fn running_status() -> SpectrumStatus {
    SpectrumStatus {
        available: true,
        running: true,
        provider: PROVIDER_SYSTEM_LOOPBACK.to_string(),
        reason: None,
        subscriber_count: None,
    }
}

pub fn supported_on_current_platform() -> bool {
    cfg!(target_os = "windows") || cfg!(target_os = "linux") || cfg!(target_os = "macos")
}

pub fn platform_unsupported_reason() -> String {
    if cfg!(target_os = "macos") {
        "macOS ScreenCaptureKit system audio capture is unavailable".to_string()
    } else {
        "native system audio capture is not supported on this platform yet".to_string()
    }
}

fn clamp_u32(value: u32, min: u32, max: u32) -> u32 {
    value.max(min).min(max)
}

fn sanitize_fft_size(value: u32) -> u32 {
    let mut size = value.clamp(MIN_FFT_SIZE, MAX_FFT_SIZE).next_power_of_two();
    if size > MAX_FFT_SIZE {
        size = MAX_FFT_SIZE;
    }
    size
}
