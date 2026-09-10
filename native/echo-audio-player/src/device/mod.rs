pub mod selection;
pub mod watcher;

#[cfg(target_os = "linux")]
pub mod platform_linux;
#[cfg(target_os = "macos")]
pub mod platform_macos;
#[cfg(target_os = "windows")]
pub mod platform_windows;

#[cfg(not(target_os = "windows"))]
pub(crate) use selection::device_display_name;
#[cfg(target_os = "linux")]
pub use selection::is_default_device_name;
pub use selection::{
    clear_preferred_output_sample_rate_cache, list_output_devices, normalize_device_name,
    preferred_output_sample_rate, validate_output_device,
};
#[cfg(not(target_os = "windows"))]
pub use selection::{resolve_output_sample_rate, select_output_device_checked};
pub use watcher::DeviceWatcher;
