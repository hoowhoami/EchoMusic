//! Curve25519 ECDH for session key agreement.

use airplay_core::error::CryptoError;
use rand::rngs::OsRng;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::ZeroizeOnDrop;

/// Ephemeral Curve25519 key pair for ECDH.
#[derive(ZeroizeOnDrop)]
pub struct EcdhKeyPair {
    #[zeroize(skip)]
    public: [u8; 32],
    secret: [u8; 32],
}

impl EcdhKeyPair {
    /// Generate a new random key pair.
    pub fn generate() -> Self {
        let secret = StaticSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&secret);
        Self {
            public: public.to_bytes(),
            secret: secret.to_bytes(),
        }
    }

    /// Create from existing secret key bytes.
    pub fn from_secret(secret: &[u8; 32]) -> Self {
        let static_secret = StaticSecret::from(*secret);
        let public = PublicKey::from(&static_secret);
        Self {
            public: public.to_bytes(),
            secret: *secret,
        }
    }

    /// Get the public key (32 bytes).
    pub fn public_key(&self) -> [u8; 32] {
        self.public
    }

    /// Perform Diffie-Hellman key exchange.
    ///
    /// Returns the shared secret (32 bytes).
    /// Rejects low-order points (all-zero public keys produce all-zero output).
    pub fn diffie_hellman(self, peer_public: &[u8; 32]) -> Result<[u8; 32], CryptoError> {
        // Check for all-zero public key (invalid)
        if peer_public.iter().all(|&b| b == 0) {
            return Err(CryptoError::Encryption(
                "Invalid peer public key: all zeros".to_string(),
            ));
        }

        let static_secret = StaticSecret::from(self.secret);
        let their_public = PublicKey::from(*peer_public);
        let shared = static_secret.diffie_hellman(&their_public);

        // Check for weak result (low-order points produce all-zero shared secret)
        let shared_bytes = shared.to_bytes();
        if shared_bytes.iter().all(|&b| b == 0) {
            return Err(CryptoError::Encryption(
                "Weak ECDH: shared secret is all zeros (low-order point)".to_string(),
            ));
        }

        Ok(shared_bytes)
    }
}

/// Perform one-shot ECDH without exposing intermediate state.
pub fn ecdh_once(peer_public: &[u8; 32]) -> Result<([u8; 32], [u8; 32]), CryptoError> {
    let kp = EcdhKeyPair::generate();
    let public = kp.public_key();
    let shared = kp.diffie_hellman(peer_public)?;
    Ok((public, shared))
}

#[cfg(test)]
mod tests {
    use super::*;

    mod key_generation {
        use super::*;

        #[test]
        fn generate_creates_32_byte_public_key() {
            let kp = EcdhKeyPair::generate();
            assert_eq!(kp.public_key().len(), 32);
        }

        #[test]
        fn generate_creates_unique_keys() {
            let kp1 = EcdhKeyPair::generate();
            let kp2 = EcdhKeyPair::generate();
            assert_ne!(kp1.public_key(), kp2.public_key());
        }

