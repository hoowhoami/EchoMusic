//! RTP packet cipher abstraction.
//!
//! Provides a trait for encrypting audio payloads, with implementations
//! for both AirPlay 2 (ChaCha20-Poly1305) and AirPlay 1 (AES-128-CBC).

use airplay_core::error::Result;
use airplay_crypto::aes::AesCbcCipher;
use airplay_crypto::chacha::AudioCipher;

/// Encrypted audio payload with optional authentication data.
pub struct EncryptedPayload {
    /// Encrypted audio data.
    pub data: Vec<u8>,
    /// Authentication tag (ChaCha20-Poly1305 only, 16 bytes).
    pub tag: Option<[u8; 16]>,
    /// Nonce (ChaCha20-Poly1305 only, 8 bytes).
    pub nonce: Option<[u8; 8]>,
}

/// Trait for encrypting RTP audio payloads.
///
/// Implementations handle the cipher-specific details (key management,
/// nonce generation, IV reset) while `RtpSender` handles packet framing.
pub trait PacketCipher: Send {
    /// Encrypt an audio payload for RTP transmission.
    ///
    /// The `timestamp`, `ssrc`, and `sequence` are from the RTP header and
    /// may be used as AAD or nonce material depending on the cipher.
    fn encrypt_payload(
        &self,
        payload: &[u8],
        timestamp: u32,
        ssrc: u32,
        sequence: u16,
    ) -> Result<EncryptedPayload>;
}

/// ChaCha20-Poly1305 cipher for AirPlay 2 audio.
///
/// Wraps `AudioCipher` and produces authenticated ciphertext with
/// a 16-byte tag and 8-byte nonce appended to each packet.
pub struct ChaChaPacketCipher {
    cipher: AudioCipher,
}

impl ChaChaPacketCipher {
    /// Create a new ChaCha20-Poly1305 packet cipher from an existing `AudioCipher`.
    pub fn new(cipher: AudioCipher) -> Self {
        Self { cipher }
    }
}

impl PacketCipher for ChaChaPacketCipher {
    fn encrypt_payload(
        &self,
        payload: &[u8],
        timestamp: u32,
        ssrc: u32,
        sequence: u16,
    ) -> Result<EncryptedPayload> {
        let (ciphertext, nonce, tag) = self
            .cipher
            .encrypt_with_seq(payload, timestamp, ssrc, sequence)
            .map_err(|e| airplay_core::error::Error::Crypto(e))?;

        Ok(EncryptedPayload {
            data: ciphertext,
            tag: Some(tag),
            nonce: Some(nonce),
        })
    }
}

/// AES-128-CBC cipher for AirPlay 1 (RAOP) audio.
///
/// Each packet is encrypted independently: only full 16-byte blocks are
/// encrypted, trailing bytes pass through unencrypted. The IV is always
/// reset to the original IV before each packet.
pub struct AesCbcPacketCipher {
    key: [u8; 16],
    iv: [u8; 16],
}

impl AesCbcPacketCipher {
    /// Create a new AES-CBC packet cipher with the given key and IV.
    pub fn new(key: [u8; 16], iv: [u8; 16]) -> Self {
        Self { key, iv }
    }
}

impl PacketCipher for AesCbcPacketCipher {
    fn encrypt_payload(
        &self,
        payload: &[u8],
        _timestamp: u32,
        _ssrc: u32,
        _sequence: u16,
    ) -> Result<EncryptedPayload> {
        // Create a fresh cipher with the original IV for each packet
        let cipher = AesCbcCipher::new(self.key, self.iv);
        let encrypted = cipher
            .encrypt_raop(payload)
            .map_err(|e| airplay_core::error::Error::Crypto(e))?;

        Ok(EncryptedPayload {
            data: encrypted,
            tag: None,
            nonce: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aes_cbc_packet_cipher_no_tag_or_nonce() {
        let cipher = AesCbcPacketCipher::new([0x42u8; 16], [0x24u8; 16]);
        let payload = vec![0xAB; 32]; // 2 full blocks
        let result = cipher.encrypt_payload(&payload, 0, 0, 0).unwrap();

        assert!(result.tag.is_none());
        assert!(result.nonce.is_none());
        assert_eq!(result.data.len(), 32);
        // Should be encrypted (different from plaintext)
        assert_ne!(result.data, payload);
    }

    #[test]
    fn aes_cbc_packet_cipher_deterministic_per_packet() {
        let cipher = AesCbcPacketCipher::new([0x42u8; 16], [0x24u8; 16]);
        let payload = vec![0xAB; 32];

        // Each call should produce the same output (IV always reset)
        let r1 = cipher.encrypt_payload(&payload, 0, 0, 0).unwrap();
        let r2 = cipher.encrypt_payload(&payload, 0, 0, 1).unwrap();
        assert_eq!(r1.data, r2.data);
    }

    #[test]
    fn aes_cbc_packet_cipher_partial_block_passthrough() {
        let cipher = AesCbcPacketCipher::new([0x42u8; 16], [0x24u8; 16]);
        let mut payload = vec![0xAB; 20]; // 1 full block + 4 trailing
        payload[16] = 0xDE;
        payload[17] = 0xAD;
        payload[18] = 0xBE;
        payload[19] = 0xEF;

        let result = cipher.encrypt_payload(&payload, 0, 0, 0).unwrap();
        assert_eq!(result.data.len(), 20);
        // Trailing bytes should pass through
        assert_eq!(&result.data[16..], &[0xDE, 0xAD, 0xBE, 0xEF]);
    }

    #[test]
    fn chacha_packet_cipher_has_tag_and_nonce() {
        let audio_cipher = AudioCipher::new([0x42u8; 32]);
        let cipher = ChaChaPacketCipher::new(audio_cipher);
        let payload = vec![0xAB; 100];

        let result = cipher.encrypt_payload(&payload, 1000, 0x1234, 1).unwrap();
        assert!(result.tag.is_some());
        assert!(result.nonce.is_some());
        assert_eq!(result.tag.unwrap().len(), 16);
        assert_eq!(result.nonce.unwrap().len(), 8);
    }

    #[test]
    fn chacha_packet_cipher_encrypts_data() {
        let audio_cipher = AudioCipher::new([0x42u8; 32]);
        let cipher = ChaChaPacketCipher::new(audio_cipher);
        let payload = vec![0xAB; 100];

        let result = cipher.encrypt_payload(&payload, 1000, 0x1234, 1).unwrap();
        // Encrypted data should differ from plaintext
        assert_ne!(result.data, payload);
    }
}
