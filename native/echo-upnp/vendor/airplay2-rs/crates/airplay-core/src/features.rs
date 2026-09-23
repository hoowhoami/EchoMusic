//! 64-bit AirPlay feature bitmask parsing and querying.
//!
//! AirPlay 2 devices advertise capabilities via a 64-bit bitmask in the format
//! "0xLOWER,0xUPPER" where the full value is (UPPER << 32) | LOWER.

use crate::error::ParseError;

/// 64-bit AirPlay feature flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Features(pub u64);

/// Authentication method determined from feature flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMethod {
    /// No authentication required.
    None,
    /// HomeKit transient pairing (SRP + Curve25519).
    HomeKitTransient,
    /// FairPlay authentication required.
    FairPlay,
    /// MFi hardware authentication required (not implementable).
    MfiRequired,
}

// Feature bit constants
impl Features {
    // Lower 32 bits
    pub const SUPPORTS_VIDEO_V1: u64 = 1 << 0;
    pub const SUPPORTS_PHOTO: u64 = 1 << 1;
    pub const SUPPORTS_SLIDESHOW: u64 = 1 << 5;
    pub const SUPPORTS_SCREEN: u64 = 1 << 7;
    pub const SUPPORTS_AUDIO: u64 = 1 << 9;
    pub const AUDIO_REDUNDANT: u64 = 1 << 11;
    pub const AUTHENTICATION_FAIRPLAY: u64 = 1 << 14;
    pub const METADATA_FEATURES_0: u64 = 1 << 15;
    pub const METADATA_FEATURES_1: u64 = 1 << 16;
    pub const METADATA_FEATURES_2: u64 = 1 << 17;
    pub const AUDIO_FORMATS_0: u64 = 1 << 18;
    pub const AUDIO_FORMATS_1: u64 = 1 << 19;
    pub const AUDIO_FORMATS_2: u64 = 1 << 20;
    pub const AUDIO_FORMATS_3: u64 = 1 << 21;
    pub const AUTHENTICATION_1: u64 = 1 << 23;
    pub const AUTHENTICATION_MFI: u64 = 1 << 26;
    pub const SUPPORTS_LEGACY_PAIRING: u64 = 1 << 27;
    pub const HAS_UNIFIED_ADVERTISER_INFO: u64 = 1 << 30;

    // Upper 32 bits (bit indices 32+)
    pub const IS_CARPLAY: u64 = 1 << 32;
    pub const SUPPORTS_VIDEO_PLAY_QUEUE: u64 = 1 << 33;
    pub const SUPPORTS_AIRPLAY_FROM_CLOUD: u64 = 1 << 34;
    pub const SUPPORTS_TLS_PSK: u64 = 1 << 35;
    pub const SUPPORTS_UNIFIED_MEDIA_CONTROL: u64 = 1 << 38;
    pub const SUPPORTS_BUFFERED_AUDIO: u64 = 1 << 40;
    pub const SUPPORTS_PTP: u64 = 1 << 41;
    pub const SUPPORTS_SCREEN_MULTI_CODEC: u64 = 1 << 42;
    pub const SUPPORTS_SYSTEM_PAIRING: u64 = 1 << 43;
    pub const IS_AP_VALERIA_SCREEN_SENDER: u64 = 1 << 44;
    pub const SUPPORTS_HOMEKIT_PAIRING: u64 = 1 << 46;
    pub const SUPPORTS_TRANSIENT_PAIRING: u64 = 1 << 48;
    pub const SUPPORTS_VIDEO_V2: u64 = 1 << 49;
    pub const METADATA_FEATURES_3: u64 = 1 << 50;
    pub const SUPPORTS_UNIFIED_PAIR_MFI: u64 = 1 << 51;
    pub const SUPPORTS_SET_PEERS_EXTENDED_MESSAGE: u64 = 1 << 52;
    pub const SUPPORTS_AP_SYNC: u64 = 1 << 54;
    pub const SUPPORTS_WOL_55: u64 = 1 << 55;
    pub const SUPPORTS_WOL_56: u64 = 1 << 56;
    pub const SUPPORTS_HANGDOG_REMOTE_CONTROL: u64 = 1 << 58;
    pub const SUPPORTS_AUDIO_STREAM_CONNECTION_SETUP: u64 = 1 << 59;
    pub const SUPPORTS_AUDIO_MEDIA_DATA_CONTROL: u64 = 1 << 60;
    pub const SUPPORTS_RFC2198_REDUNDANCY: u64 = 1 << 61;
}

