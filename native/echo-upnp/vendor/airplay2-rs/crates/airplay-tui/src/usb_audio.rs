//! USB audio capture using cpal.
//!
//! Enumerates input devices (e.g. Focusrite Scarlett 2i2) and captures audio
//! via cpal, sending PCM frames through a crossbeam channel for consumption
//! by the LiveAudioDecoder → AirPlay streaming pipeline.

use std::time::Duration;

use crossbeam_channel::{bounded, Receiver, TrySendError};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tracing::{error, info};

/// Suppress ALSA's internal error messages on Linux.
///
/// ALSA prints warnings to stderr when enumerating devices (e.g. for BlueALSA
/// PCMs that aren't available, dmix/dsnoop plugin mismatches). These corrupt
/// the TUI display. Installing a no-op error handler silences them.
#[cfg(target_os = "linux")]
fn suppress_alsa_errors() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // Non-variadic signature — safe to cast since the no-op body ignores all args.
        // The actual ALSA handler is variadic (printf-style), but at the ABI level the
        // fixed parameters use the same calling convention, and the callee simply
        // never reads the variadic portion.
        type AlsaErrorHandler = unsafe extern "C" fn(
            file: *const std::ffi::c_char,
            line: std::ffi::c_int,
            function: *const std::ffi::c_char,
            err: std::ffi::c_int,
            fmt: *const std::ffi::c_char,
        );

        unsafe extern "C" fn alsa_error_noop(
            _file: *const std::ffi::c_char,
            _line: std::ffi::c_int,
            _function: *const std::ffi::c_char,
            _err: std::ffi::c_int,
            _fmt: *const std::ffi::c_char,
        ) {
            // Intentionally empty — swallow all ALSA error output
        }

        extern "C" {
            fn snd_lib_error_set_handler(
                handler: Option<AlsaErrorHandler>,
            ) -> std::ffi::c_int;
        }
        // Safety: installing a no-op handler to silence ALSA stderr output
        unsafe { snd_lib_error_set_handler(Some(alsa_error_noop)); }
    });
}

#[cfg(not(target_os = "linux"))]
fn suppress_alsa_errors() {}

/// Information about an available USB/system audio input device.
#[derive(Debug, Clone)]
pub struct UsbAudioDevice {
    /// Human-readable device name.
    pub name: String,
    /// Index in cpal's device list (used to re-select).
    pub index: usize,
    /// Preferred sample rate (44100 if supported, else default).
    pub sample_rate: u32,
    /// Number of input channels.
    pub channels: u16,
}

/// A captured audio frame from cpal.
pub struct CapturedFrame {
    /// Interleaved i16 PCM samples.
    pub samples: Vec<i16>,
}

/// Receiver half of a USB audio capture — `Send` safe, can go to another thread.
pub struct CaptureReceiver {
    rx: Receiver<CapturedFrame>,
}

impl CaptureReceiver {
    /// Receive a captured frame, blocking up to the given timeout.
    pub fn recv_timeout(&self, timeout: Duration) -> Result<CapturedFrame, CaptureError> {
        self.rx
            .recv_timeout(timeout)
            .map_err(|e| match e {
                crossbeam_channel::RecvTimeoutError::Timeout => CaptureError::Timeout,
                crossbeam_channel::RecvTimeoutError::Disconnected => CaptureError::Disconnected,
            })
    }
}

/// The cpal stream handle — must stay on the thread that created it.
/// Drop this to stop the capture.
pub struct CaptureStream {
    _stream: cpal::Stream,
}

/// Errors from USB audio capture.
#[derive(Debug)]
pub enum CaptureError {
    /// No data available within timeout.
    Timeout,
    /// Channel disconnected (stream stopped).
    Disconnected,
    /// Failed to build or start the stream.
    Stream(String),
    /// Device not found.
    DeviceNotFound,
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CaptureError::Timeout => write!(f, "capture timeout"),
            CaptureError::Disconnected => write!(f, "capture stream disconnected"),
            CaptureError::Stream(e) => write!(f, "stream error: {}", e),
            CaptureError::DeviceNotFound => write!(f, "device not found"),
        }
    }
}

/// Read the long name for an ALSA card from /proc/asound/cards.
///
/// Given a short card name like "Gen", parses `/proc/asound/cards` which has
/// entries like:
/// ```text
///  1 [Gen            ]: USB-Audio - Scarlett 2i2 4th Gen
///                       Focusrite Scarlett 2i2 4th Gen at usb-..., high speed
/// ```
/// Returns the descriptive name after " - " (e.g. "Scarlett 2i2 4th Gen").
#[cfg(target_os = "linux")]
fn read_card_longname(short_name: &str) -> Option<String> {
    let cards = std::fs::read_to_string("/proc/asound/cards").ok()?;
    // Find the line containing [short_name ...]
    let bracket_pattern = format!("[{}", short_name);
    for line in cards.lines() {
        if line.contains(&bracket_pattern) {
            // Line format: " 1 [Gen            ]: USB-Audio - Scarlett 2i2 4th Gen"
            // Extract everything after " - "
            if let Some(pos) = line.find(" - ") {
                let name = line[pos + 3..].trim();
                if !name.is_empty() {
                    return Some(name.to_string());
                }
            }
        }
    }
    None
}

