//! TLV8 encoding/decoding for HomeKit pairing messages.
//!
//! TLV8 format: [Type: 1 byte][Length: 1 byte][Value: 0-255 bytes]
//! Values longer than 255 bytes are fragmented across multiple TLVs.

use airplay_core::error::ParseError;
use std::collections::HashMap;

/// TLV type constants for HomeKit pairing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum TlvType {
    Method = 0x00,
    Identifier = 0x01,
    Salt = 0x02,
    PublicKey = 0x03,
    Proof = 0x04,
    EncryptedData = 0x05,
    State = 0x06,
    Error = 0x07,
    RetryDelay = 0x08,
    Certificate = 0x09,
    Signature = 0x0A,
    Permissions = 0x0B,
    FragmentData = 0x0C,
    FragmentLast = 0x0D,
    SessionId = 0x0E,
    Flags = 0x13,
    Separator = 0xFF,
}

/// Parsed TLV8 message.
#[derive(Debug, Clone, Default)]
pub struct Tlv8 {
    items: HashMap<u8, Vec<u8>>,
}

impl Tlv8 {
    /// Create empty TLV8 message.
    pub fn new() -> Self {
        Self::default()
    }

    /// Parse TLV8 from bytes.
    ///
    /// Handles fragmented values (values > 255 bytes split across multiple TLVs).
    /// Consecutive TLVs with the same type are concatenated.
    pub fn parse(data: &[u8]) -> Result<Self, ParseError> {
        let mut items: HashMap<u8, Vec<u8>> = HashMap::new();
        let mut i = 0;
        let mut last_type: Option<u8> = None;

        while i < data.len() {
            // Need at least 2 bytes for type and length
            if i + 2 > data.len() {
                return Err(ParseError::InvalidFormat(
                    "TLV8: truncated header".to_string(),
                ));
            }

            let typ = data[i];
            let len = data[i + 1] as usize;
            i += 2;

            // Check if we have enough bytes for the value
            if i + len > data.len() {
                return Err(ParseError::InvalidFormat(format!(
                    "TLV8: truncated value (expected {} bytes, got {})",
                    len,
                    data.len() - i
                )));
            }

            let value = &data[i..i + len];
            i += len;

            // Handle fragmentation: if same type as previous, append to existing value
            if Some(typ) == last_type {
                if let Some(existing) = items.get_mut(&typ) {
                    existing.extend_from_slice(value);
                }
            } else {
                // New type or first occurrence
                items
                    .entry(typ)
                    .or_insert_with(Vec::new)
                    .extend_from_slice(value);
            }

            last_type = Some(typ);
        }

        Ok(Self { items })
    }

    /// Encode to bytes.
    ///
    /// Values > 255 bytes are automatically fragmented across multiple TLVs.
    pub fn encode(&self) -> Vec<u8> {
        let mut result = Vec::new();

        // Sort by type for deterministic output
        let mut types: Vec<_> = self.items.keys().collect();
        types.sort();

        for typ in types {
            let value = &self.items[typ];

            if value.is_empty() {
                // Zero-length value
                result.push(*typ);
                result.push(0);
            } else {
                // Fragment if necessary
                for chunk in value.chunks(255) {
                    result.push(*typ);
                    result.push(chunk.len() as u8);
                    result.extend_from_slice(chunk);
                }
            }
        }

        result
    }

    /// Get value for type.
    pub fn get(&self, typ: TlvType) -> Option<&[u8]> {
        self.items.get(&(typ as u8)).map(|v| v.as_slice())
    }

    /// Get value for raw type.
    pub fn get_raw(&self, typ: u8) -> Option<&[u8]> {
        self.items.get(&typ).map(|v| v.as_slice())
    }

    /// Set value for type.
    pub fn set(&mut self, typ: TlvType, value: impl Into<Vec<u8>>) {
        self.items.insert(typ as u8, value.into());
    }

    /// Set value for raw type.
    pub fn set_raw(&mut self, typ: u8, value: impl Into<Vec<u8>>) {
        self.items.insert(typ, value.into());
    }

    /// Check if type is present.
    pub fn contains(&self, typ: TlvType) -> bool {
        self.items.contains_key(&(typ as u8))
    }

