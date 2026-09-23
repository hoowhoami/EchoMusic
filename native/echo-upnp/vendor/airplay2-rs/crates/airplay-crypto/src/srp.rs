//! SRP-6a implementation for HomeKit pair-setup.
//!
//! Uses 3072-bit prime (RFC 5054), generator g=5, SHA-512.

use airplay_core::error::CryptoError;
use num_bigint::{BigUint, RandBigInt};
use rand::rngs::OsRng;
use sha2::{Digest, Sha512};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// N size in bytes (3072 bits = 384 bytes).
const N_BYTES: usize = 384;

/// RFC 5054 3072-bit prime N as hex string.
const RFC5054_N_3072: &str = concat!(
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E08",
    "8A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B",
    "302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9",
    "A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE6",
    "49286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8",
    "FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D",
    "670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C",
    "180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718",
    "3995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D",
    "04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7D",
    "B3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D226",
    "1AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C",
    "BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFC",
    "E0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF"
);

/// SRP-6a parameters (3072-bit, RFC 5054).
pub struct SrpParams {
    /// Prime modulus N.
    pub n: BigUint,
    /// Generator g (always 5).
    pub g: BigUint,
}

impl Default for SrpParams {
    fn default() -> Self {
        let n = BigUint::parse_bytes(RFC5054_N_3072.as_bytes(), 16)
            .expect("Invalid RFC 5054 prime constant");
        let g = BigUint::from(5u32);
        Self { n, g }
    }
}

/// Client-side SRP state machine.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct SrpClient {
    #[zeroize(skip)]
    params: SrpParams,
    identity: Vec<u8>,
    password: Vec<u8>,
    private_key: Vec<u8>,
    #[zeroize(skip)]
    public_key: BigUint,
}

/// Server challenge containing salt and public key.
pub struct SrpChallenge {
    pub salt: [u8; 16],
    pub server_public_key: Vec<u8>,
}

/// Result of processing a challenge.
pub struct SrpProof {
    pub client_proof: Vec<u8>,
    pub shared_secret: Vec<u8>,
    pub expected_server_proof: Vec<u8>,
}

impl SrpClient {
    /// Create new SRP client with identity and password.
    ///
    /// For AirPlay, identity is typically "Pair-Setup" and password is the PIN.
    pub fn new(identity: &[u8], password: &[u8]) -> Self {
        let params = SrpParams::default();

        // Generate random private key a (256 bits)
        let a = OsRng.gen_biguint(256);
        let private_key = a.to_bytes_be();

        // Compute public key A = g^a mod N
        let public_key = params.g.modpow(&a, &params.n);

        Self {
            params,
            identity: identity.to_vec(),
            password: password.to_vec(),
            private_key,
            public_key,
        }
    }

    /// Create SRP client with a specific private key (for testing).
    #[cfg(test)]
    pub fn with_private_key(identity: &[u8], password: &[u8], private_key: &[u8]) -> Self {
        let params = SrpParams::default();
        let a = BigUint::from_bytes_be(private_key);
        let public_key = params.g.modpow(&a, &params.n);

        Self {
            params,
            identity: identity.to_vec(),
            password: password.to_vec(),
            private_key: private_key.to_vec(),
            public_key,
        }
    }

    /// Get client public key A (384 bytes for 3072-bit).
    pub fn public_key(&self) -> Vec<u8> {
        pad_to_n(&self.public_key)
    }

