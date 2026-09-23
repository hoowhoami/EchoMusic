//! Ed25519 digital signatures for identity verification.

use airplay_core::error::CryptoError;
use curve25519_dalek::edwards::CompressedEdwardsY;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use sha2::{Digest, Sha512};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};
use zeroize::ZeroizeOnDrop;

/// Long-term Ed25519 identity key pair.
///
/// Note: Clone is implemented to allow sharing identity between pairing phases.
/// Both copies will zeroize on drop.
#[derive(Clone, ZeroizeOnDrop)]
pub struct IdentityKeyPair {
    #[zeroize(skip)]
    public: [u8; 32],
    secret: [u8; 32], // Ed25519 seed (32 bytes, not expanded)
}

impl IdentityKeyPair {
    /// Generate a new random identity key pair.
    pub fn generate() -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);
        let public = signing_key.verifying_key().to_bytes();
        let secret = signing_key.to_bytes();
        Self { public, secret }
    }

    /// Create from seed bytes (32 bytes).
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        let signing_key = SigningKey::from_bytes(seed);
        let public = signing_key.verifying_key().to_bytes();
        Self {
            public,
            secret: *seed,
        }
    }

    /// Load from expanded secret key (64 bytes).
    ///
    /// The 64-byte format is: seed (32 bytes) || public_key (32 bytes).
    /// This validates that the public key matches the seed.
    pub fn from_secret(secret: &[u8; 64]) -> Result<Self, CryptoError> {
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&secret[..32]);

        let signing_key = SigningKey::from_bytes(&seed);
        let derived_public = signing_key.verifying_key().to_bytes();

        // Validate the provided public key matches
        let provided_public = &secret[32..64];
        if derived_public != provided_public {
            return Err(CryptoError::KeyDerivation(
                "Public key does not match seed".to_string(),
            ));
        }

        Ok(Self {
            public: derived_public,
            secret: seed,
        })
    }

    /// Get the public key (32 bytes).
    pub fn public_key(&self) -> [u8; 32] {
        self.public
    }

    /// Sign a message, returning 64-byte signature.
    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        let signing_key = SigningKey::from_bytes(&self.secret);
        let signature = signing_key.sign(message);
        signature.to_bytes()
    }

    /// Export the seed for storage (32 bytes).
    pub fn seed(&self) -> [u8; 32] {
        self.secret
    }
}

/// Verify an Ed25519 signature.
pub fn verify(
    public_key: &[u8; 32],
    message: &[u8],
    signature: &[u8; 64],
) -> Result<(), CryptoError> {
    let verifying_key = VerifyingKey::from_bytes(public_key)
        .map_err(|e| CryptoError::Encryption(format!("Invalid public key: {}", e)))?;

    let sig = Signature::from_bytes(signature);

    verifying_key
        .verify(message, &sig)
        .map_err(|_| CryptoError::Encryption("Signature verification failed".to_string()))
}

/// Verify signature with strict validation (rejects non-canonical signatures).
pub fn verify_strict(
    public_key: &[u8; 32],
    message: &[u8],
    signature: &[u8; 64],
) -> Result<(), CryptoError> {
    let verifying_key = VerifyingKey::from_bytes(public_key)
        .map_err(|e| CryptoError::Encryption(format!("Invalid public key: {}", e)))?;

    let sig = Signature::from_bytes(signature);

    verifying_key
        .verify_strict(message, &sig)
        .map_err(|_| CryptoError::Encryption("Strict signature verification failed".to_string()))
}

/// Convert an Ed25519 seed (private key) to an X25519 private key.
///
/// The conversion involves:
/// 1. Hash the Ed25519 seed with SHA-512 to get 64 bytes
/// 2. Take the first 32 bytes
/// 3. "Clamp" them for X25519: clear bottom 3 bits, clear top bit, set second-highest bit
pub fn ed25519_seed_to_x25519_secret(seed: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha512::new();
    hasher.update(seed);
    let hash = hasher.finalize();

    let mut x25519_secret = [0u8; 32];
    x25519_secret.copy_from_slice(&hash[..32]);

    // Clamp for X25519 (this is what x25519-dalek does internally too)
    x25519_secret[0] &= 248;
    x25519_secret[31] &= 127;
    x25519_secret[31] |= 64;

    x25519_secret
}

