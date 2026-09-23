//! AirPlay TUI library.
//!
//! This crate provides a terminal user interface for discovering, connecting to,
//! and streaming audio to AirPlay 2 devices.

pub mod action;
pub mod app;
pub mod audio_info;
#[cfg(feature = "bluetooth")]
pub mod bluetooth_helper;
pub mod file_browser;
#[cfg(feature = "usb-audio")]
pub mod usb_audio;
pub mod spatial_config;
pub mod state;
pub mod ui;

pub use app::App;
pub use state::{AppState, View};
pub use file_browser::FileBrowser;