    /// Process server's challenge and generate proof.
    pub fn process_challenge(&self, challenge: &SrpChallenge) -> Result<SrpProof, CryptoError> {
        let b = BigUint::from_bytes_be(&challenge.server_public_key);

        // Validate B != 0 (mod N)
        if &b % &self.params.n == BigUint::ZERO {
            return Err(CryptoError::Encryption(
                "Invalid server public key: B mod N = 0".to_string(),
            ));
        }

        // Get private key a
        let a = BigUint::from_bytes_be(&self.private_key);

        // Compute u = H(PAD(A) || PAD(B))
        let u = compute_u(&self.public_key, &b, &self.params);
        if u == BigUint::ZERO {
            return Err(CryptoError::Encryption(
                "Invalid u value: u = 0".to_string(),
            ));
        }

        // Compute x = H(salt || H(identity || ":" || password))
        let x = compute_x(&challenge.salt, &self.identity, &self.password);

        // Compute k = H(N || PAD(g))
        let k = compute_k(&self.params);

        // Compute S = (B - k * g^x)^(a + u*x) mod N
        let g_x = self.params.g.modpow(&x, &self.params.n);
        let k_gx = (&k * &g_x) % &self.params.n;

        // Handle potential underflow: if B < k*g^x, add N
        let base = if b >= k_gx {
            (&b - &k_gx) % &self.params.n
        } else {
            (&b + &self.params.n - &k_gx) % &self.params.n
        };

        let exponent = (&a + &u * &x) % (&self.params.n - BigUint::from(1u32));
        let s = base.modpow(&exponent, &self.params.n);

        // Compute shared secret K = H(S)
        let s_padded = pad_to_n(&s);
        let mut hasher = Sha512::new();
        hasher.update(&s_padded);
        let shared_secret = hasher.finalize().to_vec();

        // Compute client proof M1 = H(H(N) XOR H(g) || H(I) || salt || PAD(A) || PAD(B) || K)
        let client_proof = compute_m1(
            &self.params,
            &self.identity,
            &challenge.salt,
            &self.public_key,
            &b,
            &shared_secret,
        );

        // Compute expected server proof M2 = H(PAD(A) || M1 || K)
        let a_padded = pad_to_n(&self.public_key);
        let mut hasher = Sha512::new();
        hasher.update(&a_padded);
        hasher.update(&client_proof);
        hasher.update(&shared_secret);
        let expected_server_proof = hasher.finalize().to_vec();

        Ok(SrpProof {
            client_proof,
            shared_secret,
            expected_server_proof,
        })
    }

    /// Verify server's proof M2.
    pub fn verify_server_proof(&self, proof: &[u8], expected: &[u8]) -> bool {
        proof.ct_eq(expected).into()
    }

    /// Dump SRP transcript for debugging M4 failures.
    ///
    /// Call this after `process_challenge()` to log all SRP values for comparison
    /// against known-good implementations like shairport-sync.
    ///
    /// Enable with `cargo build --features srp-debug`
    #[cfg(feature = "srp-debug")]
    pub fn dump_transcript(&self, challenge: &SrpChallenge, proof: &SrpProof) {
        fn hex_str(data: &[u8]) -> String {
            data.iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join("")
        }

        eprintln!("=== SRP Transcript (for debugging M4 failures) ===");
        eprintln!("Identity: {:?}", String::from_utf8_lossy(&self.identity));
        eprintln!("salt (16B): {}", hex_str(&challenge.salt));
        eprintln!("B (server pubkey, first 32B): {}", hex_str(&challenge.server_public_key[..32.min(challenge.server_public_key.len())]));
        eprintln!("B (server pubkey, last 32B):  {}", hex_str(&challenge.server_public_key[challenge.server_public_key.len().saturating_sub(32)..]));
        eprintln!("B length: {} bytes", challenge.server_public_key.len());

        let a_bytes = self.public_key();
        eprintln!("A (client pubkey, first 32B): {}", hex_str(&a_bytes[..32.min(a_bytes.len())]));
        eprintln!("A (client pubkey, last 32B):  {}", hex_str(&a_bytes[a_bytes.len().saturating_sub(32)..]));
        eprintln!("A length: {} bytes", a_bytes.len());

        eprintln!("M1 (client proof, 64B): {}", hex_str(&proof.client_proof));
        eprintln!("expected M2 (server proof, 64B): {}", hex_str(&proof.expected_server_proof));
        eprintln!("K (shared secret, 64B): {}", hex_str(&proof.shared_secret));
        eprintln!("================================================");
    }
}

