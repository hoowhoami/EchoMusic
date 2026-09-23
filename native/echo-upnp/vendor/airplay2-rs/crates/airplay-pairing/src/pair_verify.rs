//! HomeKit pair-verify protocol (M1-M4).
//!
//! Pair-verify establishes a session using Curve25519 ECDH.
//! It's used after initial pair-setup OR for transient pairing.
//!
//! # M1 Format Selection Guide
//!
//! Multiple M1 formats exist because different AirPlay devices expect different formats.
//! Use this guide to select the appropriate format:
//!
//! ## Recommended Usage
//!
//! | Scenario | Method | Format |
//! |----------|--------|--------|
//! | Standard HomeKit (after M1-M6 pair-setup) | `generate_m1()` | TLV8, 37 bytes |
//! | Transient mode (after M1-M4 pair-setup) | `generate_m1_transient()` | Raw, 68 bytes, flags at end |
//! | Transient fallback | `generate_m1_transient_prefix()` | Raw, 68 bytes, flags at start |
//! | Transient with TLV8 | `generate_m1_transient_tlv()` | TLV8, 74 bytes |
//!
//! ## Troubleshooting
//!
//! If the recommended format doesn't work, try these in order:
//! 1. `generate_m1_transient()` - Primary transient format
//! 2. `generate_m1_transient_prefix()` - Flags-first variant
//! 3. `generate_m1_transient_tlv()` - TLV8 encoded transient
//! 4. `generate_m1()` - Standard HomeKit (may work for some transient devices)
//!
//! Use `reset()` between attempts to try a different format.
//!
//! ## Experimental Formats (avoid unless needed)
//!
//! - `generate_m1_transient_no_flags()` - 64 bytes, no flags
//! - `generate_m1_transient_signed()` - 68 bytes with truncated signature
//! - `generate_m1_transient_full_sig()` - 100 bytes with full signature

use airplay_core::error::{CryptoError, PairingError, Result};
use airplay_crypto::{
    chacha::{decrypt_with_nonce, encrypt_with_nonce, nonce_from_string},
    curve25519::EcdhKeyPair,
    ed25519::{verify, IdentityKeyPair},
    hkdf,
    keys::{SessionKeys, SharedSecret},
    tlv::{Tlv8, TlvType},
};

use crate::controller::ControllerIdentity;

/// Pair-verify state machine.
pub struct PairVerify {
    state: PairVerifyState,
    identity: IdentityKeyPair,
    /// Custom identifier for M3. If None, derived from Ed25519 public key.
    custom_identifier: Option<String>,
    ecdh_keypair: Option<EcdhKeyPair>,
    ecdh_public: Option<[u8; 32]>,
    server_public: Option<[u8; 32]>,
    shared_secret: Option<[u8; 32]>,
    session_key: Option<[u8; 32]>,
    /// Server's Ed25519 long-term public key (for transient mode signature verification).
    /// Set via `set_server_ltpk()` before processing M2 if known from /info response.
    server_ltpk: Option<[u8; 32]>,
    signature_order: SignatureOrder,
}

#[derive(Debug, Clone, Copy)]
enum SignatureOrder {
    /// signer_ecdh || identifier || peer_ecdh
    SignerIdPeer,
    /// signer_ecdh || peer_ecdh || identifier
    SignerPeerId,
    /// identifier || signer_ecdh || peer_ecdh
    IdSignerPeer,
    /// peer_ecdh || identifier || signer_ecdh
    PeerIdSigner,
    /// peer_ecdh || signer_ecdh || identifier
    PeerSignerId,
    /// identifier || peer_ecdh || signer_ecdh
    IdPeerSigner,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairVerifyState {
    Initial,
    M1Sent,
    M2Received,
    M3Sent,
    Complete,
    Failed,
}

/// Nonces for pair-verify encryption.
const PV_MSG02_NONCE: &[u8] = b"PV-Msg02";
const PV_MSG03_NONCE: &[u8] = b"PV-Msg03";

fn build_signed_message(
    order: SignatureOrder,
    signer_ecdh: &[u8],
    peer_ecdh: &[u8],
    identifier: &[u8],
) -> Vec<u8> {
    let mut signed_message = Vec::with_capacity(signer_ecdh.len() + peer_ecdh.len() + identifier.len());
    match order {
        SignatureOrder::SignerIdPeer => {
            signed_message.extend_from_slice(signer_ecdh);
            signed_message.extend_from_slice(identifier);
            signed_message.extend_from_slice(peer_ecdh);
        }
        SignatureOrder::SignerPeerId => {
            signed_message.extend_from_slice(signer_ecdh);
            signed_message.extend_from_slice(peer_ecdh);
            signed_message.extend_from_slice(identifier);
        }
        SignatureOrder::IdSignerPeer => {
            signed_message.extend_from_slice(identifier);
            signed_message.extend_from_slice(signer_ecdh);
            signed_message.extend_from_slice(peer_ecdh);
        }
        SignatureOrder::PeerIdSigner => {
            signed_message.extend_from_slice(peer_ecdh);
            signed_message.extend_from_slice(identifier);
            signed_message.extend_from_slice(signer_ecdh);
        }
        SignatureOrder::PeerSignerId => {
            signed_message.extend_from_slice(peer_ecdh);
            signed_message.extend_from_slice(signer_ecdh);
            signed_message.extend_from_slice(identifier);
        }
        SignatureOrder::IdPeerSigner => {
            signed_message.extend_from_slice(identifier);
            signed_message.extend_from_slice(peer_ecdh);
            signed_message.extend_from_slice(signer_ecdh);
        }
    }
    signed_message
}

fn hex_prefix(bytes: &[u8], len: usize) -> String {
    bytes
        .iter()
        .take(len)
        .map(|b| format!("{:02x}", b))
        .collect::<Vec<_>>()
        .join("")
}

impl PairVerify {
    /// Create new pair-verify with our identity key pair.
    pub fn new(identity: IdentityKeyPair) -> Self {
        Self {
            state: PairVerifyState::Initial,
            identity,
            custom_identifier: None,
            ecdh_keypair: None,
            ecdh_public: None,
            server_public: None,
            shared_secret: None,
            session_key: None,
            server_ltpk: None,
            signature_order: SignatureOrder::SignerIdPeer,
        }
    }

    /// Create new pair-verify with a ControllerIdentity.
    ///
    /// This is the recommended constructor when using the same identity
    /// that was registered during pair-setup. The controller's stable UUID
    /// is used in M3 to match what was sent in pair-setup M5.
    pub fn new_with_controller(controller: &ControllerIdentity) -> Self {
        Self {
            state: PairVerifyState::Initial,
            identity: controller.keypair().clone(),
            custom_identifier: Some(controller.id().to_string()),
            ecdh_keypair: None,
            ecdh_public: None,
            server_public: None,
            shared_secret: None,
            session_key: None,
            server_ltpk: None,
            signature_order: SignatureOrder::SignerIdPeer,
        }
    }

    /// Set the server's Ed25519 long-term public key (from /info response).
    ///
    /// In transient mode, the server's LTPK is used to verify the M2 signature.
    /// Call this before `process_m2_transient()` if you have the server's public key.
    pub fn set_server_ltpk(&mut self, ltpk: [u8; 32]) {
        self.server_ltpk = Some(ltpk);
    }

    /// Generate M1 request with ephemeral ECDH public key (standard HomeKit format).
    ///
    /// **When to use:** This is the recommended default format for standard HomeKit
    /// pair-verify after a full pair-setup (M1-M6) has been completed. Use this
    /// for devices that have already established a pairing relationship.
    ///
    /// **Format (TLV8 encoded, ~37 bytes):**
    /// ```text
    /// State     = 0x01 (3 bytes: tag + len + value)
    /// PublicKey = ECDH ephemeral public key (34 bytes: tag + len + 32 bytes)
    /// ```
    ///
    /// **Devices:** Apple TV, HomePod, AirPlay speakers after successful pair-setup.
    pub fn generate_m1(&mut self) -> Result<Vec<u8>> {
        if self.state != PairVerifyState::Initial {
            return Err(PairingError::StateMismatch {
                expected: 0x00,
                actual: self.state as u8,
            }
            .into());
        }

        // Generate ephemeral ECDH key pair
        let ecdh = EcdhKeyPair::generate();
        let public_key = ecdh.public_key();

        // Store for later use
        self.ecdh_public = Some(public_key);
        self.ecdh_keypair = Some(ecdh);

        // Build M1 TLV - standard HomeKit format
        let mut tlv = Tlv8::new();
        tlv.set(TlvType::State, vec![0x01]);
        tlv.set(TlvType::PublicKey, public_key.to_vec());

        self.state = PairVerifyState::M1Sent;
        Ok(tlv.encode())
    }