impl Features {
    /// Parse from TXT record format "0xLOWER" or "0xLOWER,0xUPPER".
    pub fn from_txt_value(s: &str) -> Result<Self, ParseError> {
        let s = s.trim();
        if s.is_empty() {
            return Err(ParseError::InvalidFormat(
                "empty features string".to_string(),
            ));
        }

        // Helper to parse a hex value with optional 0x prefix
        fn parse_hex(part: &str) -> Result<u64, ParseError> {
            let part = part.trim();
            let hex_str = part
                .strip_prefix("0x")
                .or_else(|| part.strip_prefix("0X"))
                .unwrap_or(part);

            if hex_str.is_empty() {
                return Err(ParseError::InvalidHex("empty hex value".to_string()));
            }

            u64::from_str_radix(hex_str, 16).map_err(|_| ParseError::InvalidHex(part.to_string()))
        }

        let (lower, upper) = match s.split_once(',') {
            Some((lower_str, upper_str)) => {
                let lower = parse_hex(lower_str)?;
                let upper = parse_hex(upper_str)?;
                (lower, upper)
            }
            None => {
                let lower = parse_hex(s)?;
                (lower, 0u64)
            }
        };

        Ok(Self(lower | (upper << 32)))
    }

    /// Create from raw 64-bit value.
    pub fn from_raw(value: u64) -> Self {
        Self(value)
    }

    /// Get raw 64-bit value.
    pub fn raw(&self) -> u64 {
        self.0
    }

    /// Format as TXT record value.
    pub fn to_txt_value(&self) -> String {
        let lower = self.0 & 0xFFFF_FFFF;
        let upper = self.0 >> 32;

        if upper == 0 {
            format!("0x{:X}", lower)
        } else {
            format!("0x{:X},0x{:X}", lower, upper)
        }
    }

    // Query methods — lower 32 bits
    pub fn supports_video_v1(&self) -> bool {
        self.0 & Self::SUPPORTS_VIDEO_V1 != 0
    }

    pub fn supports_photo(&self) -> bool {
        self.0 & Self::SUPPORTS_PHOTO != 0
    }

    pub fn supports_slideshow(&self) -> bool {
        self.0 & Self::SUPPORTS_SLIDESHOW != 0
    }

    pub fn supports_screen(&self) -> bool {
        self.0 & Self::SUPPORTS_SCREEN != 0
    }

    pub fn supports_audio(&self) -> bool {
        self.0 & Self::SUPPORTS_AUDIO != 0
    }

    pub fn supports_redundant_audio(&self) -> bool {
        self.0 & Self::AUDIO_REDUNDANT != 0
    }

    pub fn requires_fairplay(&self) -> bool {
        self.0 & Self::AUTHENTICATION_FAIRPLAY != 0
    }

    pub fn metadata_features(&self) -> u8 {
        let b0 = (self.0 >> 15) & 1;
        let b1 = (self.0 >> 16) & 1;
        let b2 = (self.0 >> 17) & 1;
        let b3 = (self.0 >> 50) & 1;
        (b0 | (b1 << 1) | (b2 << 2) | (b3 << 3)) as u8
    }

    pub fn audio_formats(&self) -> u8 {
        ((self.0 >> 18) & 0xF) as u8
    }

    pub fn has_authentication_1(&self) -> bool {
        self.0 & Self::AUTHENTICATION_1 != 0
    }

    pub fn requires_mfi(&self) -> bool {
        self.0 & Self::AUTHENTICATION_MFI != 0
    }

    pub fn supports_legacy_pairing(&self) -> bool {
        self.0 & Self::SUPPORTS_LEGACY_PAIRING != 0
    }

    pub fn has_unified_advertiser_info(&self) -> bool {
        self.0 & Self::HAS_UNIFIED_ADVERTISER_INFO != 0
    }

    // Query methods — upper 32 bits
    pub fn is_carplay(&self) -> bool {
        self.0 & Self::IS_CARPLAY != 0
    }

    pub fn supports_video_play_queue(&self) -> bool {
        self.0 & Self::SUPPORTS_VIDEO_PLAY_QUEUE != 0
    }

    pub fn supports_airplay_from_cloud(&self) -> bool {
        self.0 & Self::SUPPORTS_AIRPLAY_FROM_CLOUD != 0
    }

    pub fn supports_tls_psk(&self) -> bool {
        self.0 & Self::SUPPORTS_TLS_PSK != 0
    }

    pub fn supports_unified_media_control(&self) -> bool {
        self.0 & Self::SUPPORTS_UNIFIED_MEDIA_CONTROL != 0
    }

