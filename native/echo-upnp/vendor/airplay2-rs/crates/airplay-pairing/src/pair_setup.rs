//! HomeKit pair-setup protocol (M1-M6).
//!
//! This implements the SRP-6a based pairing flow for HomeKit transient pairing.
//! The protocol establishes a shared secret using the device's PIN.

use airplay_core::error::{Error, PairingError, Result};
use airplay_crypto::{
    chacha::{decrypt_with_nonce, encrypt_with_nonce, nonce_from_string},
    ed25519::IdentityKeyPair,
    hkdf,
    keys::SharedSecret,
    srp::{SrpChallenge, SrpClient, SrpProof},
    tlv::{Tlv8, TlvType},
};

use crate::controller::ControllerIdentity;

/// Pair-setup state machine.
pub struct PairSetup {
    state: PairSetupState,
    pin: String,
    srp_client: Option<SrpClient>,
    srp_proof: Option<SrpProof>,
    session_key: Option<[u8; 32]>,
    /// Transient mode: stop at M4, skip M5/M6
    transient_mode: bool,
    server_identifier: Option<Vec<u8>>,
    server_ltpk: Option<[u8; 32]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PairSetupState {
    Initial,
    M1Sent,
    M2Received,
    M3Sent,
    M4Received,
    M5Sent,
    Complete,
    Failed,
}

/// Nonce for pair-setup M5 encryption.
const PS_MSG05_NONCE: &[u8] = b"PS-Msg05";
/// Nonce for pair-setup M6 decryption.
const PS_MSG06_NONCE: &[u8] = b"PS-Msg06";

impl PairSetup {
    /// Create new pair-setup with PIN.
    pub fn new(pin: &str) -> Self {
        Self {
            state: PairSetupState::Initial,
            pin: pin.to_string(),
            srp_client: None,
            srp_proof: None,
            session_key: None,
            transient_mode: false,
            server_identifier: None,
            server_ltpk: None,
        }
    }

    /// Create new pair-setup for transient mode with PIN "3939".
    ///
    /// Transient mode uses Flags=0x10 (kPairingFlag_Transient) as 4-byte LE in M1
    /// and stops at M4 (no M5/M6 needed). This is the recommended mode for HomePod
    /// and other AirPlay 2 devices that support feature bit 51 (SupportsUnifiedPairSetupAndMFi).
    pub fn new_transient() -> Self {
        Self {
            state: PairSetupState::Initial,
            pin: "3939".to_string(),
            srp_client: None,
            srp_proof: None,
            session_key: None,
            transient_mode: true,
            server_identifier: None,
            server_ltpk: None,
        }
    }

    /// Create new pair-setup with custom PIN in transient mode.
    pub fn new_transient_with_pin(pin: &str) -> Self {
        Self {
            state: PairSetupState::Initial,
            pin: pin.to_string(),
            srp_client: None,
            srp_proof: None,
            session_key: None,
            transient_mode: true,
            server_identifier: None,
            server_ltpk: None,
        }
    }

    /// Check if this is transient mode.
    pub fn is_transient(&self) -> bool {
        self.transient_mode
    }

    /// Generate M1 request.
    ///
    /// M1: {Method=0x00, State=0x01}
    /// In transient mode, automatically includes Flags=0x10 (4-byte LE).
    pub fn generate_m1(&mut self) -> Result<Vec<u8>> {
        self.generate_m1_internal(self.transient_mode)
    }

    /// Generate M1 request with Flags (matching iOS transient format).
    ///
    /// M1: {Method=0x00, State=0x01, Flags=0x10 (4-byte LE)}
    /// The Flags=0x10 (kPairingFlag_Transient) indicates transient pairing mode.
    pub fn generate_m1_with_flags(&mut self) -> Result<Vec<u8>> {
        self.generate_m1_internal(true)
    }

    fn generate_m1_internal(&mut self, with_flags: bool) -> Result<Vec<u8>> {
        if self.state != PairSetupState::Initial {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::InvalidState(
                "M1 can only be generated from Initial state".to_string(),
            )));
        }

        // Create SRP client with "Pair-Setup" identity and PIN as password
        self.srp_client = Some(SrpClient::new(b"Pair-Setup", self.pin.as_bytes()));

        // Build M1 TLV
        let tlv = if with_flags {
            Tlv8::pair_setup_m1_with_flags()
        } else {
            Tlv8::pair_setup_m1()
        };

