#![warn(
    nonstandard_style,
    rust_2018_idioms,
    future_incompatible,
    missing_debug_implementations
)]

//! An asynchronous library for finding UPnP control points, performing actions on them
//! and reading their service descriptions.
//! UPnP stand for `Universal Plug and Play` and is widely used for routers, WiFi-enabled speakers
//! and media servers.
//!
//! Specification:
//! [http://upnp.org/specs/arch/UPnP-arch-DeviceArchitecture-v2.0.pdf](http://upnp.org/specs/arch/UPnP-arch-DeviceArchitecture-v2.0.pdf)
//!
//! # Example usage:
//! The following code searches for devices that have a `RenderingControl` service
//! and prints their names along with their current volume.
//!
//! ```rust,no_run
//! use futures::prelude::*;
//! use std::time::Duration;
//! use rupnp::ssdp::{SearchTarget, URN};
//!
//! const RENDERING_CONTROL: URN = URN::service("schemas-upnp-org", "RenderingControl", 1);
//!
//! #[tokio::main]
//! async fn main() -> Result<(), rupnp::Error> {
//!     let search_target = SearchTarget::URN(RENDERING_CONTROL);
//!     let devices = rupnp::discover(&search_target, Duration::from_secs(3), None).await?;
//!     let mut devices = std::pin::pin!(devices);
//!
//!     while let Some(device) = devices.try_next().await? {
//!         let service = device
//!             .find_service(&RENDERING_CONTROL)
//!             .expect("searched for RenderingControl, got something else");
//!
//!         let args = "<InstanceID>0</InstanceID><Channel>Master</Channel>";
//!         let response = service.action(device.url(), "GetVolume", args).await?;
//!
//!         let volume = response.get("CurrentVolume").unwrap();
//!
//!         println!("'{}' is at volume {}", device.friendly_name(), volume);
//!     }
//!
//!     Ok(())
//! }
//! ```
// TODO: doc include when it gets stable

mod device;
mod discovery;
mod error;
/// Service Control Protocol Description.
pub mod scpd;
mod service;
pub mod utils;

pub use device::{Device, DeviceSpec};
pub use discovery::{discover, discover_with_properties};
pub use error::Error;
pub use service::Service;

pub use http;
pub use ssdp_client as ssdp;

pub(crate) type Result<T, E = Error> = std::result::Result<T, E>;
