//! Encrypted control channel with length-prefixed framing.
//!
//! After pair-verify completes, all subsequent RTSP communication must be
//! encrypted using ChaCha20-Poly1305 with a length-prefixed framing protocol.

use airplay_crypto::chacha::ControlCipher;
use airplay_crypto::keys::SessionKeys;
use airplay_core::error::{CryptoError, Error, Result};

/// Encrypted control channel for post-pairing communication.
///
/// After pair-verify completes successfully, all subsequent RTSP messages
/// must be encrypted using this channel. The framing protocol is:
///
/// ```text
/// +----------------+------------------+----------+
/// | Length (2 BE)  | Ciphertext (N)   | Tag (16) |
/// +----------------+------------------+----------+
/// ```
///
/// - Length: 2 bytes, big-endian, size of ciphertext + tag
/// - Ciphertext: encrypted plaintext
/// - Tag: 16-byte ChaCha20-Poly1305 authentication tag
///
/// Nonces are auto-incrementing counters, separate for read and write directions.
pub struct EncryptedChannel {
    /// Cipher for encrypting outgoing messages (controller -> accessory)
    write_cipher: ControlCipher,
    /// Cipher for decrypting incoming messages (accessory -> controller)
    read_cipher: ControlCipher,
}

impl EncryptedChannel {
    /// Create a new encrypted channel from session keys.
    ///
    /// The session keys are derived from pair-verify and contain
    /// separate read and write keys for bidirectional encryption.
    pub fn new(keys: SessionKeys) -> Self {
        Self {
            write_cipher: ControlCipher::new_unidirectional(*keys.write_key.as_bytes()),
            read_cipher: ControlCipher::new_unidirectional(*keys.read_key.as_bytes()),
        }
    }

    /// Create a channel with explicit keys.
    ///
    /// This is useful for testing or when resuming a session.
    pub fn with_keys(write_key: [u8; 32], read_key: [u8; 32]) -> Self {
        Self {
            write_cipher: ControlCipher::new_unidirectional(write_key),
            read_cipher: ControlCipher::new_unidirectional(read_key),
        }
    }

    /// Encrypt data with framing (2-byte length + ciphertext + 16-byte tag).
    ///
    /// Returns the complete framed message ready to send over the wire.
    /// The write nonce is automatically incremented after each call.
    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>> {
        // Encrypt with current nonce
        let ciphertext = self
            .write_cipher
            .encrypt(plaintext)
            .map_err(|e| Error::Crypto(e))?;

        // Build framed message: length (2 BE) + ciphertext
        let len = ciphertext.len() as u16;
        let mut framed = Vec::with_capacity(2 + ciphertext.len());
        framed.extend_from_slice(&len.to_be_bytes());
        framed.extend_from_slice(&ciphertext);

        Ok(framed)
    }

    /// Encrypt data without framing (raw ciphertext + tag).
    ///
    /// Use this when the transport handles framing separately.
    /// The write nonce is automatically incremented after each call.
    pub fn encrypt_raw(&mut self, plaintext: &[u8]) -> Result<Vec<u8>> {
        self.write_cipher
            .encrypt(plaintext)
            .map_err(|e| Error::Crypto(e))
    }

    /// Decrypt framed data (expects 2-byte little-endian length prefix).
    ///
    /// Parses the length prefix and decrypts the ciphertext.
    /// The read nonce is automatically incremented after each call.
    pub fn decrypt(&mut self, framed: &[u8]) -> Result<Vec<u8>> {
        if framed.len() < 2 {
            return Err(Error::Crypto(CryptoError::Decryption(
                "Frame too short: missing length prefix".to_string(),
            )));
        }

        // Parse length prefix
        let len = u16::from_le_bytes([framed[0], framed[1]]) as usize;
        let expected_total = 2 + len;

        if framed.len() < expected_total {
            return Err(Error::Crypto(CryptoError::Decryption(format!(
                "Frame truncated: expected {} bytes, got {}",
                expected_total,
                framed.len()
            ))));
        }

        // Extract ciphertext (includes auth tag)
        let ciphertext = &framed[2..expected_total];

        // Decrypt
        self.read_cipher
            .decrypt_raw(ciphertext)
            .map_err(|e| Error::Crypto(e))
    }