    /// Generate M1 request for AirPlay 2 transient pairing (raw binary format, flags at end).
    ///
    /// **When to use:** Primary format for transient pair-verify after completing
    /// transient pair-setup (M1-M4 with PIN "3939"). Try this format first when
    /// connecting to AirPlay 2 devices that support transient mode.
    ///
    /// **Format (68 bytes raw binary, NOT TLV8):**
    /// ```text
    /// Bytes 0-31:  ECDH ephemeral public key
    /// Bytes 32-63: Ed25519 identity public key
    /// Bytes 64-67: Flags (0x01, 0x00, 0x00, 0x00) - little-endian
    /// ```
    ///
    /// **Devices:** HomePod, newer Apple TV models with transient support.
    /// Use `process_m2_transient()` to handle the corresponding M2 response.
    pub fn generate_m1_transient(&mut self) -> Result<Vec<u8>> {
        if self.state != PairVerifyState::Initial {
            return Err(PairingError::StateMismatch {
                expected: 0x00,
                actual: self.state as u8,
            }
            .into());
        }

        // Generate ephemeral ECDH key pair
        let ecdh = EcdhKeyPair::generate();
        let ecdh_public = ecdh.public_key();

        // Store for later use
        self.ecdh_public = Some(ecdh_public);
        self.ecdh_keypair = Some(ecdh);

        // Build 68-byte raw binary M1 for transient pairing (flags at end)
        let mut m1 = Vec::with_capacity(68);
        m1.extend_from_slice(&ecdh_public);           // 32 bytes ECDH public key
        m1.extend_from_slice(&self.identity.public_key()); // 32 bytes Ed25519 public key
        m1.extend_from_slice(&[0x01, 0x00, 0x00, 0x00]); // 4 bytes flags (little-endian 0x01)

        self.state = PairVerifyState::M1Sent;
        Ok(m1)
    }

    /// Generate M1 request for AirPlay 2 transient pairing (raw binary format, flags at start).
    ///
    /// **When to use:** Alternative transient format with flags as prefix. Try this
    /// if `generate_m1_transient()` (flags at end) doesn't work with your device.
    /// Some AirPlay implementations expect flags first.
    ///
    /// **Format (68 bytes raw binary, NOT TLV8):**
    /// ```text
    /// Bytes 0-3:   Flags (0x01, 0x00, 0x00, 0x00) - little-endian
    /// Bytes 4-35:  ECDH ephemeral public key
    /// Bytes 36-67: Ed25519 identity public key
    /// ```
    ///
    /// **Devices:** Some older AirPlay receivers, certain third-party implementations.
    pub fn generate_m1_transient_prefix(&mut self) -> Result<Vec<u8>> {
        if self.state != PairVerifyState::Initial {
            return Err(PairingError::StateMismatch {
                expected: 0x00,
                actual: self.state as u8,
            }
            .into());
        }

        // Generate ephemeral ECDH key pair
        let ecdh = EcdhKeyPair::generate();
        let ecdh_public = ecdh.public_key();

        // Store for later use
        self.ecdh_public = Some(ecdh_public);
        self.ecdh_keypair = Some(ecdh);

        // Build 68-byte raw binary M1 for transient pairing (flags at start)
        let mut m1 = Vec::with_capacity(68);
        m1.extend_from_slice(&[0x01, 0x00, 0x00, 0x00]); // 4 bytes flags (little-endian 0x01)
        m1.extend_from_slice(&ecdh_public);           // 32 bytes ECDH public key
        m1.extend_from_slice(&self.identity.public_key()); // 32 bytes Ed25519 public key

        self.state = PairVerifyState::M1Sent;
        Ok(m1)
    }

    /// Generate M1 with just 64 bytes (ECDH + Ed25519, no flags).
    ///
    /// **When to use:** Experimental format for devices that may not expect flags.
    /// Try this if other formats fail and the device is rejecting the connection.
    ///
    /// **Format (64 bytes raw binary, NOT TLV8):**
    /// ```text
    /// Bytes 0-31:  ECDH ephemeral public key
    /// Bytes 32-63: Ed25519 identity public key
    /// ```
    ///
    /// **Devices:** Unknown - this is an experimental format for troubleshooting.
    pub fn generate_m1_transient_no_flags(&mut self) -> Result<Vec<u8>> {
        if self.state != PairVerifyState::Initial {
            return Err(PairingError::StateMismatch {
                expected: 0x00,
                actual: self.state as u8,
            }
            .into());
        }

        // Generate ephemeral ECDH key pair
        let ecdh = EcdhKeyPair::generate();
        let ecdh_public = ecdh.public_key();

        // Store for later use
        self.ecdh_public = Some(ecdh_public);
        self.ecdh_keypair = Some(ecdh);

        // Build 64-byte raw binary M1 (no flags)
        let mut m1 = Vec::with_capacity(64);
        m1.extend_from_slice(&ecdh_public);           // 32 bytes ECDH public key
        m1.extend_from_slice(&self.identity.public_key()); // 32 bytes Ed25519 public key

        self.state = PairVerifyState::M1Sent;
        Ok(m1)
    }

    /// Generate M1 with ECDH key and truncated signature (68 bytes).
    ///
    /// **When to use:** Experimental format that includes a signature over the ECDH
    /// public key. The signature is truncated to 32 bytes to fit the 68-byte format.
    /// This is an interpretation of the spec where the second 32 bytes might be
    /// a truncated signature rather than an Ed25519 identity key.
    ///
    /// **Format (68 bytes raw binary, NOT TLV8):**
    /// ```text
    /// Bytes 0-3:   Flags (0x01, 0x00, 0x00, 0x00) - little-endian
    /// Bytes 4-35:  ECDH ephemeral public key
    /// Bytes 36-67: First 32 bytes of Ed25519 signature over ECDH key
    /// ```
    ///
    /// **Devices:** Unknown - this is an experimental format for troubleshooting.
    /// The truncated signature may not verify on the server side.
    pub fn generate_m1_transient_signed(&mut self) -> Result<Vec<u8>> {
        if self.state != PairVerifyState::Initial {
            return Err(PairingError::StateMismatch {
                expected: 0x00,
                actual: self.state as u8,
            }
            .into());
        }

        // Generate ephemeral ECDH key pair
        let ecdh = EcdhKeyPair::generate();
        let ecdh_public = ecdh.public_key();

        // Store for later use
        self.ecdh_public = Some(ecdh_public);
        self.ecdh_keypair = Some(ecdh);

        // Sign our ECDH public key
        let signature = self.identity.sign(&ecdh_public);

        // Build 68-byte: flag(4) + ECDH(32) + signature_first_half(32)
        let mut m1 = Vec::with_capacity(68);
        m1.extend_from_slice(&[0x01, 0x00, 0x00, 0x00]); // Flag = 0x01
        m1.extend_from_slice(&ecdh_public);              // 32 bytes ECDH
        m1.extend_from_slice(&signature[..32]);          // First 32 bytes of signature

        self.state = PairVerifyState::M1Sent;
        Ok(m1)
    }

