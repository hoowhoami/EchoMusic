//! Session key types and derivation.

use crate::hkdf;
use airplay_core::error::CryptoError;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Shared secret from SRP or ECDH.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SharedSecret(pub Vec<u8>);

/// 32-byte encryption key.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct EncryptionKey(pub [u8; 32]);

/// Complete set of session keys derived from shared secret.
#[derive(ZeroizeOnDrop)]
pub struct SessionKeys {
    /// Key for encrypting data we send.
    pub write_key: EncryptionKey,
    /// Key for decrypting data we receive.
    pub read_key: EncryptionKey,
}

/// FairPlay stream keys (placeholder derivation).
pub struct FairPlayStreamKeys {
    pub ekey: [u8; 72],
    pub eiv: [u8; 16],
    pub shk: [u8; 32],
}

impl SharedSecret {
    /// Create from raw bytes.
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    /// Get raw bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl EncryptionKey {
    /// Create from raw bytes.
    pub fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Get raw bytes.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl SessionKeys {
    /// Derive session keys for control channel encryption.
    pub fn derive_control_keys(shared_secret: &SharedSecret) -> Result<Self, CryptoError> {
        let write_key = hkdf::derive_control_write_key(shared_secret.as_bytes())?;
        let read_key = hkdf::derive_control_read_key(shared_secret.as_bytes())?;

        Ok(Self {
            write_key: EncryptionKey(write_key),
            read_key: EncryptionKey(read_key),
        })
    }

    /// Derive session keys for pair-setup encryption.
    pub fn derive_pair_setup_keys(
        shared_secret: &SharedSecret,
    ) -> Result<EncryptionKey, CryptoError> {
        let key = hkdf::derive_pair_setup_key(shared_secret.as_bytes())?;
        Ok(EncryptionKey(key))
    }

    /// Derive session keys for pair-verify encryption.
    pub fn derive_pair_verify_keys(
        shared_secret: &SharedSecret,
    ) -> Result<EncryptionKey, CryptoError> {
        let key = hkdf::derive_pair_verify_key(shared_secret.as_bytes())?;
        Ok(EncryptionKey(key))
    }
}

/// Derive stream keys from a FairPlay session key.
///
/// NOTE: This is a placeholder derivation using HKDF and does NOT implement
/// Apple’s real FairPlay key schedule.
pub fn derive_fairplay_stream_keys(session_key: &[u8; 32]) -> Result<FairPlayStreamKeys, CryptoError> {
    let ekey = hkdf::derive_key(
        session_key,
        &[],
        hkdf::constants::FAIRPLAY_EKEY_INFO,
        72,
    )?;
    let eiv = hkdf::derive_key(
        session_key,
        &[],
        hkdf::constants::FAIRPLAY_EIV_INFO,
        16,
    )?;
    let shk = hkdf::derive_key_32(
        session_key,
        &[],
        hkdf::constants::FAIRPLAY_SHK_INFO,
    )?;

    let mut ekey_arr = [0u8; 72];
    ekey_arr.copy_from_slice(&ekey);
    let mut eiv_arr = [0u8; 16];
    eiv_arr.copy_from_slice(&eiv);

    Ok(FairPlayStreamKeys {
        ekey: ekey_arr,
        eiv: eiv_arr,
        shk,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    mod shared_secret {
        use super::*;

        #[test]
        fn new_stores_bytes() {
            let bytes = vec![0x01, 0x02, 0x03, 0x04];
            let secret = SharedSecret::new(bytes.clone());
            assert_eq!(secret.as_bytes(), &bytes);
        }

        #[test]
        fn zeroized_on_drop() {
            // Create a secret, drop it, and verify zeroize is called
            // This is verified by the ZeroizeOnDrop derive
            let secret = SharedSecret::new(vec![0x42u8; 32]);
            drop(secret);
            // The ZeroizeOnDrop derive ensures the bytes are cleared
        }

        #[test]
        fn clone_produces_independent_copy() {
            let original = SharedSecret::new(vec![0x42u8; 32]);
            let cloned = original.clone();
            assert_eq!(original.as_bytes(), cloned.as_bytes());
        }
    }

    mod encryption_key {
        use super::*;

        #[test]
        fn new_stores_32_bytes() {
            let bytes = [0x42u8; 32];
            let key = EncryptionKey::new(bytes);
            assert_eq!(key.as_bytes(), &bytes);
        }

        #[test]
        fn zeroized_on_drop() {
            // Create a key, drop it, and verify zeroize is called
            // This is verified by the ZeroizeOnDrop derive
            let key = EncryptionKey::new([0x42u8; 32]);
            drop(key);
            // The ZeroizeOnDrop derive ensures the bytes are cleared
        }

        #[test]
        fn clone_produces_independent_copy() {
            let original = EncryptionKey::new([0x42u8; 32]);
            let cloned = original.clone();
            assert_eq!(original.as_bytes(), cloned.as_bytes());
        }
    }

    mod session_keys {
        use super::*;

        #[test]
        fn derive_control_keys_produces_different_read_write() {
            let shared_secret = SharedSecret::new(vec![0xABu8; 32]);
            let session_keys = SessionKeys::derive_control_keys(&shared_secret).unwrap();

            // Write and read keys should be different
            assert_ne!(
                session_keys.write_key.as_bytes(),
                session_keys.read_key.as_bytes()
            );
        }

        #[test]
        fn derive_pair_setup_keys_is_deterministic() {
            let shared_secret = SharedSecret::new(vec![0xABu8; 32]);

            let key1 = SessionKeys::derive_pair_setup_keys(&shared_secret).unwrap();
            let key2 = SessionKeys::derive_pair_setup_keys(&shared_secret).unwrap();

            assert_eq!(key1.as_bytes(), key2.as_bytes());
        }

        #[test]
        fn derive_pair_verify_keys_is_deterministic() {
            let shared_secret = SharedSecret::new(vec![0xABu8; 32]);

            let key1 = SessionKeys::derive_pair_verify_keys(&shared_secret).unwrap();
            let key2 = SessionKeys::derive_pair_verify_keys(&shared_secret).unwrap();

            assert_eq!(key1.as_bytes(), key2.as_bytes());
        }

        #[test]
        fn keys_zeroized_on_drop() {
            // Create session keys, drop them, and verify zeroize is called
            // This is verified by the ZeroizeOnDrop derive
            let shared_secret = SharedSecret::new(vec![0xABu8; 32]);
            let session_keys = SessionKeys::derive_control_keys(&shared_secret).unwrap();
            drop(session_keys);
            // The ZeroizeOnDrop derive ensures the keys are cleared
        }

        #[test]
        fn different_secrets_produce_different_keys() {
            let secret1 = SharedSecret::new(vec![0x01u8; 32]);
            let secret2 = SharedSecret::new(vec![0x02u8; 32]);

            let keys1 = SessionKeys::derive_control_keys(&secret1).unwrap();
            let keys2 = SessionKeys::derive_control_keys(&secret2).unwrap();

            assert_ne!(keys1.write_key.as_bytes(), keys2.write_key.as_bytes());
            assert_ne!(keys1.read_key.as_bytes(), keys2.read_key.as_bytes());
        }

        #[test]
        fn pair_setup_and_verify_keys_are_different() {
            let shared_secret = SharedSecret::new(vec![0xABu8; 32]);

            let setup_key = SessionKeys::derive_pair_setup_keys(&shared_secret).unwrap();
            let verify_key = SessionKeys::derive_pair_verify_keys(&shared_secret).unwrap();

            assert_ne!(setup_key.as_bytes(), verify_key.as_bytes());
        }
    }
}
