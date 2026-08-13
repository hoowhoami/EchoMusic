use crate::events::{AudioDevice, PlayerEvent};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const DEVICE_EVENT_DEBOUNCE: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) enum PlaybackOutputDeviceEvent {
    DefaultRouteChanged,
    BoundDeviceChanged(String),
    BoundDeviceUnavailable(String),
}

pub struct DeviceWatcher {
    _inner: DeviceWatcherInner,
}

enum DeviceWatcherInner {
    #[cfg(target_os = "windows")]
    #[allow(dead_code)]
    Windows(crate::device::platform_windows::DeviceWatcher),
    #[cfg(target_os = "macos")]
    #[allow(dead_code)]
    Macos(crate::device::platform_macos::DeviceWatcher),
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    Generic {
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    },
}

impl DeviceWatcher {
    pub fn start(
        emit: fn(PlayerEvent),
        playback_output_changed: fn(PlaybackOutputDeviceEvent),
        output_devices_changed: fn(Vec<AudioDevice>),
    ) -> Result<Option<Self>, String> {
        #[cfg(target_os = "windows")]
        {
            crate::device::platform_windows::DeviceWatcher::start(
                emit,
                playback_output_changed,
                output_devices_changed,
            )
            .map(|watcher| {
                watcher.map(|watcher| Self {
                    _inner: DeviceWatcherInner::Windows(watcher),
                })
            })
        }

        #[cfg(target_os = "macos")]
        {
            crate::device::platform_macos::DeviceWatcher::start(
                emit,
                playback_output_changed,
                output_devices_changed,
            )
            .map(|watcher| {
                watcher.map(|watcher| Self {
                    _inner: DeviceWatcherInner::Macos(watcher),
                })
            })
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            #[cfg(target_os = "linux")]
            let mut last_pulse_default = crate::device::platform_linux::pulse_default_output_id();
            #[cfg(not(target_os = "linux"))]
            let _ = playback_output_changed;
            let stop = Arc::new(AtomicBool::new(false));
            let thread_stop = stop.clone();
            let thread = thread::Builder::new()
                .name("player-device-watcher".to_string())
                .spawn(move || {
                    let mut last_devices = crate::device::list_output_devices();
                    let mut last_signature = device_list_signature(&last_devices);
                    emit(PlayerEvent::audio_device_list_changed(
                        last_devices.clone(),
                        "initial",
                        Vec::new(),
                    ));
                    while !thread_stop.load(Ordering::Acquire) {
                        thread::sleep(Duration::from_secs(1));
                        let devices = crate::device::list_output_devices();
                        #[cfg(target_os = "linux")]
                        {
                            let pulse_default =
                                crate::device::platform_linux::pulse_default_output_id();
                            if pulse_default.is_some()
                                && last_pulse_default.is_some()
                                && pulse_default != last_pulse_default
                            {
                                playback_output_changed(
                                    PlaybackOutputDeviceEvent::DefaultRouteChanged,
                                );
                            }
                            if pulse_default.is_some() {
                                last_pulse_default = pulse_default;
                            }
                        }
                        let signature = device_list_signature(&devices);
                        if signature == last_signature {
                            continue;
                        }
                        let disconnected_devices = disconnected_devices(&last_devices, &devices);
                        let change_kind = if disconnected_devices.is_empty() {
                            "changed"
                        } else {
                            "disconnected"
                        };
                        crate::device::clear_preferred_output_sample_rate_cache();
                        last_signature = signature;
                        last_devices = devices.clone();
                        emit(PlayerEvent::audio_device_list_changed(
                            devices.clone(),
                            change_kind,
                            disconnected_devices,
                        ));
                        output_devices_changed(devices);
                    }
                })
                .map_err(|err| format!("failed to spawn device watcher thread: {err}"))?;
            Ok(Some(Self {
                _inner: DeviceWatcherInner::Generic {
                    stop,
                    thread: Some(thread),
                },
            }))
        }
    }
}

#[cfg(any(test, not(any(target_os = "windows", target_os = "macos"))))]
pub(crate) fn device_list_signature(
    devices: &[crate::events::AudioDevice],
) -> Vec<(String, String)> {
    devices
        .iter()
        .map(|device| (device.name.clone(), device.description.clone()))
        .collect()
}

impl Drop for DeviceWatcher {
    fn drop(&mut self) {
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let DeviceWatcherInner::Generic { stop, thread } = &mut self._inner;
            stop.store(true, Ordering::Release);
            if let Some(thread) = thread.take() {
                let _ = thread.join();
            }
        }
    }
}

