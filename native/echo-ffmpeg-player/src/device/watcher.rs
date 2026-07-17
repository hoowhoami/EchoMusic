use crate::events::PlayerEvent;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const DEVICE_EVENT_DEBOUNCE: Duration = Duration::from_millis(250);

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
    pub fn start(emit: fn(PlayerEvent)) -> Result<Option<Self>, String> {
        #[cfg(target_os = "windows")]
        {
            return crate::device::platform_windows::DeviceWatcher::start(emit).map(|watcher| {
                watcher.map(|watcher| Self {
                    _inner: DeviceWatcherInner::Windows(watcher),
                })
            });
        }

        #[cfg(target_os = "macos")]
        {
            return crate::device::platform_macos::DeviceWatcher::start(emit).map(|watcher| {
                watcher.map(|watcher| Self {
                    _inner: DeviceWatcherInner::Macos(watcher),
                })
            });
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let stop = Arc::new(AtomicBool::new(false));
            let thread_stop = stop.clone();
            let thread = thread::Builder::new()
                .name("player-device-watcher".to_string())
                .spawn(move || {
                    let initial_devices = crate::device::list_output_devices();
                    let mut last_signature = device_list_signature(&initial_devices);
                    emit(PlayerEvent::audio_device_list_changed(initial_devices));
                    while !thread_stop.load(Ordering::Acquire) {
                        thread::sleep(Duration::from_secs(1));
                        let devices = crate::device::list_output_devices();
                        let signature = device_list_signature(&devices);
                        if signature == last_signature {
                            continue;
                        }
                        last_signature = signature;
                        emit(PlayerEvent::audio_device_list_changed(devices));
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

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn device_list_signature(devices: &[crate::events::AudioDevice]) -> Vec<(String, String)> {
    devices
        .iter()
        .map(|device| (device.name.clone(), device.description.clone()))
        .collect()
}

impl Drop for DeviceWatcher {
    fn drop(&mut self) {
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        if let DeviceWatcherInner::Generic { stop, thread } = &mut self._inner {
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
) {
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
        emit(PlayerEvent::audio_device_list_changed(
            crate::device::list_output_devices(),
        ));
    }
}
