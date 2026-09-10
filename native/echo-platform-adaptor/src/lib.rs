//! Native platform integration, independent of system media controls.
#[cfg(target_os = "windows")]
mod taskbar;
#[cfg(target_os = "windows")]
mod window_composition;
#[cfg(target_os = "macos")]
mod window_pointer;