pub(crate) fn run_debounced_device_events(
    rx: Receiver<()>,
    stop: Arc<AtomicBool>,
    emit: fn(PlayerEvent),
    output_devices_changed: fn(Vec<AudioDevice>),
) {
    let mut last_devices = crate::device::list_output_devices();
    emit(PlayerEvent::audio_device_list_changed(
        last_devices.clone(),
        "initial",
        Vec::new(),
    ));

    while !stop.load(Ordering::Acquire) {
        if rx.recv_timeout(Duration::from_millis(100)).is_err() {
            continue;
        }
        let deadline = Instant::now() + DEVICE_EVENT_DEBOUNCE;
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if rx.recv_timeout(remaining).is_err() {
                break;
            }
        }
        let devices = crate::device::list_output_devices();
        let disconnected_devices = disconnected_devices(&last_devices, &devices);
        let change_kind = if disconnected_devices.is_empty() {
            "changed"
        } else {
            "disconnected"
        };
        crate::device::clear_preferred_output_sample_rate_cache();
        last_devices = devices.clone();
        emit(PlayerEvent::audio_device_list_changed(
            devices.clone(),
            change_kind,
            disconnected_devices,
        ));
        output_devices_changed(devices);
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn run_debounced_playback_output_events(
    rx: Receiver<PlaybackOutputDeviceEvent>,
    stop: Arc<AtomicBool>,
    playback_output_changed: fn(PlaybackOutputDeviceEvent),
) {
    while !stop.load(Ordering::Acquire) {
        let first = match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(event) => event,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let mut pending = vec![first];
        let deadline = Instant::now() + DEVICE_EVENT_DEBOUNCE;
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(remaining) {
                Ok(event) => merge_playback_output_device_event(&mut pending, event),
                Err(_) => break,
            }
        }
        if stop.load(Ordering::Acquire) {
            break;
        }
        for event in pending {
            playback_output_changed(event);
        }
    }
}

#[cfg(any(test, target_os = "windows"))]
fn merge_playback_output_device_event(
    pending: &mut Vec<PlaybackOutputDeviceEvent>,
    event: PlaybackOutputDeviceEvent,
) {
    match &event {
        PlaybackOutputDeviceEvent::DefaultRouteChanged => {
            if !pending
                .iter()
                .any(|item| matches!(item, PlaybackOutputDeviceEvent::DefaultRouteChanged))
            {
                pending.push(event);
            }
        }
        PlaybackOutputDeviceEvent::BoundDeviceChanged(device) => {
            if !pending.iter().any(|item| {
                playback_output_event_device(item).is_some_and(|existing| existing == device)
            }) {
                pending.push(event);
            }
        }
        PlaybackOutputDeviceEvent::BoundDeviceUnavailable(device) => {
            if let Some(existing) = pending.iter_mut().find(|item| {
                playback_output_event_device(item).is_some_and(|existing| existing == device)
            }) {
                *existing = event;
            } else {
                pending.push(event);
            }
        }
    }
}

#[cfg(any(test, target_os = "windows"))]
fn playback_output_event_device(event: &PlaybackOutputDeviceEvent) -> Option<&str> {
    match event {
        PlaybackOutputDeviceEvent::DefaultRouteChanged => None,
        PlaybackOutputDeviceEvent::BoundDeviceChanged(device)
        | PlaybackOutputDeviceEvent::BoundDeviceUnavailable(device) => Some(device),
    }
}

pub(crate) fn disconnected_devices(
    previous: &[AudioDevice],
    current: &[AudioDevice],
) -> Vec<AudioDevice> {
    previous
        .iter()
        .filter(|previous_device| {
            !current
                .iter()
                .any(|current_device| current_device.name == previous_device.name)
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(name: &str, is_default: bool) -> AudioDevice {
        AudioDevice {
            name: name.to_string(),
            description: name.to_string(),
            is_default: Some(is_default),
        }
    }

    #[test]
    fn device_signature_ignores_default_route_metadata() {
        let before = vec![device("speakers", true), device("headphones", false)];
        let after = vec![device("speakers", false), device("headphones", true)];

        assert_eq!(
            device_list_signature(&before),
            device_list_signature(&after)
        );
    }

    #[test]
    fn playback_output_events_are_coalesced_by_route_and_device() {
        let mut pending = vec![PlaybackOutputDeviceEvent::DefaultRouteChanged];
        merge_playback_output_device_event(
            &mut pending,
            PlaybackOutputDeviceEvent::DefaultRouteChanged,
        );
        merge_playback_output_device_event(
            &mut pending,
            PlaybackOutputDeviceEvent::BoundDeviceChanged("wasapi:a".to_string()),
        );
        merge_playback_output_device_event(
            &mut pending,
            PlaybackOutputDeviceEvent::BoundDeviceUnavailable("wasapi:a".to_string()),
        );

        assert_eq!(
            pending,
            vec![
                PlaybackOutputDeviceEvent::DefaultRouteChanged,
                PlaybackOutputDeviceEvent::BoundDeviceUnavailable("wasapi:a".to_string()),
            ]
        );
    }
}