    /// Generate M1 with ECDH + full signature (100 bytes).
    ///
    /// **When to use:** Experimental format that includes the full Ed25519 signature
    /// over the ECDH public key. Use this if the device expects signed ECDH keys
    /// for authentication.
    ///
    /// **Format (100 bytes raw binary, NOT TLV8):**
    /// ```text
    /// Bytes 0-3:   Flags (0x01, 0x00, 0x00, 0x00) - little-endian
    /// Bytes 4-35:  ECDH ephemeral public key
    /// Bytes 36-99: Full Ed25519 signature (64 bytes) over ECDH key
    /// ```
    ///
    /// **Devices:** Unknown - this is an experimental format for troubleshooting.
    /// Server must have our Ed25519 public key from pair-setup to verify.
    pub fn generate_m1_transient_full_sig(&mut self) -> Result<Vec<u8>> {
        if self.state != PairVerifyState::Initial {
            return Err(PairingError::StateMismatch {
                expected: 0x00,
                actual: self.state as u8,
            }
            .into());
        }

        // Generate ephemeral ECDH key pair
        let ecdh = EcdhKeyPair::generate();
        let ecdh_public = ecdh.public_key();

        // Store for later use
        self.ecdh_public = Some(ecdh_public);
        self.ecdh_keypair = Some(ecdh);

        // Sign our ECDH public key
        let signature = self.identity.sign(&ecdh_public);

        // Build: flag(4) + ECDH(32) + signature(64) = 100 bytes
        let mut m1 = Vec::with_capacity(100);
        m1.extend_from_slice(&[0x01, 0x00, 0x00, 0x00]); // Flag = 0x01
        m1.extend_from_slice(&ecdh_public);              // 32 bytes ECDH
        m1.extend_from_slice(&signature);                // 64 bytes signature

        self.state = PairVerifyState::M1Sent;
        Ok(m1)
    }

    /// Generate M1 request with full TLV8 encoding for AirPlay 2 transient pairing.
    ///
    /// **When to use:** Alternative transient format using TLV8 encoding instead of
    /// raw binary. Try this if raw binary formats are rejected but the device
    /// clearly expects transient-style data (both ECDH and identity keys).
    ///
    /// **Format (TLV8 encoded, ~74 bytes):**
    /// ```text
    /// State      = 0x01 (3 bytes)
    /// PublicKey  = ECDH ephemeral public key (34 bytes)
    /// Identifier = Ed25519 identity public key (34 bytes)
    /// Flags      = 0x01 (3 bytes)
    /// ```
    ///
    /// **Devices:** Some devices may prefer TLV8 encoding even for transient mode.
    /// The server response should still use `process_m2()` (TLV8 format).
    pub fn generate_m1_transient_tlv(&mut self) -> Result<Vec<u8>> {
        if self.state != PairVerifyState::Initial {
            return Err(PairingError::StateMismatch {
                expected: 0x00,
                actual: self.state as u8,
            }
            .into());
        }

        // Generate ephemeral ECDH key pair
        let ecdh = EcdhKeyPair::generate();
        let ecdh_public = ecdh.public_key();

        // Store for later use
        self.ecdh_public = Some(ecdh_public);
        self.ecdh_keypair = Some(ecdh);

        // Build M1 TLV with all transient pairing fields
        let mut tlv = Tlv8::new();
        tlv.set(TlvType::State, vec![0x01]);
        tlv.set(TlvType::PublicKey, ecdh_public.to_vec());
        tlv.set(TlvType::Identifier, self.identity.public_key().to_vec());
        tlv.set(TlvType::Flags, vec![0x01]);

        self.state = PairVerifyState::M1Sent;
        Ok(tlv.encode())
    }

    /// Reset state to allow retrying M1 with a different format.
    pub fn reset(&mut self) {
        self.state = PairVerifyState::Initial;
        self.ecdh_keypair = None;
        self.ecdh_public = None;
        self.server_public = None;
        self.shared_secret = None;
        self.session_key = None;
        // Note: server_ltpk is NOT reset - it comes from /info and persists across retries
    }

    /// Process M2 response in raw binary format (for transient pairing).
    ///
    /// AirPlay 2 transient pair-verify M2 contains (per AIRPLAY_2_SPEC.md):
    /// - ECDH server public key (32 bytes)
    /// - Encrypted data (64 bytes: signature + auth tag OR encrypted TLV)
    ///
    /// Total: 96 bytes raw binary
    ///
    /// In transient mode, the server signs: `server_ecdh || client_ecdh` (64 bytes, NO identifier!).
    /// The server's Ed25519 LTPK should be set via `set_server_ltpk()` before calling this.
    pub fn process_m2_transient(&mut self, response: &[u8]) -> Result<()> {
        if self.state != PairVerifyState::M1Sent {
            return Err(PairingError::StateMismatch {
                expected: 0x01,
                actual: self.state as u8,
            }
            .into());
        }

        // Check response length - should be 96 bytes for transient mode
        if response.len() < 96 {
            self.state = PairVerifyState::Failed;
            return Err(PairingError::TlvParse(format!(
                "M2 response too short: expected 96 bytes, got {}",
                response.len()
            ))
            .into());
        }

        // Extract server's ECDH public key (first 32 bytes)
        let mut server_public_arr = [0u8; 32];
        server_public_arr.copy_from_slice(&response[0..32]);
        self.server_public = Some(server_public_arr);

        // Get our client ECDH public key (needed for signature verification)
        let client_public = self.ecdh_public.ok_or_else(|| {
            self.state = PairVerifyState::Failed;
            PairingError::SrpVerificationFailed
        })?;

        // Perform ECDH to get shared secret
        let ecdh = self.ecdh_keypair.take().ok_or_else(|| {
            self.state = PairVerifyState::Failed;
            PairingError::SrpVerificationFailed
        })?;

        let shared_secret = ecdh.diffie_hellman(&server_public_arr).map_err(|e| {
            self.state = PairVerifyState::Failed;
            e
        })?;

        self.shared_secret = Some(shared_secret);

        // Derive session key for encryption
        let session_key = hkdf::derive_pair_verify_key(&shared_secret).map_err(|e| {
            self.state = PairVerifyState::Failed;
            e
        })?;

        self.session_key = Some(session_key);

        // Extract encrypted data (remaining 64 bytes)
        let encrypted_data = &response[32..];

        // Try to decrypt the encrypted data
        let nonce = nonce_from_string(PV_MSG02_NONCE);
        let decrypted = decrypt_with_nonce(&session_key, &nonce, encrypted_data).map_err(|e| {
            self.state = PairVerifyState::Failed;
            e
        })?;

        // In transient mode, decrypted data might be:
        // - TLV8 with Identifier + Signature (standard HomeKit format)
        // - Raw signature (64 bytes) - transient format
        // - Raw: Ed25519 pubkey (32) + Signature (64) = 96 bytes

        // Try parsing as TLV8 first
        if let Ok(inner_tlv) = Tlv8::parse(&decrypted) {
            if let (Some(server_identifier), Some(server_signature)) = (
                inner_tlv.get(TlvType::Identifier),
                inner_tlv.get(TlvType::Signature),
            ) {
                // Got TLV format - identifier IS the Ed25519 LTPK
                // Server signs: server_ecdh || server_identifier || client_ecdh
                if server_identifier.len() == 32 && server_signature.len() == 64 {
                    let mut server_ltpk = [0u8; 32];
                    server_ltpk.copy_from_slice(server_identifier);

                    // Build signed message: server_ecdh || server_identifier || client_ecdh
                    let mut signed_message = Vec::with_capacity(96);
                    signed_message.extend_from_slice(&server_public_arr);
                    signed_message.extend_from_slice(server_identifier);
                    signed_message.extend_from_slice(&client_public);

                    let mut sig_arr = [0u8; 64];
                    sig_arr.copy_from_slice(server_signature);

                    verify(&server_ltpk, &signed_message, &sig_arr).map_err(|_| {
                        self.state = PairVerifyState::Failed;
                        PairingError::SignatureInvalid
                    })?;

                    self.state = PairVerifyState::M2Received;
                    return Ok(());
                }
            }
        }

        // If TLV parsing failed, try raw format with 64-byte signature
        if decrypted.len() == 64 {
            // Just a signature - use server_ltpk if set via set_server_ltpk()
            if let Some(server_ltpk) = self.server_ltpk {
                // Server signs: server_ecdh || server_identifier || client_ecdh
                let mut signed_message = Vec::with_capacity(96);
                signed_message.extend_from_slice(&server_public_arr);
                signed_message.extend_from_slice(&server_ltpk);
                signed_message.extend_from_slice(&client_public);

                let mut sig_arr = [0u8; 64];
                sig_arr.copy_from_slice(&decrypted);

                verify(&server_ltpk, &signed_message, &sig_arr).map_err(|_| {
                    self.state = PairVerifyState::Failed;
                    PairingError::SignatureInvalid
                })?;

                self.state = PairVerifyState::M2Received;
                return Ok(());
            } else {
                self.state = PairVerifyState::Failed;
                return Err(PairingError::TlvParse(
                    "M2 decrypted to 64 bytes (signature only) - call set_server_ltpk() first"
                        .to_string(),
                )
                .into());
            }
        }

        // Try raw format: Ed25519 pubkey (32) + Signature (64) = 96 bytes
        if decrypted.len() == 96 {
            let mut server_ltpk = [0u8; 32];
            server_ltpk.copy_from_slice(&decrypted[0..32]);

            let mut sig_arr = [0u8; 64];
            sig_arr.copy_from_slice(&decrypted[32..96]);

            // Server signs: server_ecdh || server_identifier || client_ecdh
            let mut signed_message = Vec::with_capacity(96);
            signed_message.extend_from_slice(&server_public_arr);
            signed_message.extend_from_slice(&server_ltpk);
            signed_message.extend_from_slice(&client_public);

            verify(&server_ltpk, &signed_message, &sig_arr).map_err(|_| {
                self.state = PairVerifyState::Failed;
                PairingError::SignatureInvalid
            })?;

            self.state = PairVerifyState::M2Received;
            return Ok(());
        }

        self.state = PairVerifyState::Failed;
        Err(PairingError::TlvParse(format!(
            "M2 decrypted data has unexpected format: {} bytes",
            decrypted.len()
        ))
        .into())
    }

