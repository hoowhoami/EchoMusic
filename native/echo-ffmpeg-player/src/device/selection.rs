use crate::events::AudioDevice;
#[cfg(target_os = "linux")]
use crate::shared::MIX_CHANNELS;
use cpal::traits::{DeviceTrait, HostTrait};
use cpal::SampleFormat;
#[cfg(target_os = "linux")]
use cpal::{Stream, StreamConfig};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const FALLBACK_SAMPLE_RATE: u32 = 48_000;
pub(crate) const DEVICE_KEY_SEPARATOR: &str = "\u{1f}";
pub const DEFAULT_DEVICE_NAME: &str = "auto";
pub const LEGACY_DEFAULT_DEVICE_NAME: &str = "default";
const WASAPI_DEVICE_NAMESPACE: &str = "wasapi";
const COREAUDIO_DEVICE_NAMESPACE: &str = "coreaudio";
const ALSA_DEVICE_NAMESPACE: &str = "alsa";
const CPAL_DEVICE_NAMESPACE: &str = "cpal";
const JACK_DEVICE_NAMESPACE: &str = "jack";
const OPENAL_DEVICE_NAMESPACE: &str = "openal";
const PIPEWIRE_DEVICE_NAMESPACE: &str = "pipewire";
const PULSE_DEVICE_NAMESPACE: &str = "pulse";
const SDL_DEVICE_NAMESPACE: &str = "sdl";
type SampleRateCacheKey = (String, bool);
type SampleRateCache = HashMap<SampleRateCacheKey, Option<u32>>;
static PREFERRED_OUTPUT_SAMPLE_RATE_CACHE: OnceLock<Mutex<SampleRateCache>> = OnceLock::new();

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
        .and_then(|device| device_display_name(&device));
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
            let is_default = duplicate_count == 1 && default_name.as_ref() == Some(&raw_name);
            AudioDevice {
                name: key,
                description,
                is_default: Some(is_default),
            }
        })
        .collect();
    with_default_device(devices)
}

pub fn preferred_output_sample_rate(device_name: &str, exclusive: bool) -> Option<u32> {
    let device_name = normalize_device_name(device_name);
    let cache_key = (device_name.clone(), exclusive);
    if let Ok(cache) = preferred_sample_rate_cache().lock() {
        if let Some(cached) = cache.get(&cache_key) {
            return *cached;
        }
    }
    let resolved = preferred_output_sample_rate_uncached(&device_name, exclusive);
    if let Ok(mut cache) = preferred_sample_rate_cache().lock() {
        cache.insert(cache_key, resolved);
    }
    resolved
}

pub fn clear_preferred_output_sample_rate_cache() {
    if let Ok(mut cache) = preferred_sample_rate_cache().lock() {
        cache.clear();
    }
}

fn preferred_sample_rate_cache() -> &'static Mutex<SampleRateCache> {
    PREFERRED_OUTPUT_SAMPLE_RATE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn preferred_output_sample_rate_uncached(device_name: &str, exclusive: bool) -> Option<u32> {
    #[cfg(target_os = "windows")]
    if exclusive {
        return Some(
            crate::device::platform_windows::resolve_wasapi_output_sample_rate(device_name),
        );
    }
    #[cfg(target_os = "windows")]
    if !exclusive {
        return crate::device::platform_windows::resolve_wasapi_shared_output_sample_rate(
            device_name,
        );
    }
    #[cfg(target_os = "macos")]
    if exclusive {
        return Some(
            crate::device::platform_macos::resolve_coreaudio_output_sample_rate(device_name),
        );
    }
    #[cfg(target_os = "linux")]
    if exclusive {
        let Ok(device) = select_output_device_checked(device_name, exclusive) else {
            return None;
        };
        return device
            .default_output_config()
            .ok()
            .map(|config| config.sample_rate());
    }

    let Ok(device) = select_output_device_checked(device_name, exclusive) else {
        return None;
    };
    device
        .default_output_config()
        .ok()
        .map(|config| config.sample_rate())
}

pub fn resolve_output_sample_rate(device_name: &str, exclusive: bool) -> u32 {
    preferred_output_sample_rate(device_name, exclusive).unwrap_or(FALLBACK_SAMPLE_RATE)
}

