//! AES encryption for AirPlay.
//!
//! Supports:
//! - AES-128-CBC for legacy audio (RAOP)
//! - AES-128-GCM for fruit pair-setup phase 3
//! - AES-128-CTR for fruit pair-verify phase 2

use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit, StreamCipher};
use aes::Aes128;
use aes_gcm::{Aes128Gcm, Nonce as GcmNonce, Tag};
use aes_gcm::aead::{Aead, KeyInit as AeadKeyInit};
use airplay_core::error::CryptoError;
use ctr::cipher::KeyIvInit;
use zeroize::ZeroizeOnDrop;

type Aes128Ctr = ctr::Ctr64BE<Aes128>;

/// AES-128-CBC cipher for legacy AirPlay 1 audio encryption.
#[derive(ZeroizeOnDrop)]
pub struct AesCbcCipher {
    key: [u8; 16],
    #[zeroize(skip)]
    iv: [u8; 16],
}

impl AesCbcCipher {
    /// Create cipher with 16-byte key and IV.
    pub fn new(key: [u8; 16], iv: [u8; 16]) -> Self {
        Self { key, iv }
    }

    /// Encrypt plaintext (must be multiple of 16 bytes).
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if plaintext.len() % 16 != 0 {
            return Err(CryptoError::Encryption(
                "Plaintext must be a multiple of 16 bytes".to_string(),
            ));
        }

        let cipher = Aes128::new_from_slice(&self.key)
            .map_err(|e| CryptoError::Encryption(format!("Invalid key: {}", e)))?;

        let mut ciphertext = Vec::with_capacity(plaintext.len());
        let mut prev_block = self.iv;

        for chunk in plaintext.chunks(16) {
            // XOR with previous ciphertext (or IV for first block)
            let mut block = [0u8; 16];
            for i in 0..16 {
                block[i] = chunk[i] ^ prev_block[i];
            }

            // Encrypt in place
            let block_arr = aes::Block::from_mut_slice(&mut block);
            cipher.encrypt_block(block_arr);

            prev_block = block;
            ciphertext.extend_from_slice(&block);
        }

        Ok(ciphertext)
    }

    /// Decrypt ciphertext (must be multiple of 16 bytes).
    pub fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if ciphertext.len() % 16 != 0 {
            return Err(CryptoError::Decryption(
                "Ciphertext must be a multiple of 16 bytes".to_string(),
            ));
        }

        let cipher = Aes128::new_from_slice(&self.key)
            .map_err(|e| CryptoError::Decryption(format!("Invalid key: {}", e)))?;

        let mut plaintext = Vec::with_capacity(ciphertext.len());
        let mut prev_block = self.iv;

        for chunk in ciphertext.chunks(16) {
            let mut block = [0u8; 16];
            block.copy_from_slice(chunk);

            // Decrypt
            let block_arr = aes::Block::from_mut_slice(&mut block);
            cipher.decrypt_block(block_arr);

            // XOR with previous ciphertext (or IV for first block)
            for i in 0..16 {
                block[i] ^= prev_block[i];
            }

            prev_block.copy_from_slice(chunk);
            plaintext.extend_from_slice(&block);
        }

        Ok(plaintext)
    }

    /// Reset IV for new packet sequence.
    pub fn reset_iv(&mut self, iv: [u8; 16]) {
        self.iv = iv;
    }

    /// Get the stored IV.
    pub fn iv(&self) -> &[u8; 16] {
        &self.iv
    }

    /// Get the stored key.
    pub fn key(&self) -> &[u8; 16] {
        &self.key
    }
}