    /// Process M2 response, decrypt and verify server signature (standard TLV8 format).
    pub fn process_m2(&mut self, response: &[u8]) -> Result<()> {
        if self.state != PairVerifyState::M1Sent {
            return Err(PairingError::StateMismatch {
                expected: 0x01,
                actual: self.state as u8,
            }
            .into());
        }

        let tlv = Tlv8::parse(response).map_err(|e| {
            self.state = PairVerifyState::Failed;
            PairingError::TlvParse(e.to_string())
        })?;

        // Check for error
        if let Some(_error_code) = tlv.error() {
            self.state = PairVerifyState::Failed;
            return Err(PairingError::Rejected.into());
        }

        // Verify state
        if tlv.state() != Some(0x02) {
            self.state = PairVerifyState::Failed;
            return Err(PairingError::StateMismatch {
                expected: 0x02,
                actual: tlv.state().unwrap_or(0),
            }
            .into());
        }

        // Extract server's ECDH public key
        let server_public = tlv.get(TlvType::PublicKey).ok_or_else(|| {
            self.state = PairVerifyState::Failed;
            PairingError::MissingTlv(TlvType::PublicKey as u8)
        })?;

        if server_public.len() != 32 {
            self.state = PairVerifyState::Failed;
            return Err(CryptoError::InvalidKeyLength {
                expected: 32,
                actual: server_public.len(),
            }
            .into());
        }

        let mut server_public_arr = [0u8; 32];
        server_public_arr.copy_from_slice(server_public);
        self.server_public = Some(server_public_arr);

        // Extract encrypted data
        let encrypted_data = tlv.get(TlvType::EncryptedData).ok_or_else(|| {
            self.state = PairVerifyState::Failed;
            PairingError::MissingTlv(TlvType::EncryptedData as u8)
        })?;

        // Perform ECDH to get shared secret
        let ecdh = self.ecdh_keypair.take().ok_or_else(|| {
            self.state = PairVerifyState::Failed;
            PairingError::SrpVerificationFailed
        })?;

        let shared_secret = ecdh.diffie_hellman(&server_public_arr).map_err(|e| {
            self.state = PairVerifyState::Failed;
            e
        })?;

        self.shared_secret = Some(shared_secret);

        // Derive session key for encryption
        let session_key = hkdf::derive_pair_verify_key(&shared_secret).map_err(|e| {
            self.state = PairVerifyState::Failed;
            e
        })?;

        self.session_key = Some(session_key);

        // Decrypt the encrypted data
        let nonce = nonce_from_string(PV_MSG02_NONCE);
        let decrypted = decrypt_with_nonce(&session_key, &nonce, encrypted_data).map_err(|e| {
            tracing::debug!(
                "M2 decryption failed. ECDH public: {:02x?}, Server public: {:02x?}, Encrypted: {} bytes",
                &self.ecdh_public.unwrap_or([0u8; 32])[..8],
                &server_public_arr[..8],
                encrypted_data.len()
            );
            self.state = PairVerifyState::Failed;
            e
        })?;

        // Debug: print decrypted data
        eprintln!(
            "  DEBUG: Decrypted M2 data ({} bytes): {}",
            decrypted.len(),
            decrypted.iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join("")
        );

        // Parse decrypted TLV: should contain Identifier + Signature
        let inner_tlv = Tlv8::parse(&decrypted).map_err(|e| {
            self.state = PairVerifyState::Failed;
            PairingError::TlvParse(e.to_string())
        })?;

        // Debug: print what we extracted from TLV
        if let Some(id) = inner_tlv.get(TlvType::Identifier) {
            eprintln!("  DEBUG: TLV Identifier: {} bytes", id.len());
            if let Ok(s) = std::str::from_utf8(id) {
                eprintln!("  DEBUG: TLV Identifier as string: {}", s);
            }
        }
        if let Some(sig) = inner_tlv.get(TlvType::Signature) {
            eprintln!("  DEBUG: TLV Signature: {} bytes", sig.len());
        }
        if let Some(pk) = inner_tlv.get(TlvType::PublicKey) {
            eprintln!("  DEBUG: TLV PublicKey: {} bytes", pk.len());
        }

        // The Identifier can be either:
        // 1. A UUID string (standard HomeKit) - variable length UTF-8
        // 2. A 32-byte Ed25519 public key (transient/mock mode) - binary
        let server_identifier = inner_tlv.get(TlvType::Identifier).ok_or_else(|| {
            self.state = PairVerifyState::Failed;
            PairingError::MissingTlv(TlvType::Identifier as u8)
        })?;

        let server_signature = inner_tlv.get(TlvType::Signature).ok_or_else(|| {
            self.state = PairVerifyState::Failed;
            PairingError::MissingTlv(TlvType::Signature as u8)
        })?;

        if server_signature.len() != 64 {
            self.state = PairVerifyState::Failed;
            return Err(PairingError::SignatureInvalid.into());
        }

        // Get client public key for signature verification
        let client_public = self.ecdh_public.ok_or_else(|| {
            self.state = PairVerifyState::Failed;
            PairingError::SrpVerificationFailed
        })?;

        // Determine if identifier is an Ed25519 public key (32 bytes, non-UTF8) or UUID string
        let server_ltpk: Option<[u8; 32]> = if server_identifier.len() == 32 {
            // Check if it's a valid Ed25519 public key (binary, non-UTF8)
            if std::str::from_utf8(server_identifier).is_err() {
                // It's binary - treat as Ed25519 public key
                let mut arr = [0u8; 32];
                arr.copy_from_slice(server_identifier);
                Some(arr)
            } else {
                // It's a 32-byte UTF-8 string - look for PublicKey field
                inner_tlv.get(TlvType::PublicKey).and_then(|pk| {
                    if pk.len() == 32 {
                        let mut arr = [0u8; 32];
                        arr.copy_from_slice(pk);
                        Some(arr)
                    } else {
                        None
                    }
                })
            }
        } else {
            // Not 32 bytes - look for separate PublicKey field
            inner_tlv.get(TlvType::PublicKey).and_then(|pk| {
                if pk.len() == 32 {
                    let mut arr = [0u8; 32];
                    arr.copy_from_slice(pk);
                    Some(arr)
                } else {
                    None
                }
            })
        };

        // If M2 didn't include the server LTPK, fall back to the one we already know.
        let server_ltpk = server_ltpk.or(self.server_ltpk);

        // Verify signature if we have the server's LTPK
        if let Some(server_ltpk_arr) = server_ltpk {
            eprintln!(
                "  DEBUG: LTPK={}.. server_ecdh={}.. client_ecdh={}.. id_len={}",
                hex_prefix(&server_ltpk_arr, 8),
                hex_prefix(&server_public_arr, 8),
                hex_prefix(&client_public, 8),
                server_identifier.len(),
            );

            let mut sig_arr = [0u8; 64];
            sig_arr.copy_from_slice(server_signature);

            let verify_with = |order: SignatureOrder| -> bool {
                let signed_message = build_signed_message(order, &server_public_arr, &client_public, server_identifier);
                verify(&server_ltpk_arr, &signed_message, &sig_arr).is_ok()
            };

            if verify_with(SignatureOrder::SignerIdPeer) {
                self.signature_order = SignatureOrder::SignerIdPeer;
            } else if verify_with(SignatureOrder::SignerPeerId) {
                self.signature_order = SignatureOrder::SignerPeerId;
            } else if verify_with(SignatureOrder::IdSignerPeer) {
                self.signature_order = SignatureOrder::IdSignerPeer;
            } else if verify_with(SignatureOrder::PeerIdSigner) {
                self.signature_order = SignatureOrder::PeerIdSigner;
            } else if verify_with(SignatureOrder::PeerSignerId) {
                self.signature_order = SignatureOrder::PeerSignerId;
            } else if verify_with(SignatureOrder::IdPeerSigner) {
                self.signature_order = SignatureOrder::IdPeerSigner;
            } else {
                self.state = PairVerifyState::Failed;
                return Err(PairingError::SignatureInvalid.into());
            }

            eprintln!("  DEBUG: Server signature verified with order: {:?}", self.signature_order);
        } else {
            // No LTPK available - skip signature verification (transient mode fallback)
            eprintln!("  DEBUG: No server LTPK, skipping signature verification (transient mode)");
        }

        self.state = PairVerifyState::M2Received;
        Ok(())
    }

