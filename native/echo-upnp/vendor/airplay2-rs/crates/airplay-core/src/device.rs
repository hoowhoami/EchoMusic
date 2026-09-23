//! Device representation and identification types.

use crate::features::Features;
use std::net::{IpAddr, SocketAddr};

/// Unique device identifier derived from MAC address.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DeviceId(pub [u8; 6]);

/// Parsed source version (e.g., "366.0.0").
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

/// Core device information from /info endpoint.
#[derive(Debug, Clone)]
pub struct DeviceInfo {
    pub features: Features,
    pub model: String,
    pub source_version: Version,
    pub public_key: Option<[u8; 32]>,
}

/// A discovered AirPlay receiver with full metadata.
#[derive(Debug, Clone)]
pub struct Device {
    // --- Core identity ---
    pub id: DeviceId,
    pub name: String,
    pub model: String,
    pub manufacturer: Option<String>,
    pub serial_number: Option<String>,
    pub addresses: Vec<IpAddr>,
    pub port: u16,

    // --- Capabilities ---
    pub features: Features,
    /// Required sender features from `rsf` TXT field.
    pub required_sender_features: Option<Features>,
    pub public_key: Option<[u8; 32]>,
    pub source_version: Version,
    pub firmware_version: Option<String>,
    pub os_version: Option<String>,
    pub protocol_version: Option<String>,
    pub requires_password: bool,

    // --- Status & access ---
    /// System/status flags from `flags` (AirPlay) or `sf` (RAOP) TXT field.
    pub status_flags: u64,
    /// Access control level from `acl` TXT field (0=everyone, 1=same network, 2=home members).
    pub access_control: Option<u8>,

    // --- Pairing identities ---
    /// Public CU AirPlay pairing identity from `pi` TXT field.
    pub pairing_identity: Option<String>,
    /// Public CU System Pairing Identity from `psi` TXT field.
    pub system_pairing_identity: Option<String>,
    /// Bluetooth address from `btaddr` TXT field.
    pub bluetooth_address: Option<String>,
    /// HomeKit home UUID from `hkid` TXT field.
    pub homekit_home_id: Option<String>,

    // --- Group / multi-room ---
    pub group_id: Option<uuid::Uuid>,
    pub is_group_leader: bool,
    /// Group public name from `gpn` TXT field.
    pub group_public_name: Option<String>,
    /// Group contains discoverable leader from `gcgl` TXT field.
    pub group_contains_discoverable_leader: bool,
    /// Home group UUID from `hgid` TXT field.
    pub home_group_id: Option<String>,
    /// Household ID from `hmid` TXT field.
    pub household_id: Option<String>,
    /// Parent group UUID from `pgid` TXT field.
    pub parent_group_id: Option<uuid::Uuid>,
    /// Parent group contains discoverable leader from `pgcgl` TXT field.
    pub parent_group_contains_discoverable_leader: bool,
    /// Tight sync UUID from `tsid` TXT field.
    pub tight_sync_id: Option<uuid::Uuid>,

    // --- RAOP (legacy AirPlay 1) ---
    /// RAOP service port (from `_raop._tcp` SRV record).
    pub raop_port: Option<u16>,
    /// RAOP encryption types from `et` TXT field (0=none, 1=RSA, 3=FairPlay, 4=MFiSAP, 5=FairPlay SAPv2.5).
    pub raop_encryption_types: Option<Vec<u8>>,
    /// RAOP supported codecs from `cn` TXT field (0=PCM, 1=ALAC, 2=AAC, 3=AAC-ELD).
    pub raop_codecs: Option<Vec<u8>>,
    /// RAOP transport from `tp` TXT field (e.g. "UDP", "TCP", "TCP,UDP").
    pub raop_transport: Option<String>,
    /// RAOP metadata types from `md` TXT field.
    pub raop_metadata_types: Option<Vec<u8>>,
    /// RAOP digest auth from `da` TXT field.
    pub raop_digest_auth: bool,
    /// Vodka version from `vv` TXT field.
    pub vodka_version: Option<String>,
}