        self.state = PairSetupState::M1Sent;
        Ok(tlv.encode())
    }

    /// Process M2 response, extracts salt and server public key.
    ///
    /// M2: {State=0x02, Salt(16B), PublicKey(384B)}
    pub fn process_m2(&mut self, response: &[u8]) -> Result<()> {
        if self.state != PairSetupState::M1Sent {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::InvalidState(
                "M2 can only be processed after M1".to_string(),
            )));
        }

        let tlv = Tlv8::parse(response).map_err(|e| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol(format!("Failed to parse M2: {}", e)))
        })?;

        // Check for error
        if let Some(_error_code) = tlv.error() {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::Protocol(
                "Server returned error in M2".to_string(),
            )));
        }

        // Verify state is 2
        if tlv.state() != Some(0x02) {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::Protocol(
                "M2 has wrong state value".to_string(),
            )));
        }

        // Extract salt
        let salt = tlv
            .get(TlvType::Salt)
            .ok_or_else(|| {
                self.state = PairSetupState::Failed;
                Error::Pairing(PairingError::Protocol("M2 missing salt".to_string()))
            })?;

        if salt.len() != 16 {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::Protocol(format!(
                "M2 salt has wrong length: {} (expected 16)",
                salt.len()
            ))));
        }

        // Extract server public key
        let server_pk_raw = tlv
            .get(TlvType::PublicKey)
            .ok_or_else(|| {
                self.state = PairSetupState::Failed;
                Error::Pairing(PairingError::Protocol(
                    "M2 missing server public key".to_string(),
                ))
            })?;

        // SRP-3072 public key should be 384 bytes (3072 bits)
        // Left-pad with zeros if shorter (leading zero bytes may be stripped)
        let server_pk = if server_pk_raw.len() < 384 {
            let mut padded = vec![0u8; 384 - server_pk_raw.len()];
            padded.extend_from_slice(server_pk_raw);
            padded
        } else if server_pk_raw.len() == 384 {
            server_pk_raw.to_vec()
        } else {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::Protocol(format!(
                "M2 public key too long: {} (expected <= 384)",
                server_pk_raw.len()
            ))));
        };

        // Create SRP challenge and compute proof
        let mut salt_arr = [0u8; 16];
        salt_arr.copy_from_slice(salt);

        let challenge = SrpChallenge {
            salt: salt_arr,
            server_public_key: server_pk,
        };

        let srp_client = self.srp_client.as_ref().ok_or_else(|| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol("SRP client not initialized".to_string()))
        })?;

        let proof = srp_client.process_challenge(&challenge).map_err(|e| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol(format!(
                "Failed to process SRP challenge: {}",
                e
            )))
        })?;

        self.srp_proof = Some(proof);
        self.state = PairSetupState::M2Received;
        Ok(())
    }

    /// Generate M3 request with client proof.
    ///
    /// M3: {State=0x03, PublicKey(384B), Proof(64B)}
    pub fn generate_m3(&mut self) -> Result<Vec<u8>> {
        if self.state != PairSetupState::M2Received {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::InvalidState(
                "M3 can only be generated after processing M2".to_string(),
            )));
        }

        let srp_client = self.srp_client.as_ref().ok_or_else(|| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol("SRP client not initialized".to_string()))
        })?;

        let proof = self.srp_proof.as_ref().ok_or_else(|| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol("SRP proof not computed".to_string()))
        })?;

        // Build M3 TLV
        let mut tlv = Tlv8::new();
        tlv.set(TlvType::State, vec![0x03]);
        tlv.set(TlvType::PublicKey, srp_client.public_key());
        tlv.set(TlvType::Proof, proof.client_proof.clone());

        self.state = PairSetupState::M3Sent;
        Ok(tlv.encode())
    }

    /// Process M4 response, verifies server proof.
    ///
    /// M4: {State=0x04, Proof(64B)}
    pub fn process_m4(&mut self, response: &[u8]) -> Result<()> {
        if self.state != PairSetupState::M3Sent {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::InvalidState(
                "M4 can only be processed after M3".to_string(),
            )));
        }

        let tlv = Tlv8::parse(response).map_err(|e| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol(format!("Failed to parse M4: {}", e)))
        })?;

        // Check for error
        if let Some(_error_code) = tlv.error() {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::Protocol(
                "Server returned error in M4 (wrong PIN?)".to_string(),
            )));
        }

        // Verify state is 4
        if tlv.state() != Some(0x04) {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::Protocol(
                "M4 has wrong state value".to_string(),
            )));
        }

        // Extract and verify server proof
        let server_proof = tlv
            .get(TlvType::Proof)
            .ok_or_else(|| {
                self.state = PairSetupState::Failed;
                Error::Pairing(PairingError::Protocol("M4 missing server proof".to_string()))
            })?;

        let srp_client = self.srp_client.as_ref().ok_or_else(|| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol("SRP client not initialized".to_string()))
        })?;

        let proof = self.srp_proof.as_ref().ok_or_else(|| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol("SRP proof not computed".to_string()))
        })?;

        if !srp_client.verify_server_proof(server_proof, &proof.expected_server_proof) {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::Protocol(
                "Server proof verification failed".to_string(),
            )));
        }

        // Derive session key from SRP shared secret
        let session_key = hkdf::derive_pair_setup_key(&proof.shared_secret).map_err(|e| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol(format!(
                "Failed to derive session key: {}",
                e
            )))
        })?;

        self.session_key = Some(session_key);
        self.state = PairSetupState::M4Received;
        Ok(())
    }

    /// Complete transient pairing after M4.
    ///
    /// In transient mode, M5/M6 are not needed. After M4 is processed,
    /// call this method to get the shared secret derived from SRP.
    ///
    /// Returns the shared secret that can be used to derive session keys.
    pub fn complete_transient(&mut self) -> Result<SharedSecret> {
        if self.state != PairSetupState::M4Received {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::InvalidState(
                "complete_transient() can only be called after processing M4".to_string(),
            )));
        }

        if !self.transient_mode {
            return Err(Error::Pairing(PairingError::InvalidState(
                "complete_transient() should only be called in transient mode".to_string(),
            )));
        }

        let proof = self.srp_proof.as_ref().ok_or_else(|| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol("SRP proof not computed".to_string()))
        })?;

        self.state = PairSetupState::Complete;
        Ok(SharedSecret::new(proof.shared_secret.clone()))
    }

    /// Generate M5 request with encrypted identity using ControllerIdentity.
    ///
    /// This is the recommended method that uses a stable UUID identifier.
    /// The same identifier must be used in pair-verify M3 for the device
    /// to recognize this controller.
    ///
    /// M5: {State=0x05, EncryptedData}
    /// EncryptedData contains TLV: {Identifier, PublicKey(Ed25519), Signature}
    pub fn generate_m5_with_controller(&mut self, controller: &ControllerIdentity) -> Result<Vec<u8>> {
        self.generate_m5_internal(&controller.id_bytes(), controller.keypair())
    }

    /// Generate M5 request with encrypted identity (legacy API).
    ///
    /// NOTE: This method uses "Pair-Setup" as the identifier, which may not
    /// match what pair-verify uses. For consistent pairing, use
    /// `generate_m5_with_controller()` instead.
    ///
    /// M5: {State=0x05, EncryptedData}
    /// EncryptedData contains TLV: {Identifier, PublicKey(Ed25519), Signature}
    pub fn generate_m5(&mut self, identity: &IdentityKeyPair) -> Result<Vec<u8>> {
        // For backward compatibility, derive identifier from public key
        let pk = identity.public_key();
        let id = format!(
            "{:02X}{:02X}{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}",
            pk[0], pk[1], pk[2], pk[3],
            pk[4], pk[5],
            pk[6], pk[7],
            pk[8], pk[9],
            pk[10], pk[11], pk[12], pk[13], pk[14], pk[15]
        );
        self.generate_m5_internal(id.as_bytes(), identity)
    }

    fn generate_m5_internal(&mut self, pairing_id: &[u8], identity: &IdentityKeyPair) -> Result<Vec<u8>> {
        if self.state != PairSetupState::M4Received {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::InvalidState(
                "M5 can only be generated after processing M4".to_string(),
            )));
        }

        let session_key = self.session_key.as_ref().ok_or_else(|| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol("Session key not derived".to_string()))
        })?;

        let proof = self.srp_proof.as_ref().ok_or_else(|| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol("SRP proof not computed".to_string()))
        })?;

        // Derive signing key from SRP shared secret
        let ios_device_x = hkdf::derive_key(
            &proof.shared_secret,
            b"Pair-Setup-Controller-Sign-Salt",
            b"Pair-Setup-Controller-Sign-Info",
            32,
        )
        .map_err(|e| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol(format!(
                "Failed to derive signing key: {}",
                e
            )))
        })?;

        // Build message to sign: iOSDeviceX || iOSDevicePairingID || iOSDeviceLTPK
        let mut message = Vec::new();
        message.extend_from_slice(&ios_device_x);
        message.extend_from_slice(pairing_id);
        message.extend_from_slice(&identity.public_key());

        // Sign the message
        let signature = identity.sign(&message);

        // Build inner TLV for encrypted data
        let mut inner_tlv = Tlv8::new();
        inner_tlv.set(TlvType::Identifier, pairing_id.to_vec());
        inner_tlv.set(TlvType::PublicKey, identity.public_key().to_vec());
        inner_tlv.set(TlvType::Signature, signature.to_vec());

        let inner_data = inner_tlv.encode();

        // Encrypt with ChaCha20-Poly1305
        let nonce = nonce_from_string(PS_MSG05_NONCE);
        let encrypted = encrypt_with_nonce(session_key, &nonce, &inner_data).map_err(|e| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol(format!("Failed to encrypt M5: {}", e)))
        })?;

        // Build M5 TLV
        let mut tlv = Tlv8::new();
        tlv.set(TlvType::State, vec![0x05]);
        tlv.set(TlvType::EncryptedData, encrypted);

        self.state = PairSetupState::M5Sent;
        Ok(tlv.encode())
    }

    /// Process M6 response, completes pairing.
    ///
    /// M6: {State=0x06, EncryptedData}
    /// Returns the shared secret for deriving session keys.
    pub fn process_m6(&mut self, response: &[u8]) -> Result<SharedSecret> {
        if self.state != PairSetupState::M5Sent {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::InvalidState(
                "M6 can only be processed after M5".to_string(),
            )));
        }

        let tlv = Tlv8::parse(response).map_err(|e| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol(format!("Failed to parse M6: {}", e)))
        })?;

        // Check for error
        if let Some(_error_code) = tlv.error() {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::Protocol(
                "Server returned error in M6".to_string(),
            )));
        }

        // Verify state is 6
        if tlv.state() != Some(0x06) {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::Protocol(
                "M6 has wrong state value".to_string(),
            )));
        }

        let session_key = self.session_key.as_ref().ok_or_else(|| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol("Session key not derived".to_string()))
        })?;

        let proof = self.srp_proof.as_ref().ok_or_else(|| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol("SRP proof not computed".to_string()))
        })?;

        // Extract and decrypt server's encrypted data
        let encrypted_data = tlv
            .get(TlvType::EncryptedData)
            .ok_or_else(|| {
                self.state = PairSetupState::Failed;
                Error::Pairing(PairingError::Protocol(
                    "M6 missing encrypted data".to_string(),
                ))
            })?;

        let nonce = nonce_from_string(PS_MSG06_NONCE);
        let decrypted = decrypt_with_nonce(session_key, &nonce, encrypted_data).map_err(|e| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol(format!("Failed to decrypt M6: {}", e)))
        })?;

        // Parse inner TLV
        let inner_tlv = Tlv8::parse(&decrypted).map_err(|e| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol(format!(
                "Failed to parse M6 inner TLV: {}",
                e
            )))
        })?;

        // Extract server identity components
        let _server_id = inner_tlv
            .get(TlvType::Identifier)
            .ok_or_else(|| {
                self.state = PairSetupState::Failed;
                Error::Pairing(PairingError::Protocol(
                    "M6 missing server identifier".to_string(),
                ))
            })?;

        let server_pk = inner_tlv
            .get(TlvType::PublicKey)
            .ok_or_else(|| {
                self.state = PairSetupState::Failed;
                Error::Pairing(PairingError::Protocol(
                    "M6 missing server public key".to_string(),
                ))
            })?;

        let server_sig = inner_tlv
            .get(TlvType::Signature)
            .ok_or_else(|| {
                self.state = PairSetupState::Failed;
                Error::Pairing(PairingError::Protocol(
                    "M6 missing server signature".to_string(),
                ))
            })?;

        // Derive accessory signing key
        let accessory_x = hkdf::derive_key(
            &proof.shared_secret,
            b"Pair-Setup-Accessory-Sign-Salt",
            b"Pair-Setup-Accessory-Sign-Info",
            32,
        )
        .map_err(|e| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol(format!(
                "Failed to derive accessory signing key: {}",
                e
            )))
        })?;

        // Build message to verify: AccessoryX || AccessoryPairingID || AccessoryLTPK
        let server_id_bytes = inner_tlv.get(TlvType::Identifier).unwrap();
        let mut message = Vec::new();
        message.extend_from_slice(&accessory_x);
        message.extend_from_slice(server_id_bytes);
        message.extend_from_slice(server_pk);

        // Verify server signature
        if server_pk.len() != 32 {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::Protocol(
                "M6 server public key has wrong length".to_string(),
            )));
        }

        if server_sig.len() != 64 {
            self.state = PairSetupState::Failed;
            return Err(Error::Pairing(PairingError::Protocol(
                "M6 server signature has wrong length".to_string(),
            )));
        }

        let mut server_pk_arr = [0u8; 32];
        server_pk_arr.copy_from_slice(server_pk);
        let mut server_sig_arr = [0u8; 64];
        server_sig_arr.copy_from_slice(server_sig);

        airplay_crypto::ed25519::verify(&server_pk_arr, &message, &server_sig_arr).map_err(|_| {
            self.state = PairSetupState::Failed;
            Error::Pairing(PairingError::Protocol(
                "M6 server signature verification failed".to_string(),
            ))
        })?;

        self.server_identifier = Some(server_id_bytes.to_vec());
        self.server_ltpk = Some(server_pk_arr);
        self.state = PairSetupState::Complete;

        // Return the SRP shared secret
        Ok(SharedSecret::new(proof.shared_secret.clone()))
    }

    /// Get current state.
    pub fn state(&self) -> &'static str {
        match self.state {
            PairSetupState::Initial => "initial",
            PairSetupState::M1Sent => "m1_sent",
            PairSetupState::M2Received => "m2_received",
            PairSetupState::M3Sent => "m3_sent",
            PairSetupState::M4Received => "m4_received",
            PairSetupState::M5Sent => "m5_sent",
            PairSetupState::Complete => "complete",
            PairSetupState::Failed => "failed",
        }
    }

    /// Check if pairing completed successfully.
    pub fn is_complete(&self) -> bool {
        self.state == PairSetupState::Complete
    }

    /// Return the server's pairing identifier extracted from M6, if available.
    pub fn server_identifier(&self) -> Option<&[u8]> {
        self.server_identifier.as_deref()
    }

    /// Return the server's LTPK extracted from M6, if available.
    pub fn server_ltpk(&self) -> Option<[u8; 32]> {
        self.server_ltpk
    }
}