        #[test]
        fn from_secret_derives_correct_public_key() {
            // RFC 7748 test vector
            let secret =
                hex::decode("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
                    .unwrap();
            let expected_public =
                hex::decode("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
                    .unwrap();

            let mut secret_arr = [0u8; 32];
            secret_arr.copy_from_slice(&secret);

            let kp = EcdhKeyPair::from_secret(&secret_arr);
            assert_eq!(kp.public_key().to_vec(), expected_public);
        }

        #[test]
        fn from_secret_is_deterministic() {
            let secret = [0x42u8; 32];
            let kp1 = EcdhKeyPair::from_secret(&secret);
            let kp2 = EcdhKeyPair::from_secret(&secret);
            assert_eq!(kp1.public_key(), kp2.public_key());
        }
    }

    mod diffie_hellman {
        use super::*;

        #[test]
        fn both_parties_derive_same_secret() {
            let alice = EcdhKeyPair::generate();
            let bob = EcdhKeyPair::generate();

            let alice_public = alice.public_key();
            let bob_public = bob.public_key();

            let shared_a = alice.diffie_hellman(&bob_public).unwrap();
            let shared_b = bob.diffie_hellman(&alice_public).unwrap();

            assert_eq!(shared_a, shared_b);
        }

        #[test]
        fn different_peers_produce_different_secrets() {
            let alice = EcdhKeyPair::generate();
            let bob = EcdhKeyPair::generate();
            let charlie = EcdhKeyPair::generate();

            let bob_public = bob.public_key();
            let charlie_public = charlie.public_key();

            let shared_ab = alice.diffie_hellman(&bob_public).unwrap();

            let alice2 = EcdhKeyPair::generate();
            let shared_ac = alice2.diffie_hellman(&charlie_public).unwrap();

            assert_ne!(shared_ab, shared_ac);
        }

        #[test]
        fn rejects_low_order_points() {
            // Low-order points produce all-zero shared secrets
            // Point of order 8 (a torsion point)
            let low_order =
                hex::decode("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f")
                    .unwrap();
            let mut low_order_arr = [0u8; 32];
            low_order_arr.copy_from_slice(&low_order);

            let kp = EcdhKeyPair::generate();
            let result = kp.diffie_hellman(&low_order_arr);
            assert!(result.is_err());
        }

        #[test]
        fn rejects_all_zero_public_key() {
            let kp = EcdhKeyPair::generate();
            let zero_key = [0u8; 32];
            let result = kp.diffie_hellman(&zero_key);
            assert!(result.is_err());
        }

        #[test]
        fn consumes_keypair() {
            // This test just verifies the API - diffie_hellman takes self by value
            let kp = EcdhKeyPair::generate();
            let peer = EcdhKeyPair::generate();
            let peer_pub = peer.public_key();
            let _ = kp.diffie_hellman(&peer_pub);
            // kp is now consumed, can't use it again (compile-time check)
        }
    }

    mod ecdh_once {
        use super::*;

        #[test]
        fn returns_public_key_and_shared_secret() {
            let peer = EcdhKeyPair::generate();
            let peer_pub = peer.public_key();

            let (our_pub, shared) = ecdh_once(&peer_pub).unwrap();
            assert_eq!(our_pub.len(), 32);
            assert_eq!(shared.len(), 32);
        }

        #[test]
        fn peer_can_derive_same_secret() {
            let peer = EcdhKeyPair::generate();
            let peer_pub = peer.public_key();

            let (our_pub, shared_ours) = ecdh_once(&peer_pub).unwrap();
            let shared_theirs = peer.diffie_hellman(&our_pub).unwrap();

            assert_eq!(shared_ours, shared_theirs);
        }
    }

    mod security {
        use super::*;

        #[test]
        fn secret_key_zeroized_on_drop() {
            // Create keypair, drop it, and verify memory is cleared
            // This is hard to test directly, but we can verify the type derives ZeroizeOnDrop
            let kp = EcdhKeyPair::generate();
            let _public = kp.public_key(); // Just verify it works
            drop(kp);
            // The ZeroizeOnDrop derive ensures the secret is cleared
        }

        #[test]
        fn secret_key_not_in_debug_output() {
            // EcdhKeyPair doesn't derive Debug, so this is enforced at compile time
            // We just verify the public key is accessible
            let kp = EcdhKeyPair::generate();
            let _pub = kp.public_key();
        }
    }

    mod known_vectors {
        use super::*;

        #[test]
        fn rfc7748_test_vector() {
            // RFC 7748 Section 6.1 Test Vectors
            // Alice's private key
            let alice_private =
                hex::decode("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
                    .unwrap();
            // Alice's public key
            let alice_public_expected =
                hex::decode("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
                    .unwrap();

            // Bob's private key
            let bob_private =
                hex::decode("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
                    .unwrap();
            // Bob's public key
            let bob_public_expected =
                hex::decode("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
                    .unwrap();

            // Shared secret
            let shared_expected =
                hex::decode("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")
                    .unwrap();

            let mut alice_secret = [0u8; 32];
            alice_secret.copy_from_slice(&alice_private);
            let mut bob_secret = [0u8; 32];
            bob_secret.copy_from_slice(&bob_private);
            let mut bob_public = [0u8; 32];
            bob_public.copy_from_slice(&bob_public_expected);

            // Verify Alice's public key derivation
            let alice = EcdhKeyPair::from_secret(&alice_secret);
            assert_eq!(alice.public_key().to_vec(), alice_public_expected);

            // Verify Bob's public key derivation
            let bob = EcdhKeyPair::from_secret(&bob_secret);
            assert_eq!(bob.public_key().to_vec(), bob_public_expected);

            // Verify shared secret
            let shared = alice.diffie_hellman(&bob_public).unwrap();
            assert_eq!(shared.to_vec(), shared_expected);
        }
    }
}
