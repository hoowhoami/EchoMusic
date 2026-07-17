use crate::events::AudioDevice;
#[cfg(target_os = "linux")]
use crate::shared::TARGET_CHANNELS;
use cpal::traits::{DeviceTrait, HostTrait};
use cpal::SampleFormat;
#[cfg(target_os = "linux")]
use cpal::{Stream, StreamConfig};
use std::collections::HashMap;

const FALLBACK_SAMPLE_RATE: u32 = 48_000;
pub(crate) const DEVICE_KEY_SEPARATOR: &str = "\u{1f}";
pub const DEFAULT_DEVICE_NAME: &str = "auto";
pub const LEGACY_DEFAULT_DEVICE_NAME: &str = "default";

pub fn list_output_devices() -> Vec<AudioDevice> {
    #[cfg(target_os = "macos")]
    if let Some(devices) = crate::device::platform_macos::list_output_devices() {
        return with_default_device(devices);
    }
    #[cfg(target_os = "windows")]
    if let Some(devices) = crate::device::platform_windows::list_output_devices() {
        return with_default_device(devices);
    }
    #[cfg(target_os = "linux")]
    if let Some(devices) = crate::device::platform_linux::list_output_devices() {
        return with_default_device(devices);
    }

    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|device| device.name().ok());
    let names = output_device_names(&host);
    let mut counts = HashMap::<String, usize>::new();
    for name in &names {
        *counts.entry(name.clone()).or_insert(0) += 1;
    }

    let mut occurrences = HashMap::<String, usize>::new();
    let devices = names
        .into_iter()
        .map(|raw_name| {
            let occurrence = occurrences.entry(raw_name.clone()).or_insert(0);
            let duplicate_count = counts.get(&raw_name).copied().unwrap_or(1);
            let key = device_key(&raw_name, *occurrence);
            let display_name = if duplicate_count > 1 {
                format!("{} #{}", raw_name, *occurrence + 1)
            } else {
                raw_name.clone()
            };
            *occurrence += 1;

            let description = if duplicate_count == 1 && default_name.as_ref() == Some(&raw_name) {
                format!("{display_name} (默认)")
            } else {
                display_name
            };
            AudioDevice {
                name: key,
                description,
            }
        })
        .collect();
    with_default_device(devices)
}

pub fn resolve_output_sample_rate(device_name: &str, exclusive: bool) -> u32 {
    #[cfg(target_os = "windows")]
    if exclusive {
        return crate::device::platform_windows::resolve_wasapi_output_sample_rate(device_name);
    }

    let Ok(device) = select_output_device_checked(device_name, exclusive) else {
        return FALLBACK_SAMPLE_RATE;
    };
    device
        .default_output_config()
        .ok()
        .map(|config| config.sample_rate().0)
        .unwrap_or(FALLBACK_SAMPLE_RATE)
}

pub fn validate_output_device(device_name: &str, exclusive: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    if exclusive {
        return crate::device::platform_windows::validate_wasapi_output_device(device_name);
    }

    let device = select_output_device_checked(device_name, exclusive)?;
    let config = device
        .default_output_config()
        .map_err(|err| format!("failed to read output config for '{device_name}': {err}"))?;
    validate_platform_exclusive_open(
        &device,
        exclusive,
        config.sample_format(),
        config.sample_rate().0,
    )
}

pub fn select_output_device_checked(name: &str, exclusive: bool) -> Result<cpal::Device, String> {
    let host = output_host(name, exclusive)?;
    select_output_device(&host, name, exclusive)
        .ok_or_else(|| output_device_not_found_message(name, exclusive))
}

#[cfg(target_os = "linux")]
fn output_host(name: &str, exclusive: bool) -> Result<cpal::Host, String> {
    if exclusive || crate::device::platform_linux::is_alsa_hardware_pcm(name) {
        cpal::host_from_id(cpal::HostId::Alsa)
            .map_err(|err| format!("ALSA output host unavailable: {err}"))
    } else {
        Ok(cpal::default_host())
    }
}

#[cfg(not(target_os = "linux"))]
fn output_host(_name: &str, _exclusive: bool) -> Result<cpal::Host, String> {
    Ok(cpal::default_host())
}