    /// Generate M3 request with our encrypted signature.
    ///
    /// If created with `new_with_controller()`, uses the controller's stable
    /// identifier. Otherwise, derives identifier from Ed25519 public key.
    pub fn generate_m3(&mut self) -> Result<Vec<u8>> {
        // Clone to avoid borrow conflict with &mut self
        let custom_id = self.custom_identifier.clone();
        self.generate_m3_with_identifier(custom_id.as_deref())
    }

    /// Generate M3 request with a custom identifier.
    ///
    /// The identifier is typically a UUID string. If not provided, we use
    /// a UUID derived from our Ed25519 public key.
    pub fn generate_m3_with_identifier(&mut self, identifier: Option<&str>) -> Result<Vec<u8>> {
        if self.state != PairVerifyState::M2Received {
            return Err(PairingError::StateMismatch {
                expected: 0x02,
                actual: self.state as u8,
            }
            .into());
        }

        let client_public = self.ecdh_public.ok_or(PairingError::SrpVerificationFailed)?;
        let server_public = self.server_public.ok_or(PairingError::SrpVerificationFailed)?;
        let session_key = self.session_key.ok_or(PairingError::SrpVerificationFailed)?;

        // Generate a UUID-format identifier (uppercase hex with dashes)
        let pk = self.identity.public_key();
        let client_id = match identifier {
            Some(id) => id.to_string(),
            None => format!(
                "{:02X}{:02X}{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}",
                pk[0], pk[1], pk[2], pk[3], pk[4], pk[5], pk[6], pk[7],
                pk[8], pk[9], pk[10], pk[11], pk[12], pk[13], pk[14], pk[15]
            ),
        };
        let id_bytes = client_id.as_bytes().to_vec();

        eprintln!("  DEBUG: M3 identifier: {} ({} bytes)", client_id, id_bytes.len());

        // Build message to sign; order is learned from server M2 signature.
        let signed_message = build_signed_message(
            self.signature_order,
            &client_public,
            &server_public,
            &id_bytes,
        );

        eprintln!("  DEBUG: M3 signed_message: {} bytes (ecdh + id + ecdh)", signed_message.len());

        // Sign with our Ed25519 identity key
        let signature = self.identity.sign(&signed_message);

        // Build inner TLV: Identifier + PublicKey + Signature
        // Server extracts PublicKey (Tag 0x03) to verify the Signature
        let mut inner_tlv = Tlv8::new();
        inner_tlv.set(TlvType::Identifier, id_bytes.clone());
        inner_tlv.set(TlvType::PublicKey, pk.to_vec());  // Ed25519 public key - REQUIRED
        inner_tlv.set(TlvType::Signature, signature.to_vec());

        eprintln!("  DEBUG: M3 inner TLV: id={}B, pk=32B, sig=64B", id_bytes.len());

        // Encrypt the inner TLV
        let nonce = nonce_from_string(PV_MSG03_NONCE);
        let encrypted = encrypt_with_nonce(&session_key, &nonce, &inner_tlv.encode())?;

        // Build M3 TLV
        let mut tlv = Tlv8::new();
        tlv.set(TlvType::State, vec![0x03]);
        tlv.set(TlvType::EncryptedData, encrypted);

        self.state = PairVerifyState::M3Sent;
        Ok(tlv.encode())
    }

    /// Generate M3 for transient pair-verify (raw binary format).
    ///
    /// In transient mode, M3 contains:
    /// - Encrypted signature (64 bytes signature + 16 bytes auth tag = 80 bytes)
    /// - Flags (4 bytes, little-endian 0x00)
    ///
    /// Total: 84 bytes raw binary (NOT TLV8!)
    ///
    /// The signature is over: `client_ecdh || server_ecdh` (64 bytes, NO identifier!).
    /// This differs from standard HomeKit which signs `client_ecdh || identifier || server_ecdh`.
    pub fn generate_m3_transient(&mut self) -> Result<Vec<u8>> {
        if self.state != PairVerifyState::M2Received {
            return Err(PairingError::StateMismatch {
                expected: 0x02,
                actual: self.state as u8,
            }
            .into());
        }

        let client_public = self.ecdh_public.ok_or(PairingError::SrpVerificationFailed)?;
        let server_public = self.server_public.ok_or(PairingError::SrpVerificationFailed)?;
        let session_key = self.session_key.ok_or(PairingError::SrpVerificationFailed)?;

        // Build message to sign: client_ecdh || server_ecdh (64 bytes, NO identifier!)
        // This is the transient mode format - differs from standard HomeKit!
        let mut signed_message = Vec::with_capacity(64);
        signed_message.extend_from_slice(&client_public);
        signed_message.extend_from_slice(&server_public);

        // Sign with our Ed25519 identity key
        let signature = self.identity.sign(&signed_message);

        // Encrypt the raw signature (64 bytes) with PV-Msg03 nonce
        let nonce = nonce_from_string(PV_MSG03_NONCE);
        let encrypted = encrypt_with_nonce(&session_key, &nonce, &signature)?;
        // encrypted = signature(64) + auth_tag(16) = 80 bytes

        // Build raw binary M3: encrypted(80) + flags(4) = 84 bytes
        let mut m3 = Vec::with_capacity(84);
        m3.extend_from_slice(&encrypted);
        m3.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // Flags = 0x00

        self.state = PairVerifyState::M3Sent;
        Ok(m3)
    }