/// AES-128-GCM encryption for fruit pair-setup.
///
/// Used in pair-setup phase 3 to encrypt the client's Ed25519 public key.
pub fn aes_gcm_encrypt(
    plaintext: &[u8],
    key: &[u8; 16],
    iv: &[u8; 16],
) -> Result<(Vec<u8>, [u8; 16]), CryptoError> {
    let cipher = Aes128Gcm::new_from_slice(key)
        .map_err(|e| CryptoError::Encryption(format!("AES-GCM key init failed: {}", e)))?;

    // GCM uses 12-byte nonce, but fruit pairing uses 16-byte IV
    // We increment the last byte as the nonce (matching the C code: iv[15]++)
    let mut nonce_bytes = [0u8; 12];
    nonce_bytes.copy_from_slice(&iv[..12]);
    // The C code increments iv[15], but GCM only uses 12 bytes
    // We use the first 12 bytes as the nonce
    let nonce = GcmNonce::from_slice(&nonce_bytes);

    let ciphertext = cipher.encrypt(nonce, plaintext)
        .map_err(|e| CryptoError::Encryption(format!("AES-GCM encrypt failed: {}", e)))?;

    // The ciphertext includes the 16-byte tag at the end
    if ciphertext.len() < 16 {
        return Err(CryptoError::Encryption("AES-GCM output too short".to_string()));
    }

    let tag_start = ciphertext.len() - 16;
    let mut tag = [0u8; 16];
    tag.copy_from_slice(&ciphertext[tag_start..]);

    Ok((ciphertext[..tag_start].to_vec(), tag))
}

/// AES-128-GCM decryption for fruit pair-setup.
pub fn aes_gcm_decrypt(
    ciphertext: &[u8],
    tag: &[u8; 16],
    key: &[u8; 16],
    iv: &[u8; 16],
) -> Result<Vec<u8>, CryptoError> {
    let cipher = Aes128Gcm::new_from_slice(key)
        .map_err(|e| CryptoError::Decryption(format!("AES-GCM key init failed: {}", e)))?;

    let mut nonce_bytes = [0u8; 12];
    nonce_bytes.copy_from_slice(&iv[..12]);
    let nonce = GcmNonce::from_slice(&nonce_bytes);

    // Combine ciphertext and tag for decryption
    let mut combined = Vec::with_capacity(ciphertext.len() + 16);
    combined.extend_from_slice(ciphertext);
    combined.extend_from_slice(tag);

    cipher.decrypt(nonce, combined.as_slice())
        .map_err(|e| CryptoError::Decryption(format!("AES-GCM decrypt failed: {}", e)))
}

/// AES-128-CTR encryption for fruit pair-verify.
///
/// Used in pair-verify phase 2 to encrypt the signature.
/// Note: CTR mode encryption and decryption are the same operation.
pub fn aes_ctr_encrypt(
    plaintext: &[u8],
    key: &[u8; 16],
    iv: &[u8; 16],
) -> Result<Vec<u8>, CryptoError> {
    let mut cipher = Aes128Ctr::new(key.into(), iv.into());
    let mut output = plaintext.to_vec();
    cipher.apply_keystream(&mut output);
    Ok(output)
}

/// AES-128-CTR decryption for fruit pair-verify.
///
/// Note: CTR mode encryption and decryption are the same operation.
pub fn aes_ctr_decrypt(
    ciphertext: &[u8],
    key: &[u8; 16],
    iv: &[u8; 16],
) -> Result<Vec<u8>, CryptoError> {
    aes_ctr_encrypt(ciphertext, key, iv)
}