    pub fn supports_buffered_audio(&self) -> bool {
        self.0 & Self::SUPPORTS_BUFFERED_AUDIO != 0
    }

    pub fn supports_ptp(&self) -> bool {
        self.0 & Self::SUPPORTS_PTP != 0
    }

    pub fn supports_screen_multi_codec(&self) -> bool {
        self.0 & Self::SUPPORTS_SCREEN_MULTI_CODEC != 0
    }

    pub fn supports_system_pairing(&self) -> bool {
        self.0 & Self::SUPPORTS_SYSTEM_PAIRING != 0
    }

    pub fn is_ap_valeria_screen_sender(&self) -> bool {
        self.0 & Self::IS_AP_VALERIA_SCREEN_SENDER != 0
    }

    pub fn supports_homekit_pairing(&self) -> bool {
        self.0 & Self::SUPPORTS_HOMEKIT_PAIRING != 0
    }

    pub fn supports_transient_pairing(&self) -> bool {
        self.0 & Self::SUPPORTS_TRANSIENT_PAIRING != 0
    }

    pub fn supports_video_v2(&self) -> bool {
        self.0 & Self::SUPPORTS_VIDEO_V2 != 0
    }

    pub fn supports_unified_pair_mfi(&self) -> bool {
        self.0 & Self::SUPPORTS_UNIFIED_PAIR_MFI != 0
    }

    pub fn supports_set_peers_extended_message(&self) -> bool {
        self.0 & Self::SUPPORTS_SET_PEERS_EXTENDED_MESSAGE != 0
    }

    pub fn supports_ap_sync(&self) -> bool {
        self.0 & Self::SUPPORTS_AP_SYNC != 0
    }

    pub fn supports_wol(&self) -> bool {
        self.0 & (Self::SUPPORTS_WOL_55 | Self::SUPPORTS_WOL_56) != 0
    }

    pub fn supports_hangdog_remote_control(&self) -> bool {
        self.0 & Self::SUPPORTS_HANGDOG_REMOTE_CONTROL != 0
    }

    pub fn supports_audio_stream_connection_setup(&self) -> bool {
        self.0 & Self::SUPPORTS_AUDIO_STREAM_CONNECTION_SETUP != 0
    }

    pub fn supports_audio_media_data_control(&self) -> bool {
        self.0 & Self::SUPPORTS_AUDIO_MEDIA_DATA_CONTROL != 0
    }

    pub fn supports_rfc2198_redundancy(&self) -> bool {
        self.0 & Self::SUPPORTS_RFC2198_REDUNDANCY != 0
    }

