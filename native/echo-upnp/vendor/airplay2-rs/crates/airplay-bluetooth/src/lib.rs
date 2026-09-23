//! # airplay-bluetooth
//!
//! Bluetooth A2DP audio source for AirPlay 2 streaming.
//!
//! This crate provides functionality to receive audio from Bluetooth devices
//! (phones, turntables, etc.) and forward it to the AirPlay audio pipeline.
//!
//! ## Features
//!
//! - Bluetooth adapter management via BlueZ/D-Bus
//! - Device discovery and pairing
//! - A2DP sink profile for receiving audio
//! - BlueALSA audio capture (supports standard and HD codecs)
//! - `AudioSource` trait implementation for AirPlay integration
//! - System setup verification for required components
//!
//! ## Requirements
//!
//! This crate is Linux-only and requires:
//! - BlueZ daemon (bluetooth service)
//! - BlueALSA daemon (bluez-alsa-utils package)
//!
//! Use `SystemSetup::check()` to verify requirements are met.
//!
//! ## Example
//!
//! ```ignore
//! // This example only compiles on Linux
//! use airplay_bluetooth::{
//!     BluetoothAdapter, DeviceScanner, PairingManager, BluetoothAudioSource,
//!     SystemSetup,
//! };
//!
//! async fn example() -> Result<(), Box<dyn std::error::Error>> {
//!     // Check system setup
//!     let status = SystemSetup::check();
//!     if !status.ready {
//!         eprintln!("System not ready: {}", status.summary());
//!         for issue in &status.issues {
//!             eprintln!("  - {}", issue.description);
//!             if let Some(cmd) = &issue.fix_command {
//!                 eprintln!("    Fix: {}", cmd);
//!             }
//!         }
//!         return Ok(());
//!     }
//!
//!     // Initialize Bluetooth adapter
//!     let adapter = BluetoothAdapter::new().await?;
//!     adapter.make_connectable().await?;
//!
//!     // Scan for devices
//!     let scanner = DeviceScanner::new(&adapter);
//!     let devices = scanner.scan(std::time::Duration::from_secs(10)).await?;
//!
//!     // Find and connect to an A2DP device
//!     for device in devices {
//!         if device.supports_a2dp_source() {
//!             let pairing = PairingManager::new(&adapter);
//!             let connected = pairing.pair_and_connect(&device.address).await?;
//!
//!             // Create audio source
//!             let mut source = BluetoothAudioSource::new(connected);
//!             source.start()?;
//!
//!             // Now use source with AirPlay client...
//!             break;
//!         }
//!     }
//!     Ok(())
//! }
//! ```

#![cfg(target_os = "linux")]

pub mod a2dp;
pub mod adapter;
pub mod alsa_capture;
pub mod device;
pub mod discovery;
pub mod error;
pub mod pairing;
pub mod setup;
pub mod source;

// Re-exports for convenience
pub use a2dp::{A2dpEvent, A2dpSink, A2dpState};
pub use adapter::BluetoothAdapter;
pub use alsa_capture::{
    calculate_rms, start_capture, AudioFormat, CaptureConfig, CaptureHandle, CapturedFrame,
    SAMPLE_RATE_HD,
};
pub use device::{Address, BluetoothDevice, A2DP_SINK_UUID, A2DP_SOURCE_UUID};
pub use discovery::DeviceScanner;
pub use error::{BluetoothError, Result};
pub use pairing::PairingManager;
pub use setup::{ComponentStatus, SetupIssue, SetupStatus, SystemSetup};
pub use source::BluetoothAudioSource;