// ============================================================================
// Transient Pair-Setup (Ed25519 key exchange, no SRP, no PIN required)
// ============================================================================

/// State for transient pair-setup flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransientState {
    Initial,
    M1Sent,
    Complete,
    Failed,
}

/// Transient pair-setup protocol (DEPRECATED).
///
/// **DEPRECATED:** This implementation is incorrect. Transient pairing actually
/// uses standard SRP pair-setup (M1-M4) with:
/// - Flags=0x10 (kPairingFlag_Transient) as 4-byte little-endian
/// - PIN "3939" (hardcoded for transient mode)
/// - Stop at M4 - no M5/M6 identity exchange needed
///
/// Use [`PairSetup::new_transient()`] instead, which correctly implements
/// transient pairing as SRP M1-M4 with the transient flag.
///
/// This struct incorrectly implements Ed25519 key exchange, which HomePod
/// does not accept - it responds with an SRP challenge (384-byte public key)
/// instead of a 32-byte Ed25519 key.
#[deprecated(
    since = "0.1.0",
    note = "Use PairSetup::new_transient() instead. This implementation incorrectly uses Ed25519 key exchange; transient pairing actually uses SRP with Flags=0x10."
)]
pub struct TransientPairSetup {
    state: TransientState,
    identity: IdentityKeyPair,
    server_ed25519_public: Option<[u8; 32]>,
    shared_secret: Option<[u8; 32]>,
}

impl TransientPairSetup {
    /// Create a new transient pair-setup with the given Ed25519 identity.
    pub fn new(identity: IdentityKeyPair) -> Self {
        Self {
            state: TransientState::Initial,
            identity,
            server_ed25519_public: None,
            shared_secret: None,
        }
    }

    /// Generate transient M1 request with Ed25519 public key.
    ///
    /// M1: {Method=0x00, State=0x01, Flags=0x10 (4-byte LE), PublicKey=Ed25519(32B)}
    pub fn generate_m1(&mut self) -> Result<Vec<u8>> {
        if self.state != TransientState::Initial {
            self.state = TransientState::Failed;
            return Err(Error::Pairing(PairingError::InvalidState(
                "Transient M1 can only be generated from Initial state".to_string(),
            )));
        }

        // Build M1 TLV with transient flag and Ed25519 public key
        let mut tlv = Tlv8::new();
        tlv.set(TlvType::Method, vec![0x00]); // Pair-Setup
        tlv.set(TlvType::State, vec![0x01]); // M1
        // Transient flag = 0x10 as 4-byte little-endian (same as Tlv8::pair_setup_m1_with_flags)
        tlv.set(TlvType::Flags, vec![0x10, 0x00, 0x00, 0x00]);
        tlv.set(TlvType::PublicKey, self.identity.public_key().to_vec());

        self.state = TransientState::M1Sent;
        Ok(tlv.encode())
    }

    /// Generate transient M1 as raw 32-byte Ed25519 public key (simplest format).
    ///
    /// Some devices may accept just the raw public key without TLV8 wrapper.
    pub fn generate_m1_raw(&mut self) -> Result<Vec<u8>> {
        if self.state != TransientState::Initial {
            self.state = TransientState::Failed;
            return Err(Error::Pairing(PairingError::InvalidState(
                "Transient M1 can only be generated from Initial state".to_string(),
            )));
        }

        self.state = TransientState::M1Sent;
        Ok(self.identity.public_key().to_vec())
    }

    /// Process transient M2 response and derive shared secret.
    ///
    /// M2 formats accepted:
    /// - TLV8: {State=0x02, PublicKey=Ed25519(32B)}
    /// - Raw: Ed25519 public key (32 bytes)
    ///
    /// Returns the shared secret for deriving session keys.
    pub fn process_m2(&mut self, response: &[u8]) -> Result<SharedSecret> {
        if self.state != TransientState::M1Sent {
            self.state = TransientState::Failed;
            return Err(Error::Pairing(PairingError::InvalidState(
                "Transient M2 can only be processed after M1".to_string(),
            )));
        }

        let server_pk = match self.extract_server_public_key(response) {
            Ok(pk) => pk,
            Err(e) => {
                self.state = TransientState::Failed;
                return Err(e);
            }
        };

        if server_pk.len() != 32 {
            self.state = TransientState::Failed;
            return Err(Error::Pairing(PairingError::Protocol(format!(
                "Server Ed25519 public key has wrong length: {} (expected 32)",
                server_pk.len()
            ))));
        }

        let mut server_pk_arr = [0u8; 32];
        server_pk_arr.copy_from_slice(&server_pk);
        self.server_ed25519_public = Some(server_pk_arr);

        // Perform Ed25519→X25519 ECDH to get shared secret
        let shared_secret = self.identity.x25519_dh(&server_pk_arr).map_err(|e| {
            self.state = TransientState::Failed;
            Error::Pairing(PairingError::Protocol(format!(
                "Failed to derive shared secret: {}",
                e
            )))
        })?;

        self.shared_secret = Some(shared_secret);
        self.state = TransientState::Complete;

        // Return the raw shared secret (32 bytes)
        // The caller can use HKDF to derive session keys as needed
        Ok(SharedSecret::new(shared_secret.to_vec()))
    }

