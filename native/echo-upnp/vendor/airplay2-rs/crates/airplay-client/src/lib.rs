//! # airplay-client
//!
//! High-level AirPlay 2 sender client.
//!
//! This crate provides:
//! - Simple API for discovering and connecting to AirPlay receivers
//! - Audio streaming from files or raw PCM
//! - Multi-room group management
//! - Volume and playback control
//!
//! ## Example
//!
//! ```ignore
//! use airplay_client::{AirPlayClient, DeviceSelector};
//! use std::path::Path;
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     // Create client and discover devices
//!     let mut client = AirPlayClient::new();
//!     let devices = client.discover(Duration::from_secs(5)).await?;
//!     
//!     // Connect to first device
//!     let device = devices.first().unwrap();
//!     client.connect(device).await?;
//!     
//!     // Stream audio file
//!     client.play_file(Path::new("song.mp3")).await?;
//!     
//!     // Wait for playback
//!     client.wait_for_completion().await?;
//!     
//!     Ok(())
//! }
//! ```

mod client;
mod connection;
mod group;
mod playback;
mod builder;
mod events;
mod raop_connection;
mod stats;

pub use client::AirPlayClient;
pub use connection::{Connection, StreamingParams};
pub use raop_connection::RaopConnection;
pub use group::{DeviceGroup, GroupMember};
pub use playback::{PlaybackState, PlaybackInfo};
pub use builder::ClientBuilder;
pub use events::{ClientEvent, EventHandler, NoOpHandler, CallbackHandler};
pub use stats::{StreamStats, StatsSnapshot, DeviceStatsSnapshot};

// Re-export commonly used types
pub use airplay_core::{Device, DeviceId, AudioFormat, StreamConfig, Error, Result};
pub use airplay_discovery::Discovery;

// Live streaming types for external sources (e.g., Bluetooth audio)
pub use airplay_audio::{LiveAudioDecoder, LiveFrameSender, LivePcmFrame};

// Equalizer types
pub use airplay_audio::{EqConfig, EqParams};
pub use airplay_audio::eq::MAX_GAIN_DB;

// Spatial audio types
pub use airplay_audio::{SpatialMixer, SpatialParams, SpatialMode, SpatialSnapshot, Position, SpeakerConfig, SpeakerParams};

// Timing types needed for group streaming
pub use airplay_timing::ClockOffset;