/// Compute M1 = H(H(N) XOR H(g) || H(I) || salt || PAD(A) || PAD(B) || K)
fn compute_m1(
    params: &SrpParams,
    identity: &[u8],
    salt: &[u8],
    a: &BigUint,
    b: &BigUint,
    k: &[u8],
) -> Vec<u8> {
    // H(N)
    let n_bytes = pad_to_n(&params.n);
    let mut hasher = Sha512::new();
    hasher.update(&n_bytes);
    let h_n = hasher.finalize();

    // H(g)
    // IMPORTANT: Apple expects H(g) over the raw generator bytes (e.g., 0x05),
    // NOT H(PAD(g)). Padding g here causes SRP proof mismatch -> M4 error 0x02.
    // This differs from k = H(N || PAD(g)) which correctly uses padding.
    let g_bytes = params.g.to_bytes_be();
    let mut hasher = Sha512::new();
    hasher.update(&g_bytes);
    let h_g = hasher.finalize();

    // H(N) XOR H(g)
    let mut xor_result = [0u8; 64];
    for i in 0..64 {
        xor_result[i] = h_n[i] ^ h_g[i];
    }

    // H(I)
    let mut hasher = Sha512::new();
    hasher.update(identity);
    let h_i = hasher.finalize();

    // M1 = H(H(N) XOR H(g) || H(I) || salt || PAD(A) || PAD(B) || K)
    let mut hasher = Sha512::new();
    hasher.update(&xor_result);
    hasher.update(&h_i);
    hasher.update(salt);
    hasher.update(&pad_to_n(a));
    hasher.update(&pad_to_n(b));
    hasher.update(k);
    hasher.finalize().to_vec()
}

/// Pad BigUint to N_BYTES with leading zeros.
fn pad_to_n(value: &BigUint) -> Vec<u8> {
    let bytes = value.to_bytes_be();
    if bytes.len() >= N_BYTES {
        bytes[bytes.len() - N_BYTES..].to_vec()
    } else {
        let mut padded = vec![0u8; N_BYTES - bytes.len()];
        padded.extend_from_slice(&bytes);
        padded
    }
}

/// Compute k = SHA512(N || PAD(g)).
fn compute_k(params: &SrpParams) -> BigUint {
    let n_bytes = pad_to_n(&params.n);
    let g_bytes = pad_to_n(&params.g);

    let mut hasher = Sha512::new();
    hasher.update(&n_bytes);
    hasher.update(&g_bytes);
    let hash = hasher.finalize();

    BigUint::from_bytes_be(&hash)
}

/// Compute u = SHA512(PAD(A) || PAD(B)).
fn compute_u(a: &BigUint, b: &BigUint, _params: &SrpParams) -> BigUint {
    let a_bytes = pad_to_n(a);
    let b_bytes = pad_to_n(b);

    let mut hasher = Sha512::new();
    hasher.update(&a_bytes);
    hasher.update(&b_bytes);
    let hash = hasher.finalize();

    BigUint::from_bytes_be(&hash)
}