    /// Extract server's Ed25519 public key from M2 response.
    fn extract_server_public_key(&self, response: &[u8]) -> Result<Vec<u8>> {
        // Try TLV8 format first
        if let Ok(tlv) = Tlv8::parse(response) {
            // Check for error
            if let Some(error_code) = tlv.error() {
                return Err(Error::Pairing(PairingError::Protocol(format!(
                    "Server returned error in M2: 0x{:02x}",
                    error_code
                ))));
            }

            // Verify state (optional - some servers may not include it)
            if let Some(state) = tlv.state() {
                if state != 0x02 {
                    return Err(Error::Pairing(PairingError::Protocol(format!(
                        "M2 has wrong state: 0x{:02x} (expected 0x02)",
                        state
                    ))));
                }
            }

            // Extract public key
            if let Some(pk) = tlv.get(TlvType::PublicKey) {
                return Ok(pk.to_vec());
            }
        }

        // Fall back to raw format (32 bytes)
        if response.len() == 32 {
            return Ok(response.to_vec());
        }

        Err(Error::Pairing(PairingError::Protocol(format!(
            "Cannot parse M2: not valid TLV8 and not 32 bytes (got {} bytes)",
            response.len()
        ))))
    }

    /// Get current state as string.
    pub fn state(&self) -> &'static str {
        match self.state {
            TransientState::Initial => "initial",
            TransientState::M1Sent => "m1_sent",
            TransientState::Complete => "complete",
            TransientState::Failed => "failed",
        }
    }

    /// Check if transient pairing completed successfully.
    pub fn is_complete(&self) -> bool {
        self.state == TransientState::Complete
    }

    /// Get the server's Ed25519 public key (available after M2 is processed).
    pub fn server_public_key(&self) -> Option<[u8; 32]> {
        self.server_ed25519_public
    }

    /// Get the shared secret (available after successful completion).
    pub fn shared_secret(&self) -> Option<[u8; 32]> {
        self.shared_secret
    }
}

/// Mock SRP server for testing pair-setup.
#[cfg(test)]
pub(crate) struct MockSetupServer {
    identity: IdentityKeyPair,
    salt: [u8; 16],
    srp_server: MockSrpServer,
    client_public_key: Option<Vec<u8>>,
    session_key: Option<[u8; 32]>,
}

#[cfg(test)]
struct MockSrpServer {
    params: airplay_crypto::srp::SrpParams,
    salt: [u8; 16],
    verifier: num_bigint::BigUint,
    private_key: num_bigint::BigUint,
    public_key: num_bigint::BigUint,
    shared_secret: Option<Vec<u8>>,
}

#[cfg(test)]
impl MockSrpServer {
    fn new(identity: &[u8], password: &[u8], salt: [u8; 16]) -> Self {
        use num_bigint::{BigUint, RandBigInt};
        use rand::rngs::OsRng;
        use sha2::{Digest, Sha512};

        let params = airplay_crypto::srp::SrpParams::default();

        // Compute x = H(salt || H(identity || ":" || password))
        let mut hasher = Sha512::new();
        hasher.update(identity);
        hasher.update(b":");
        hasher.update(password);
        let inner_hash = hasher.finalize();

        let mut hasher = Sha512::new();
        hasher.update(&salt);
        hasher.update(&inner_hash);
        let x = BigUint::from_bytes_be(&hasher.finalize());

        // Compute verifier v = g^x mod N
        let verifier = params.g.modpow(&x, &params.n);

        // Generate server private key b
        let b = OsRng.gen_biguint(256);

        // Compute k = H(N || PAD(g))
        let n_bytes = pad_to_n(&params.n);
        let g_bytes = pad_to_n(&params.g);
        let mut hasher = Sha512::new();
        hasher.update(&n_bytes);
        hasher.update(&g_bytes);
        let k = BigUint::from_bytes_be(&hasher.finalize());

        // Server public key B = (k*v + g^b) mod N
        let g_b = params.g.modpow(&b, &params.n);
        let k_v = (&k * &verifier) % &params.n;
        let public_key = (&k_v + &g_b) % &params.n;

        Self {
            params,
            salt,
            verifier,
            private_key: b,
            public_key,
            shared_secret: None,
        }
    }

    fn public_key_bytes(&self) -> Vec<u8> {
        pad_to_n(&self.public_key)
    }

    fn compute_session(&mut self, client_public: &[u8]) -> (Vec<u8>, Vec<u8>) {
        use num_bigint::BigUint;
        use sha2::{Digest, Sha512};

        let a = BigUint::from_bytes_be(client_public);

        // Compute u = H(PAD(A) || PAD(B))
        let a_padded = pad_to_n(&a);
        let b_padded = pad_to_n(&self.public_key);
        let mut hasher = Sha512::new();
        hasher.update(&a_padded);
        hasher.update(&b_padded);
        let u = BigUint::from_bytes_be(&hasher.finalize());

        // S = (A * v^u)^b mod N
        let v_u = self.verifier.modpow(&u, &self.params.n);
        let base = (&a * &v_u) % &self.params.n;
        let s = base.modpow(&self.private_key, &self.params.n);

        // K = H(S)
        let s_padded = pad_to_n(&s);
        let mut hasher = Sha512::new();
        hasher.update(&s_padded);
        let shared_secret = hasher.finalize().to_vec();

        // Compute server proof M2
        // M2 = H(PAD(A) || M1 || K)
        // But we need M1 from client first, so we compute it here

        // First compute M1 = H(H(N) XOR H(g) || H(I) || salt || PAD(A) || PAD(B) || K)
        let n_bytes = pad_to_n(&self.params.n);
        let mut hasher = Sha512::new();
        hasher.update(&n_bytes);
        let h_n = hasher.finalize();

        // IMPORTANT: Apple expects H(g) over the raw generator bytes (e.g., 0x05),
        // NOT H(PAD(g)). This must match the client's compute_m1() implementation.
        let g_bytes = self.params.g.to_bytes_be();
        let mut hasher = Sha512::new();
        hasher.update(&g_bytes);
        let h_g = hasher.finalize();

        let mut xor_result = [0u8; 64];
        for i in 0..64 {
            xor_result[i] = h_n[i] ^ h_g[i];
        }

        let mut hasher = Sha512::new();
        hasher.update(b"Pair-Setup");
        let h_i = hasher.finalize();

        let mut hasher = Sha512::new();
        hasher.update(&xor_result);
        hasher.update(&h_i);
        hasher.update(&self.salt);
        hasher.update(&a_padded);
        hasher.update(&b_padded);
        hasher.update(&shared_secret);
        let m1 = hasher.finalize();

        // M2 = H(PAD(A) || M1 || K)
        let mut hasher = Sha512::new();
        hasher.update(&a_padded);
        hasher.update(&m1);
        hasher.update(&shared_secret);
        let m2 = hasher.finalize().to_vec();

        self.shared_secret = Some(shared_secret.clone());
        (shared_secret, m2)
    }
}

#[cfg(test)]
fn pad_to_n(value: &num_bigint::BigUint) -> Vec<u8> {
    const N_BYTES: usize = 384;
    let bytes = value.to_bytes_be();
    if bytes.len() >= N_BYTES {
        bytes[bytes.len() - N_BYTES..].to_vec()
    } else {
        let mut padded = vec![0u8; N_BYTES - bytes.len()];
        padded.extend_from_slice(&bytes);
        padded
    }
}

#[cfg(test)]
impl MockSetupServer {
    pub(crate) fn new(pin: &str) -> Self {
        use rand::{rngs::OsRng, RngCore};

        let identity = IdentityKeyPair::generate();
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);

        let srp_server = MockSrpServer::new(b"Pair-Setup", pin.as_bytes(), salt);