    /// Decrypt raw ciphertext (no framing, expects ciphertext + 16-byte tag).
    ///
    /// Use this when the transport handles framing separately.
    /// The read nonce is automatically incremented after each call.
    pub fn decrypt_raw(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>> {
        self.read_cipher
            .decrypt_raw(ciphertext)
            .map_err(|e| Error::Crypto(e))
    }

    /// Get the current write nonce counter.
    pub fn write_nonce(&self) -> u64 {
        self.write_cipher.encrypt_counter()
    }

    /// Get the current read nonce counter.
    pub fn read_nonce(&self) -> u64 {
        self.read_cipher.decrypt_counter()
    }

    /// Reset both nonce counters to zero.
    pub fn reset_counters(&mut self) {
        self.write_cipher.reset_counters();
        self.read_cipher.reset_counters();
    }

    /// Parse length prefix from a frame and return the expected total frame size.
    ///
    /// Returns `None` if the buffer is too short to contain the length prefix.
    pub fn parse_frame_length(data: &[u8]) -> Option<usize> {
        if data.len() < 2 {
            return None;
        }
        let len = u16::from_le_bytes([data[0], data[1]]) as usize;
        Some(2 + len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_keys() -> ([u8; 32], [u8; 32]) {
        let write_key = [
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
            0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
            0x1d, 0x1e, 0x1f, 0x20,
        ];
        let read_key = [
            0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e,
            0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c,
            0x3d, 0x3e, 0x3f, 0x40,
        ];
        (write_key, read_key)
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let (write_key, read_key) = test_keys();

        // Create channels with swapped keys for sender/receiver
        let mut sender = EncryptedChannel::with_keys(write_key, read_key);
        let mut receiver = EncryptedChannel::with_keys(read_key, write_key);

        let plaintext = b"Hello, encrypted world!";

        // Sender encrypts with write key, receiver decrypts with read key
        let framed = sender.encrypt(plaintext).unwrap();
        let decrypted = receiver.decrypt(&framed).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn nonce_increments_after_each_operation() {
        let (write_key, read_key) = test_keys();
        let mut channel = EncryptedChannel::with_keys(write_key, read_key);

        assert_eq!(channel.write_nonce(), 0);
        assert_eq!(channel.read_nonce(), 0);

        // Encrypt increments write nonce
        let _ = channel.encrypt(b"test").unwrap();
        assert_eq!(channel.write_nonce(), 1);

        let _ = channel.encrypt(b"test").unwrap();
        assert_eq!(channel.write_nonce(), 2);
    }

    #[test]
    fn framed_message_has_correct_format() {
        let (write_key, read_key) = test_keys();
        let mut channel = EncryptedChannel::with_keys(write_key, read_key);

        let plaintext = b"test";
        let framed = channel.encrypt(plaintext).unwrap();

        // Frame should be: 2-byte length + ciphertext (4) + tag (16) = 22 bytes total
        // Length prefix should encode 20 (4 + 16)
        assert_eq!(framed.len(), 22);
        assert_eq!(framed[0], 0x00);
        assert_eq!(framed[1], 20);
    }

    #[test]
    fn parse_frame_length_works() {
        let data = [0x00, 0x14, 0x01, 0x02, 0x03]; // length = 20
        assert_eq!(EncryptedChannel::parse_frame_length(&data), Some(22));

        let short_data = [0x00];
        assert_eq!(EncryptedChannel::parse_frame_length(&short_data), None);
    }

    #[test]
    fn decrypt_rejects_truncated_frame() {
        let (write_key, read_key) = test_keys();
        let mut channel = EncryptedChannel::with_keys(write_key, read_key);

        // Frame claims 20 bytes but only has 10
        let truncated = [0x00, 0x14, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];
        let result = channel.decrypt(&truncated);

        assert!(result.is_err());
    }

    #[test]
    fn raw_encrypt_decrypt_roundtrip() {
        let (write_key, read_key) = test_keys();

        let mut sender = EncryptedChannel::with_keys(write_key, read_key);
        let mut receiver = EncryptedChannel::with_keys(read_key, write_key);

        let plaintext = b"Raw message without framing";

        let ciphertext = sender.encrypt_raw(plaintext).unwrap();
        let decrypted = receiver.decrypt_raw(&ciphertext).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn multiple_messages_with_incrementing_nonces() {
        let (write_key, read_key) = test_keys();

        let mut sender = EncryptedChannel::with_keys(write_key, read_key);
        let mut receiver = EncryptedChannel::with_keys(read_key, write_key);

        for i in 0..10 {
            let plaintext = format!("Message {}", i);
            let framed = sender.encrypt(plaintext.as_bytes()).unwrap();
            let decrypted = receiver.decrypt(&framed).unwrap();
            assert_eq!(decrypted, plaintext.as_bytes());
        }

        assert_eq!(sender.write_nonce(), 10);
        assert_eq!(receiver.read_nonce(), 10);
    }

    #[test]
    fn reset_counters_works() {
        let (write_key, read_key) = test_keys();
        let mut channel = EncryptedChannel::with_keys(write_key, read_key);

        let _ = channel.encrypt(b"test").unwrap();
        let _ = channel.encrypt(b"test").unwrap();
        assert_eq!(channel.write_nonce(), 2);

        channel.reset_counters();
        assert_eq!(channel.write_nonce(), 0);
        assert_eq!(channel.read_nonce(), 0);
    }
}
