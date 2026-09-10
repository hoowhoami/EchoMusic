use crate::device::selection::{
    device_display_name, device_name_matches_key, is_default_device_name, parse_device_key,
    DEVICE_KEY_SEPARATOR,
};
use crate::events::AudioDevice;
use cpal::traits::{DeviceTrait, HostTrait};
use std::collections::{HashMap, HashSet};
use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};
use std::thread::{self, ThreadId};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LinuxOutputHost {
    PipeWire,
    PulseAudio,
    Alsa,
}

const PIPEWIRE_KEY_PREFIX: &str = "pipewire:";
const PULSE_KEY_PREFIX: &str = "pulse:";
const PULSEAUDIO_KEY_PREFIX: &str = "pulseaudio:";
const ALSA_KEY_PREFIX: &str = "alsa:";
static PULSE_AUDIO_HOST: OnceLock<PulseAudioHostCache> = OnceLock::new();

// Keep one PulseAudio host per process so cpal does not create a new
// cpal-pulseaudio-<pid> client during every device watcher poll. The host is
// moved out of the cache while in use, so no cpal calls run while holding the
// cache mutex. A same-thread nested access returns Err instead of deadlocking;
// a panic while using the host clears the cache before resuming the unwind; and
// callers reset stale hosts only on concrete PulseAudio query failures.
struct PulseAudioHostCache {
    state: Mutex<PulseAudioHostState>,
    available: Condvar,
}

enum PulseAudioHostState {
    Empty,
    Ready(cpal::Host),
    Busy { owner: ThreadId },
}

pub(crate) fn list_output_devices() -> Option<Vec<AudioDevice>> {
    let mut devices = Vec::new();
    let mut seen_keys = HashSet::<String>::new();
    let mut seen_sound_server_names = HashMap::<String, LinuxOutputHost>::new();
    let mut occurrences = HashMap::<String, usize>::new();

    for host_kind in shared_host_order()
        .into_iter()
        .chain([LinuxOutputHost::Alsa])
    {
        let mut list_host = || {
            with_output_host(host_kind, |host| {
                let default_name = host
                    .default_output_device()
                    .and_then(|device| device_display_name(&device));
                append_host_devices(
                    host,
                    host_kind,
                    default_name.as_deref(),
                    &mut devices,
                    &mut seen_keys,
                    &mut seen_sound_server_names,
                    &mut occurrences,
                )
            })
        };
        let listed = list_host();
        if host_kind == LinuxOutputHost::PulseAudio && matches!(listed, Ok(Err(()))) {
            reset_pulse_audio_host();
            let _ = list_host();
        }
    }

    (!devices.is_empty()).then_some(devices)
}

pub(crate) fn is_alsa_hardware_pcm(name: &str) -> bool {
    let lower = strip_linux_host_namespace(name).trim().to_ascii_lowercase();
    lower.starts_with("hw:") || lower.starts_with("plughw:")
}

pub(crate) fn output_host_candidates_for_device_name(
    name: &str,
    exclusive: bool,
) -> Vec<LinuxOutputHost> {
    if exclusive || is_alsa_output_key(name) {
        vec![LinuxOutputHost::Alsa]
    } else if is_pipewire_output_key(name) {
        vec![LinuxOutputHost::PipeWire]
    } else if is_pulse_output_key(name) {
        vec![LinuxOutputHost::PulseAudio]
    } else {
        let mut hosts = shared_output_host_order();
        hosts.push(LinuxOutputHost::Alsa);
        hosts
    }
}

pub(crate) fn shared_output_host_order() -> Vec<LinuxOutputHost> {
    shared_host_order()
        .into_iter()
        .filter(|host_kind| output_host_has_output_device(*host_kind))
        .collect()
}

pub(crate) fn pulse_default_output_id() -> Option<String> {
    let query = || {
        with_output_host(LinuxOutputHost::PulseAudio, |host| {
            host.default_output_device()?
                .id()
                .ok()
                .map(|id| id.id().to_string())
        })
        .ok()
        .flatten()
    };
    let current = query();
    if current.is_none() {
        reset_pulse_audio_host();
        return query();
    }
    current
}

pub(crate) fn normalize_linux_namespaced_device(namespace: &str, device: &str) -> Option<String> {
    match namespace.to_ascii_lowercase().as_str() {
        "pipewire" => Some(format!("{PIPEWIRE_KEY_PREFIX}{device}")),
        "pulse" | "pulseaudio" => Some(format!("{PULSE_KEY_PREFIX}{device}")),
        "alsa" => Some(device.to_string()),
        _ => None,
    }
}

