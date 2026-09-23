//! # airplay-discovery
//!
//! mDNS/Bonjour service discovery for AirPlay 2 devices.
//!
//! This crate provides:
//! - Async device discovery via mDNS
//! - TXT record parsing for device capabilities
//! - Trait-based design for testing with mocks
//!
//! ## Example
//!
//! ```ignore
//! use airplay_discovery::{ServiceBrowser, Discovery};
//! use std::time::Duration;
//!
//! let browser = ServiceBrowser::new()?;
//! let devices = browser.scan(Duration::from_secs(5)).await?;
//! for device in devices {
//!     println!("Found: {} ({})", device.name, device.model);
//! }
//! ```

mod browser;
mod parser;
mod traits;

pub use browser::ServiceBrowser;
pub use parser::TxtRecordParser;
pub use traits::{BrowseEvent, Discovery};

/// AirPlay 2 service type for mDNS discovery.
pub const AIRPLAY_SERVICE_TYPE: &str = "_airplay._tcp.local.";

/// RAOP (Remote Audio Output Protocol) service type for legacy AirPlay discovery.
pub const RAOP_SERVICE_TYPE: &str = "_raop._tcp.local.";

/// AirPlay P2P service type.
pub const AIRPLAY_P2P_SERVICE_TYPE: &str = "_airplay-p2p._tcp.local.";

/// Service type constants (module for backwards compatibility).
pub mod service_types {
    pub use super::AIRPLAY_P2P_SERVICE_TYPE as AIRPLAY_P2P;
    pub use super::AIRPLAY_SERVICE_TYPE as AIRPLAY;
    pub use super::RAOP_SERVICE_TYPE as RAOP;
}