fn select_output_device(host: &cpal::Host, name: &str, _exclusive: bool) -> Option<cpal::Device> {
    #[cfg(target_os = "linux")]
    if _exclusive || crate::device::platform_linux::is_alsa_hardware_pcm(name) {
        return select_alsa_exclusive_output_device(host, name);
    }
    if is_default_device_name(name) {
        return host.default_output_device();
    }
    #[cfg(target_os = "macos")]
    if crate::device::platform_macos::is_coreaudio_device_key(name) {
        let resolved_name = crate::device::platform_macos::resolve_coreaudio_device_name(name)?;
        let selector = DeviceKey {
            raw_name: resolved_name,
            occurrence: 0,
        };
        return select_named_output_device(host, &selector);
    }
    #[cfg(target_os = "windows")]
    if crate::device::platform_windows::is_wasapi_device_key(name) {
        let resolved_name = crate::device::platform_windows::resolve_wasapi_device_name(name)?;
        let selector = DeviceKey {
            raw_name: resolved_name,
            occurrence: 0,
        };
        return select_named_output_device(host, &selector);
    }
    let selector = parse_device_key(name);
    select_named_output_device(host, &selector)
}

#[cfg(target_os = "linux")]
fn select_alsa_exclusive_output_device(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
    let wants_default = is_default_device_name(name);
    let selector = parse_device_key(name);
    let mut occurrence = 0usize;
    host.output_devices().ok()?.find(|device| {
        let Ok(device_name) = device.name() else {
            return false;
        };
        if !crate::device::platform_linux::is_alsa_hardware_pcm(&device_name) {
            return false;
        }
        if wants_default {
            return device.default_output_config().is_ok();
        }
        if !device_name_matches_key(&device_name, &selector) {
            return false;
        }
        let matched = occurrence == selector.occurrence && device.default_output_config().is_ok();
        occurrence += 1;
        matched
    })
}

fn output_device_not_found_message(name: &str, _exclusive: bool) -> String {
    #[cfg(target_os = "linux")]
    if _exclusive {
        let target = if is_default_device_name(name) {
            "default ALSA hardware output".to_string()
        } else {
            format!("ALSA hardware output '{name}'")
        };
        return format!("{target} is not available; choose a hw:/plughw: output device");
    }

    if is_default_device_name(name) {
        "no audio output device available".to_string()
    } else {
        format!("audio output device not found: {name}")
    }
}

pub fn is_default_device_name(name: &str) -> bool {
    let name = name.trim();
    name.is_empty() || name == DEFAULT_DEVICE_NAME || name == LEGACY_DEFAULT_DEVICE_NAME
}