pub(crate) fn linux_device_selector(value: &str) -> &str {
    strip_linux_host_namespace(value)
}

pub(crate) fn is_sound_server_output_key(name: &str) -> bool {
    is_pipewire_output_key(name) || is_pulse_output_key(name)
}

pub(crate) fn sound_server_exclusive_error(device_name: &str) -> String {
    format!(
        "exclusive audio output is only available for ALSA hardware devices; '{device_name}' is a PulseAudio/PipeWire output, disable exclusive audio output to use it"
    )
}

pub(crate) fn resolve_alsa_exclusive_device_name(device_name: &str) -> Option<String> {
    let device_name = strip_linux_host_namespace(device_name);
    if is_alsa_hardware_pcm(device_name) {
        return Some(device_name.to_string());
    }

    let alsa_host = cpal::host_from_id(cpal::HostId::Alsa).ok()?;
    if is_default_device_name(device_name) {
        return alsa_host
            .output_devices()
            .ok()?
            .filter_map(|device| device_display_name(&device))
            .find(|name| is_alsa_hardware_pcm(name));
    }

    let selector = parse_device_key(device_name);
    let mut occurrence = 0usize;
    alsa_host
        .output_devices()
        .ok()?
        .filter_map(|device| device_display_name(&device))
        .find(|name| {
            if !is_alsa_hardware_pcm(name) || !device_name_matches_key(name, &selector) {
                return false;
            }
            let matched = occurrence == selector.occurrence;
            occurrence += 1;
            matched
        })
}

pub(crate) fn validate_alsa_exclusive_output(
    device_name: &str,
    sample_rate: u32,
) -> Result<(), String> {
    let resolved = resolve_alsa_exclusive_device_name(device_name).ok_or_else(|| {
        if is_default_device_name(device_name) {
            "default ALSA hardware output is not available".to_string()
        } else {
            format!("ALSA hardware output not found: {device_name}")
        }
    })?;
    crate::output::alsa_exclusive::probe_output(&resolved, sample_rate)
}

pub(crate) fn with_output_host<R>(
    host_kind: LinuxOutputHost,
    f: impl FnOnce(&cpal::Host) -> R,
) -> Result<R, String> {
    if host_kind == LinuxOutputHost::PulseAudio {
        return with_pulse_audio_host(f);
    }

    let host = create_output_host(host_kind)?;
    Ok(f(&host))
}

fn create_output_host(host_kind: LinuxOutputHost) -> Result<cpal::Host, String> {
    cpal::host_from_id(host_kind.host_id())
        .map_err(|err| format!("{} unavailable: {err}", host_kind.host_id()))
}

fn with_pulse_audio_host<R>(f: impl FnOnce(&cpal::Host) -> R) -> Result<R, String> {
    let cache = pulse_audio_host();
    let owner = thread::current().id();
    let host = take_pulse_audio_host(cache, owner)?;
    let outcome = catch_unwind(AssertUnwindSafe(|| f(&host)));

    let mut state = lock_pulse_audio_host(cache);
    match outcome {
        Ok(result) => {
            *state = PulseAudioHostState::Ready(host);
            cache.available.notify_all();
            Ok(result)
        }
        Err(payload) => {
            *state = PulseAudioHostState::Empty;
            cache.available.notify_all();
            drop(state);
            resume_unwind(payload);
        }
    }
}

fn take_pulse_audio_host(
    cache: &PulseAudioHostCache,
    owner: ThreadId,
) -> Result<cpal::Host, String> {
    loop {
        let mut state = lock_pulse_audio_host(cache);
        match &*state {
            PulseAudioHostState::Ready(_) => {
                let PulseAudioHostState::Ready(host) =
                    std::mem::replace(&mut *state, PulseAudioHostState::Busy { owner })
                else {
                    return Err("PulseAudio host cache changed while locked".to_string());
                };
                return Ok(host);
            }
            PulseAudioHostState::Empty => {
                *state = PulseAudioHostState::Busy { owner };
                drop(state);
                match create_output_host(LinuxOutputHost::PulseAudio) {
                    Ok(host) => return Ok(host),
                    Err(err) => {
                        let mut state = lock_pulse_audio_host(cache);
                        if matches!(*state, PulseAudioHostState::Busy { owner: busy_owner } if busy_owner == owner)
                        {
                            *state = PulseAudioHostState::Empty;
                        }
                        cache.available.notify_all();
                        return Err(err);
                    }
                }
            }
            PulseAudioHostState::Busy { owner: busy_owner } if *busy_owner == owner => {
                return Err("reentrant PulseAudio host access is not supported".to_string());
            }
            PulseAudioHostState::Busy { .. } => {
                drop(wait_pulse_audio_host(cache, state));
            }
        }
    }
}