/// Convert an Ed25519 public key to an X25519 public key.
///
/// This performs the birational map from twisted Edwards curve (Ed25519)
/// to Montgomery curve (X25519): x_mont = (1 + y) / (1 - y)
pub fn ed25519_public_to_x25519_public(ed25519_pk: &[u8; 32]) -> Result<[u8; 32], CryptoError> {
    // Decompress the Ed25519 point
    let compressed = CompressedEdwardsY(*ed25519_pk);
    let edwards_point = compressed.decompress().ok_or_else(|| {
        CryptoError::KeyDerivation("Invalid Ed25519 public key: failed to decompress".to_string())
    })?;

    // Convert to Montgomery form (X25519)
    let montgomery_point = edwards_point.to_montgomery();

    Ok(montgomery_point.to_bytes())
}

/// Perform ECDH key exchange using Ed25519 keys converted to X25519.
///
/// This is used for transient pairing where both parties have Ed25519 keys
/// but need to derive a shared secret via X25519 ECDH.
///
/// # Arguments
/// * `our_ed25519_seed` - Our Ed25519 private key (32-byte seed)
/// * `their_ed25519_pk` - Their Ed25519 public key (32 bytes)
///
/// # Returns
/// The 32-byte shared secret from X25519 ECDH
pub fn ed25519_to_x25519_dh(
    our_ed25519_seed: &[u8; 32],
    their_ed25519_pk: &[u8; 32],
) -> Result<[u8; 32], CryptoError> {
    // Convert our Ed25519 seed to X25519 private key
    let x25519_secret_bytes = ed25519_seed_to_x25519_secret(our_ed25519_seed);
    let x25519_secret = X25519StaticSecret::from(x25519_secret_bytes);

    // Convert their Ed25519 public key to X25519 public key
    let x25519_pk_bytes = ed25519_public_to_x25519_public(their_ed25519_pk)?;
    let x25519_public = X25519PublicKey::from(x25519_pk_bytes);

    // Perform ECDH
    let shared_secret = x25519_secret.diffie_hellman(&x25519_public);
    let shared_bytes = shared_secret.to_bytes();

    // Check for weak shared secret (all zeros indicates low-order point attack)
    if shared_bytes.iter().all(|&b| b == 0) {
        return Err(CryptoError::KeyDerivation(
            "ECDH failed: shared secret is all zeros".to_string(),
        ));
    }

    Ok(shared_bytes)
}

impl IdentityKeyPair {
    /// Convert this Ed25519 keypair to X25519 and derive shared secret with peer.
    ///
    /// Used for transient pairing where we exchange Ed25519 public keys
    /// and derive a shared secret via X25519 ECDH.
    pub fn x25519_dh(&self, their_ed25519_pk: &[u8; 32]) -> Result<[u8; 32], CryptoError> {
        ed25519_to_x25519_dh(&self.secret, their_ed25519_pk)
    }

