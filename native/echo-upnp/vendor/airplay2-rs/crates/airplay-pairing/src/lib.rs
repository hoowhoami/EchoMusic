//! # airplay-pairing
//!
//! HomeKit and FairPlay authentication for AirPlay 2.
//!
//! This crate implements:
//! - HomeKit pair-setup (SRP-6a based) - use [`PairSetup`] for Apple TV (HKP=3) or HomePod (HKP=4)
//! - HomeKit pair-verify (Curve25519 + Ed25519) - use [`PairVerify`]
//! - FairPlay authentication (for licensed scenarios)
//! - Transient pairing (no persistent storage) - use [`PairingSession`]
//!
//! ## Apple TV vs HomePod
//!
//! - **Apple TV**: Use [`PairSetup::new(pin)`] with HKP=3 header (HomeKit Normal)
//! - **HomePod**: Use [`PairSetup::new_transient()`] with HKP=4 header (HomeKit Transient)

mod channel;
mod controller;
mod fairplay;
mod pair_setup;
mod pair_verify;
mod session;
mod traits;

pub use channel::EncryptedChannel;
pub use controller::ControllerIdentity;
pub use fairplay::FairPlaySetup;
pub use pair_setup::{PairSetup, TransientPairSetup};
pub use pair_verify::PairVerify;
pub use session::{PairingSession, PairingStep};
pub use traits::{PairingHandler, Transport};