impl DeviceId {
    /// Parse a MAC address from string.
    ///
    /// Supports formats:
    /// - Colon-separated: "AA:BB:CC:DD:EE:FF"
    /// - Hyphen-separated: "AA-BB-CC-DD-EE-FF"
    /// - Bare hex: "AABBCCDDEEFF"
    pub fn from_mac_string(s: &str) -> Result<Self, crate::error::ParseError> {
        use crate::error::ParseError;

        let s = s.trim();

        // Try to parse based on separator
        let bytes: Vec<u8> = if s.contains(':') {
            // Colon-separated format
            s.split(':')
                .map(|part| {
                    u8::from_str_radix(part, 16)
                        .map_err(|_| ParseError::InvalidHex(part.to_string()))
                })
                .collect::<Result<Vec<_>, _>>()?
        } else if s.contains('-') {
            // Hyphen-separated format
            s.split('-')
                .map(|part| {
                    u8::from_str_radix(part, 16)
                        .map_err(|_| ParseError::InvalidHex(part.to_string()))
                })
                .collect::<Result<Vec<_>, _>>()?
        } else {
            // Bare hex format (no separators)
            if s.len() != 12 {
                return Err(ParseError::InvalidFormat(format!(
                    "MAC address must be 12 hex characters, got {}",
                    s.len()
                )));
            }
            (0..6)
                .map(|i| {
                    let start = i * 2;
                    u8::from_str_radix(&s[start..start + 2], 16)
                        .map_err(|_| ParseError::InvalidHex(s[start..start + 2].to_string()))
                })
                .collect::<Result<Vec<_>, _>>()?
        };

        if bytes.len() != 6 {
            return Err(ParseError::InvalidFormat(format!(
                "MAC address must have 6 bytes, got {}",
                bytes.len()
            )));
        }

        let mut arr = [0u8; 6];
        arr.copy_from_slice(&bytes);
        Ok(Self(arr))
    }

    /// Convert to colon-separated MAC string (uppercase).
    pub fn to_mac_string(&self) -> String {
        format!(
            "{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
            self.0[0], self.0[1], self.0[2], self.0[3], self.0[4], self.0[5]
        )
    }
}

impl Version {
    pub fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    /// Parse version from string.
    ///
    /// Supports formats:
    /// - "366.0.0" (three parts)
    /// - "366.0" (two parts, patch defaults to 0)
    /// - "366" (one part, minor and patch default to 0)
    pub fn parse(s: &str) -> Result<Self, crate::error::ParseError> {
        use crate::error::ParseError;

        let s = s.trim();
        if s.is_empty() {
            return Err(ParseError::InvalidFormat(
                "empty version string".to_string(),
            ));
        }

        let parts: Vec<&str> = s.split('.').collect();

        let major = parts
            .first()
            .ok_or_else(|| ParseError::InvalidFormat("missing major version".to_string()))?
            .parse::<u32>()
            .map_err(|_| {
                ParseError::InvalidValue(format!("invalid major version: {}", parts[0]))
            })?;

        let minor = parts
            .get(1)
            .map(|s| {
                s.parse::<u32>()
                    .map_err(|_| ParseError::InvalidValue(format!("invalid minor version: {}", s)))
            })
            .transpose()?
            .unwrap_or(0);

        let patch = parts
            .get(2)
            .map(|s| {
                s.parse::<u32>()
                    .map_err(|_| ParseError::InvalidValue(format!("invalid patch version: {}", s)))
            })
            .transpose()?
            .unwrap_or(0);

        Ok(Self {
            major,
            minor,
            patch,
        })
    }
}

/// Minimum version required for AirPlay 2 buffered audio.
const MIN_AIRPLAY2_VERSION: Version = Version {
    major: 354,
    minor: 54,
    patch: 6,
};

/// Minimum version required for PTP timing.
const MIN_PTP_VERSION: Version = Version {
    major: 366,
    minor: 0,
    patch: 0,
};

impl Device {
    /// Check if device supports AirPlay 2 buffered audio.
    ///
    /// Requires both the SupportsBufferedAudio feature flag (bit 40)
    /// AND source version >= 354.54.6.
    pub fn supports_airplay2(&self) -> bool {
        self.features.supports_buffered_audio() && self.source_version >= MIN_AIRPLAY2_VERSION
    }

    /// Check if device supports PTP timing (required for multi-room).
    ///
    /// Requires both the SupportsPTP feature flag (bit 41)
    /// AND source version >= 366.
    pub fn supports_ptp(&self) -> bool {
        self.features.supports_ptp() && self.source_version >= MIN_PTP_VERSION
    }