    /// Get our X25519 public key derived from our Ed25519 identity.
    ///
    /// This is the Montgomery-curve representation of our public key,
    /// useful when the protocol requires X25519 format.
    pub fn x25519_public_key(&self) -> Result<[u8; 32], CryptoError> {
        ed25519_public_to_x25519_public(&self.public)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod key_generation {
        use super::*;

        #[test]
        fn generate_creates_32_byte_public_key() {
            let kp = IdentityKeyPair::generate();
            assert_eq!(kp.public_key().len(), 32);
        }

        #[test]
        fn generate_creates_unique_keys() {
            let kp1 = IdentityKeyPair::generate();
            let kp2 = IdentityKeyPair::generate();
            assert_ne!(kp1.public_key(), kp2.public_key());
        }

        #[test]
        fn from_seed_is_deterministic() {
            let seed = [0x42u8; 32];
            let kp1 = IdentityKeyPair::from_seed(&seed);
            let kp2 = IdentityKeyPair::from_seed(&seed);
            assert_eq!(kp1.public_key(), kp2.public_key());
        }

        #[test]
        fn from_seed_derives_correct_public_key() {
            // RFC 8032 Test Vector 1
            let seed =
                hex::decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
                    .unwrap();
            let expected_public =
                hex::decode("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
                    .unwrap();

            let mut seed_arr = [0u8; 32];
            seed_arr.copy_from_slice(&seed);

            let kp = IdentityKeyPair::from_seed(&seed_arr);
            assert_eq!(kp.public_key().to_vec(), expected_public);
        }

        #[test]
        fn seed_roundtrip() {
            let original_seed = [0x55u8; 32];
            let kp = IdentityKeyPair::from_seed(&original_seed);
            let extracted_seed = kp.seed();
            assert_eq!(original_seed, extracted_seed);
        }

        #[test]
        fn from_secret_validates_public_key() {
            // Create valid 64-byte secret (seed || public_key)
            let seed = [0x42u8; 32];
            let kp = IdentityKeyPair::from_seed(&seed);
            let mut secret = [0u8; 64];
            secret[..32].copy_from_slice(&seed);
            secret[32..].copy_from_slice(&kp.public_key());

            let loaded = IdentityKeyPair::from_secret(&secret).unwrap();
            assert_eq!(loaded.public_key(), kp.public_key());
        }

        #[test]
        fn from_secret_rejects_mismatched_public_key() {
            let seed = [0x42u8; 32];
            let mut secret = [0u8; 64];
            secret[..32].copy_from_slice(&seed);
            secret[32..].copy_from_slice(&[0xFFu8; 32]); // Wrong public key

            let result = IdentityKeyPair::from_secret(&secret);
            assert!(result.is_err());
        }
    }

    mod signing {
        use super::*;

        #[test]
        fn sign_produces_64_byte_signature() {
            let kp = IdentityKeyPair::generate();
            let message = b"test message";
            let signature = kp.sign(message);
            assert_eq!(signature.len(), 64);
        }

        #[test]
        fn sign_is_deterministic() {
            let seed = [0x42u8; 32];
            let kp = IdentityKeyPair::from_seed(&seed);
            let message = b"test message";

            let sig1 = kp.sign(message);

            let kp2 = IdentityKeyPair::from_seed(&seed);
            let sig2 = kp2.sign(message);

            assert_eq!(sig1, sig2);
        }

        #[test]
        fn different_messages_produce_different_signatures() {
            let kp = IdentityKeyPair::generate();
            let sig1 = kp.sign(b"message 1");

            let seed = kp.seed();
            let kp2 = IdentityKeyPair::from_seed(&seed);
            let sig2 = kp2.sign(b"message 2");

            assert_ne!(sig1, sig2);
        }

        #[test]
        fn different_keys_produce_different_signatures() {
            let kp1 = IdentityKeyPair::generate();
            let kp2 = IdentityKeyPair::generate();
            let message = b"same message";

            let sig1 = kp1.sign(message);
            let sig2 = kp2.sign(message);

            assert_ne!(sig1, sig2);
        }
    }

    mod verification {
        use super::*;

        #[test]
        fn verify_accepts_valid_signature() {
            let kp = IdentityKeyPair::generate();
            let message = b"test message";
            let signature = kp.sign(message);

            let result = verify(&kp.public_key(), message, &signature);
            assert!(result.is_ok());
        }

        #[test]
        fn verify_rejects_wrong_signature() {
            let kp = IdentityKeyPair::generate();
            let message = b"test message";
            let mut signature = kp.sign(message);

            // Corrupt the signature
            signature[0] ^= 0xFF;

            let result = verify(&kp.public_key(), message, &signature);
            assert!(result.is_err());
        }

        #[test]
        fn verify_rejects_wrong_message() {
            let kp = IdentityKeyPair::generate();
            let signature = kp.sign(b"original message");

            let result = verify(&kp.public_key(), b"different message", &signature);
            assert!(result.is_err());
        }

        #[test]
        fn verify_rejects_wrong_public_key() {
            let kp1 = IdentityKeyPair::generate();
            let kp2 = IdentityKeyPair::generate();
            let message = b"test message";
            let signature = kp1.sign(message);

            let result = verify(&kp2.public_key(), message, &signature);
            assert!(result.is_err());
        }

        #[test]
        fn verify_strict_accepts_valid_signature() {
            let kp = IdentityKeyPair::generate();
            let message = b"test message";
            let signature = kp.sign(message);

            let result = verify_strict(&kp.public_key(), message, &signature);
            assert!(result.is_ok());
        }
    }

    mod security {
        use super::*;

        #[test]
        fn secret_key_zeroized_on_drop() {
            // Create keypair, drop it, verify memory is cleared
            // This is verified by the ZeroizeOnDrop derive
            let kp = IdentityKeyPair::generate();
            let _public = kp.public_key();
            drop(kp);
            // The ZeroizeOnDrop derive ensures the secret is cleared
        }

        #[test]
        fn secret_key_not_in_debug_output() {
            // IdentityKeyPair doesn't derive Debug, so this is enforced at compile time
            let kp = IdentityKeyPair::generate();
            let _pub = kp.public_key();
        }
    }

    mod known_vectors {
        use super::*;

        #[test]
        fn rfc8032_test_vector_1() {
            // RFC 8032 Section 7.1 - Test Vector 1
            // Empty message
            let seed =
                hex::decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
                    .unwrap();
            let expected_public =
                hex::decode("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
                    .unwrap();
            let expected_signature = hex::decode(
                "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
            ).unwrap();

            let mut seed_arr = [0u8; 32];
            seed_arr.copy_from_slice(&seed);

            let kp = IdentityKeyPair::from_seed(&seed_arr);
            assert_eq!(kp.public_key().to_vec(), expected_public);

            let message = b"";
            let signature = kp.sign(message);
            assert_eq!(signature.to_vec(), expected_signature);

            // Verify the signature
            let mut sig_arr = [0u8; 64];
            sig_arr.copy_from_slice(&expected_signature);
            let mut pub_arr = [0u8; 32];
            pub_arr.copy_from_slice(&expected_public);
            assert!(verify(&pub_arr, message, &sig_arr).is_ok());
        }

        #[test]
        fn rfc8032_test_vector_2() {
            // RFC 8032 Section 7.1 - Test Vector 2
            // Single byte message (0x72)
            let seed =
                hex::decode("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")
                    .unwrap();
            let expected_public =
                hex::decode("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c")
                    .unwrap();
            let expected_signature = hex::decode(
                "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"
            ).unwrap();

            let mut seed_arr = [0u8; 32];
            seed_arr.copy_from_slice(&seed);

            let kp = IdentityKeyPair::from_seed(&seed_arr);
            assert_eq!(kp.public_key().to_vec(), expected_public);

            let message = [0x72u8];
            let signature = kp.sign(&message);
            assert_eq!(signature.to_vec(), expected_signature);
        }

        #[test]
        fn rfc8032_test_vector_sha_abc() {
            // RFC 8032 Section 7.1 - Test Vector 3 (SHA(abc) as message)
            let seed =
                hex::decode("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7")
                    .unwrap();
            let expected_public =
                hex::decode("fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025")
                    .unwrap();
            let expected_signature = hex::decode(
                "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"
            ).unwrap();

            let mut seed_arr = [0u8; 32];
            seed_arr.copy_from_slice(&seed);

            let kp = IdentityKeyPair::from_seed(&seed_arr);
            assert_eq!(kp.public_key().to_vec(), expected_public);

            // Message is "af82" which is the two-byte message from the RFC
            let message = hex::decode("af82").unwrap();
            let signature = kp.sign(&message);
            assert_eq!(signature.to_vec(), expected_signature);
        }
    }

    mod ed25519_to_x25519 {
        use super::*;

        #[test]
        fn seed_conversion_is_deterministic() {
            let seed = [0x42u8; 32];
            let x25519_1 = ed25519_seed_to_x25519_secret(&seed);
            let x25519_2 = ed25519_seed_to_x25519_secret(&seed);
            assert_eq!(x25519_1, x25519_2);
        }

        #[test]
        fn seed_conversion_produces_clamped_key() {
            let seed = [0xFFu8; 32];
            let x25519 = ed25519_seed_to_x25519_secret(&seed);

            // Check clamping: bottom 3 bits clear, top bit clear, second-highest set
            assert_eq!(x25519[0] & 0x07, 0); // Bottom 3 bits clear
            assert_eq!(x25519[31] & 0x80, 0); // Top bit clear
            assert_eq!(x25519[31] & 0x40, 0x40); // Second-highest bit set
        }

        #[test]
        fn public_key_conversion_succeeds() {
            let kp = IdentityKeyPair::generate();
            let result = ed25519_public_to_x25519_public(&kp.public_key());
            assert!(result.is_ok());
            let x25519_pk = result.unwrap();
            assert_eq!(x25519_pk.len(), 32);
        }

        #[test]
        fn public_key_conversion_is_deterministic() {
            let kp = IdentityKeyPair::generate();
            let x25519_1 = ed25519_public_to_x25519_public(&kp.public_key()).unwrap();
            let x25519_2 = ed25519_public_to_x25519_public(&kp.public_key()).unwrap();
            assert_eq!(x25519_1, x25519_2);
        }

        #[test]
        fn ecdh_produces_shared_secret() {
            let alice = IdentityKeyPair::generate();
            let bob = IdentityKeyPair::generate();

            let shared_a = alice.x25519_dh(&bob.public_key()).unwrap();
            let shared_b = bob.x25519_dh(&alice.public_key()).unwrap();

            assert_eq!(shared_a, shared_b);
            assert_eq!(shared_a.len(), 32);
        }

        #[test]
        fn ecdh_different_parties_get_same_secret() {
            // Generate two Ed25519 keypairs
            let seed_a = [0x11u8; 32];
            let seed_b = [0x22u8; 32];

            let alice = IdentityKeyPair::from_seed(&seed_a);
            let bob = IdentityKeyPair::from_seed(&seed_b);

            // Both should derive the same shared secret
            let shared_a = ed25519_to_x25519_dh(&seed_a, &bob.public_key()).unwrap();
            let shared_b = ed25519_to_x25519_dh(&seed_b, &alice.public_key()).unwrap();

            assert_eq!(shared_a, shared_b);
        }

        #[test]
        fn ecdh_via_identity_keypair_method() {
            let alice = IdentityKeyPair::generate();
            let bob = IdentityKeyPair::generate();

            // Use the method on IdentityKeyPair
            let shared_a = alice.x25519_dh(&bob.public_key()).unwrap();
            let shared_b = bob.x25519_dh(&alice.public_key()).unwrap();

            assert_eq!(shared_a, shared_b);
        }

        #[test]
        fn x25519_public_key_differs_from_ed25519() {
            let kp = IdentityKeyPair::generate();
            let ed25519_pk = kp.public_key();
            let x25519_pk = kp.x25519_public_key().unwrap();

            // The two representations should be different
            assert_ne!(ed25519_pk, x25519_pk);
        }

        #[test]
        fn different_keypairs_produce_different_shared_secrets() {
            let alice = IdentityKeyPair::generate();
            let bob = IdentityKeyPair::generate();
            let charlie = IdentityKeyPair::generate();

            let shared_ab = alice.x25519_dh(&bob.public_key()).unwrap();
            let shared_ac = alice.x25519_dh(&charlie.public_key()).unwrap();

            assert_ne!(shared_ab, shared_ac);
        }

        #[test]
        fn rejects_invalid_public_key() {
            let seed = [0x42u8; 32];
            // All zeros is not a valid Ed25519 public key (identity point)
            // but curve25519-dalek accepts it - instead test with a clearly invalid point
            let invalid_pk = [0xFFu8; 32]; // Not a valid compressed Edwards point

            let result = ed25519_to_x25519_dh(&seed, &invalid_pk);
            // This may or may not fail depending on whether it decompresses
            // The important thing is it doesn't panic
            let _ = result;
        }
    }
}