        Self {
            identity,
            salt,
            srp_server,
            client_public_key: None,
            session_key: None,
        }
    }

    pub(crate) fn generate_m2(&self) -> Vec<u8> {
        let mut tlv = Tlv8::new();
        tlv.set(TlvType::State, vec![0x02]);
        tlv.set(TlvType::Salt, self.salt.to_vec());
        tlv.set(TlvType::PublicKey, self.srp_server.public_key_bytes());
        tlv.encode()
    }

    pub(crate) fn process_m3(&mut self, m3_data: &[u8]) -> Result<Vec<u8>> {
        let tlv = Tlv8::parse(m3_data).map_err(|e| {
            Error::Pairing(PairingError::Protocol(format!("Failed to parse M3: {}", e)))
        })?;

        let client_pk = tlv
            .get(TlvType::PublicKey)
            .ok_or_else(|| Error::Pairing(PairingError::Protocol("M3 missing public key".to_string())))?;

        let _client_proof = tlv
            .get(TlvType::Proof)
            .ok_or_else(|| Error::Pairing(PairingError::Protocol("M3 missing proof".to_string())))?;

        self.client_public_key = Some(client_pk.to_vec());

        let (shared_secret, server_proof) = self.srp_server.compute_session(client_pk);

        // Derive session key
        let session_key = hkdf::derive_pair_setup_key(&shared_secret).map_err(|e| {
            Error::Pairing(PairingError::Protocol(format!(
                "Failed to derive session key: {}",
                e
            )))
        })?;
        self.session_key = Some(session_key);

        // Build M4
        let mut tlv = Tlv8::new();
        tlv.set(TlvType::State, vec![0x04]);
        tlv.set(TlvType::Proof, server_proof);
        Ok(tlv.encode())
    }

    pub(crate) fn process_m5(&self, m5_data: &[u8]) -> Result<Vec<u8>> {
        let tlv = Tlv8::parse(m5_data).map_err(|e| {
            Error::Pairing(PairingError::Protocol(format!("Failed to parse M5: {}", e)))
        })?;

        let encrypted_data = tlv
            .get(TlvType::EncryptedData)
            .ok_or_else(|| {
                Error::Pairing(PairingError::Protocol(
                    "M5 missing encrypted data".to_string(),
                ))
            })?;

        let session_key = self.session_key.as_ref().ok_or_else(|| {
            Error::Pairing(PairingError::Protocol("Session key not derived".to_string()))
        })?;

        // Decrypt M5
        let nonce = nonce_from_string(PS_MSG05_NONCE);
        let _decrypted = decrypt_with_nonce(session_key, &nonce, encrypted_data).map_err(|e| {
            Error::Pairing(PairingError::Protocol(format!("Failed to decrypt M5: {}", e)))
        })?;

        // Get shared secret for deriving accessory signing key
        let shared_secret = self.srp_server.shared_secret.as_ref().ok_or_else(|| {
            Error::Pairing(PairingError::Protocol("Shared secret not computed".to_string()))
        })?;

        // Derive accessory signing key
        let accessory_x = hkdf::derive_key(
            shared_secret,
            b"Pair-Setup-Accessory-Sign-Salt",
            b"Pair-Setup-Accessory-Sign-Info",
            32,
        )
        .map_err(|e| {
            Error::Pairing(PairingError::Protocol(format!(
                "Failed to derive accessory signing key: {}",
                e
            )))
        })?;

        // Build server identity response
        let server_id = b"AirPlay-Server";
        let mut message = Vec::new();
        message.extend_from_slice(&accessory_x);
        message.extend_from_slice(server_id);
        message.extend_from_slice(&self.identity.public_key());

        let signature = self.identity.sign(&message);

        // Build inner TLV
        let mut inner_tlv = Tlv8::new();
        inner_tlv.set(TlvType::Identifier, server_id.to_vec());
        inner_tlv.set(TlvType::PublicKey, self.identity.public_key().to_vec());
        inner_tlv.set(TlvType::Signature, signature.to_vec());

        let inner_data = inner_tlv.encode();

        // Encrypt response
        let nonce = nonce_from_string(PS_MSG06_NONCE);
        let encrypted = encrypt_with_nonce(session_key, &nonce, &inner_data).map_err(|e| {
            Error::Pairing(PairingError::Protocol(format!("Failed to encrypt M6: {}", e)))
        })?;

        // Build M6
        let mut tlv = Tlv8::new();
        tlv.set(TlvType::State, vec![0x06]);
        tlv.set(TlvType::EncryptedData, encrypted);
        Ok(tlv.encode())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod state_machine {
        use super::*;

        #[test]
        fn starts_in_initial_state() {
            let setup = PairSetup::new("1234");
            assert_eq!(setup.state(), "initial");
        }

        #[test]
        fn transitions_to_m1_sent_after_generate_m1() {
            let mut setup = PairSetup::new("1234");
            let _ = setup.generate_m1().unwrap();
            assert_eq!(setup.state(), "m1_sent");
        }

        #[test]
        fn transitions_to_m2_received_after_process_m2() {
            let mut setup = PairSetup::new("1234");
            let server = MockSetupServer::new("1234");

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();

            assert_eq!(setup.state(), "m2_received");
        }

        #[test]
        fn transitions_to_complete_after_process_m6() {
            let mut setup = PairSetup::new("1234");
            let mut server = MockSetupServer::new("1234");
            let identity = IdentityKeyPair::generate();

            // Complete full flow
            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();

            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();

            let m5 = setup.generate_m5(&identity).unwrap();
            let m6 = server.process_m5(&m5).unwrap();
            setup.process_m6(&m6).unwrap();

            assert_eq!(setup.state(), "complete");
            assert!(setup.is_complete());
        }

        #[test]
        fn error_transitions_to_failed() {
            let mut setup = PairSetup::new("1234");
            let _ = setup.generate_m1().unwrap();

            // Try to process invalid M2
            let result = setup.process_m2(&[0x00, 0x01, 0x02]); // Invalid TLV
            assert!(result.is_err());
            assert_eq!(setup.state(), "failed");
        }

        #[test]
        fn cannot_generate_m3_before_m2() {
            let mut setup = PairSetup::new("1234");
            let _ = setup.generate_m1().unwrap();

            // Skip M2, try to generate M3
            let result = setup.generate_m3();
            assert!(result.is_err());
            assert_eq!(setup.state(), "failed");
        }

        #[test]
        fn cannot_process_m4_before_m3() {
            let mut setup = PairSetup::new("1234");
            let server = MockSetupServer::new("1234");

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();

            // Skip M3, try to process M4
            let fake_m4 = {
                let mut tlv = Tlv8::new();
                tlv.set(TlvType::State, vec![0x04]);
                tlv.set(TlvType::Proof, vec![0u8; 64]);
                tlv.encode()
            };

            let result = setup.process_m4(&fake_m4);
            assert!(result.is_err());
            assert_eq!(setup.state(), "failed");
        }
    }

    mod m1_generation {
        use super::*;

        #[test]
        fn m1_contains_state_1() {
            let mut setup = PairSetup::new("1234");
            let m1 = setup.generate_m1().unwrap();
            let tlv = Tlv8::parse(&m1).unwrap();
            assert_eq!(tlv.state(), Some(0x01));
        }

        #[test]
        fn m1_contains_method_0() {
            let mut setup = PairSetup::new("1234");
            let m1 = setup.generate_m1().unwrap();
            let tlv = Tlv8::parse(&m1).unwrap();
            assert_eq!(tlv.get(TlvType::Method), Some([0x00].as_slice()));
        }

        #[test]
        fn m1_is_valid_tlv8() {
            let mut setup = PairSetup::new("1234");
            let m1 = setup.generate_m1().unwrap();
            let result = Tlv8::parse(&m1);
            assert!(result.is_ok());
        }
    }

    mod m2_processing {
        use super::*;

        #[test]
        fn extracts_salt_from_m2() {
            let mut setup = PairSetup::new("1234");
            let server = MockSetupServer::new("1234");

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            let result = setup.process_m2(&m2);
            assert!(result.is_ok());
        }

        #[test]
        fn extracts_server_public_key_from_m2() {
            let mut setup = PairSetup::new("1234");
            let server = MockSetupServer::new("1234");

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();

            let tlv = Tlv8::parse(&m2).unwrap();
            let pk = tlv.get(TlvType::PublicKey).unwrap();
            assert_eq!(pk.len(), 384);
        }

        #[test]
        fn error_on_missing_salt() {
            let mut setup = PairSetup::new("1234");
            let _ = setup.generate_m1().unwrap();

            // M2 without salt
            let mut tlv = Tlv8::new();
            tlv.set(TlvType::State, vec![0x02]);
            tlv.set(TlvType::PublicKey, vec![0u8; 384]);
            let m2 = tlv.encode();

            let result = setup.process_m2(&m2);
            assert!(result.is_err());
        }

        #[test]
        fn error_on_missing_public_key() {
            let mut setup = PairSetup::new("1234");
            let _ = setup.generate_m1().unwrap();

            // M2 without public key
            let mut tlv = Tlv8::new();
            tlv.set(TlvType::State, vec![0x02]);
            tlv.set(TlvType::Salt, vec![0u8; 16]);
            let m2 = tlv.encode();

            let result = setup.process_m2(&m2);
            assert!(result.is_err());
        }

        #[test]
        fn error_on_tlv_error_field() {
            let mut setup = PairSetup::new("1234");
            let _ = setup.generate_m1().unwrap();

            // M2 with error field
            let mut tlv = Tlv8::new();
            tlv.set(TlvType::State, vec![0x02]);
            tlv.set(TlvType::Error, vec![0x02]); // Authentication error
            let m2 = tlv.encode();

            let result = setup.process_m2(&m2);
            assert!(result.is_err());
        }
    }

    mod m3_generation {
        use super::*;

        #[test]
        fn m3_contains_state_3() {
            let mut setup = PairSetup::new("1234");
            let server = MockSetupServer::new("1234");

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();

            let m3 = setup.generate_m3().unwrap();
            let tlv = Tlv8::parse(&m3).unwrap();
            assert_eq!(tlv.state(), Some(0x03));
        }

        #[test]
        fn m3_contains_client_public_key() {
            let mut setup = PairSetup::new("1234");
            let server = MockSetupServer::new("1234");

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();

            let m3 = setup.generate_m3().unwrap();
            let tlv = Tlv8::parse(&m3).unwrap();
            let pk = tlv.get(TlvType::PublicKey).unwrap();
            assert_eq!(pk.len(), 384);
        }

        #[test]
        fn m3_contains_client_proof() {
            let mut setup = PairSetup::new("1234");
            let server = MockSetupServer::new("1234");

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();

            let m3 = setup.generate_m3().unwrap();
            let tlv = Tlv8::parse(&m3).unwrap();
            let proof = tlv.get(TlvType::Proof).unwrap();
            assert_eq!(proof.len(), 64); // SHA-512 output
        }
    }

    mod m4_processing {
        use super::*;

        #[test]
        fn verifies_server_proof() {
            let mut setup = PairSetup::new("1234");
            let mut server = MockSetupServer::new("1234");

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();

            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();

            let result = setup.process_m4(&m4);
            assert!(result.is_ok());
        }

        #[test]
        fn error_on_invalid_proof() {
            let mut setup = PairSetup::new("1234");
            let server = MockSetupServer::new("1234");

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            let _ = setup.generate_m3().unwrap();

            // M4 with invalid proof
            let mut tlv = Tlv8::new();
            tlv.set(TlvType::State, vec![0x04]);
            tlv.set(TlvType::Proof, vec![0xFFu8; 64]); // Wrong proof
            let m4 = tlv.encode();

            let result = setup.process_m4(&m4);
            assert!(result.is_err());
        }

        #[test]
        fn error_on_missing_proof() {
            let mut setup = PairSetup::new("1234");
            let server = MockSetupServer::new("1234");

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            let _ = setup.generate_m3().unwrap();

            // M4 without proof
            let mut tlv = Tlv8::new();
            tlv.set(TlvType::State, vec![0x04]);
            let m4 = tlv.encode();

            let result = setup.process_m4(&m4);
            assert!(result.is_err());
        }
    }

    mod m5_generation {
        use super::*;

        #[test]
        fn m5_contains_state_5() {
            let mut setup = PairSetup::new("1234");
            let mut server = MockSetupServer::new("1234");
            let identity = IdentityKeyPair::generate();

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();

            let m5 = setup.generate_m5(&identity).unwrap();
            let tlv = Tlv8::parse(&m5).unwrap();
            assert_eq!(tlv.state(), Some(0x05));
        }

        #[test]
        fn m5_contains_encrypted_data() {
            let mut setup = PairSetup::new("1234");
            let mut server = MockSetupServer::new("1234");
            let identity = IdentityKeyPair::generate();

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();

            let m5 = setup.generate_m5(&identity).unwrap();
            let tlv = Tlv8::parse(&m5).unwrap();
            assert!(tlv.get(TlvType::EncryptedData).is_some());
        }

        #[test]
        fn encrypted_data_contains_identifier() {
            let mut setup = PairSetup::new("1234");
            let mut server = MockSetupServer::new("1234");
            let identity = IdentityKeyPair::generate();

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();

            let m5 = setup.generate_m5(&identity).unwrap();
            let outer = Tlv8::parse(&m5).unwrap();
            let encrypted = outer.get(TlvType::EncryptedData).unwrap();

            // Decrypt and verify
            let session_key = setup.session_key.as_ref().unwrap();
            let nonce = nonce_from_string(PS_MSG05_NONCE);
            let decrypted = decrypt_with_nonce(session_key, &nonce, encrypted).unwrap();

            let inner = Tlv8::parse(&decrypted).unwrap();
            assert!(inner.get(TlvType::Identifier).is_some());
        }

        #[test]
        fn encrypted_data_contains_public_key() {
            let mut setup = PairSetup::new("1234");
            let mut server = MockSetupServer::new("1234");
            let identity = IdentityKeyPair::generate();

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();

            let m5 = setup.generate_m5(&identity).unwrap();
            let outer = Tlv8::parse(&m5).unwrap();
            let encrypted = outer.get(TlvType::EncryptedData).unwrap();

            // Decrypt and verify
            let session_key = setup.session_key.as_ref().unwrap();
            let nonce = nonce_from_string(PS_MSG05_NONCE);
            let decrypted = decrypt_with_nonce(session_key, &nonce, encrypted).unwrap();

            let inner = Tlv8::parse(&decrypted).unwrap();
            let pk = inner.get(TlvType::PublicKey).unwrap();
            assert_eq!(pk.len(), 32);
        }

        #[test]
        fn encrypted_data_contains_signature() {
            let mut setup = PairSetup::new("1234");
            let mut server = MockSetupServer::new("1234");
            let identity = IdentityKeyPair::generate();

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();

            let m5 = setup.generate_m5(&identity).unwrap();
            let outer = Tlv8::parse(&m5).unwrap();
            let encrypted = outer.get(TlvType::EncryptedData).unwrap();

            // Decrypt and verify
            let session_key = setup.session_key.as_ref().unwrap();
            let nonce = nonce_from_string(PS_MSG05_NONCE);
            let decrypted = decrypt_with_nonce(session_key, &nonce, encrypted).unwrap();

            let inner = Tlv8::parse(&decrypted).unwrap();
            let sig = inner.get(TlvType::Signature).unwrap();
            assert_eq!(sig.len(), 64);
        }
    }

    mod m6_processing {
        use super::*;

        #[test]
        fn decrypts_server_identity() {
            let mut setup = PairSetup::new("1234");
            let mut server = MockSetupServer::new("1234");
            let identity = IdentityKeyPair::generate();

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();
            let m5 = setup.generate_m5(&identity).unwrap();
            let m6 = server.process_m5(&m5).unwrap();

            let result = setup.process_m6(&m6);
            assert!(result.is_ok());
        }

        #[test]
        fn verifies_server_signature() {
            let mut setup = PairSetup::new("1234");
            let mut server = MockSetupServer::new("1234");
            let identity = IdentityKeyPair::generate();

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();
            let m5 = setup.generate_m5(&identity).unwrap();
            let m6 = server.process_m5(&m5).unwrap();

            let result = setup.process_m6(&m6);
            assert!(result.is_ok());
        }

        #[test]
        fn returns_shared_secret_on_success() {
            let mut setup = PairSetup::new("1234");
            let mut server = MockSetupServer::new("1234");
            let identity = IdentityKeyPair::generate();

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();
            let m5 = setup.generate_m5(&identity).unwrap();
            let m6 = server.process_m5(&m5).unwrap();

            let shared_secret = setup.process_m6(&m6).unwrap();
            assert_eq!(shared_secret.as_bytes().len(), 64); // SHA-512 output
        }

        #[test]
        fn error_on_decryption_failure() {
            let mut setup = PairSetup::new("1234");
            let mut server = MockSetupServer::new("1234");
            let identity = IdentityKeyPair::generate();

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();
            let _ = setup.generate_m5(&identity).unwrap();

            // M6 with corrupted encrypted data
            let mut tlv = Tlv8::new();
            tlv.set(TlvType::State, vec![0x06]);
            tlv.set(TlvType::EncryptedData, vec![0xFFu8; 100]);
            let m6 = tlv.encode();

            let result = setup.process_m6(&m6);
            assert!(result.is_err());
        }

        #[test]
        fn error_on_signature_verification_failure() {
            let mut setup = PairSetup::new("1234");
            let mut server = MockSetupServer::new("1234");
            let identity = IdentityKeyPair::generate();

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();
            let _ = setup.generate_m5(&identity).unwrap();

            // Build M6 with wrong signature
            let session_key = setup.session_key.as_ref().unwrap();
            let fake_identity = IdentityKeyPair::generate();

            let mut inner_tlv = Tlv8::new();
            inner_tlv.set(TlvType::Identifier, b"Fake-Server".to_vec());
            inner_tlv.set(TlvType::PublicKey, fake_identity.public_key().to_vec());
            inner_tlv.set(TlvType::Signature, vec![0xFFu8; 64]); // Invalid signature

            let inner_data = inner_tlv.encode();
            let nonce = nonce_from_string(PS_MSG06_NONCE);
            let encrypted = encrypt_with_nonce(session_key, &nonce, &inner_data).unwrap();

            let mut tlv = Tlv8::new();
            tlv.set(TlvType::State, vec![0x06]);
            tlv.set(TlvType::EncryptedData, encrypted);
            let m6 = tlv.encode();

            let result = setup.process_m6(&m6);
            assert!(result.is_err());
        }
    }

    mod integration {
        use super::*;

        #[test]
        fn full_pairing_flow_with_mock_server() {
            let mut setup = PairSetup::new("1234");
            let mut server = MockSetupServer::new("1234");
            let identity = IdentityKeyPair::generate();

            // M1 -> M2
            let m1 = setup.generate_m1().unwrap();
            assert!(!m1.is_empty());
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();

            // M3 -> M4
            let m3 = setup.generate_m3().unwrap();
            assert!(!m3.is_empty());
            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();

            // M5 -> M6
            let m5 = setup.generate_m5(&identity).unwrap();
            assert!(!m5.is_empty());
            let m6 = server.process_m5(&m5).unwrap();
            let shared_secret = setup.process_m6(&m6).unwrap();

            assert!(setup.is_complete());
            assert!(!shared_secret.as_bytes().is_empty());
        }

        #[test]
        fn pairing_with_wrong_pin_fails() {
            let mut setup = PairSetup::new("1234");
            let mut server = MockSetupServer::new("9999"); // Different PIN!

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();

            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();

            // M4 verification should fail because the SRP shared secrets don't match
            let result = setup.process_m4(&m4);
            assert!(result.is_err());
        }
    }

    mod transient_pair_setup {
        use super::*;

        #[test]
        fn starts_in_initial_state() {
            let identity = IdentityKeyPair::generate();
            let setup = TransientPairSetup::new(identity);
            assert_eq!(setup.state(), "initial");
        }

        #[test]
        fn generate_m1_transitions_to_m1_sent() {
            let identity = IdentityKeyPair::generate();
            let mut setup = TransientPairSetup::new(identity);
            let m1 = setup.generate_m1().unwrap();
            assert!(!m1.is_empty());
            assert_eq!(setup.state(), "m1_sent");
        }

        #[test]
        fn m1_is_valid_tlv8() {
            let identity = IdentityKeyPair::generate();
            let mut setup = TransientPairSetup::new(identity);
            let m1 = setup.generate_m1().unwrap();

            let tlv = Tlv8::parse(&m1).unwrap();
            assert_eq!(tlv.state(), Some(0x01));
            assert_eq!(tlv.get(TlvType::Method), Some(&[0x00][..]));
            // Transient flag = 0x10 as 4-byte little-endian
            assert_eq!(tlv.get(TlvType::Flags), Some(&[0x10, 0x00, 0x00, 0x00][..]));

            let pk = tlv.get(TlvType::PublicKey).unwrap();
            assert_eq!(pk.len(), 32);
        }

        #[test]
        fn m1_contains_our_ed25519_public_key() {
            let identity = IdentityKeyPair::generate();
            let ed25519_pk = identity.public_key();
            let mut setup = TransientPairSetup::new(identity);
            let m1 = setup.generate_m1().unwrap();

            let tlv = Tlv8::parse(&m1).unwrap();
            let pk = tlv.get(TlvType::PublicKey).unwrap();
            assert_eq!(pk, &ed25519_pk);
        }

        #[test]
        fn generate_m1_raw_returns_32_bytes() {
            let identity = IdentityKeyPair::generate();
            let mut setup = TransientPairSetup::new(identity);
            let m1 = setup.generate_m1_raw().unwrap();
            assert_eq!(m1.len(), 32);
        }

        #[test]
        fn cannot_generate_m1_twice() {
            let identity = IdentityKeyPair::generate();
            let mut setup = TransientPairSetup::new(identity);
            let _ = setup.generate_m1().unwrap();
            let result = setup.generate_m1();
            assert!(result.is_err());
            assert_eq!(setup.state(), "failed");
        }

        #[test]
        fn process_m2_tlv8_format() {
            let client_identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();

            let mut setup = TransientPairSetup::new(client_identity);
            let _ = setup.generate_m1().unwrap();

            // Server sends back its Ed25519 public key in TLV8 format
            let mut response = Tlv8::new();
            response.set(TlvType::State, vec![0x02]);
            response.set(TlvType::PublicKey, server_identity.public_key().to_vec());
            let m2 = response.encode();

            let result = setup.process_m2(&m2);
            assert!(result.is_ok());
            assert_eq!(setup.state(), "complete");
            assert!(setup.is_complete());
        }

        #[test]
        fn process_m2_raw_format() {
            let client_identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();

            let mut setup = TransientPairSetup::new(client_identity);
            let _ = setup.generate_m1().unwrap();

            // Server sends just 32 bytes raw Ed25519 public key
            let m2 = server_identity.public_key().to_vec();

            let result = setup.process_m2(&m2);
            assert!(result.is_ok());
            assert!(setup.is_complete());
        }

        #[test]
        fn derives_same_shared_secret_as_server() {
            let client_identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();

            // Client side
            let mut client_setup = TransientPairSetup::new(client_identity.clone());
            let _ = client_setup.generate_m1().unwrap();
            let m2 = server_identity.public_key().to_vec();
            let client_secret = client_setup.process_m2(&m2).unwrap();

            // Server side would do the same
            let server_secret = server_identity.x25519_dh(&client_identity.public_key()).unwrap();

            // Both should derive the same shared secret
            assert_eq!(client_secret.as_bytes(), &server_secret);
        }

        #[test]
        fn shared_secret_is_32_bytes() {
            let client_identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();

            let mut setup = TransientPairSetup::new(client_identity);
            let _ = setup.generate_m1().unwrap();
            let m2 = server_identity.public_key().to_vec();
            let secret = setup.process_m2(&m2).unwrap();

            assert_eq!(secret.as_bytes().len(), 32);
        }

        #[test]
        fn stores_server_public_key() {
            let client_identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();
            let server_pk = server_identity.public_key();

            let mut setup = TransientPairSetup::new(client_identity);
            let _ = setup.generate_m1().unwrap();
            setup.process_m2(&server_pk.to_vec()).unwrap();

            assert_eq!(setup.server_public_key(), Some(server_pk));
        }

        #[test]
        fn stores_shared_secret() {
            let client_identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();

            let mut setup = TransientPairSetup::new(client_identity);
            let _ = setup.generate_m1().unwrap();
            setup.process_m2(&server_identity.public_key().to_vec()).unwrap();

            assert!(setup.shared_secret().is_some());
            assert_eq!(setup.shared_secret().unwrap().len(), 32);
        }

        #[test]
        fn error_on_server_error_response() {
            let identity = IdentityKeyPair::generate();
            let mut setup = TransientPairSetup::new(identity);
            let _ = setup.generate_m1().unwrap();

            // Server sends error
            let mut response = Tlv8::new();
            response.set(TlvType::State, vec![0x02]);
            response.set(TlvType::Error, vec![0x02]); // Auth error
            let m2 = response.encode();

            let result = setup.process_m2(&m2);
            assert!(result.is_err());
            assert_eq!(setup.state(), "failed");
        }

        #[test]
        fn error_on_wrong_state_in_m2() {
            let identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();
            let mut setup = TransientPairSetup::new(identity);
            let _ = setup.generate_m1().unwrap();

            // Server sends wrong state
            let mut response = Tlv8::new();
            response.set(TlvType::State, vec![0x04]); // Wrong!
            response.set(TlvType::PublicKey, server_identity.public_key().to_vec());
            let m2 = response.encode();

            let result = setup.process_m2(&m2);
            assert!(result.is_err());
        }

        #[test]
        fn error_on_invalid_public_key_length() {
            let identity = IdentityKeyPair::generate();
            let mut setup = TransientPairSetup::new(identity);
            let _ = setup.generate_m1().unwrap();

            // Server sends wrong length public key
            let mut response = Tlv8::new();
            response.set(TlvType::State, vec![0x02]);
            response.set(TlvType::PublicKey, vec![0u8; 16]); // Wrong length!
            let m2 = response.encode();

            let result = setup.process_m2(&m2);
            assert!(result.is_err());
            assert_eq!(setup.state(), "failed");
        }

        #[test]
        fn cannot_process_m2_before_m1() {
            let identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();
            let mut setup = TransientPairSetup::new(identity);

            let m2 = server_identity.public_key().to_vec();
            let result = setup.process_m2(&m2);

            assert!(result.is_err());
            assert_eq!(setup.state(), "failed");
        }

        #[test]
        fn full_transient_flow() {
            // Simulate the full transient pairing flow
            let client_identity = IdentityKeyPair::generate();
            let server_identity = IdentityKeyPair::generate();

            // Client generates M1
            let mut client = TransientPairSetup::new(client_identity.clone());
            let m1 = client.generate_m1().unwrap();

            // Parse M1 (as server would)
            let m1_tlv = Tlv8::parse(&m1).unwrap();
            let client_pk = m1_tlv.get(TlvType::PublicKey).unwrap();
            assert_eq!(client_pk.len(), 32);
            assert_eq!(client_pk, &client_identity.public_key());

            // Server generates M2 (just sends its Ed25519 public key)
            let mut m2_tlv = Tlv8::new();
            m2_tlv.set(TlvType::State, vec![0x02]);
            m2_tlv.set(TlvType::PublicKey, server_identity.public_key().to_vec());
            let m2 = m2_tlv.encode();

            // Client processes M2
            let client_secret = client.process_m2(&m2).unwrap();
            assert!(client.is_complete());

            // Server would derive same shared secret
            let mut client_pk_arr = [0u8; 32];
            client_pk_arr.copy_from_slice(client_pk);
            let server_secret = server_identity.x25519_dh(&client_pk_arr).unwrap();

            // Both should have the same shared secret
            assert_eq!(client_secret.as_bytes(), &server_secret);
        }
    }

    /// Tests for the correct transient pairing implementation using SRP.
    ///
    /// This tests `PairSetup::new_transient()` which uses SRP M1-M4 with
    /// transient flags, as opposed to the deprecated `TransientPairSetup`
    /// which incorrectly used Ed25519 key exchange.
    mod transient_srp_pair_setup {
        use super::*;

        #[test]
        fn new_transient_uses_pin_3939() {
            // Create transient setup and verify PIN is "3939"
            let setup = PairSetup::new_transient();
            assert!(setup.is_transient());
            // PIN is private, but we can verify behavior by testing with mock server
        }

        #[test]
        fn new_transient_sets_transient_mode_flag() {
            let setup = PairSetup::new_transient();
            assert!(setup.is_transient());
        }

        #[test]
        fn new_transient_with_custom_pin() {
            let setup = PairSetup::new_transient_with_pin("1234");
            assert!(setup.is_transient());
        }

        #[test]
        fn m1_includes_transient_flags() {
            let mut setup = PairSetup::new_transient();
            let m1 = setup.generate_m1().unwrap();

            let tlv = Tlv8::parse(&m1).unwrap();
            assert_eq!(tlv.state(), Some(0x01));
            assert_eq!(tlv.get(TlvType::Method), Some(&[0x00][..]));

            // Transient flag = 0x10 as 4-byte little-endian
            let flags = tlv.get(TlvType::Flags).unwrap();
            assert_eq!(flags, &[0x10, 0x00, 0x00, 0x00]);
        }

        #[test]
        fn m1_without_transient_mode_has_no_flags() {
            let mut setup = PairSetup::new("1234");
            let m1 = setup.generate_m1().unwrap();

            let tlv = Tlv8::parse(&m1).unwrap();
            assert_eq!(tlv.state(), Some(0x01));
            // Non-transient M1 should not have flags
            assert!(tlv.get(TlvType::Flags).is_none());
        }

        #[test]
        fn complete_transient_requires_m4_received_state() {
            let mut setup = PairSetup::new_transient();

            // Try to complete before processing any messages
            let result = setup.complete_transient();
            assert!(result.is_err());
        }

        #[test]
        fn complete_transient_requires_transient_mode() {
            let mut setup = PairSetup::new("1234");
            let mut server = MockSetupServer::new("1234");

            // Complete M1-M4 but in non-transient mode
            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();

            // complete_transient should fail because we're not in transient mode
            let result = setup.complete_transient();
            assert!(result.is_err());
        }

        #[test]
        fn complete_transient_returns_shared_secret() {
            let mut setup = PairSetup::new_transient();
            let mut server = MockSetupServer::new("3939");

            // Complete M1-M4 flow
            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();

            // complete_transient should return the shared secret
            let shared_secret = setup.complete_transient().unwrap();

            // Shared secret from SRP should be 64 bytes (SHA-512 output)
            assert_eq!(shared_secret.as_bytes().len(), 64);
            assert!(!shared_secret.as_bytes().iter().all(|&b| b == 0));
        }

        #[test]
        fn full_transient_m1_m4_flow_with_mock_server() {
            let mut setup = PairSetup::new_transient();
            let mut server = MockSetupServer::new("3939"); // Same PIN

            // M1: Client sends transient flag
            let m1 = setup.generate_m1().unwrap();
            assert!(!m1.is_empty());

            // Verify M1 has transient flag
            let m1_tlv = Tlv8::parse(&m1).unwrap();
            assert_eq!(m1_tlv.get(TlvType::Flags), Some(&[0x10, 0x00, 0x00, 0x00][..]));

            // M2: Server responds with salt + SRP public key
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();

            // M3: Client sends SRP proof
            let m3 = setup.generate_m3().unwrap();
            let m3_tlv = Tlv8::parse(&m3).unwrap();
            assert_eq!(m3_tlv.state(), Some(0x03));

            // M4: Server verifies proof and sends server proof
            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();

            // Complete transient pairing
            let shared_secret = setup.complete_transient().unwrap();
            assert!(setup.is_complete());
            assert_eq!(shared_secret.as_bytes().len(), 64);
        }

        #[test]
        fn transient_flow_with_wrong_pin_fails() {
            let mut setup = PairSetup::new_transient(); // Uses PIN "3939"
            let mut server = MockSetupServer::new("0000"); // Different PIN!

            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();

            // M4 verification should fail because SRP proofs don't match
            let result = setup.process_m4(&m4);
            assert!(result.is_err());
        }

        #[test]
        fn transient_flow_skips_m5_m6() {
            let mut setup = PairSetup::new_transient();
            let mut server = MockSetupServer::new("3939");

            // Complete M1-M4
            let _ = setup.generate_m1().unwrap();
            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            let m3 = setup.generate_m3().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();

            // In transient mode, we complete with complete_transient(), not M5/M6
            let shared_secret = setup.complete_transient();
            assert!(shared_secret.is_ok());

            // State should be "complete" now
            assert!(setup.is_complete());
        }

        #[test]
        fn state_transitions_correctly() {
            let mut setup = PairSetup::new_transient();
            let mut server = MockSetupServer::new("3939");

            assert_eq!(setup.state(), "initial");

            let _ = setup.generate_m1().unwrap();
            assert_eq!(setup.state(), "m1_sent");

            let m2 = server.generate_m2();
            setup.process_m2(&m2).unwrap();
            assert_eq!(setup.state(), "m2_received");

            let m3 = setup.generate_m3().unwrap();
            assert_eq!(setup.state(), "m3_sent");

            let m4 = server.process_m3(&m3).unwrap();
            setup.process_m4(&m4).unwrap();
            assert_eq!(setup.state(), "m4_received");

            setup.complete_transient().unwrap();
            assert_eq!(setup.state(), "complete");
        }

        #[test]
        fn generate_m1_with_flags_explicit_call() {
            // Test that non-transient setup can still use generate_m1_with_flags()
            let mut setup = PairSetup::new("1234");
            let m1 = setup.generate_m1_with_flags().unwrap();

            let tlv = Tlv8::parse(&m1).unwrap();
            let flags = tlv.get(TlvType::Flags).unwrap();
            assert_eq!(flags, &[0x10, 0x00, 0x00, 0x00]);
        }
    }
}