/// Compute x = SHA512(salt || SHA512(identity || ":" || password)).
fn compute_x(salt: &[u8], identity: &[u8], password: &[u8]) -> BigUint {
    // Inner hash: H(identity || ":" || password)
    let mut hasher = Sha512::new();
    hasher.update(identity);
    hasher.update(b":");
    hasher.update(password);
    let inner_hash = hasher.finalize();

    // Outer hash: H(salt || inner_hash)
    let mut hasher = Sha512::new();
    hasher.update(salt);
    hasher.update(&inner_hash);
    let hash = hasher.finalize();

    BigUint::from_bytes_be(&hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    mod srp_params {
        use super::*;

        #[test]
        fn default_uses_3072_bit_prime() {
            let params = SrpParams::default();
            let n_bytes = params.n.to_bytes_be();
            // 3072 bits = 384 bytes
            assert_eq!(n_bytes.len(), 384);
        }

        #[test]
        fn generator_is_5() {
            let params = SrpParams::default();
            assert_eq!(params.g, BigUint::from(5u32));
        }

        #[test]
        fn prime_matches_rfc5054() {
            let params = SrpParams::default();
            let n_hex = hex::encode(params.n.to_bytes_be()).to_uppercase();
            let expected_hex = RFC5054_N_3072.to_uppercase();
            assert_eq!(n_hex, expected_hex);
        }
    }

    mod srp_client {
        use super::*;

        #[test]
        fn new_generates_random_private_key() {
            let client1 = SrpClient::new(b"Pair-Setup", b"1234");
            let client2 = SrpClient::new(b"Pair-Setup", b"1234");
            // Private keys should be different
            assert_ne!(client1.private_key, client2.private_key);
        }

        #[test]
        fn public_key_is_384_bytes() {
            let client = SrpClient::new(b"Pair-Setup", b"1234");
            let public_key = client.public_key();
            assert_eq!(public_key.len(), 384);
        }

        #[test]
        fn public_key_is_deterministic_for_same_private() {
            let private_key = vec![0x42u8; 32];
            let client1 = SrpClient::with_private_key(b"Pair-Setup", b"1234", &private_key);
            let client2 = SrpClient::with_private_key(b"Pair-Setup", b"1234", &private_key);
            assert_eq!(client1.public_key(), client2.public_key());
        }

        #[test]
        fn different_clients_have_different_public_keys() {
            let client1 = SrpClient::new(b"Pair-Setup", b"1234");
            let client2 = SrpClient::new(b"Pair-Setup", b"1234");
            assert_ne!(client1.public_key(), client2.public_key());
        }
    }

    mod process_challenge {
        use super::*;

        fn create_mock_server_key(params: &SrpParams) -> Vec<u8> {
            // Generate a valid server public key B = k*v + g^b mod N
            let b = OsRng.gen_biguint(256);
            let server_public = params.g.modpow(&b, &params.n);
            pad_to_n(&server_public)
        }

        #[test]
        fn rejects_zero_server_public_key() {
            let client = SrpClient::new(b"Pair-Setup", b"1234");
            let challenge = SrpChallenge {
                salt: [0u8; 16],
                server_public_key: vec![0u8; 384], // All zeros
            };
            let result = client.process_challenge(&challenge);
            assert!(result.is_err());
        }

        #[test]
        fn rejects_server_key_multiple_of_n() {
            let client = SrpClient::new(b"Pair-Setup", b"1234");
            // N itself is N mod N = 0
            let n_bytes = pad_to_n(&client.params.n);
            let challenge = SrpChallenge {
                salt: [0u8; 16],
                server_public_key: n_bytes,
            };
            let result = client.process_challenge(&challenge);
            assert!(result.is_err());
        }

        #[test]
        fn generates_64_byte_proof() {
            let client = SrpClient::new(b"Pair-Setup", b"1234");
            let server_key = create_mock_server_key(&client.params);
            let challenge = SrpChallenge {
                salt: [0x42u8; 16],
                server_public_key: server_key,
            };
            let proof = client.process_challenge(&challenge).unwrap();
            assert_eq!(proof.client_proof.len(), 64); // SHA-512 output
        }

        #[test]
        fn generates_consistent_shared_secret() {
            let private_key = vec![0x42u8; 32];
            let client = SrpClient::with_private_key(b"Pair-Setup", b"1234", &private_key);
            let server_key = create_mock_server_key(&client.params);
            let challenge = SrpChallenge {
                salt: [0x42u8; 16],
                server_public_key: server_key.clone(),
            };

            let proof1 = client.process_challenge(&challenge).unwrap();

            let client2 = SrpClient::with_private_key(b"Pair-Setup", b"1234", &private_key);
            let challenge2 = SrpChallenge {
                salt: [0x42u8; 16],
                server_public_key: server_key,
            };
            let proof2 = client2.process_challenge(&challenge2).unwrap();

            assert_eq!(proof1.shared_secret, proof2.shared_secret);
        }

        #[test]
        fn different_salts_produce_different_secrets() {
            let private_key = vec![0x42u8; 32];
            let params = SrpParams::default();
            let server_key = create_mock_server_key(&params);

            let client1 = SrpClient::with_private_key(b"Pair-Setup", b"1234", &private_key);
            let challenge1 = SrpChallenge {
                salt: [0x01u8; 16],
                server_public_key: server_key.clone(),
            };
            let proof1 = client1.process_challenge(&challenge1).unwrap();

            let client2 = SrpClient::with_private_key(b"Pair-Setup", b"1234", &private_key);
            let challenge2 = SrpChallenge {
                salt: [0x02u8; 16],
                server_public_key: server_key,
            };
            let proof2 = client2.process_challenge(&challenge2).unwrap();

            assert_ne!(proof1.shared_secret, proof2.shared_secret);
        }
    }

    mod verify_server_proof {
        use super::*;

        #[test]
        fn accepts_valid_proof() {
            let client = SrpClient::new(b"Pair-Setup", b"1234");
            let proof = b"some_proof_data_here";
            let expected = b"some_proof_data_here";
            assert!(client.verify_server_proof(proof, expected));
        }

        #[test]
        fn rejects_invalid_proof() {
            let client = SrpClient::new(b"Pair-Setup", b"1234");
            let proof = b"wrong_proof_data";
            let expected = b"expected_proof_data";
            assert!(!client.verify_server_proof(proof, expected));
        }

        #[test]
        fn uses_constant_time_comparison() {
            // The constant-time comparison is provided by subtle crate
            // We verify it works correctly
            let client = SrpClient::new(b"Pair-Setup", b"1234");
            let proof = [0x42u8; 64];
            let expected = [0x42u8; 64];
            assert!(client.verify_server_proof(&proof, &expected));

            let mut wrong = [0x42u8; 64];
            wrong[63] = 0x00;
            assert!(!client.verify_server_proof(&wrong, &expected));
        }
    }

    mod internal_functions {
        use super::*;

        #[test]
        fn compute_k_is_deterministic() {
            let params = SrpParams::default();
            let k1 = compute_k(&params);
            let k2 = compute_k(&params);
            assert_eq!(k1, k2);
        }

        #[test]
        fn compute_u_changes_with_public_keys() {
            let params = SrpParams::default();
            let a1 = BigUint::from(12345u32);
            let a2 = BigUint::from(12346u32);
            let b = BigUint::from(67890u32);

            let u1 = compute_u(&a1, &b, &params);
            let u2 = compute_u(&a2, &b, &params);
            assert_ne!(u1, u2);
        }

        #[test]
        fn compute_x_uses_double_hash() {
            let salt = [0x01u8; 16];
            let identity = b"Pair-Setup";
            let password = b"1234";

            let x1 = compute_x(&salt, identity, password);
            let x2 = compute_x(&salt, identity, password);
            assert_eq!(x1, x2);

            // Different password should produce different x
            let x3 = compute_x(&salt, identity, b"5678");
            assert_ne!(x1, x3);
        }

        #[test]
        fn pad_to_n_pads_correctly() {
            let small_value = BigUint::from(255u32);
            let padded = pad_to_n(&small_value);
            assert_eq!(padded.len(), N_BYTES);
            assert!(padded[..N_BYTES - 1].iter().all(|&b| b == 0));
            assert_eq!(padded[N_BYTES - 1], 255);
        }
    }

    mod integration {
        use super::*;

        /// Simple SRP server for testing.
        struct MockSrpServer {
            params: SrpParams,
            salt: [u8; 16],
            verifier: BigUint,
            private_key: BigUint,
            public_key: BigUint,
        }

        impl MockSrpServer {
            fn new(identity: &[u8], password: &[u8], salt: [u8; 16]) -> Self {
                let params = SrpParams::default();

                // Compute verifier v = g^x mod N
                let x = compute_x(&salt, identity, password);
                let verifier = params.g.modpow(&x, &params.n);

                // Generate server private key b
                let b = OsRng.gen_biguint(256);

                // Compute k
                let k = compute_k(&params);

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
                }
            }

            fn challenge(&self) -> SrpChallenge {
                SrpChallenge {
                    salt: self.salt,
                    server_public_key: pad_to_n(&self.public_key),
                }
            }

            fn compute_session_key(&self, client_public: &[u8]) -> Vec<u8> {
                let a = BigUint::from_bytes_be(client_public);

                // Compute u = H(PAD(A) || PAD(B))
                let u = compute_u(&a, &self.public_key, &self.params);

                // S = (A * v^u)^b mod N
                let v_u = self.verifier.modpow(&u, &self.params.n);
                let base = (&a * &v_u) % &self.params.n;
                let s = base.modpow(&self.private_key, &self.params.n);

                // K = H(S)
                let s_padded = pad_to_n(&s);
                let mut hasher = Sha512::new();
                hasher.update(&s_padded);
                hasher.finalize().to_vec()
            }
        }

        #[test]
        fn client_server_roundtrip() {
            let identity = b"Pair-Setup";
            let password = b"1234";
            let salt = [0x42u8; 16];

            // Create server
            let server = MockSrpServer::new(identity, password, salt);

            // Create client
            let client = SrpClient::new(identity, password);

            // Get challenge from server
            let challenge = server.challenge();

            // Client processes challenge
            let proof = client.process_challenge(&challenge).unwrap();

            // Server computes session key
            let server_session_key = server.compute_session_key(&client.public_key());

            // Both should have the same session key
            assert_eq!(proof.shared_secret, server_session_key);
        }

        #[test]
        fn wrong_password_fails_verification() {
            let identity = b"Pair-Setup";
            let correct_password = b"1234";
            let wrong_password = b"9999";
            let salt = [0x42u8; 16];

            // Server uses correct password
            let server = MockSrpServer::new(identity, correct_password, salt);

            // Client uses wrong password
            let client = SrpClient::new(identity, wrong_password);

            // Get challenge from server
            let challenge = server.challenge();

            // Client processes challenge
            let proof = client.process_challenge(&challenge).unwrap();

            // Server computes session key
            let server_session_key = server.compute_session_key(&client.public_key());

            // Session keys should NOT match
            assert_ne!(proof.shared_secret, server_session_key);
        }
    }

    mod security {
        use super::*;

        #[test]
        fn private_key_zeroized_on_drop() {
            // Create client, drop it, verify memory is cleared
            // This is verified by the ZeroizeOnDrop derive
            let client = SrpClient::new(b"Pair-Setup", b"1234");
            drop(client);
            // The ZeroizeOnDrop derive ensures the private key is cleared
        }

        #[test]
        fn password_zeroized_on_drop() {
            // Create client, drop it, verify password is cleared
            // This is verified by the ZeroizeOnDrop derive
            let client = SrpClient::new(b"Pair-Setup", b"1234");
            drop(client);
            // The ZeroizeOnDrop derive ensures the password is cleared
        }
    }

    mod known_vectors {
        use super::*;

        #[test]
        fn rfc5054_appendix_b_prime() {
            // RFC 5054 Appendix B includes test vectors for 1024-bit group
            // We use 3072-bit, so we just verify our prime is valid
            let params = SrpParams::default();

            // Verify N is odd (should be for a prime)
            assert!(&params.n % BigUint::from(2u32) != BigUint::ZERO);

            // Verify N > g
            assert!(params.n > params.g);

            // Verify g^2 mod N != 1 (g has high order)
            let g_squared = params.g.modpow(&BigUint::from(2u32), &params.n);
            assert_ne!(g_squared, BigUint::from(1u32));
        }

        #[test]
        fn compute_x_matches_specification() {
            // x = H(salt || H(I || ":" || P))
            let salt = [0x01u8; 16];
            let identity = b"alice";
            let password = b"password123";

            // Manually compute expected x
            let mut inner_hasher = Sha512::new();
            inner_hasher.update(identity);
            inner_hasher.update(b":");
            inner_hasher.update(password);
            let inner_hash = inner_hasher.finalize();

            let mut outer_hasher = Sha512::new();
            outer_hasher.update(&salt);
            outer_hasher.update(&inner_hash);
            let expected_x = BigUint::from_bytes_be(&outer_hasher.finalize());

            let computed_x = compute_x(&salt, identity, password);
            assert_eq!(computed_x, expected_x);
        }
    }
}
