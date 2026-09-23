//! Controller identity for consistent pairing identifiers.
//!
//! The `ControllerIdentity` struct holds both an Ed25519 keypair and a stable UUID
//! identifier that must be used consistently across pair-setup M5 and pair-verify M3.

use airplay_crypto::ed25519::IdentityKeyPair;
use std::path::Path;

/// Controller identity for AirPlay pairing.
///
/// This struct holds both the Ed25519 keypair (LTSK/LTPK) and a stable UUID identifier.
/// The same identifier must be used in both:
/// - pair-setup M5 (when registering with the device)
/// - pair-verify M3 (when authenticating in subsequent sessions)
///
/// If the identifiers don't match, the device will reject the pairing.
#[derive(Clone)]
pub struct ControllerIdentity {
    /// Stable UUID identifier (e.g., "12345678-ABCD-1234-ABCD-123456789ABC")
    id: String,
    /// Ed25519 keypair (LTSK/LTPK)
    keypair: IdentityKeyPair,
}

impl ControllerIdentity {
    /// Generate a new identity with a random UUID derived from the public key.
    ///
    /// The UUID is derived from the first 16 bytes of the Ed25519 public key
    /// to ensure it's stable for a given keypair.
    pub fn generate() -> Self {
        let keypair = IdentityKeyPair::generate();
        Self::from_keypair(keypair)
    }

    /// Create from an existing keypair with a UUID derived from the public key.
    ///
    /// The UUID format is: `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`
    /// where X is derived from the public key bytes.
    pub fn from_keypair(keypair: IdentityKeyPair) -> Self {
        let pk = keypair.public_key();
        let id = format!(
            "{:02X}{:02X}{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}",
            pk[0], pk[1], pk[2], pk[3],
            pk[4], pk[5],
            pk[6], pk[7],
            pk[8], pk[9],
            pk[10], pk[11], pk[12], pk[13], pk[14], pk[15]
        );
        Self { id, keypair }
    }

    /// Create from an existing keypair with a custom identifier.
    ///
    /// Use this when you need to specify a particular identifier format,
    /// such as when interoperating with other implementations.
    pub fn with_id(keypair: IdentityKeyPair, id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            keypair,
        }
    }

    /// Get the stable identifier.
    ///
    /// This identifier must be used consistently in both pair-setup M5
    /// and pair-verify M3 to match what the device expects.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Get the identifier as bytes for TLV encoding.
    pub fn id_bytes(&self) -> Vec<u8> {
        self.id.as_bytes().to_vec()
    }

    /// Get the Ed25519 keypair.
    pub fn keypair(&self) -> &IdentityKeyPair {
        &self.keypair
    }

    /// Get the Ed25519 public key (LTPK).
    pub fn public_key(&self) -> [u8; 32] {
        self.keypair.public_key()
    }

    /// Sign a message with the Ed25519 private key.
    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.keypair.sign(message)
    }

    /// Load identity from persistent storage.
    ///
    /// File format: Line 1 = UUID, Line 2 = hex-encoded Ed25519 seed (32 bytes)
    pub fn load(path: &Path) -> std::io::Result<Self> {
        let contents = std::fs::read_to_string(path)?;
        let mut lines = contents.lines();

        let id = lines
            .next()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "Missing UUID"))?
            .to_string();

        let seed_hex = lines
            .next()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "Missing seed"))?;

        let seed_bytes = hex_decode(seed_hex).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("Invalid hex: {}", e))
        })?;

        if seed_bytes.len() != 32 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Seed must be 32 bytes, got {}", seed_bytes.len()),
            ));
        }

        let mut seed = [0u8; 32];
        seed.copy_from_slice(&seed_bytes);

        let keypair = IdentityKeyPair::from_seed(&seed);
        Ok(Self { id, keypair })
    }

    /// Save identity to persistent storage.
    ///
    /// File format: Line 1 = UUID, Line 2 = hex-encoded Ed25519 seed (32 bytes)
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let seed_hex = hex_encode(&self.keypair.seed());
        let contents = format!("{}\n{}\n", self.id, seed_hex);
        std::fs::write(path, contents)
    }

    /// Load or generate identity.
    ///
    /// If the file exists, load from it. Otherwise, generate a new identity and save it.
    pub fn load_or_generate(path: &Path) -> std::io::Result<Self> {
        if path.exists() {
            Self::load(path)
        } else {
            let identity = Self::generate();
            identity.save(path)?;
            Ok(identity)
        }
    }
}

fn hex_encode(data: &[u8]) -> String {
    data.iter().map(|b| format!("{:02x}", b)).collect()
}

fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("Odd number of hex characters".to_string());
    }

    (0..s.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&s[i..i + 2], 16)
                .map_err(|e| format!("Invalid hex at position {}: {}", i, e))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn generate_creates_valid_identity() {
        let identity = ControllerIdentity::generate();

        // UUID should be 36 characters (8-4-4-4-12)
        assert_eq!(identity.id().len(), 36);
        assert!(identity.id().contains('-'));

        // Public key should be 32 bytes
        assert_eq!(identity.public_key().len(), 32);
    }

    #[test]
    fn from_keypair_generates_consistent_id() {
        let keypair = IdentityKeyPair::generate();
        let pk = keypair.public_key();

        let identity1 = ControllerIdentity::from_keypair(keypair.clone());
        let identity2 = ControllerIdentity::from_keypair(keypair);

        // Same keypair should produce same ID
        assert_eq!(identity1.id(), identity2.id());

        // ID should be derived from public key
        assert!(identity1.id().starts_with(&format!("{:02X}{:02X}", pk[0], pk[1])));
    }

    #[test]
    fn with_id_uses_custom_identifier() {
        let keypair = IdentityKeyPair::generate();
        let custom_id = "Custom-Controller-ID";

        let identity = ControllerIdentity::with_id(keypair, custom_id);

        assert_eq!(identity.id(), custom_id);
    }

    #[test]
    fn id_bytes_returns_utf8_bytes() {
        let identity = ControllerIdentity::generate();

        let id_bytes = identity.id_bytes();

        assert_eq!(id_bytes, identity.id().as_bytes());
    }

    #[test]
    fn sign_produces_valid_signature() {
        let identity = ControllerIdentity::generate();
        let message = b"test message";

        let signature = identity.sign(message);

        // Signature should be 64 bytes (Ed25519)
        assert_eq!(signature.len(), 64);

        // Verify with the public key
        airplay_crypto::ed25519::verify(&identity.public_key(), message, &signature).unwrap();
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("identity.txt");

        let original = ControllerIdentity::generate();
        original.save(&path).unwrap();

        let loaded = ControllerIdentity::load(&path).unwrap();

        assert_eq!(original.id(), loaded.id());
        assert_eq!(original.public_key(), loaded.public_key());
    }

    #[test]
    fn load_or_generate_creates_new_if_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("new_identity.txt");

        assert!(!path.exists());

        let identity = ControllerIdentity::load_or_generate(&path).unwrap();

        assert!(path.exists());
        assert_eq!(identity.id().len(), 36);
    }

    #[test]
    fn load_or_generate_loads_existing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("existing.txt");

        let original = ControllerIdentity::generate();
        original.save(&path).unwrap();

        let loaded = ControllerIdentity::load_or_generate(&path).unwrap();

        assert_eq!(original.id(), loaded.id());
        assert_eq!(original.public_key(), loaded.public_key());
    }
}