    /// Get state value (single byte).
    pub fn state(&self) -> Option<u8> {
        self.get(TlvType::State).and_then(|v| v.first().copied())
    }

    /// Get error value (single byte).
    pub fn error(&self) -> Option<u8> {
        self.get(TlvType::Error).and_then(|v| v.first().copied())
    }

    /// Get retry delay value in seconds (for rate limiting).
    /// The value is little-endian encoded (1-2 bytes).
    pub fn retry_delay(&self) -> Option<u16> {
        self.get(TlvType::RetryDelay).map(|v| {
            match v.len() {
                0 => 0,
                1 => v[0] as u16,
                _ => u16::from_le_bytes([v[0], v[1]]),
            }
        })
    }

    /// Get error description string.
    pub fn error_description(&self) -> Option<String> {
        let error_code = self.error()?;
        let error_name = match error_code {
            0x01 => "Unknown",
            0x02 => "Authentication",
            0x03 => "Backoff (rate limited)",
            0x04 => "MaxPeers",
            0x05 => "MaxTries",
            0x06 => "Unavailable",
            0x07 => "Busy",
            _ => "Unknown error code",
        };

        let mut desc = format!("Error 0x{:02x}: {}", error_code, error_name);

        if let Some(delay) = self.retry_delay() {
            if delay > 0 {
                desc.push_str(&format!(" (retry after {} seconds)", delay));
            }
        }

        Some(desc)
    }

    /// Create M1 pair-setup request.
    pub fn pair_setup_m1() -> Self {
        let mut tlv = Self::new();
        tlv.set(TlvType::State, vec![0x01]);
        tlv.set(TlvType::Method, vec![0x00]); // PairSetup
        tlv
    }

    /// Create M1 pair-setup request with transient Flags.
    ///
    /// The transient flag is `kPairingFlag_Transient = 0x00000010` (bit 4),
    /// encoded as a 4-byte little-endian u32.
    pub fn pair_setup_m1_with_flags() -> Self {
        let mut tlv = Self::new();
        tlv.set(TlvType::State, vec![0x01]);      // State = M1
        tlv.set(TlvType::Method, vec![0x00]);      // Method = PairSetup
        // Transient flag = 0x10 as 4-byte little-endian
        tlv.set(TlvType::Flags, vec![0x10, 0x00, 0x00, 0x00]);
        tlv
    }

    /// Create M1 pair-verify request with public key.
    pub fn pair_verify_m1(public_key: &[u8; 32]) -> Self {
        let mut tlv = Self::new();
        tlv.set(TlvType::State, vec![0x01]);
        tlv.set(TlvType::PublicKey, public_key.to_vec());
        tlv
    }
}