pub fn normalize_device_name(name: &str) -> String {
    if is_default_device_name(name) {
        DEFAULT_DEVICE_NAME.to_string()
    } else {
        name.to_string()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DeviceKey {
    pub raw_name: String,
    pub occurrence: usize,
}

pub(crate) fn parse_device_key(value: &str) -> DeviceKey {
    if let Some((raw_name, suffix)) = value.rsplit_once(DEVICE_KEY_SEPARATOR) {
        if !raw_name.is_empty() {
            if let Ok(occurrence) = suffix.parse::<usize>() {
                return DeviceKey {
                    raw_name: raw_name.to_string(),
                    occurrence,
                };
            }
        }
    }
    DeviceKey {
        raw_name: value.to_string(),
        occurrence: 0,
    }
}

pub(crate) fn select_named_output_device(
    host: &cpal::Host,
    selector: &DeviceKey,
) -> Option<cpal::Device> {
    let mut occurrence = 0usize;
    host.output_devices().ok()?.find(|device| {
        let Ok(device_name) = device.name() else {
            return false;
        };
        if !device_name_matches_key(&device_name, selector) {
            return false;
        }
        let matched = occurrence == selector.occurrence;
        occurrence += 1;
        matched
    })
}

pub(crate) fn device_name_matches_key(device_name: &str, selector: &DeviceKey) -> bool {
    device_name == selector.raw_name
}

fn output_device_names(host: &cpal::Host) -> Vec<String> {
    host.output_devices()
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|device| device.name().ok())
        .filter(|name| !is_hidden_output_device_name(name))
        .collect()
}

fn is_hidden_output_device_name(name: &str) -> bool {
    let normalized = name.trim().to_ascii_lowercase();
    normalized.is_empty() || normalized == "system default" || normalized == "default"
}

fn device_key(raw_name: &str, occurrence: usize) -> String {
    if occurrence == 0 {
        raw_name.to_string()
    } else {
        format!("{raw_name}{DEVICE_KEY_SEPARATOR}{occurrence}")
    }
}

fn with_default_device(mut devices: Vec<AudioDevice>) -> Vec<AudioDevice> {
    devices.retain(|device| !is_default_device_name(&device.name) && device.name != "null");
    devices.insert(
        0,
        AudioDevice {
            name: DEFAULT_DEVICE_NAME.to_string(),
            description: "Autoselect device".to_string(),
        },
    );
    devices
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_device_keeps_plain_name_for_existing_settings() {
        let key = device_key("USB DAC", 0);
        assert_eq!(key, "USB DAC");
        assert_eq!(
            parse_device_key(&key),
            DeviceKey {
                raw_name: "USB DAC".to_string(),
                occurrence: 0,
            }
        );
    }

    #[test]
    fn normalizes_legacy_default_to_player_auto() {
        assert_eq!(normalize_device_name(""), DEFAULT_DEVICE_NAME);
        assert_eq!(normalize_device_name("default"), DEFAULT_DEVICE_NAME);
        assert_eq!(normalize_device_name("auto"), DEFAULT_DEVICE_NAME);
        assert_eq!(normalize_device_name("USB DAC"), "USB DAC");
    }

    #[test]
    fn output_device_list_starts_with_auto_device() {
        let devices = with_default_device(vec![
            AudioDevice {
                name: "default".to_string(),
                description: "System Default".to_string(),
            },
            AudioDevice {
                name: "USB DAC".to_string(),
                description: "USB DAC".to_string(),
            },
        ]);
        assert_eq!(devices[0].name, DEFAULT_DEVICE_NAME);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[1].name, "USB DAC");
    }

    #[test]
    fn duplicate_device_key_round_trips_to_occurrence() {
        let key = device_key("USB DAC", 2);
        assert_eq!(
            parse_device_key(&key),
            DeviceKey {
                raw_name: "USB DAC".to_string(),
                occurrence: 2,
            }
        );
    }
}

#[cfg(target_os = "linux")]
fn validate_platform_exclusive_open(
    device: &cpal::Device,
    exclusive: bool,
    sample_format: SampleFormat,
    sample_rate: u32,
) -> Result<(), String> {
    if !exclusive {
        return Ok(());
    }
    let config = StreamConfig {
        channels: TARGET_CHANNELS as u16,
        sample_rate: cpal::SampleRate(sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };
    build_probe_stream(device, sample_format, &config)
        .map(|_| ())
        .map_err(|err| format!("failed to open ALSA hardware output for exclusive mode: {err}"))
}

#[cfg(not(target_os = "linux"))]
fn validate_platform_exclusive_open(
    _device: &cpal::Device,
    _exclusive: bool,
    _sample_format: SampleFormat,
    _sample_rate: u32,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn build_probe_stream(
    device: &cpal::Device,
    sample_format: SampleFormat,
    config: &StreamConfig,
) -> Result<Stream, String> {
    let err_fn = |_| {};
    match sample_format {
        SampleFormat::F32 => device
            .build_output_stream(config, |data: &mut [f32], _| data.fill(0.0), err_fn, None)
            .map_err(|err| format!("failed to build f32 output stream: {err}")),
        SampleFormat::I16 => device
            .build_output_stream(config, |data: &mut [i16], _| data.fill(0), err_fn, None)
            .map_err(|err| format!("failed to build i16 output stream: {err}")),
        SampleFormat::U16 => device
            .build_output_stream(config, |data: &mut [u16], _| data.fill(0), err_fn, None)
            .map_err(|err| format!("failed to build u16 output stream: {err}")),
        _ => Err("audio output sample format is not available".to_string()),
    }
}