    /// Get preferred socket address (prefers IPv4).
    ///
    /// Returns the first IPv4 address if available, otherwise the first IPv6.
    /// Returns None if no addresses are available.
    pub fn socket_addr(&self) -> Option<SocketAddr> {
        // Prefer IPv4
        for addr in &self.addresses {
            if addr.is_ipv4() {
                return Some(SocketAddr::new(*addr, self.port));
            }
        }
        // Fall back to IPv6
        self.addresses
            .first()
            .map(|addr| SocketAddr::new(*addr, self.port))
    }

    /// Determine the best authentication method for this device.
    pub fn auth_method(&self) -> crate::features::AuthMethod {
        self.features.auth_method()
    }

    /// Check if this device supports RAOP (AirPlay 1) connections.
    ///
    /// Returns true if the device has a RAOP port or doesn't support AirPlay 2.
    pub fn supports_raop(&self) -> bool {
        self.raop_port.is_some() || !self.supports_airplay2()
    }

    /// Get the connection port for RAOP.
    ///
    /// Uses `raop_port` if available, otherwise falls back to the main AirPlay port.
    pub fn raop_connection_port(&self) -> u16 {
        self.raop_port.unwrap_or(self.port)
    }

    /// Check if the device supports RSA encryption for RAOP.
    ///
    /// Looks for encryption type 1 (RSA) in the `et` TXT field.
    pub fn supports_rsa_encryption(&self) -> bool {
        self.raop_encryption_types
            .as_ref()
            .map(|et| et.contains(&1))
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod device_id {
        use super::*;

        #[test]
        fn parse_valid_colon_separated_mac() {
            let id = DeviceId::from_mac_string("AA:BB:CC:DD:EE:FF").unwrap();
            assert_eq!(id.0, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
        }

        #[test]
        fn parse_valid_hyphen_separated_mac() {
            let id = DeviceId::from_mac_string("AA-BB-CC-DD-EE-FF").unwrap();
            assert_eq!(id.0, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
        }

        #[test]
        fn parse_valid_bare_mac() {
            let id = DeviceId::from_mac_string("AABBCCDDEEFF").unwrap();
            assert_eq!(id.0, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
        }

        #[test]
        fn parse_invalid_mac_too_short() {
            let result = DeviceId::from_mac_string("AA:BB:CC");
            assert!(result.is_err());

            let result = DeviceId::from_mac_string("AABBCC");
            assert!(result.is_err());
        }

        #[test]
        fn parse_invalid_mac_bad_hex() {
            let result = DeviceId::from_mac_string("GG:HH:II:JJ:KK:LL");
            assert!(result.is_err());
        }

        #[test]
        fn roundtrip_mac_string() {
            let original = DeviceId([0x58, 0x55, 0xCA, 0x1A, 0xE2, 0x88]);
            let string = original.to_mac_string();
            assert_eq!(string, "58:55:CA:1A:E2:88");
            let parsed = DeviceId::from_mac_string(&string).unwrap();
            assert_eq!(original, parsed);
        }
    }

    mod version {
        use super::*;

        #[test]
        fn parse_three_part_version() {
            let v = Version::parse("366.0.0").unwrap();
            assert_eq!(v, Version::new(366, 0, 0));

            let v = Version::parse("354.54.6").unwrap();
            assert_eq!(v, Version::new(354, 54, 6));
        }

        #[test]
        fn parse_two_part_version() {
            let v = Version::parse("366.0").unwrap();
            assert_eq!(v, Version::new(366, 0, 0));
        }

        #[test]
        fn parse_single_part_version() {
            let v = Version::parse("366").unwrap();
            assert_eq!(v, Version::new(366, 0, 0));
        }

        #[test]
        fn version_ordering() {
            let v1 = Version::new(354, 54, 5);
            let v2 = Version::new(354, 54, 6);
            let v3 = Version::new(354, 55, 0);
            let v4 = Version::new(355, 0, 0);
            let v5 = Version::new(366, 0, 0);

            assert!(v1 < v2);
            assert!(v2 < v3);
            assert!(v3 < v4);
            assert!(v4 < v5);
            assert!(v1 < v5);

            // Equal versions
            assert!(Version::new(366, 0, 0) == Version::new(366, 0, 0));
        }

        #[test]
        fn parse_invalid_version() {
            let result = Version::parse("");
            assert!(result.is_err());

            let result = Version::parse("abc");
            assert!(result.is_err());

            let result = Version::parse("1.abc.0");
            assert!(result.is_err());
        }
    }

    mod device {
        use super::*;
        use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

        fn make_test_device(
            features: Features,
            version: Version,
            addresses: Vec<IpAddr>,
        ) -> Device {
            Device {
                id: DeviceId([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]),
                name: "Test Device".to_string(),
                model: "AppleTV5,3".to_string(),
                manufacturer: None,
                serial_number: None,
                addresses,
                port: 7000,
                features,
                required_sender_features: None,
                public_key: None,
                source_version: version,
                firmware_version: None,
                os_version: None,
                protocol_version: None,
                requires_password: false,
                status_flags: 0,
                access_control: None,
                pairing_identity: None,
                system_pairing_identity: None,
                bluetooth_address: None,
                homekit_home_id: None,
                group_id: None,
                is_group_leader: false,
                group_public_name: None,
                group_contains_discoverable_leader: false,
                home_group_id: None,
                household_id: None,
                parent_group_id: None,
                parent_group_contains_discoverable_leader: false,
                tight_sync_id: None,
                raop_port: None,
                raop_encryption_types: None,
                raop_codecs: None,
                raop_transport: None,
                raop_metadata_types: None,
                raop_digest_auth: false,
                vodka_version: None,
            }
        }

        #[test]
        fn supports_airplay2_with_buffered_audio_and_sufficient_version() {
            // Has buffered audio flag (bit 40) and version >= 354.54.6
            let features = Features::from_raw(1 << 40);
            let version = Version::new(366, 0, 0);
            let device = make_test_device(features, version, vec![]);
            assert!(device.supports_airplay2());
        }

        #[test]
        fn not_supports_airplay2_without_buffered_audio_flag() {
            // Has sufficient version but no buffered audio flag
            let features = Features::from_raw(1 << 9); // Audio only
            let version = Version::new(366, 0, 0);
            let device = make_test_device(features, version, vec![]);
            assert!(!device.supports_airplay2());
        }

        #[test]
        fn not_supports_airplay2_with_old_version() {
            // Has buffered audio flag but old version
            let features = Features::from_raw(1 << 40);
            let version = Version::new(354, 54, 5); // Just below threshold
            let device = make_test_device(features, version, vec![]);
            assert!(!device.supports_airplay2());

            // Exactly at threshold should work
            let version = Version::new(354, 54, 6);
            let device = make_test_device(features, version, vec![]);
            assert!(device.supports_airplay2());
        }

        #[test]
        fn supports_ptp_with_flag_and_sufficient_version() {
            // Has PTP flag (bit 41) and version >= 366
            let features = Features::from_raw(1 << 41);
            let version = Version::new(366, 0, 0);
            let device = make_test_device(features, version, vec![]);
            assert!(device.supports_ptp());

            // Below version threshold
            let version = Version::new(365, 0, 0);
            let device = make_test_device(features, version, vec![]);
            assert!(!device.supports_ptp());

            // No PTP flag
            let features = Features::from_raw(0);
            let version = Version::new(366, 0, 0);
            let device = make_test_device(features, version, vec![]);
            assert!(!device.supports_ptp());
        }

        #[test]
        fn socket_addr_prefers_ipv4() {
            let ipv4 = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 100));
            let ipv6 = IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1));

            // IPv6 first in list, but should still return IPv4
            let device =
                make_test_device(Features::default(), Version::default(), vec![ipv6, ipv4]);
            let addr = device.socket_addr().unwrap();
            assert!(addr.ip().is_ipv4());
            assert_eq!(addr.port(), 7000);
        }

        #[test]
        fn socket_addr_falls_back_to_ipv6() {
            let ipv6 = IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1));

            // Only IPv6 available
            let device = make_test_device(Features::default(), Version::default(), vec![ipv6]);
            let addr = device.socket_addr().unwrap();
            assert!(addr.ip().is_ipv6());
            assert_eq!(addr.port(), 7000);
        }

        #[test]
        fn socket_addr_none_when_no_addresses() {
            let device = make_test_device(Features::default(), Version::default(), vec![]);
            assert!(device.socket_addr().is_none());
        }
    }
}