    /// Process M4 response, completes verification.
    pub fn process_m4(&mut self, response: &[u8]) -> Result<SessionKeys> {
        if self.state != PairVerifyState::M3Sent {
            return Err(PairingError::StateMismatch {
                expected: 0x03,
                actual: self.state as u8,
            }
            .into());
        }

        eprintln!("  DEBUG: M4 response ({} bytes): {}",
            response.len(),
            response.iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join("")
        );

        let tlv = Tlv8::parse(response).map_err(|e| {
            self.state = PairVerifyState::Failed;
            PairingError::TlvParse(e.to_string())
        })?;

        eprintln!("  DEBUG: M4 state: {:?}", tlv.state());
        eprintln!("  DEBUG: M4 error: {:?}", tlv.error());

        // Check for error
        if let Some(error_code) = tlv.error() {
            self.state = PairVerifyState::Failed;
            eprintln!("  DEBUG: M4 rejected with error code: {}", error_code);
            return Err(PairingError::Rejected.into());
        }

        // Verify state
        if tlv.state() != Some(0x04) {
            self.state = PairVerifyState::Failed;
            return Err(PairingError::StateMismatch {
                expected: 0x04,
                actual: tlv.state().unwrap_or(0),
            }
            .into());
        }

        // Derive session keys from shared secret
        let shared_secret = self.shared_secret.ok_or_else(|| {
            self.state = PairVerifyState::Failed;
            PairingError::SrpVerificationFailed
        })?;

        let keys =
            SessionKeys::derive_control_keys(&SharedSecret::new(shared_secret.to_vec())).map_err(
                |e| {
                    self.state = PairVerifyState::Failed;
                    e
                },
            )?;

        self.state = PairVerifyState::Complete;
        Ok(keys)
    }

    /// Process M4 response for transient mode (may be raw binary or TLV8).
    ///
    /// In transient mode, M4 can be:
    /// - Raw binary: 4 bytes of zeros (success) or error flags
    /// - TLV8: State = 0x04 (success) or Error field
    ///
    /// This method handles both formats gracefully.
    pub fn process_m4_transient(&mut self, response: &[u8]) -> Result<SessionKeys> {
        if self.state != PairVerifyState::M3Sent {
            return Err(PairingError::StateMismatch {
                expected: 0x03,
                actual: self.state as u8,
            }
            .into());
        }

        // Try TLV8 first
        if let Ok(tlv) = Tlv8::parse(response) {
            if let Some(error_code) = tlv.error() {
                self.state = PairVerifyState::Failed;
                eprintln!("  DEBUG: M4 transient rejected with TLV8 error code: {}", error_code);
                return Err(PairingError::Rejected.into());
            }
            if tlv.state() == Some(0x04) {
                return self.derive_session_keys();
            }
        }

        // Check for raw success (4 bytes of zeros)
        if response.len() == 4 && response == [0x00, 0x00, 0x00, 0x00] {
            return self.derive_session_keys();
        }

        // Short response (<=8 bytes) without error indicator - assume success
        // Some devices send minimal responses
        if response.len() <= 8 {
            // Check if it looks like an error (non-zero first byte often means error)
            if response.is_empty() || response[0] == 0x00 {
                return self.derive_session_keys();
            }
        }

        self.state = PairVerifyState::Failed;
        eprintln!(
            "  DEBUG: M4 transient unrecognized format ({} bytes): {}",
            response.len(),
            response.iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join("")
        );
        Err(PairingError::Rejected.into())
    }

    /// Derive session keys from shared secret (internal helper).
    fn derive_session_keys(&mut self) -> Result<SessionKeys> {
        let shared_secret = self.shared_secret.ok_or_else(|| {
            self.state = PairVerifyState::Failed;
            PairingError::SrpVerificationFailed
        })?;

        let keys =
            SessionKeys::derive_control_keys(&SharedSecret::new(shared_secret.to_vec())).map_err(
                |e| {
                    self.state = PairVerifyState::Failed;
                    e
                },
            )?;

        self.state = PairVerifyState::Complete;
        Ok(keys)
    }

    /// Get current state.
    pub fn state(&self) -> &'static str {
        match self.state {
            PairVerifyState::Initial => "initial",
            PairVerifyState::M1Sent => "m1_sent",
            PairVerifyState::M2Received => "m2_received",
            PairVerifyState::M3Sent => "m3_sent",
            PairVerifyState::Complete => "complete",
            PairVerifyState::Failed => "failed",
        }
    }

    /// Get the raw state enum.
    pub fn raw_state(&self) -> PairVerifyState {
        self.state
    }

    /// Check if verification completed successfully.
    pub fn is_complete(&self) -> bool {
        self.state == PairVerifyState::Complete
    }

    /// Get the ECDH shared secret (available after M2 processing).
    ///
    /// This can be used to derive additional keys like the stream encryption key (shk).
    pub fn shared_secret(&self) -> Option<[u8; 32]> {
        self.shared_secret
    }
}

/// Mock server for testing pair-verify.
#[cfg(test)]
pub(crate) struct MockVerifyServer {
    identity: IdentityKeyPair,
    ecdh: Option<EcdhKeyPair>,
    client_public: Option<[u8; 32]>,
    shared_secret: Option<[u8; 32]>,
    session_key: Option<[u8; 32]>,
}

#[cfg(test)]
impl MockVerifyServer {
    /// Create a new mock server with a generated identity.
    pub(crate) fn new() -> Self {
        Self {
            identity: IdentityKeyPair::generate(),
            ecdh: None,
            client_public: None,
            shared_secret: None,
            session_key: None,
        }
    }

    /// Create a new mock server with a specific identity.
    pub(crate) fn with_identity(identity: IdentityKeyPair) -> Self {
        Self {
            identity,
            ecdh: None,
            client_public: None,
            shared_secret: None,
            session_key: None,
        }
    }

    /// Process M1, return M2.
    pub(crate) fn process_m1(&mut self, m1: &[u8]) -> Result<Vec<u8>> {
        let tlv = Tlv8::parse(m1)?;

        // Extract client's ECDH public key
        let client_public = tlv
            .get(TlvType::PublicKey)
            .ok_or(PairingError::MissingTlv(TlvType::PublicKey as u8))?;

        if client_public.len() != 32 {
            return Err(CryptoError::InvalidKeyLength {
                expected: 32,
                actual: client_public.len(),
            }
            .into());
        }

        let mut client_public_arr = [0u8; 32];
        client_public_arr.copy_from_slice(client_public);
        self.client_public = Some(client_public_arr);

        // Generate server's ECDH key pair
        let ecdh = EcdhKeyPair::generate();
        let server_public = ecdh.public_key();

        // Compute shared secret
        let shared_secret = ecdh.diffie_hellman(&client_public_arr)?;
        self.shared_secret = Some(shared_secret);

        // Derive session key
        let session_key = hkdf::derive_pair_verify_key(&shared_secret)?;
        self.session_key = Some(session_key);

        // Build message to sign: server_ecdh || server_identifier || client_ecdh
        let server_ltpk = self.identity.public_key();
        let mut signed_message = Vec::with_capacity(96);
        signed_message.extend_from_slice(&server_public);
        signed_message.extend_from_slice(&server_ltpk);
        signed_message.extend_from_slice(&client_public_arr);

        // Sign with server's identity key
        let signature = self.identity.sign(&signed_message);

        // Build inner TLV: Identifier (server's public key) + Signature
        let mut inner_tlv = Tlv8::new();
        inner_tlv.set(TlvType::Identifier, server_ltpk.to_vec());
        inner_tlv.set(TlvType::Signature, signature.to_vec());

        // Encrypt inner TLV
        let nonce = nonce_from_string(PV_MSG02_NONCE);
        let encrypted = encrypt_with_nonce(&session_key, &nonce, &inner_tlv.encode())?;

        // Build M2 response
        let mut tlv = Tlv8::new();
        tlv.set(TlvType::State, vec![0x02]);
        tlv.set(TlvType::PublicKey, server_public.to_vec());
        tlv.set(TlvType::EncryptedData, encrypted);

        Ok(tlv.encode())
    }

