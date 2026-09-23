//! # airplay-crypto
//!
//! Cryptographic primitives for AirPlay 2 authentication and streaming.
//!
//! This crate provides:
//! - SRP-6a (3072-bit) for HomeKit pair-setup
//! - Curve25519 ECDH for key agreement
//! - Ed25519 for digital signatures
//! - ChaCha20-Poly1305 for AEAD encryption
//! - AES-128-CBC for legacy encryption
//! - HKDF-SHA512 for key derivation
//!
//! All secret material is zeroized on drop.

pub mod aes;
pub mod chacha;
pub mod curve25519;
pub mod digest;
pub mod ed25519;
pub mod hkdf;
pub mod keys;
pub mod rsa;
pub mod srp;
pub mod tlv;

pub use chacha::{AudioCipher, ControlCipher};
pub use keys::{EncryptionKey, SessionKeys, SharedSecret};
pub use tlv::{Tlv8, TlvType};