impl TlvType {
    /// Convert from raw byte.
    pub fn from_byte(b: u8) -> Option<Self> {
        match b {
            0x00 => Some(Self::Method),
            0x01 => Some(Self::Identifier),
            0x02 => Some(Self::Salt),
            0x03 => Some(Self::PublicKey),
            0x04 => Some(Self::Proof),
            0x05 => Some(Self::EncryptedData),
            0x06 => Some(Self::State),
            0x07 => Some(Self::Error),
            0x08 => Some(Self::RetryDelay),
            0x09 => Some(Self::Certificate),
            0x0A => Some(Self::Signature),
            0x0B => Some(Self::Permissions),
            0x0C => Some(Self::FragmentData),
            0x0D => Some(Self::FragmentLast),
            0x0E => Some(Self::SessionId),
            0x13 => Some(Self::Flags),
            0xFF => Some(Self::Separator),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod parsing {
        use super::*;

        #[test]
        fn parse_empty() {
            let tlv = Tlv8::parse(&[]).unwrap();
            assert!(!tlv.contains(TlvType::State));
        }

        #[test]
        fn parse_single_tlv() {
            // State = 0x01
            let data = [0x06, 0x01, 0x01]; // Type=State, Length=1, Value=0x01
            let tlv = Tlv8::parse(&data).unwrap();
            assert_eq!(tlv.state(), Some(0x01));
        }

        #[test]
        fn parse_multiple_tlvs() {
            // State=0x01, Method=0x00
            let data = [
                0x06, 0x01, 0x01, // State=1
                0x00, 0x01, 0x00, // Method=0
            ];
            let tlv = Tlv8::parse(&data).unwrap();
            assert_eq!(tlv.state(), Some(0x01));
            assert_eq!(tlv.get(TlvType::Method), Some([0x00].as_slice()));
        }

        #[test]
        fn parse_zero_length_value() {
            let data = [0x06, 0x00]; // State with zero-length value
            let tlv = Tlv8::parse(&data).unwrap();
            assert_eq!(tlv.get(TlvType::State), Some([].as_slice()));
        }

        #[test]
        fn parse_max_length_value() {
            // 255 bytes of data
            let mut data = vec![0x03, 0xFF]; // PublicKey, length=255
            data.extend(vec![0xAA; 255]);
            let tlv = Tlv8::parse(&data).unwrap();
            let pk = tlv.get(TlvType::PublicKey).unwrap();
            assert_eq!(pk.len(), 255);
            assert!(pk.iter().all(|&b| b == 0xAA));
        }

        #[test]
        fn parse_fragmented_value() {
            // 300 bytes split: 255 + 45
            let mut data = vec![0x03, 0xFF]; // First fragment: 255 bytes
            data.extend(vec![0xAA; 255]);
            data.extend([0x03, 0x2D]); // Second fragment: 45 bytes
            data.extend(vec![0xBB; 45]);

            let tlv = Tlv8::parse(&data).unwrap();
            let pk = tlv.get(TlvType::PublicKey).unwrap();
            assert_eq!(pk.len(), 300);
            assert!(pk[..255].iter().all(|&b| b == 0xAA));
            assert!(pk[255..].iter().all(|&b| b == 0xBB));
        }

        #[test]
        fn parse_error_on_truncated_header() {
            let result = Tlv8::parse(&[0x06]); // Only type, no length
            assert!(result.is_err());
        }

        #[test]
        fn parse_error_on_truncated_value() {
            let data = [0x06, 0x05, 0x01, 0x02]; // Claims 5 bytes but only has 2
            let result = Tlv8::parse(&data);
            assert!(result.is_err());
        }
    }

    mod encoding {
        use super::*;

        #[test]
        fn encode_empty() {
            let tlv = Tlv8::new();
            assert!(tlv.encode().is_empty());
        }

        #[test]
        fn encode_single_tlv() {
            let mut tlv = Tlv8::new();
            tlv.set(TlvType::State, vec![0x01]);
            let encoded = tlv.encode();
            assert_eq!(encoded, vec![0x06, 0x01, 0x01]);
        }

        #[test]
        fn encode_multiple_tlvs() {
            let mut tlv = Tlv8::new();
            tlv.set(TlvType::State, vec![0x01]);
            tlv.set(TlvType::Method, vec![0x00]);
            let encoded = tlv.encode();
            // Sorted by type: Method (0x00) comes before State (0x06)
            assert_eq!(
                encoded,
                vec![
                    0x00, 0x01, 0x00, // Method
                    0x06, 0x01, 0x01 // State
                ]
            );
        }

        #[test]
        fn encode_fragments_long_values() {
            let mut tlv = Tlv8::new();
            let long_value: Vec<u8> = (0..300).map(|i| (i % 256) as u8).collect();
            tlv.set(TlvType::PublicKey, long_value.clone());

            let encoded = tlv.encode();

            // Should be: [type][255][first 255 bytes][type][45][remaining 45 bytes]
            assert_eq!(encoded[0], 0x03); // PublicKey type
            assert_eq!(encoded[1], 255); // First chunk length
            assert_eq!(&encoded[2..257], &long_value[..255]); // First chunk data
            assert_eq!(encoded[257], 0x03); // PublicKey type again
            assert_eq!(encoded[258], 45); // Second chunk length
            assert_eq!(&encoded[259..], &long_value[255..]); // Second chunk data
        }

        #[test]
        fn encode_roundtrip() {
            let mut tlv = Tlv8::new();
            tlv.set(TlvType::State, vec![0x03]);
            tlv.set(TlvType::PublicKey, vec![0xAB; 384]); // SRP public key size
            tlv.set(TlvType::Proof, vec![0xCD; 64]);

            let encoded = tlv.encode();
            let decoded = Tlv8::parse(&encoded).unwrap();

            assert_eq!(decoded.state(), Some(0x03));
            assert_eq!(decoded.get(TlvType::PublicKey).unwrap().len(), 384);
            assert_eq!(decoded.get(TlvType::Proof).unwrap().len(), 64);
        }
    }

    mod accessors {
        use super::*;

        #[test]
        fn get_existing_type() {
            let mut tlv = Tlv8::new();
            tlv.set(TlvType::State, vec![0x01, 0x02, 0x03]);
            assert_eq!(tlv.get(TlvType::State), Some([0x01, 0x02, 0x03].as_slice()));
        }

        #[test]
        fn get_missing_type() {
            let tlv = Tlv8::new();
            assert_eq!(tlv.get(TlvType::State), None);
        }

        #[test]
        fn state_returns_first_byte() {
            let mut tlv = Tlv8::new();
            tlv.set(TlvType::State, vec![0x05, 0xFF, 0xFF]);
            assert_eq!(tlv.state(), Some(0x05));
        }

        #[test]
        fn error_returns_first_byte() {
            let mut tlv = Tlv8::new();
            tlv.set(TlvType::Error, vec![0x02]);
            assert_eq!(tlv.error(), Some(0x02));
        }

        #[test]
        fn contains_checks_presence() {
            let mut tlv = Tlv8::new();
            assert!(!tlv.contains(TlvType::State));
            tlv.set(TlvType::State, vec![0x01]);
            assert!(tlv.contains(TlvType::State));
            assert!(!tlv.contains(TlvType::Error));
        }
    }

    mod message_builders {
        use super::*;

        #[test]
        fn pair_setup_m1_has_state_1() {
            let tlv = Tlv8::pair_setup_m1();
            assert_eq!(tlv.state(), Some(0x01));
        }

        #[test]
        fn pair_setup_m1_has_method_0() {
            let tlv = Tlv8::pair_setup_m1();
            assert_eq!(tlv.get(TlvType::Method), Some([0x00].as_slice()));
        }

        #[test]
        fn pair_verify_m1_has_state_1() {
            let pk = [0xAB; 32];
            let tlv = Tlv8::pair_verify_m1(&pk);
            assert_eq!(tlv.state(), Some(0x01));
        }

        #[test]
        fn pair_verify_m1_has_public_key() {
            let pk = [0xAB; 32];
            let tlv = Tlv8::pair_verify_m1(&pk);
            let stored_pk = tlv.get(TlvType::PublicKey).unwrap();
            assert_eq!(stored_pk.len(), 32);
            assert!(stored_pk.iter().all(|&b| b == 0xAB));
        }
    }

    mod tlv_type {
        use super::*;

        #[test]
        fn from_byte_known_types() {
            assert_eq!(TlvType::from_byte(0x00), Some(TlvType::Method));
            assert_eq!(TlvType::from_byte(0x01), Some(TlvType::Identifier));
            assert_eq!(TlvType::from_byte(0x02), Some(TlvType::Salt));
            assert_eq!(TlvType::from_byte(0x03), Some(TlvType::PublicKey));
            assert_eq!(TlvType::from_byte(0x04), Some(TlvType::Proof));
            assert_eq!(TlvType::from_byte(0x05), Some(TlvType::EncryptedData));
            assert_eq!(TlvType::from_byte(0x06), Some(TlvType::State));
            assert_eq!(TlvType::from_byte(0x07), Some(TlvType::Error));
            assert_eq!(TlvType::from_byte(0x0A), Some(TlvType::Signature));
            assert_eq!(TlvType::from_byte(0xFF), Some(TlvType::Separator));
        }

        #[test]
        fn from_byte_unknown_returns_none() {
            assert_eq!(TlvType::from_byte(0x10), None);
            assert_eq!(TlvType::from_byte(0x20), None);
            assert_eq!(TlvType::from_byte(0xFE), None);
        }
    }
}
