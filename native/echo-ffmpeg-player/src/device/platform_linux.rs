use crate::device::selection::DEVICE_KEY_SEPARATOR;
use crate::events::AudioDevice;
use cpal::traits::{DeviceTrait, HostTrait};
use std::collections::{HashMap, HashSet};

pub(crate) fn list_output_devices() -> Option<Vec<AudioDevice>> {
    let mut devices = Vec::new();
    let mut seen_keys = HashSet::<String>::new();
    let mut occurrences = HashMap::<String, usize>::new();

    let default_host = cpal::default_host();
    append_host_devices(
        &default_host,
        false,
        &mut devices,
        &mut seen_keys,
        &mut occurrences,
    );

    if let Ok(alsa_host) = cpal::host_from_id(cpal::HostId::Alsa) {
        append_host_devices(
            &alsa_host,
            true,
            &mut devices,
            &mut seen_keys,
            &mut occurrences,
        );
    }

    (!devices.is_empty()).then_some(devices)
}

pub(crate) fn is_alsa_hardware_pcm(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    lower.starts_with("hw:") || lower.starts_with("plughw:")
}

fn append_host_devices(
    host: &cpal::Host,
    hardware_only: bool,
    devices: &mut Vec<AudioDevice>,
    seen_keys: &mut HashSet<String>,
    occurrences: &mut HashMap<String, usize>,
) {
    let Ok(output_devices) = host.output_devices() else {
        return;
    };
    for device in output_devices {
        let Ok(raw_name) = device.name() else {
            continue;
        };
        let raw_name = raw_name.trim().to_string();
        if should_hide_output_device_name(&raw_name) {
            continue;
        }
        let is_hardware = is_alsa_hardware_pcm(&raw_name);
        if hardware_only && !is_hardware {
            continue;
        }

        let occurrence = occurrences.entry(raw_name.clone()).or_insert(0);
        let key = device_key(&raw_name, *occurrence);
        *occurrence += 1;
        if !seen_keys.insert(key.clone()) {
            continue;
        }
        devices.push(AudioDevice {
            name: key,
            description: display_name(&raw_name, is_hardware, *occurrence),
        });
    }
}

fn should_hide_output_device_name(name: &str) -> bool {
    let normalized = name.trim().to_ascii_lowercase();
    normalized.is_empty()
        || normalized == "default"
        || normalized == "system default"
        || normalized == "null"
        || is_generated_audio_device_name(&normalized)
}

fn is_generated_audio_device_name(normalized: &str) -> bool {
    let Some(suffix) = normalized.strip_prefix("audio device ") else {
        return false;
    };
    !suffix.is_empty() && suffix.chars().all(|ch| ch.is_ascii_digit())
}

fn display_name(raw_name: &str, is_hardware: bool, occurrence: usize) -> String {
    let base = if is_hardware {
        format!("ALSA Hardware ({raw_name})")
    } else {
        raw_name.to_string()
    };
    if occurrence <= 1 {
        base
    } else {
        format!("{base} #{}", occurrence)
    }
}

fn device_key(raw_name: &str, occurrence: usize) -> String {
    if occurrence == 0 {
        raw_name.to_string()
    } else {
        format!("{raw_name}{DEVICE_KEY_SEPARATOR}{occurrence}")
    }
}
