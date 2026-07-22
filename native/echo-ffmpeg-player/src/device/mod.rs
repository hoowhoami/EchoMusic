pub mod selection;
pub mod watcher;

#[cfg(target_os = "linux")]
pub mod platform_linux;
#[cfg(target_os = "macos")]
pub mod platform_macos;
#[cfg(target_os = "windows")]
pub mod platform_windows;

#[cfg(target_os = "linux")]
pub use selection::is_default_device_name;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub use selection::resolve_output_sample_rate;
pub use selection::{
    list_output_devices, normalize_device_name, select_output_device_checked,
    validate_output_device,
};
pub use watcher::DeviceWatcher;
