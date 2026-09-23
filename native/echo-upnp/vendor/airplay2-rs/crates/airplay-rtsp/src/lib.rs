//! # airplay-rtsp
//!
//! RTSP protocol implementation for AirPlay 2.
//!
//! This crate provides:
//! - RTSP client connection management
//! - Request/response formatting
//! - Binary plist payload handling
//! - Session management
//! - Two-phase SETUP handling

mod connection;
mod request;
mod response;
mod session;
mod plist_codec;
pub mod raop_session;
pub mod sdp;
mod traits;

pub use connection::RtspConnection;
pub use raop_session::RaopSession;
pub use request::{RtspRequest, RtspMethod};
pub use response::RtspResponse;
pub use sdp::SdpBuilder;
pub use session::{RtspSession, SessionState};
pub use traits::RtspTransport;