pub(crate) fn reset_pulse_audio_host() {
    let cache = pulse_audio_host();
    let mut state = lock_pulse_audio_host(cache);
    if !matches!(*state, PulseAudioHostState::Busy { .. }) {
        *state = PulseAudioHostState::Empty;
    }
    cache.available.notify_all();
}

fn pulse_audio_host() -> &'static PulseAudioHostCache {
    PULSE_AUDIO_HOST.get_or_init(|| PulseAudioHostCache {
        state: Mutex::new(PulseAudioHostState::Empty),
        available: Condvar::new(),
    })
}

fn lock_pulse_audio_host(cache: &PulseAudioHostCache) -> MutexGuard<'_, PulseAudioHostState> {
    cache
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn wait_pulse_audio_host<'a>(
    cache: &PulseAudioHostCache,
    state: MutexGuard<'a, PulseAudioHostState>,
) -> MutexGuard<'a, PulseAudioHostState> {
    cache
        .available
        .wait(state)
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn append_host_devices(
    host: &cpal::Host,
    host_kind: LinuxOutputHost,
    default_name: Option<&str>,
    devices: &mut Vec<AudioDevice>,
    seen_keys: &mut HashSet<String>,
    seen_sound_server_names: &mut HashMap<String, LinuxOutputHost>,
    occurrences: &mut HashMap<String, usize>,
) -> Result<(), ()> {
    let Ok(output_devices) = host.output_devices() else {
        return Err(());
    };
    for device in output_devices {
        let Some(raw_name) = device_display_name(&device) else {
            continue;
        };
        let raw_name = raw_name.trim().to_string();
        if should_hide_output_device_name(&raw_name) {
            continue;
        }
        let is_hardware = is_alsa_hardware_pcm(&raw_name);
        if host_kind == LinuxOutputHost::Alsa && !is_hardware {
            continue;
        }
        let dedupe_keys = sound_server_dedupe_keys(&device, &raw_name);
        if should_skip_sound_server_duplicate(host_kind, &dedupe_keys, seen_sound_server_names) {
            continue;
        }

        let occurrence_key = format!("{}:{raw_name}", host_kind.key_prefix());
        let occurrence = occurrences.entry(occurrence_key).or_insert(0);
        let key = linux_device_key(host_kind, &raw_name, *occurrence);
        *occurrence += 1;
        if !seen_keys.insert(key.clone()) {
            continue;
        }
        devices.push(AudioDevice {
            name: key,
            description: display_name(host_kind, &raw_name, is_hardware, *occurrence),
            is_default: Some(
                host_kind != LinuxOutputHost::Alsa && default_name == Some(raw_name.as_str()),
            ),
        });
    }
    Ok(())
}

fn should_skip_sound_server_duplicate(
    host_kind: LinuxOutputHost,
    dedupe_keys: &[String],
    seen_sound_server_names: &mut HashMap<String, LinuxOutputHost>,
) -> bool {
    if !host_kind.is_sound_server() {
        return false;
    }
    if dedupe_keys.iter().any(|key| {
        matches!(
            seen_sound_server_names.get(key).copied(),
            Some(LinuxOutputHost::PipeWire)
        ) && host_kind == LinuxOutputHost::PulseAudio
    }) {
        return true;
    }
    for key in dedupe_keys {
        seen_sound_server_names
            .entry(key.clone())
            .or_insert(host_kind);
    }
    false
}

fn sound_server_dedupe_keys(device: &cpal::Device, raw_name: &str) -> Vec<String> {
    let mut keys = Vec::new();
    push_dedupe_key(&mut keys, raw_name);
    if let Ok(id) = device.id() {
        push_dedupe_key(&mut keys, id.id());
    }
    if let Ok(description) = device.description() {
        push_dedupe_key(&mut keys, description.name());
        if let Some(address) = description.address() {
            push_dedupe_key(&mut keys, address);
        }
        for line in description.extended() {
            push_dedupe_key(&mut keys, line);
        }
    }
    keys
}