/// Extract a friendly card name from an ALSA device identifier.
///
/// ALSA names look like `plughw:CARD=Gen,DEV=0` or `default:CARD=Gen`.
/// First tries to read the full device name from /proc/asound (e.g.
/// "Focusrite Scarlett 2i2 USB"), falling back to the short card name.
#[cfg(target_os = "linux")]
fn friendly_device_name(alsa_name: &str) -> String {
    // Extract short card name from CARD=xxx
    let short_name = alsa_name
        .split("CARD=")
        .nth(1)
        .and_then(|s| s.split(',').next())
        .unwrap_or(alsa_name);

    // Try to get the long name from /proc/asound
    let display_name = read_card_longname(short_name)
        .unwrap_or_else(|| short_name.to_string());

    // Extract plugin prefix (hw, plughw, default, etc.)
    let prefix = alsa_name.split(':').next().unwrap_or("");

    match prefix {
        "hw" => format!("{} (hw, direct)", display_name),
        "plughw" => format!("{} (plughw, converted)", display_name),
        "default" => format!("{} (default)", display_name),
        "sysdefault" => format!("{} (sysdefault)", display_name),
        "dsnoop" => format!("{} (dsnoop, shared)", display_name),
        _ => alsa_name.to_string(),
    }
}

/// Check if an ALSA device name is a useful input device.
///
/// Filters out virtual/playback-only ALSA plugins like dmix, surround, front.
/// Keeps hw, plughw, default, sysdefault, and dsnoop.
#[cfg(target_os = "linux")]
fn is_useful_input_device(name: &str) -> bool {
    let prefix = name.split(':').next().unwrap_or("");
    matches!(prefix, "hw" | "plughw" | "default" | "sysdefault" | "dsnoop")
}

/// List all available audio input devices.
pub fn list_input_devices() -> Vec<UsbAudioDevice> {
    suppress_alsa_errors();

    let host = cpal::default_host();
    let mut devices = Vec::new();

    let input_devices = match host.input_devices() {
        Ok(d) => d,
        Err(e) => {
            error!("Failed to enumerate input devices: {}", e);
            return devices;
        }
    };

    for (index, device) in input_devices.enumerate() {
        let raw_name = device.name().unwrap_or_else(|_| format!("Device {}", index));

        // On Linux, filter out virtual/playback-only ALSA devices
        #[cfg(target_os = "linux")]
        if !is_useful_input_device(&raw_name) {
            continue;
        }

        // Clean up the display name
        #[cfg(target_os = "linux")]
        let name = friendly_device_name(&raw_name);
        #[cfg(not(target_os = "linux"))]
        let name = raw_name.clone();

        // Try to get supported configs to find sample rate and channels
        let (sample_rate, channels) = match device.supported_input_configs() {
            Ok(mut configs) => {
                // Look for a config supporting 44100 Hz (preferred for AirPlay)
                let mut best_rate = 0u32;
                let mut best_channels = 0u16;

                for config in configs.by_ref() {
                    let min = config.min_sample_rate().0;
                    let max = config.max_sample_rate().0;
                    let ch = config.channels();

                    if min <= 44100 && 44100 <= max {
                        best_rate = 44100;
                        best_channels = ch;
                        break;
                    }
                    if min <= 48000 && 48000 <= max && best_rate == 0 {
                        best_rate = 48000;
                        best_channels = ch;
                    }
                    if best_rate == 0 {
                        best_rate = min;
                        best_channels = ch;
                    }
                }

                if best_rate == 0 {
                    // Fallback to default config
                    match device.default_input_config() {
                        Ok(cfg) => (cfg.sample_rate().0, cfg.channels()),
                        Err(_) => continue,
                    }
                } else {
                    (best_rate, best_channels)
                }
            }
            Err(_) => {
                match device.default_input_config() {
                    Ok(cfg) => (cfg.sample_rate().0, cfg.channels()),
                    Err(_) => continue,
                }
            }
        };

        devices.push(UsbAudioDevice {
            name,
            index,
            sample_rate,
            channels,
        });
    }

    devices
}

/// Extract the first 2 channels from interleaved multi-channel i16 data.
/// If the source has <= 2 channels, returns data as-is.
fn extract_stereo_i16(data: &[i16], device_channels: u16) -> Vec<i16> {
    if device_channels <= 2 {
        return data.to_vec();
    }
    let ch = device_channels as usize;
    let frames = data.len() / ch;
    let mut stereo = Vec::with_capacity(frames * 2);
    for i in 0..frames {
        stereo.push(data[i * ch]);     // left
        stereo.push(data[i * ch + 1]); // right
    }
    stereo
}

/// Convert i32 samples to i16 and extract stereo.
/// i32 audio is full-range [-2147483648, 2147483647], shift down to i16.
fn convert_i32_to_stereo_i16(data: &[i32], device_channels: u16) -> Vec<i16> {
    if device_channels <= 2 {
        return data.iter().map(|&s| (s >> 16) as i16).collect();
    }
    let ch = device_channels as usize;
    let frames = data.len() / ch;
    let mut stereo = Vec::with_capacity(frames * 2);
    for i in 0..frames {
        stereo.push((data[i * ch] >> 16) as i16);
        stereo.push((data[i * ch + 1] >> 16) as i16);
    }
    stereo
}