pub fn validate_output_device(device_name: &str, exclusive: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    if exclusive {
        return crate::device::platform_windows::resolve_wasapi_output_device(device_name)
            .map(|_| ());
    }
    #[cfg(target_os = "linux")]
    if exclusive {
        if crate::device::platform_linux::is_sound_server_output_key(device_name) {
            return Err(crate::device::platform_linux::sound_server_exclusive_error(
                device_name,
            ));
        }
        let sample_rate = resolve_output_sample_rate(device_name, exclusive);
        return crate::device::platform_linux::validate_alsa_exclusive_output(
            device_name,
            sample_rate,
        );
    }

    let device = select_output_device_checked(device_name, exclusive)?;
    let config = device
        .default_output_config()
        .map_err(|err| format!("failed to read output config for '{device_name}': {err}"))?;
    validate_platform_exclusive_open(
        &device,
        device_name,
        exclusive,
        config.sample_format(),
        config.sample_rate(),
    )
}

pub fn select_output_device_checked(name: &str, exclusive: bool) -> Result<cpal::Device, String> {
    #[cfg(target_os = "linux")]
    {
        select_linux_output_device_checked(name, exclusive)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let host = output_host(name, exclusive)?;
        select_output_device(&host, name, exclusive)
            .ok_or_else(|| output_device_not_found_message(name, exclusive))
    }
}

