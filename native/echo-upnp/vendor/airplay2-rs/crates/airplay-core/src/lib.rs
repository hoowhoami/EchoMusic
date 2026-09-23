//! # airplay-core
//!
//! Core types, traits, and error definitions shared across all AirPlay 2 crates.
//!
//! This crate provides:
//! - Device representation and identification
//! - 64-bit feature flag parsing and querying
//! - Audio codec and format definitions
//! - Stream configuration types
//! - Common error types

pub mod codec;
pub mod device;
pub mod error;
pub mod features;
pub mod stream;

pub use codec::{AudioCodec, AudioFormat, SampleRate};
pub use device::{Device, DeviceId, DeviceInfo, Version};
pub use error::{Error, PairingError, Result, RtspError, StreamingError};
pub use features::{AuthMethod, Features};
pub use stream::{StreamConfig, StreamType, TimingProtocol, PtpMode};