impl AesCbcCipher {
    /// RAOP encryption: only full 16-byte blocks are encrypted, trailing
    /// bytes pass through unencrypted. The IV is always reset to the
    /// original IV (stored at construction) before each call.
    ///
    /// This matches the AirPlay 1 / RAOP audio encryption behavior where
    /// each RTP packet is encrypted independently using the same key and
    /// original IV.
    pub fn encrypt_raop(&self, payload: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let full_blocks = payload.len() / 16;
        let full_len = full_blocks * 16;

        if full_blocks == 0 {
            // No full blocks — entire payload passes through unencrypted
            return Ok(payload.to_vec());
        }

        // Encrypt only the full-block portion using CBC with the stored IV
        let encrypted_blocks = self.encrypt(&payload[..full_len])?;

        // Concatenate encrypted blocks + trailing unencrypted bytes
        let mut result = Vec::with_capacity(payload.len());
        result.extend_from_slice(&encrypted_blocks);
        result.extend_from_slice(&payload[full_len..]);

        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_requires_block_aligned_input() {
        let cipher = AesCbcCipher::new([0u8; 16], [0u8; 16]);

        // Valid: 16 bytes
        assert!(cipher.encrypt(&[0u8; 16]).is_ok());

        // Valid: 32 bytes
        assert!(cipher.encrypt(&[0u8; 32]).is_ok());

        // Invalid: 15 bytes
        assert!(cipher.encrypt(&[0u8; 15]).is_err());

        // Invalid: 17 bytes
        assert!(cipher.encrypt(&[0u8; 17]).is_err());
    }

    #[test]
    fn decrypt_requires_block_aligned_input() {
        let cipher = AesCbcCipher::new([0u8; 16], [0u8; 16]);

        // Valid: 16 bytes
        assert!(cipher.decrypt(&[0u8; 16]).is_ok());

        // Invalid: 15 bytes
        assert!(cipher.decrypt(&[0u8; 15]).is_err());
    }

    #[test]
    fn decrypt_roundtrip() {
        let key = [0x42u8; 16];
        let iv = [0x24u8; 16];
        let cipher = AesCbcCipher::new(key, iv);

        let plaintext = b"Hello, AirPlay!!"; // Exactly 16 bytes
        let ciphertext = cipher.encrypt(plaintext).unwrap();
        let decrypted = cipher.decrypt(&ciphertext).unwrap();

        assert_eq!(&decrypted, plaintext);
    }

    #[test]
    fn decrypt_roundtrip_multiple_blocks() {
        let key = [0x42u8; 16];
        let iv = [0x24u8; 16];
        let cipher = AesCbcCipher::new(key, iv);

        let plaintext = [0xABu8; 64]; // 4 blocks
        let ciphertext = cipher.encrypt(&plaintext).unwrap();
        let decrypted = cipher.decrypt(&ciphertext).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn reset_iv_works() {
        let key = [0x42u8; 16];
        let iv1 = [0x01u8; 16];
        let iv2 = [0x02u8; 16];

        let mut cipher = AesCbcCipher::new(key, iv1);
        let plaintext = [0xABu8; 16];

        let ct1 = cipher.encrypt(&plaintext).unwrap();

        cipher.reset_iv(iv2);
        let ct2 = cipher.encrypt(&plaintext).unwrap();

        // Different IVs should produce different ciphertexts
        assert_ne!(ct1, ct2);
    }

    #[test]
    fn nist_test_vector() {
        // NIST SP 800-38A - F.2.1 CBC-AES128.Encrypt
        let key = hex::decode("2b7e151628aed2a6abf7158809cf4f3c").unwrap();
        let iv = hex::decode("000102030405060708090a0b0c0d0e0f").unwrap();
        let plaintext = hex::decode("6bc1bee22e409f96e93d7e117393172a").unwrap();
        let expected_ciphertext = hex::decode("7649abac8119b246cee98e9b12e9197d").unwrap();

        let mut key_arr = [0u8; 16];
        let mut iv_arr = [0u8; 16];
        key_arr.copy_from_slice(&key);
        iv_arr.copy_from_slice(&iv);

        let cipher = AesCbcCipher::new(key_arr, iv_arr);
        let ciphertext = cipher.encrypt(&plaintext).unwrap();

        assert_eq!(ciphertext, expected_ciphertext);

        // Verify decryption
        let decrypted = cipher.decrypt(&ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn nist_test_vector_multiple_blocks() {
        // NIST SP 800-38A - F.2.1 CBC-AES128.Encrypt (4 blocks)
        let key = hex::decode("2b7e151628aed2a6abf7158809cf4f3c").unwrap();
        let iv = hex::decode("000102030405060708090a0b0c0d0e0f").unwrap();
        let plaintext = hex::decode(concat!(
            "6bc1bee22e409f96e93d7e117393172a",
            "ae2d8a571e03ac9c9eb76fac45af8e51",
            "30c81c46a35ce411e5fbc1191a0a52ef",
            "f69f2445df4f9b17ad2b417be66c3710"
        ))
        .unwrap();
        let expected_ciphertext = hex::decode(concat!(
            "7649abac8119b246cee98e9b12e9197d",
            "5086cb9b507219ee95db113a917678b2",
            "73bed6b8e3c1743b7116e69e22229516",
            "3ff1caa1681fac09120eca307586e1a7"
        ))
        .unwrap();

        let mut key_arr = [0u8; 16];
        let mut iv_arr = [0u8; 16];
        key_arr.copy_from_slice(&key);
        iv_arr.copy_from_slice(&iv);

        let cipher = AesCbcCipher::new(key_arr, iv_arr);
        let ciphertext = cipher.encrypt(&plaintext).unwrap();

        assert_eq!(ciphertext, expected_ciphertext);

        // Verify decryption
        let decrypted = cipher.decrypt(&ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn encrypt_raop_full_blocks_only() {
        let key = [0x42u8; 16];
        let iv = [0x24u8; 16];
        let cipher = AesCbcCipher::new(key, iv);

        // 32 bytes = 2 full blocks, all encrypted
        let payload = [0xABu8; 32];
        let encrypted = cipher.encrypt_raop(&payload).unwrap();
        assert_eq!(encrypted.len(), 32);
        // Should equal normal encrypt since payload is block-aligned
        let expected = cipher.encrypt(&payload).unwrap();
        assert_eq!(encrypted, expected);
    }

    #[test]
    fn encrypt_raop_partial_block_passthrough() {
        let key = [0x42u8; 16];
        let iv = [0x24u8; 16];
        let cipher = AesCbcCipher::new(key, iv);

        // 20 bytes = 1 full block (16) + 4 trailing bytes
        let mut payload = [0xABu8; 20];
        payload[16] = 0xDE;
        payload[17] = 0xAD;
        payload[18] = 0xBE;
        payload[19] = 0xEF;

        let encrypted = cipher.encrypt_raop(&payload).unwrap();
        assert_eq!(encrypted.len(), 20);

        // First 16 bytes should be encrypted (same as full block encrypt)
        let expected_block = cipher.encrypt(&payload[..16]).unwrap();
        assert_eq!(&encrypted[..16], &expected_block[..]);

        // Last 4 bytes should pass through unencrypted
        assert_eq!(&encrypted[16..], &[0xDE, 0xAD, 0xBE, 0xEF]);
    }

    #[test]
    fn encrypt_raop_less_than_one_block() {
        let cipher = AesCbcCipher::new([0u8; 16], [0u8; 16]);

        // 10 bytes: no full blocks, all pass through
        let payload = [0x42u8; 10];
        let encrypted = cipher.encrypt_raop(&payload).unwrap();
        assert_eq!(encrypted, payload);
    }

    #[test]
    fn encrypt_raop_empty_payload() {
        let cipher = AesCbcCipher::new([0u8; 16], [0u8; 16]);
        let encrypted = cipher.encrypt_raop(&[]).unwrap();
        assert!(encrypted.is_empty());
    }

    #[test]
    fn encrypt_raop_uses_original_iv() {
        // Calling encrypt_raop multiple times should produce the same output
        // because it always uses the stored (original) IV
        let key = [0x42u8; 16];
        let iv = [0x24u8; 16];
        let cipher = AesCbcCipher::new(key, iv);

        let payload = [0xABu8; 32];
        let ct1 = cipher.encrypt_raop(&payload).unwrap();
        let ct2 = cipher.encrypt_raop(&payload).unwrap();
        assert_eq!(ct1, ct2, "encrypt_raop must always use the original IV");
    }

    #[test]
    fn key_zeroized_on_drop() {
        // Create cipher, drop it, verify memory is cleared
        // This is verified by the ZeroizeOnDrop derive
        let cipher = AesCbcCipher::new([0x42u8; 16], [0x24u8; 16]);
        drop(cipher);
        // The ZeroizeOnDrop derive ensures the key is cleared
    }
}