#[cfg(target_os = "linux")]
fn select_linux_output_device_checked(name: &str, exclusive: bool) -> Result<cpal::Device, String> {
    if exclusive && crate::device::platform_linux::is_sound_server_output_key(name) {
        return Err(crate::device::platform_linux::sound_server_exclusive_error(
            name,
        ));
    }
    let host_kinds =
        crate::device::platform_linux::output_host_candidates_for_device_name(name, exclusive);
    let mut host_errors = Vec::<String>::new();
    for host_kind in host_kinds {
        let selected = match crate::device::platform_linux::with_output_host(host_kind, |host| {
            select_output_device(host, name, exclusive)
        }) {
            Ok(device) => device,
            Err(err) => {
                host_errors.push(err);
                continue;
            }
        };
        if let Some(device) = selected {
            return Ok(device);
        }
        host_errors.push(format!("{} has no matching output", host_kind.host_id()));
    }
    if host_errors.is_empty() {
        Err(output_device_not_found_message(name, exclusive))
    } else {
        Err(format!(
            "{} ({})",
            output_device_not_found_message(name, exclusive),
            host_errors.join("; ")
        ))
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
    #[cfg(target_os = "linux")]
    let name = crate::device::platform_linux::linux_device_selector(name);
    let selector = parse_device_key(name);
    select_named_output_device(host, &selector)
}

#[cfg(target_os = "linux")]
fn select_alsa_exclusive_output_device(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
    let name = crate::device::platform_linux::linux_device_selector(name);
    let wants_default = is_default_device_name(name);
    let selector = parse_device_key(name);
    let mut occurrence = 0usize;
    host.output_devices().ok()?.find(|device| {
        let Some(device_name) = device_display_name(device) else {
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
    let name = name.trim();
    if is_default_device_name(name) {
        DEFAULT_DEVICE_NAME.to_string()
    } else if let Some((namespace, device)) = parse_namespaced_device(name) {
        normalize_namespaced_device(namespace, device).unwrap_or_else(|| name.to_string())
    } else {
        name.to_string()
    }
}

fn parse_namespaced_device(value: &str) -> Option<(&str, &str)> {
    let (namespace, device) = value.split_once('/')?;
    let namespace = namespace.trim();
    let device = device.trim();
    (!namespace.is_empty() && !device.is_empty()).then_some((namespace, device))
}

fn normalize_namespaced_device(namespace: &str, device: &str) -> Option<String> {
    if is_default_device_name(device) {
        return Some(DEFAULT_DEVICE_NAME.to_string());
    }
    #[cfg(target_os = "linux")]
    if let Some(normalized) =
        crate::device::platform_linux::normalize_linux_namespaced_device(namespace, device)
    {
        return Some(normalized);
    }
    match namespace.to_ascii_lowercase().as_str() {
        WASAPI_DEVICE_NAMESPACE => Some(format!("wasapi:{device}")),
        COREAUDIO_DEVICE_NAMESPACE => Some(format!("coreaudio:{device}")),
        ALSA_DEVICE_NAMESPACE
        | CPAL_DEVICE_NAMESPACE
        | JACK_DEVICE_NAMESPACE
        | OPENAL_DEVICE_NAMESPACE
        | PIPEWIRE_DEVICE_NAMESPACE
        | PULSE_DEVICE_NAMESPACE
        | SDL_DEVICE_NAMESPACE => Some(device.to_string()),
        _ => None,
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
        let Some(device_name) = device_display_name(device) else {
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
        .filter_map(|device| device_display_name(&device))
        .filter(|name| !is_hidden_output_device_name(name))
        .collect()
}

pub(crate) fn device_display_name(device: &cpal::Device) -> Option<String> {
    if let Ok(description) = device.description() {
        let name = description.name().trim();
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    let name = device.to_string();
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
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
            is_default: Some(false),
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
    fn normalizes_namespaced_device_names_to_player_keys() {
        assert_eq!(
            normalize_device_name("wasapi/{0.0.0.00000000}.{endpoint}"),
            "wasapi:{0.0.0.00000000}.{endpoint}"
        );
        assert_eq!(
            normalize_device_name("coreaudio/BuiltInSpeakerDevice"),
            "coreaudio:BuiltInSpeakerDevice"
        );
        assert_eq!(normalize_device_name("alsa/hw:1,0"), "hw:1,0");
        assert_eq!(normalize_device_name("cpal/USB DAC"), "USB DAC");
        #[cfg(target_os = "linux")]
        assert_eq!(
            normalize_device_name("pipewire/USB DAC"),
            "pipewire:USB DAC"
        );
        #[cfg(not(target_os = "linux"))]
        assert_eq!(normalize_device_name("pipewire/USB DAC"), "USB DAC");
        #[cfg(target_os = "linux")]
        assert_eq!(
            normalize_device_name("pulse/alsa_output.pci"),
            "pulse:alsa_output.pci"
        );
        #[cfg(not(target_os = "linux"))]
        assert_eq!(
            normalize_device_name("pulse/alsa_output.pci"),
            "alsa_output.pci"
        );
        assert_eq!(normalize_device_name("wasapi/default"), DEFAULT_DEVICE_NAME);
    }

    #[test]
    fn preferred_sample_rate_cache_can_be_cleared() {
        clear_preferred_output_sample_rate_cache();
        let missing = preferred_output_sample_rate("__missing_echo_music_device__", false);
        assert_eq!(missing, None);
        assert!(preferred_sample_rate_cache()
            .lock()
            .expect("cache lock should not be poisoned")
            .contains_key(&("__missing_echo_music_device__".to_string(), false)));

        clear_preferred_output_sample_rate_cache();
        assert!(preferred_sample_rate_cache()
            .lock()
            .expect("cache lock should not be poisoned")
            .is_empty());
    }

    #[test]
    fn output_device_list_starts_with_auto_device() {
        let devices = with_default_device(vec![
            AudioDevice {
                name: "default".to_string(),
                description: "System Default".to_string(),
                is_default: Some(false),
            },
            AudioDevice {
                name: "USB DAC".to_string(),
                description: "USB DAC".to_string(),
                is_default: Some(false),
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
    _device_name: &str,
    exclusive: bool,
    sample_format: SampleFormat,
    sample_rate: u32,
) -> Result<(), String> {
    if !exclusive {
        return Ok(());
    }
    let config = StreamConfig {
        channels: MIX_CHANNELS as u16,
        sample_rate,
        buffer_size: cpal::BufferSize::Default,
    };
    build_probe_stream(device, sample_format, config)
        .map(|_| ())
        .map_err(|err| format!("failed to open ALSA hardware output for exclusive mode: {err}"))
}

#[cfg(target_os = "macos")]
fn validate_platform_exclusive_open(
    _device: &cpal::Device,
    device_name: &str,
    exclusive: bool,
    _sample_format: SampleFormat,
    _sample_rate: u32,
) -> Result<(), String> {
    if !exclusive {
        return Ok(());
    }
    let sample_rate =
        crate::device::platform_macos::resolve_coreaudio_output_sample_rate(device_name);
    crate::device::platform_macos::validate_coreaudio_exclusive_output(device_name, sample_rate)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn validate_platform_exclusive_open(
    _device: &cpal::Device,
    _device_name: &str,
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
    config: StreamConfig,
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