    /// Determine the appropriate authentication method.
    ///
    /// Priority order (highest to lowest):
    /// 1. MFi Required - if bit 26 is set, we cannot connect
    /// 2. HomeKit Transient - if bit 51 (unified pair+MFi) is set WITHOUT bit 26,
    ///    or if bit 48 (transient pairing) is set
    /// 3. FairPlay - if bit 14 is set
    /// 4. None - no authentication required
    pub fn auth_method(&self) -> AuthMethod {
        // MFi takes absolute priority - if set, we can't connect
        if self.requires_mfi() {
            return AuthMethod::MfiRequired;
        }

        // HomeKit transient pairing: bit 51 without bit 26, or bit 48
        if self.supports_unified_pair_mfi() || self.supports_transient_pairing() {
            return AuthMethod::HomeKitTransient;
        }

        // FairPlay authentication
        if self.requires_fairplay() {
            return AuthMethod::FairPlay;
        }

        AuthMethod::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod parsing {
        use super::*;

        #[test]
        fn parse_single_32bit_value() {
            let features = Features::from_txt_value("0x445F8A00").unwrap();
            assert_eq!(features.0, 0x445F8A00);
        }

        #[test]
        fn parse_comma_separated_64bit_value() {
            // "0x445F8A00,0x1C340" -> lower=0x445F8A00, upper=0x1C340
            // Full value = (0x1C340 << 32) | 0x445F8A00 = 0x1C340_445F8A00
            let features = Features::from_txt_value("0x445F8A00,0x1C340").unwrap();
            assert_eq!(features.0, 0x1C340_445F8A00);
        }

        #[test]
        fn parse_with_0x_prefix() {
            let features = Features::from_txt_value("0xABCD").unwrap();
            assert_eq!(features.0, 0xABCD);
        }

        #[test]
        fn parse_without_0x_prefix() {
            let features = Features::from_txt_value("ABCD").unwrap();
            assert_eq!(features.0, 0xABCD);
        }

        #[test]
        fn parse_lowercase_hex() {
            let features = Features::from_txt_value("0xabcdef").unwrap();
            assert_eq!(features.0, 0xABCDEF);
        }

        #[test]
        fn parse_uppercase_hex() {
            let features = Features::from_txt_value("0xABCDEF").unwrap();
            assert_eq!(features.0, 0xABCDEF);
        }

        #[test]
        fn parse_invalid_hex() {
            let result = Features::from_txt_value("0xGHIJ");
            assert!(result.is_err());
        }

        #[test]
        fn parse_empty_string() {
            let result = Features::from_txt_value("");
            assert!(result.is_err());
        }

        #[test]
        fn roundtrip_to_txt_value() {
            // Test single value roundtrip
            let original = Features::from_raw(0x445F8A00);
            let txt = original.to_txt_value();
            let parsed = Features::from_txt_value(&txt).unwrap();
            assert_eq!(original.0, parsed.0);

            // Test 64-bit value roundtrip
            let original = Features::from_raw(0x1C340_445F8A00);
            let txt = original.to_txt_value();
            let parsed = Features::from_txt_value(&txt).unwrap();
            assert_eq!(original.0, parsed.0);
        }
    }

    mod feature_flags {
        use super::*;

        #[test]
        fn supports_audio_bit_9() {
            // Bit 9 = 0x200
            let features = Features::from_raw(1 << 9);
            assert!(features.supports_audio());

            let features = Features::from_raw(0);
            assert!(!features.supports_audio());
        }

        #[test]
        fn supports_buffered_audio_bit_40() {
            // Bit 40 = 0x100_00000000 (in upper 32 bits: 0x100,0x0)
            let features = Features::from_raw(1 << 40);
            assert!(features.supports_buffered_audio());

            let features = Features::from_raw(0);
            assert!(!features.supports_buffered_audio());
        }

        #[test]
        fn supports_ptp_bit_41() {
            // Bit 41 = 0x200_00000000 (in upper 32 bits: 0x200,0x0)
            let features = Features::from_raw(1 << 41);
            assert!(features.supports_ptp());

            let features = Features::from_raw(0);
            assert!(!features.supports_ptp());
        }

        #[test]
        fn supports_transient_pairing_bit_48() {
            // Bit 48 = 0x10000_00000000 (in upper 32 bits: 0x10000,0x0)
            let features = Features::from_raw(1 << 48);
            assert!(features.supports_transient_pairing());

            let features = Features::from_raw(0);
            assert!(!features.supports_transient_pairing());
        }

        #[test]
        fn supports_unified_pair_mfi_bit_51() {
            // Bit 51 = 0x80000_00000000 (in upper 32 bits: 0x80000,0x0)
            let features = Features::from_raw(1 << 51);
            assert!(features.supports_unified_pair_mfi());

            let features = Features::from_raw(0);
            assert!(!features.supports_unified_pair_mfi());
        }

        #[test]
        fn multiple_flags_set() {
            // Set bits 9, 40, 41, 51
            let value = (1 << 9) | (1 << 40) | (1 << 41) | (1 << 51);
            let features = Features::from_raw(value);
            assert!(features.supports_audio());
            assert!(features.supports_buffered_audio());
            assert!(features.supports_ptp());
            assert!(features.supports_unified_pair_mfi());
            assert!(!features.requires_mfi());
        }

        #[test]
        fn no_flags_set() {
            let features = Features::from_raw(0);
            assert!(!features.supports_audio());
            assert!(!features.supports_buffered_audio());
            assert!(!features.supports_ptp());
            assert!(!features.supports_transient_pairing());
            assert!(!features.supports_unified_pair_mfi());
            assert!(!features.requires_mfi());
        }
    }

    mod auth_method {
        use super::*;

        #[test]
        fn mfi_required_when_mfi_bit_set() {
            // Bit 26 = MFi required
            let features = Features::from_raw(1 << 26);
            assert_eq!(features.auth_method(), AuthMethod::MfiRequired);
        }

        #[test]
        fn homekit_transient_when_unified_pair_without_mfi() {
            // Bit 51 without bit 26 = HomeKit transient
            let features = Features::from_raw(1 << 51);
            assert_eq!(features.auth_method(), AuthMethod::HomeKitTransient);
        }

        #[test]
        fn homekit_transient_when_transient_pairing_set() {
            // Bit 48 = transient pairing
            let features = Features::from_raw(1 << 48);
            assert_eq!(features.auth_method(), AuthMethod::HomeKitTransient);
        }

        #[test]
        fn fairplay_when_only_fairplay_bit_set() {
            // Bit 14 = FairPlay
            let features = Features::from_raw(1 << 14);
            assert_eq!(features.auth_method(), AuthMethod::FairPlay);
        }

        #[test]
        fn none_when_no_auth_bits_set() {
            let features = Features::from_raw(0);
            assert_eq!(features.auth_method(), AuthMethod::None);

            // Audio bit doesn't affect auth
            let features = Features::from_raw(1 << 9);
            assert_eq!(features.auth_method(), AuthMethod::None);
        }

        #[test]
        fn auth_method_priority_order() {
            // MFi > HomeKit > FairPlay > None
            // If MFi is set, it always takes priority
            let features = Features::from_raw((1 << 26) | (1 << 51) | (1 << 14));
            assert_eq!(features.auth_method(), AuthMethod::MfiRequired);

            // HomeKit takes priority over FairPlay
            let features = Features::from_raw((1 << 51) | (1 << 14));
            assert_eq!(features.auth_method(), AuthMethod::HomeKitTransient);

            // FairPlay if no HomeKit bits
            let features = Features::from_raw(1 << 14);
            assert_eq!(features.auth_method(), AuthMethod::FairPlay);
        }
    }

    mod real_device_features {
        use super::*;

        #[test]
        fn apple_tv_4k_features() {
            // Test with actual Apple TV 4K feature string from CLAUDE.md
            // features=0x445F8A00,0x1C340
            // Note: This particular device has bit 26 (MFi) set but NOT bit 51 (Unified),
            // meaning it requires MFi hardware authentication. Different Apple TV
            // configurations or firmware versions may have different feature sets.
            let features = Features::from_txt_value("0x445F8A00,0x1C340").unwrap();

            // Verify it parses correctly
            assert_eq!(features.0, 0x1C340_445F8A00);

            // Apple TV 4K supports AirPlay 2 features
            assert!(features.supports_audio()); // bit 9
            assert!(features.supports_buffered_audio()); // bit 40
            assert!(features.supports_ptp()); // bit 41

            // This device has bit 26 set and bit 51 NOT set
            assert!(features.requires_mfi()); // bit 26 IS set
            assert!(!features.supports_unified_pair_mfi()); // bit 51 NOT set

            // Per requirements: if bit 26 is set, return MfiRequired
            assert_eq!(features.auth_method(), AuthMethod::MfiRequired);
        }

        #[test]
        fn device_supporting_homekit_transient() {
            // A device that supports HomeKit transient pairing (bit 51 without bit 26)
            // This is the configuration open-source implementations can connect to
            // Using the spec's minimum AirPlay 2 features: 0x40000a00,0x80300
            let features = Features::from_txt_value("0x40000a00,0x80300").unwrap();

            // Should have key AirPlay 2 bits
            assert!(features.supports_audio()); // bit 9
            assert!(features.supports_redundant_audio()); // bit 11
            assert!(features.supports_buffered_audio()); // bit 40
            assert!(features.supports_ptp()); // bit 41
            assert!(features.supports_unified_pair_mfi()); // bit 51

            // Should NOT require MFi (bit 26 not set)
            assert!(!features.requires_mfi());

            // Can connect using HomeKit transient pairing
            assert_eq!(features.auth_method(), AuthMethod::HomeKitTransient);
        }

        #[test]
        fn homepod_mini_features() {
            // HomePod Mini typically has similar features to Apple TV
            // Using a representative feature string: 0x40000a00,0x80300
            // This includes bits 9, 11, 40, 41, 51
            let features = Features::from_txt_value("0x40000a00,0x80300").unwrap();

            assert!(features.supports_audio()); // bit 9
            assert!(features.supports_redundant_audio()); // bit 11
            assert!(features.supports_buffered_audio()); // bit 40
            assert!(features.supports_ptp()); // bit 41
            assert!(features.supports_unified_pair_mfi()); // bit 51

            // Should NOT require MFi
            assert!(!features.requires_mfi());

            // Should use HomeKit transient pairing
            assert_eq!(features.auth_method(), AuthMethod::HomeKitTransient);
        }

        #[test]
        fn airplay_1_legacy_device_features() {
            // Legacy AirPlay 1 device with only 32-bit features
            // Typically has audio support (bit 9) but no buffered audio
            let features = Features::from_txt_value("0x200").unwrap();

            assert!(features.supports_audio()); // bit 9
            assert!(!features.supports_buffered_audio());
            assert!(!features.supports_ptp());

            // Legacy device might have no auth or FairPlay
            assert_eq!(features.auth_method(), AuthMethod::None);
        }
    }
}