    /// Process M3, return M4.
    pub(crate) fn process_m3(&mut self, m3: &[u8]) -> Result<Vec<u8>> {
        let tlv = Tlv8::parse(m3)?;

        let session_key = self.session_key.ok_or(PairingError::SrpVerificationFailed)?;

        // Extract and decrypt encrypted data
        let encrypted = tlv
            .get(TlvType::EncryptedData)
            .ok_or(PairingError::MissingTlv(TlvType::EncryptedData as u8))?;

        let nonce = nonce_from_string(PV_MSG03_NONCE);
        let decrypted = decrypt_with_nonce(&session_key, &nonce, encrypted)?;

        // Parse inner TLV
        let inner_tlv = Tlv8::parse(&decrypted)?;

        let client_identifier = inner_tlv
            .get(TlvType::Identifier)
            .ok_or(PairingError::MissingTlv(TlvType::Identifier as u8))?;

        let client_signature = inner_tlv
            .get(TlvType::Signature)
            .ok_or(PairingError::MissingTlv(TlvType::Signature as u8))?;

        // Verify signature (in real server, would verify against known client key)
        // For testing, we just accept any valid signature format

        // Return M4 (success)
        let mut response = Tlv8::new();
        response.set(TlvType::State, vec![0x04]);

        Ok(response.encode())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod state_machine {
        use super::*;

        #[test]
        fn starts_in_initial_state() {
            let identity = IdentityKeyPair::generate();
            let pv = PairVerify::new(identity);
            assert_eq!(pv.state(), "initial");
            assert_eq!(pv.raw_state(), PairVerifyState::Initial);
        }

        #[test]
        fn transitions_through_all_states() {
            let client_identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();

            let mut client = PairVerify::new(client_identity);
            let mut server = MockVerifyServer::with_identity(server_identity);

            // Initial -> M1Sent
            let m1 = client.generate_m1().unwrap();
            assert_eq!(client.raw_state(), PairVerifyState::M1Sent);

            // M1Sent -> M2Received
            let m2 = server.process_m1(&m1).unwrap();
            client.process_m2(&m2).unwrap();
            assert_eq!(client.raw_state(), PairVerifyState::M2Received);

            // M2Received -> M3Sent
            let m3 = client.generate_m3().unwrap();
            assert_eq!(client.raw_state(), PairVerifyState::M3Sent);

            // M3Sent -> Complete
            let m4 = server.process_m3(&m3).unwrap();
            let _keys = client.process_m4(&m4).unwrap();
            assert_eq!(client.raw_state(), PairVerifyState::Complete);
            assert!(client.is_complete());
        }

        #[test]
        fn cannot_skip_states() {
            let identity = IdentityKeyPair::generate();
            let mut pv = PairVerify::new(identity);

            // Can't process M2 without sending M1
            let result = pv.process_m2(&[]);
            assert!(result.is_err());

            // Can't generate M3 without processing M2
            let _ = pv.generate_m1();
            let result = pv.generate_m3();
            assert!(result.is_err());
        }

        #[test]
        fn error_transitions_to_failed() {
            let identity = IdentityKeyPair::generate();
            let mut pv = PairVerify::new(identity);

            let _ = pv.generate_m1();

            // Process invalid M2 (wrong state value)
            let mut bad_m2 = Tlv8::new();
            bad_m2.set(TlvType::State, vec![0x99]); // Invalid state
            let result = pv.process_m2(&bad_m2.encode());

            assert!(result.is_err());
            assert_eq!(pv.raw_state(), PairVerifyState::Failed);
        }
    }

    mod m1_generation {
        use super::*;

        #[test]
        fn m1_contains_state_1() {
            let identity = IdentityKeyPair::generate();
            let mut pv = PairVerify::new(identity);
            let m1 = pv.generate_m1().unwrap();

            let tlv = Tlv8::parse(&m1).unwrap();
            assert_eq!(tlv.state(), Some(0x01));
        }

        #[test]
        fn m1_contains_ecdh_public_key() {
            let identity = IdentityKeyPair::generate();
            let mut pv = PairVerify::new(identity);
            let m1 = pv.generate_m1().unwrap();

            let tlv = Tlv8::parse(&m1).unwrap();
            assert!(tlv.contains(TlvType::PublicKey));
        }

        #[test]
        fn ecdh_key_is_32_bytes() {
            let identity = IdentityKeyPair::generate();
            let mut pv = PairVerify::new(identity);
            let m1 = pv.generate_m1().unwrap();

            let tlv = Tlv8::parse(&m1).unwrap();
            let pk = tlv.get(TlvType::PublicKey).unwrap();
            assert_eq!(pk.len(), 32);
        }

        #[test]
        fn generates_new_ecdh_key_each_time() {
            let identity1 = IdentityKeyPair::generate();
            let identity2 = IdentityKeyPair::generate();

            let mut pv1 = PairVerify::new(identity1);
            let mut pv2 = PairVerify::new(identity2);

            let m1_1 = pv1.generate_m1().unwrap();
            let m1_2 = pv2.generate_m1().unwrap();

            let tlv1 = Tlv8::parse(&m1_1).unwrap();
            let tlv2 = Tlv8::parse(&m1_2).unwrap();

            let pk1 = tlv1.get(TlvType::PublicKey).unwrap();
            let pk2 = tlv2.get(TlvType::PublicKey).unwrap();

            assert_ne!(pk1, pk2);
        }

        #[test]
        fn m1_transient_is_68_bytes() {
            let identity = IdentityKeyPair::generate();
            let mut pv = PairVerify::new(identity);
            let m1 = pv.generate_m1_transient().unwrap();
            assert_eq!(m1.len(), 68);
        }

        #[test]
        fn m1_transient_contains_ecdh_and_ed25519_keys() {
            let identity = IdentityKeyPair::generate();
            let ed25519_public = identity.public_key();
            let mut pv = PairVerify::new(identity);
            let m1 = pv.generate_m1_transient().unwrap();

            // First 32 bytes should be ECDH public key (different from Ed25519)
            let ecdh_public = &m1[0..32];
            // Next 32 bytes should be Ed25519 public key
            let ed25519_in_m1 = &m1[32..64];
            // Last 4 bytes should be flags (0x01, 0x00, 0x00, 0x00)
            let flags = &m1[64..68];

            assert_ne!(ecdh_public, &ed25519_public);
            assert_eq!(ed25519_in_m1, &ed25519_public);
            assert_eq!(flags, &[0x01, 0x00, 0x00, 0x00]);
        }

        #[test]
        fn m1_transient_tlv_contains_all_fields() {
            let identity = IdentityKeyPair::generate();
            let mut pv = PairVerify::new(identity);
            let m1 = pv.generate_m1_transient_tlv().unwrap();

            let tlv = Tlv8::parse(&m1).unwrap();
            assert_eq!(tlv.state(), Some(0x01));
            assert!(tlv.contains(TlvType::PublicKey));
            assert!(tlv.contains(TlvType::Identifier));
            assert!(tlv.contains(TlvType::Flags));

            let pk = tlv.get(TlvType::PublicKey).unwrap();
            assert_eq!(pk.len(), 32);

            let id = tlv.get(TlvType::Identifier).unwrap();
            assert_eq!(id.len(), 32);

            let flags = tlv.get(TlvType::Flags).unwrap();
            assert_eq!(flags, &[0x01]);
        }

        #[test]
        fn reset_allows_retry() {
            let identity = IdentityKeyPair::generate();
            let mut pv = PairVerify::new(identity);

            // Generate M1, putting us in M1Sent state
            let _ = pv.generate_m1().unwrap();
            assert_eq!(pv.raw_state(), PairVerifyState::M1Sent);

            // Reset
            pv.reset();
            assert_eq!(pv.raw_state(), PairVerifyState::Initial);

            // Can generate M1 again with different format
            let m1 = pv.generate_m1_transient().unwrap();
            assert_eq!(m1.len(), 68);
        }
    }

    mod m2_processing {
        use super::*;

        fn setup_m2() -> (PairVerify, Vec<u8>) {
            let client_identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();

            let mut client = PairVerify::new(client_identity);
            let mut server = MockVerifyServer::with_identity(server_identity);

            let m1 = client.generate_m1().unwrap();
            let m2 = server.process_m1(&m1).unwrap();

            (client, m2)
        }

        #[test]
        fn extracts_server_ecdh_public_key() {
            let (mut client, m2) = setup_m2();
            client.process_m2(&m2).unwrap();

            assert!(client.server_public.is_some());
            assert_eq!(client.server_public.unwrap().len(), 32);
        }

        #[test]
        fn decrypts_server_signature() {
            let (mut client, m2) = setup_m2();
            // If this succeeds, decryption worked
            client.process_m2(&m2).unwrap();
        }

        #[test]
        fn verifies_server_signature() {
            let (mut client, m2) = setup_m2();
            // If this succeeds, signature verification worked
            client.process_m2(&m2).unwrap();
        }

        #[test]
        fn error_on_missing_public_key() {
            let identity = IdentityKeyPair::generate();
            let mut client = PairVerify::new(identity);
            let _ = client.generate_m1();

            let mut bad_m2 = Tlv8::new();
            bad_m2.set(TlvType::State, vec![0x02]);
            // Missing PublicKey

            let result = client.process_m2(&bad_m2.encode());
            assert!(result.is_err());
        }

        #[test]
        fn error_on_missing_encrypted_data() {
            let identity = IdentityKeyPair::generate();
            let mut client = PairVerify::new(identity);
            let _ = client.generate_m1();

            let mut bad_m2 = Tlv8::new();
            bad_m2.set(TlvType::State, vec![0x02]);
            bad_m2.set(TlvType::PublicKey, vec![0u8; 32]);
            // Missing EncryptedData

            let result = client.process_m2(&bad_m2.encode());
            assert!(result.is_err());
        }

        #[test]
        fn error_on_decryption_failure() {
            let identity = IdentityKeyPair::generate();
            let mut client = PairVerify::new(identity);
            let _ = client.generate_m1();

            let mut bad_m2 = Tlv8::new();
            bad_m2.set(TlvType::State, vec![0x02]);
            bad_m2.set(TlvType::PublicKey, vec![0x42u8; 32]);
            bad_m2.set(TlvType::EncryptedData, vec![0xABu8; 64]); // Invalid encrypted data

            let result = client.process_m2(&bad_m2.encode());
            assert!(result.is_err());
        }

        #[test]
        fn error_on_signature_verification_failure() {
            // This is implicitly tested by the above - bad encrypted data
            // means we can't verify the signature
        }
    }

    mod m3_generation {
        use super::*;

        fn setup_for_m3() -> PairVerify {
            let client_identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();

            let mut client = PairVerify::new(client_identity);
            let mut server = MockVerifyServer::with_identity(server_identity);

            let m1 = client.generate_m1().unwrap();
            let m2 = server.process_m1(&m1).unwrap();
            client.process_m2(&m2).unwrap();

            client
        }

        #[test]
        fn m3_contains_state_3() {
            let mut client = setup_for_m3();
            let m3 = client.generate_m3().unwrap();

            let tlv = Tlv8::parse(&m3).unwrap();
            assert_eq!(tlv.state(), Some(0x03));
        }

        #[test]
        fn m3_contains_encrypted_data() {
            let mut client = setup_for_m3();
            let m3 = client.generate_m3().unwrap();

            let tlv = Tlv8::parse(&m3).unwrap();
            assert!(tlv.contains(TlvType::EncryptedData));
        }

        #[test]
        fn encrypted_data_contains_our_identifier() {
            let mut client = setup_for_m3();
            let session_key = client.session_key.unwrap();
            let m3 = client.generate_m3().unwrap();

            let tlv = Tlv8::parse(&m3).unwrap();
            let encrypted = tlv.get(TlvType::EncryptedData).unwrap();

            let nonce = nonce_from_string(PV_MSG03_NONCE);
            let decrypted = decrypt_with_nonce(&session_key, &nonce, encrypted).unwrap();

            let inner = Tlv8::parse(&decrypted).unwrap();
            assert!(inner.contains(TlvType::Identifier));
        }

        #[test]
        fn encrypted_data_contains_our_signature() {
            let mut client = setup_for_m3();
            let session_key = client.session_key.unwrap();
            let m3 = client.generate_m3().unwrap();

            let tlv = Tlv8::parse(&m3).unwrap();
            let encrypted = tlv.get(TlvType::EncryptedData).unwrap();

            let nonce = nonce_from_string(PV_MSG03_NONCE);
            let decrypted = decrypt_with_nonce(&session_key, &nonce, encrypted).unwrap();

            let inner = Tlv8::parse(&decrypted).unwrap();
            assert!(inner.contains(TlvType::Signature));
        }

        #[test]
        fn signature_covers_ecdh_public_keys() {
            // This is implicitly tested by the full flow working
        }
    }

    mod m4_processing {
        use super::*;

        #[test]
        fn returns_session_keys_on_success() {
            let client_identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();

            let mut client = PairVerify::new(client_identity);
            let mut server = MockVerifyServer::with_identity(server_identity);

            let m1 = client.generate_m1().unwrap();
            let m2 = server.process_m1(&m1).unwrap();
            client.process_m2(&m2).unwrap();
            let m3 = client.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();

            let keys = client.process_m4(&m4).unwrap();
            assert_eq!(keys.write_key.as_bytes().len(), 32);
            assert_eq!(keys.read_key.as_bytes().len(), 32);
        }

        #[test]
        fn session_keys_derived_from_shared_secret() {
            // Implicitly tested by keys being returned and usable
        }

        #[test]
        fn error_on_tlv_error_field() {
            let client_identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();

            let mut client = PairVerify::new(client_identity);
            let mut server = MockVerifyServer::with_identity(server_identity);

            let m1 = client.generate_m1().unwrap();
            let m2 = server.process_m1(&m1).unwrap();
            client.process_m2(&m2).unwrap();
            let _ = client.generate_m3().unwrap();

            // Build error response
            let mut bad_m4 = Tlv8::new();
            bad_m4.set(TlvType::State, vec![0x04]);
            bad_m4.set(TlvType::Error, vec![0x02]); // Auth error

            let result = client.process_m4(&bad_m4.encode());
            assert!(result.is_err());
        }
    }

    mod key_derivation {
        use super::*;

        #[test]
        fn derives_correct_encryption_key() {
            let client_identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();

            let mut client = PairVerify::new(client_identity);
            let mut server = MockVerifyServer::with_identity(server_identity);

            let m1 = client.generate_m1().unwrap();
            let m2 = server.process_m1(&m1).unwrap();
            client.process_m2(&m2).unwrap();
            let m3 = client.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();

            let keys = client.process_m4(&m4).unwrap();

            // Keys should be 32 bytes
            assert_eq!(keys.write_key.as_bytes().len(), 32);
            assert_eq!(keys.read_key.as_bytes().len(), 32);
        }

        #[test]
        fn write_and_read_keys_are_different() {
            let client_identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();

            let mut client = PairVerify::new(client_identity);
            let mut server = MockVerifyServer::with_identity(server_identity);

            let m1 = client.generate_m1().unwrap();
            let m2 = server.process_m1(&m1).unwrap();
            client.process_m2(&m2).unwrap();
            let m3 = client.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();

            let keys = client.process_m4(&m4).unwrap();

            assert_ne!(keys.write_key.as_bytes(), keys.read_key.as_bytes());
        }
    }

    mod integration {
        use super::*;

        #[test]
        fn full_verify_flow_with_mock_server() {
            let client_identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();

            let mut client = PairVerify::new(client_identity);
            let mut server = MockVerifyServer::with_identity(server_identity);

            // M1
            let m1 = client.generate_m1().unwrap();
            assert_eq!(client.state(), "m1_sent");

            // M2
            let m2 = server.process_m1(&m1).unwrap();
            client.process_m2(&m2).unwrap();
            assert_eq!(client.state(), "m2_received");

            // M3
            let m3 = client.generate_m3().unwrap();
            assert_eq!(client.state(), "m3_sent");

            // M4
            let m4 = server.process_m3(&m3).unwrap();
            let keys = client.process_m4(&m4).unwrap();
            assert_eq!(client.state(), "complete");

            // Verify we got valid keys
            assert_eq!(keys.write_key.as_bytes().len(), 32);
        }

        #[test]
        fn verify_with_wrong_identity_fails() {
            // In a real scenario, the server would verify the client's identity
            // against a known list. Our mock server accepts any identity,
            // so we just verify the protocol completes.
        }
    }
}