/// Convert f32 samples to i16 and extract stereo.
fn convert_f32_to_stereo_i16(data: &[f32], device_channels: u16) -> Vec<i16> {
    if device_channels <= 2 {
        return data.iter().map(|&s| {
            (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
        }).collect();
    }
    let ch = device_channels as usize;
    let frames = data.len() / ch;
    let mut stereo = Vec::with_capacity(frames * 2);
    for i in 0..frames {
        stereo.push((data[i * ch].clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
        stereo.push((data[i * ch + 1].clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
    }
    stereo
}

/// Start capturing audio from the device at the given index.
///
/// Returns a `(CaptureReceiver, CaptureStream)`. The receiver produces stereo
/// i16 frames regardless of the device's native channel count. The stream handle
/// must stay on the creating thread (not `Send` on macOS).
///
/// The cpal callback extracts the first 2 channels if the device has more,
/// and pushes to a bounded channel — frames are dropped if the consumer is slow.
pub fn start_usb_capture(device_index: usize, preferred_rate: u32, device_channels: u16) -> Result<(CaptureReceiver, CaptureStream), CaptureError> {
    suppress_alsa_errors();
    let host = cpal::default_host();
    let input_devices: Vec<_> = host.input_devices()
        .map_err(|e| CaptureError::Stream(format!("enumerate: {}", e)))?
        .collect();

    let device = input_devices
        .into_iter()
        .nth(device_index)
        .ok_or(CaptureError::DeviceNotFound)?;

    let device_name = device.name().unwrap_or_else(|_| "unknown".into());
    info!("Opening USB audio device: {} (rate={}, device_ch={}, output=stereo)",
          device_name, preferred_rate, device_channels);

    // Open with the device's native channel count — cpal requires this to match
    let config = cpal::StreamConfig {
        channels: device_channels,
        sample_rate: cpal::SampleRate(preferred_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    // Bounded channel — drop frames if consumer is slow
    let (tx, rx) = bounded::<CapturedFrame>(128);

    // Determine sample format from default config
    let default_config = device.default_input_config()
        .map_err(|e| CaptureError::Stream(format!("default config: {}", e)))?;

    let stream = match default_config.sample_format() {
        cpal::SampleFormat::I16 => {
            let tx = tx.clone();
            let ch = device_channels;
            device.build_input_stream(
                &config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    let frame = CapturedFrame {
                        samples: extract_stereo_i16(data, ch),
                    };
                    if let Err(TrySendError::Disconnected(_)) = tx.try_send(frame) {}
                },
                move |err| {
                    error!("USB audio stream error: {}", err);
                },
                None,
            )
        }
        cpal::SampleFormat::F32 => {
            let tx = tx.clone();
            let ch = device_channels;
            device.build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let frame = CapturedFrame {
                        samples: convert_f32_to_stereo_i16(data, ch),
                    };
                    if let Err(TrySendError::Disconnected(_)) = tx.try_send(frame) {}
                },
                move |err| {
                    error!("USB audio stream error: {}", err);
                },
                None,
            )
        }
        cpal::SampleFormat::I32 => {
            let tx = tx.clone();
            let ch = device_channels;
            device.build_input_stream(
                &config,
                move |data: &[i32], _: &cpal::InputCallbackInfo| {
                    let frame = CapturedFrame {
                        samples: convert_i32_to_stereo_i16(data, ch),
                    };
                    if let Err(TrySendError::Disconnected(_)) = tx.try_send(frame) {}
                },
                move |err| {
                    error!("USB audio stream error: {}", err);
                },
                None,
            )
        }
        cpal::SampleFormat::U16 => {
            let tx = tx.clone();
            let ch = device_channels;
            device.build_input_stream(
                &config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    // Convert u16 to i16, then extract stereo
                    let all_i16: Vec<i16> = data.iter().map(|&s| {
                        (s as i32 - 32768) as i16
                    }).collect();
                    let frame = CapturedFrame {
                        samples: extract_stereo_i16(&all_i16, ch),
                    };
                    if let Err(TrySendError::Disconnected(_)) = tx.try_send(frame) {}
                },
                move |err| {
                    error!("USB audio stream error: {}", err);
                },
                None,
            )
        }
        fmt => {
            return Err(CaptureError::Stream(format!("unsupported sample format: {:?}", fmt)));
        }
    }.map_err(|e| CaptureError::Stream(format!("build stream: {}", e)))?;

    stream.play().map_err(|e| CaptureError::Stream(format!("play: {}", e)))?;
    info!("USB audio capture started on {}", device_name);

    Ok((CaptureReceiver { rx }, CaptureStream { _stream: stream }))
}

/// Compute RMS level of i16 samples (0.0 to 1.0).
pub fn calculate_rms(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
    let rms = (sum / samples.len() as f64).sqrt();
    (rms / i16::MAX as f64) as f32
}