fn push_dedupe_key(keys: &mut Vec<String>, value: &str) {
    let key = value.trim().to_ascii_lowercase();
    if key.is_empty() || keys.contains(&key) {
        return;
    }
    keys.push(key);
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

fn display_name(
    host_kind: LinuxOutputHost,
    raw_name: &str,
    is_hardware: bool,
    occurrence: usize,
) -> String {
    let base = match host_kind {
        LinuxOutputHost::PipeWire => format!("PipeWire ({raw_name})"),
        LinuxOutputHost::PulseAudio => format!("PulseAudio ({raw_name})"),
        LinuxOutputHost::Alsa if is_hardware => format!("ALSA Hardware ({raw_name})"),
        LinuxOutputHost::Alsa => raw_name.to_string(),
    };
    if occurrence <= 1 {
        base
    } else {
        format!("{base} #{}", occurrence)
    }
}

fn linux_device_key(host_kind: LinuxOutputHost, raw_name: &str, occurrence: usize) -> String {
    let raw_key = device_key(raw_name, occurrence);
    match host_kind {
        LinuxOutputHost::PipeWire => format!("{PIPEWIRE_KEY_PREFIX}{raw_key}"),
        LinuxOutputHost::PulseAudio => format!("{PULSE_KEY_PREFIX}{raw_key}"),
        LinuxOutputHost::Alsa => raw_key,
    }
}

fn device_key(raw_name: &str, occurrence: usize) -> String {
    if occurrence == 0 {
        raw_name.to_string()
    } else {
        format!("{raw_name}{DEVICE_KEY_SEPARATOR}{occurrence}")
    }
}

fn shared_host_order() -> [LinuxOutputHost; 2] {
    [LinuxOutputHost::PipeWire, LinuxOutputHost::PulseAudio]
}

fn output_host_has_output_device(host_kind: LinuxOutputHost) -> bool {
    let has_device = || {
        with_output_host(host_kind, |host| {
            if host.default_output_device().is_some() {
                return Ok(true);
            }
            host.output_devices()
                .map(|mut devices| devices.next().is_some())
                .map_err(|_| ())
        })
    };

    match has_device() {
        Ok(Ok(true)) => true,
        Ok(Ok(false) | Err(())) if host_kind == LinuxOutputHost::PulseAudio => {
            reset_pulse_audio_host();
            has_device().ok().and_then(Result::ok).unwrap_or(false)
        }
        _ => false,
    }
}

impl LinuxOutputHost {
    pub(crate) fn host_id(self) -> cpal::HostId {
        match self {
            LinuxOutputHost::PipeWire => cpal::HostId::PipeWire,
            LinuxOutputHost::PulseAudio => cpal::HostId::PulseAudio,
            LinuxOutputHost::Alsa => cpal::HostId::Alsa,
        }
    }

    fn key_prefix(self) -> &'static str {
        match self {
            LinuxOutputHost::PipeWire => "pipewire",
            LinuxOutputHost::PulseAudio => "pulse",
            LinuxOutputHost::Alsa => "alsa",
        }
    }

    fn is_sound_server(self) -> bool {
        matches!(
            self,
            LinuxOutputHost::PipeWire | LinuxOutputHost::PulseAudio
        )
    }
}

fn strip_linux_host_namespace(value: &str) -> &str {
    value
        .strip_prefix(PIPEWIRE_KEY_PREFIX)
        .or_else(|| value.strip_prefix(PULSE_KEY_PREFIX))
        .or_else(|| value.strip_prefix(PULSEAUDIO_KEY_PREFIX))
        .or_else(|| value.strip_prefix(ALSA_KEY_PREFIX))
        .unwrap_or(value)
}

fn is_pipewire_output_key(name: &str) -> bool {
    name.starts_with(PIPEWIRE_KEY_PREFIX)
}

fn is_pulse_output_key(name: &str) -> bool {
    name.starts_with(PULSE_KEY_PREFIX) || name.starts_with(PULSEAUDIO_KEY_PREFIX)
}

fn is_alsa_output_key(name: &str) -> bool {
    name.starts_with(ALSA_KEY_PREFIX) || is_alsa_hardware_pcm(name)
}
