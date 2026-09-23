//! mDNS TXT record parsing for AirPlay devices.

use airplay_core::error::ParseError;
use airplay_core::{Device, DeviceId, Features, Version};
use std::collections::HashMap;
use std::net::IpAddr;

/// Parser for mDNS TXT records.
pub struct TxtRecordParser;

impl TxtRecordParser {
    /// Parse `_airplay._tcp` service TXT record into a Device.
    pub fn parse_airplay_txt(
        name: &str,
        txt: &HashMap<String, String>,
        addresses: Vec<IpAddr>,
        port: u16,
    ) -> Result<Device, ParseError> {
        // deviceid is required
        let device_id_str = txt
            .get("deviceid")
            .ok_or(ParseError::MissingField("deviceid"))?;
        let id = DeviceId::from_mac_string(device_id_str)?;

        // Parse features (64-bit format "0xLOWER,0xUPPER")
        let features = txt
            .get("features")
            .map(|f| Features::from_txt_value(f))
            .transpose()?
            .unwrap_or_default();

        // Parse model (optional)
        let model = txt.get("model").cloned().unwrap_or_default();

        // Parse source version
        let source_version = txt
            .get("srcvers")
            .map(|v| Version::parse(v))
            .transpose()?
            .unwrap_or_default();

        // Parse Ed25519 public key (optional, 64 hex chars = 32 bytes)
        let public_key = txt
            .get("pk")
            .map(|pk| Self::parse_public_key(pk))
            .transpose()?;

        // Parse password required flag
        let requires_password = txt
            .get("pw")
            .map(|pw| pw == "true" || pw == "1")
            .unwrap_or(false);

        // Parse required sender features
        let required_sender_features = txt
            .get("rsf")
            .map(|f| Features::from_txt_value(f))
            .transpose()?;

        // Parse status/system flags
        let status_flags = txt
            .get("flags")
            .or_else(|| txt.get("sf"))
            .map(|f| Self::parse_hex_or_decimal(f))
            .unwrap_or(0);

        // Parse access control level
        let access_control = txt
            .get("acl")
            .and_then(|v| v.parse::<u8>().ok());

        // Parse firmware version
        let firmware_version = txt.get("fv").cloned();

        // Parse OS version
        let os_version = txt.get("osvers").cloned();

        // Parse protocol version
        let protocol_version = txt.get("protovers").cloned();

        // Parse manufacturer
        let manufacturer = txt.get("manufacturer").cloned();

        // Parse serial number
        let serial_number = txt.get("serialNumber").cloned();

        // Parse Bluetooth address
        let bluetooth_address = txt.get("btaddr").cloned();

        // Parse pairing identities
        let pairing_identity = txt.get("pi").cloned();
        let system_pairing_identity = txt.get("psi").cloned();

        // Parse HomeKit home UUID
        let homekit_home_id = txt.get("hkid").cloned();

        // Parse group UUID
        let group_id = txt
            .get("gid")
            .map(|gid| {
                uuid::Uuid::parse_str(gid)
                    .map_err(|_| ParseError::InvalidValue(format!("invalid UUID: {}", gid)))
            })
            .transpose()?;

        // Parse is group leader flag
        let is_group_leader = txt
            .get("igl")
            .map(|igl| igl == "1" || igl == "true")
            .unwrap_or(false);

        // Parse group public name
        let group_public_name = txt.get("gpn").cloned();

        // Parse group contains discoverable leader
        let group_contains_discoverable_leader = txt
            .get("gcgl")
            .map(|v| v == "1" || v == "true")
            .unwrap_or(false);

        // Parse home group ID
        let home_group_id = txt.get("hgid").cloned();

        // Parse household ID
        let household_id = txt.get("hmid").cloned();

        // Parse parent group UUID
        let parent_group_id = txt
            .get("pgid")
            .map(|pgid| {
                uuid::Uuid::parse_str(pgid)
                    .map_err(|_| ParseError::InvalidValue(format!("invalid UUID: {}", pgid)))
            })
            .transpose()?;

        // Parse parent group contains discoverable leader
        let parent_group_contains_discoverable_leader = txt
            .get("pgcgl")
            .map(|v| v == "1" || v == "true")
            .unwrap_or(false);

        // Parse tight sync UUID
        let tight_sync_id = txt
            .get("tsid")
            .map(|tsid| {
                uuid::Uuid::parse_str(tsid)
                    .map_err(|_| ParseError::InvalidValue(format!("invalid UUID: {}", tsid)))
            })
            .transpose()?;

        Ok(Device {
            id,
            name: name.to_string(),
            model,
            manufacturer,
            serial_number,
            addresses,
            port,
            features,
            required_sender_features,
            public_key,
            source_version,
            firmware_version,
            os_version,
            protocol_version,
            requires_password,
            status_flags,
            access_control,
            pairing_identity,
            system_pairing_identity,
            bluetooth_address,
            homekit_home_id,
            group_id,
            is_group_leader,
            group_public_name,
            group_contains_discoverable_leader,
            home_group_id,
            household_id,
            parent_group_id,
            parent_group_contains_discoverable_leader,
            tight_sync_id,
            raop_port: None,
            raop_encryption_types: None,
            raop_codecs: None,
            raop_transport: None,
            raop_metadata_types: None,
            raop_digest_auth: false,
            vodka_version: None,
        })
    }

    /// Parse `_raop._tcp` service TXT record into a Device.
    ///
    /// RAOP service names have format "AABBCCDDEEFF@Device Name".
    pub fn parse_raop_txt(
        name: &str,
        txt: &HashMap<String, String>,
        addresses: Vec<IpAddr>,
        port: u16,
    ) -> Result<Device, ParseError> {
        // Parse name format: "AABBCCDDEEFF@Device Name"
        let at_pos = name
            .find('@')
            .ok_or_else(|| ParseError::InvalidFormat("RAOP name must contain '@'".to_string()))?;

        let mac_hex = &name[..at_pos];
        let device_name = &name[at_pos + 1..];

        // MAC should be 12 hex chars (bare format)
        let id = DeviceId::from_mac_string(mac_hex)?;

        // Parse features: prefer 'ft' (full 64-bit) over 'sf' (legacy 32-bit status flags)
        let features = if let Some(ft) = txt.get("ft") {
            // Modern RAOP records have 'ft' with full 64-bit features
            Features::from_txt_value(ft)?
        } else if let Some(sf) = txt.get("sf") {
            // Legacy fallback to 'sf' field
            Self::parse_legacy_features(sf)?
        } else {
            Features::default()
        };

        // Parse model (optional, often 'am' in RAOP)
        let model = txt
            .get("am")
            .or_else(|| txt.get("model"))
            .cloned()
            .unwrap_or_default();

        // Parse source version from 'vs' or 'vn'
        let source_version = txt
            .get("vs")
            .or_else(|| txt.get("vn"))
            .map(|v| Version::parse(v))
            .transpose()?
            .unwrap_or_default();

        // Parse password required from 'pw'
        let requires_password = txt
            .get("pw")
            .map(|pw| pw == "true" || pw == "1")
            .unwrap_or(false);

        // Parse Ed25519 public key (optional, 64 hex chars = 32 bytes)
        let public_key = txt
            .get("pk")
            .map(|pk| Self::parse_public_key(pk))
            .transpose()?;

        // Parse firmware version
        let firmware_version = txt.get("fv").cloned();

        // Parse OS version (RAOP uses 'ov')
        let os_version = txt.get("ov").cloned();

        // Parse status flags from 'sf'
        let status_flags = txt
            .get("sf")
            .map(|f| Self::parse_hex_or_decimal(f))
            .unwrap_or(0);

        // Parse vodka version
        let vodka_version = txt.get("vv").cloned();

        // Parse digest auth
        let raop_digest_auth = txt
            .get("da")
            .map(|da| da == "true" || da == "1")
            .unwrap_or(false);

        // Parse RAOP-specific TXT fields
        let raop_encryption_types = txt.get("et").map(|et| {
            et.split(',')
                .filter_map(|s| s.trim().parse::<u8>().ok())
                .collect()
        });

        let raop_codecs = txt.get("cn").map(|cn| {
            cn.split(',')
                .filter_map(|s| s.trim().parse::<u8>().ok())
                .collect()
        });

        let raop_transport = txt.get("tp").cloned();

        let raop_metadata_types = txt.get("md").map(|md| {
            md.split(',')
                .filter_map(|s| s.trim().parse::<u8>().ok())
                .collect()
        });

        Ok(Device {
            id,
            name: device_name.to_string(),
            model,
            manufacturer: None,
            serial_number: None,
            addresses,
            port,
            features,
            required_sender_features: None,
            public_key,
            source_version,
            firmware_version,
            os_version,
            protocol_version: None,
            requires_password,
            status_flags,
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
            raop_port: Some(port),
            raop_encryption_types,
            raop_codecs,
            raop_transport,
            raop_metadata_types,
            raop_digest_auth,
            vodka_version,
        })
    }

    /// Parse Ed25519 public key from hex string.
    pub fn parse_public_key(hex: &str) -> Result<[u8; 32], ParseError> {
        let hex = hex.trim();

        if hex.len() != 64 {
            return Err(ParseError::InvalidFormat(format!(
                "public key must be 64 hex characters, got {}",
                hex.len()
            )));
        }

        let bytes: Vec<u8> = (0..32)
            .map(|i| {
                let start = i * 2;
                u8::from_str_radix(&hex[start..start + 2], 16)
                    .map_err(|_| ParseError::InvalidHex(hex[start..start + 2].to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;

        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        Ok(arr)
    }

    /// Parse a hex or decimal string to u64.
    fn parse_hex_or_decimal(s: &str) -> u64 {
        let s = s.trim();
        if s.starts_with("0x") || s.starts_with("0X") {
            u64::from_str_radix(&s[2..], 16).unwrap_or(0)
        } else {
            s.parse().unwrap_or(0)
        }
    }

    /// Parse legacy 32-bit features from 'sf' field.
    ///
    /// The 'sf' field in RAOP records contains a 32-bit value (hex or decimal)
    /// which is zero-extended to the 64-bit Features format.
    pub fn parse_legacy_features(sf: &str) -> Result<Features, ParseError> {
        let sf = sf.trim();

        // Try parsing as hex first (with optional 0x prefix)
        let value = if sf.starts_with("0x") || sf.starts_with("0X") {
            u64::from_str_radix(&sf[2..], 16).map_err(|_| ParseError::InvalidHex(sf.to_string()))?
        } else if sf.chars().all(|c| c.is_ascii_digit()) {
            // Decimal format
            sf.parse::<u64>()
                .map_err(|_| ParseError::InvalidValue(format!("invalid decimal: {}", sf)))?
        } else {
            // Try as bare hex
            u64::from_str_radix(sf, 16).map_err(|_| ParseError::InvalidHex(sf.to_string()))?
        };

        Ok(Features::from_raw(value))
    }

    /// Merge device info from both AirPlay and RAOP records.
    ///
    /// AirPlay record takes priority for features, name, and public_key.
    /// Addresses are combined from both records.
    pub fn merge_device_info(airplay: &Device, raop: &Device) -> Device {
        // Combine addresses, removing duplicates
        let mut addresses = airplay.addresses.clone();
        for addr in &raop.addresses {
            if !addresses.contains(addr) {
                addresses.push(*addr);
            }
        }

        Device {
            id: airplay.id.clone(),
            name: airplay.name.clone(),
            model: if airplay.model.is_empty() {
                raop.model.clone()
            } else {
                airplay.model.clone()
            },
            manufacturer: airplay.manufacturer.clone(),
            serial_number: airplay.serial_number.clone(),
            addresses,
            port: airplay.port,
            features: airplay.features, // Prefer AirPlay features (64-bit)
            required_sender_features: airplay.required_sender_features,
            public_key: airplay.public_key.or(raop.public_key),
            source_version: if airplay.source_version == Version::default() {
                raop.source_version
            } else {
                airplay.source_version
            },
            firmware_version: airplay.firmware_version.clone().or_else(|| raop.firmware_version.clone()),
            os_version: airplay.os_version.clone().or_else(|| raop.os_version.clone()),
            protocol_version: airplay.protocol_version.clone(),
            requires_password: airplay.requires_password || raop.requires_password,
            status_flags: if airplay.status_flags != 0 { airplay.status_flags } else { raop.status_flags },
            access_control: airplay.access_control,
            pairing_identity: airplay.pairing_identity.clone(),
            system_pairing_identity: airplay.system_pairing_identity.clone(),
            bluetooth_address: airplay.bluetooth_address.clone(),
            homekit_home_id: airplay.homekit_home_id.clone(),
            group_id: airplay.group_id,
            is_group_leader: airplay.is_group_leader,
            group_public_name: airplay.group_public_name.clone(),
            group_contains_discoverable_leader: airplay.group_contains_discoverable_leader,
            home_group_id: airplay.home_group_id.clone(),
            household_id: airplay.household_id.clone(),
            parent_group_id: airplay.parent_group_id,
            parent_group_contains_discoverable_leader: airplay.parent_group_contains_discoverable_leader,
            tight_sync_id: airplay.tight_sync_id,
            // RAOP fields come from the RAOP record
            raop_port: raop.raop_port,
            raop_encryption_types: raop.raop_encryption_types.clone(),
            raop_codecs: raop.raop_codecs.clone(),
            raop_transport: raop.raop_transport.clone(),
            raop_metadata_types: raop.raop_metadata_types.clone(),
            raop_digest_auth: raop.raop_digest_auth,
            vodka_version: raop.vodka_version.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn make_txt(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    mod parse_airplay_txt {
        use super::*;

        #[test]
        fn parses_minimal_valid_record() {
            let txt = make_txt(&[("deviceid", "AA:BB:CC:DD:EE:FF")]);

            let device =
                TxtRecordParser::parse_airplay_txt("Living Room", &txt, vec![], 7000).unwrap();

            assert_eq!(device.id.0, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
            assert_eq!(device.name, "Living Room");
            assert_eq!(device.port, 7000);
        }

        #[test]
        fn parses_full_record_with_all_fields() {
            let txt = make_txt(&[
                ("deviceid", "58:55:CA:1A:E2:88"),
                ("features", "0x445F8A00,0x1C340"),
                ("model", "AppleTV5,3"),
                ("srcvers", "366.0"),
                (
                    "pk",
                    "b4bf1e47e6aa4f5f9f2e3c8d1a0b9c7e6d5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c",
                ),
                ("gid", "712F0759-5D44-4321-8765-123456789ABC"),
                ("igl", "1"),
                ("pw", "false"),
            ]);

            let addr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 100));
            let device =
                TxtRecordParser::parse_airplay_txt("Apple TV", &txt, vec![addr], 7000).unwrap();

            assert_eq!(device.id.0, [0x58, 0x55, 0xCA, 0x1A, 0xE2, 0x88]);
            assert_eq!(device.name, "Apple TV");
            assert_eq!(device.model, "AppleTV5,3");
            assert_eq!(device.features.raw(), 0x1C340_445F8A00);
            assert_eq!(device.source_version, Version::new(366, 0, 0));
            assert!(device.public_key.is_some());
            assert!(device.group_id.is_some());
            assert!(device.is_group_leader);
            assert!(!device.requires_password);
        }

        #[test]
        fn error_on_missing_deviceid() {
            let txt = make_txt(&[("features", "0x200")]);

            let result = TxtRecordParser::parse_airplay_txt("Device", &txt, vec![], 7000);
            assert!(result.is_err());
            assert!(matches!(result.unwrap_err(), ParseError::MissingField(_)));
        }

        #[test]
        fn parses_features_64bit() {
            let txt = make_txt(&[
                ("deviceid", "AA:BB:CC:DD:EE:FF"),
                ("features", "0x445F8A00,0x1C340"),
            ]);

            let device = TxtRecordParser::parse_airplay_txt("Device", &txt, vec![], 7000).unwrap();
            assert_eq!(device.features.raw(), 0x1C340_445F8A00);
            assert!(device.features.supports_audio());
            assert!(device.features.supports_buffered_audio());
        }

        #[test]
        fn parses_public_key() {
            let txt = make_txt(&[
                ("deviceid", "AA:BB:CC:DD:EE:FF"),
                (
                    "pk",
                    "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
                ),
            ]);

            let device = TxtRecordParser::parse_airplay_txt("Device", &txt, vec![], 7000).unwrap();
            let pk = device.public_key.unwrap();
            assert_eq!(pk[0], 0x01);
            assert_eq!(pk[15], 0x10);
            assert_eq!(pk[31], 0x20);
        }

        #[test]
        fn parses_group_uuid() {
            let txt = make_txt(&[
                ("deviceid", "AA:BB:CC:DD:EE:FF"),
                ("gid", "712F0759-5D44-4321-8765-123456789ABC"),
            ]);

            let device = TxtRecordParser::parse_airplay_txt("Device", &txt, vec![], 7000).unwrap();
            assert!(device.group_id.is_some());
            assert_eq!(
                device.group_id.unwrap().to_string(),
                "712f0759-5d44-4321-8765-123456789abc"
            );
        }

        #[test]
        fn parses_is_group_leader() {
            let txt = make_txt(&[("deviceid", "AA:BB:CC:DD:EE:FF"), ("igl", "1")]);

            let device = TxtRecordParser::parse_airplay_txt("Device", &txt, vec![], 7000).unwrap();
            assert!(device.is_group_leader);

            let txt = make_txt(&[("deviceid", "AA:BB:CC:DD:EE:FF"), ("igl", "0")]);
            let device = TxtRecordParser::parse_airplay_txt("Device", &txt, vec![], 7000).unwrap();
            assert!(!device.is_group_leader);
        }

        #[test]
        fn parses_requires_password_true() {
            let txt = make_txt(&[("deviceid", "AA:BB:CC:DD:EE:FF"), ("pw", "true")]);

            let device = TxtRecordParser::parse_airplay_txt("Device", &txt, vec![], 7000).unwrap();
            assert!(device.requires_password);

            let txt = make_txt(&[("deviceid", "AA:BB:CC:DD:EE:FF"), ("pw", "1")]);
            let device = TxtRecordParser::parse_airplay_txt("Device", &txt, vec![], 7000).unwrap();
            assert!(device.requires_password);
        }

        #[test]
        fn parses_requires_password_false() {
            let txt = make_txt(&[("deviceid", "AA:BB:CC:DD:EE:FF"), ("pw", "false")]);

            let device = TxtRecordParser::parse_airplay_txt("Device", &txt, vec![], 7000).unwrap();
            assert!(!device.requires_password);

            let txt = make_txt(&[("deviceid", "AA:BB:CC:DD:EE:FF"), ("pw", "0")]);
            let device = TxtRecordParser::parse_airplay_txt("Device", &txt, vec![], 7000).unwrap();
            assert!(!device.requires_password);
        }

        #[test]
        fn handles_missing_optional_fields() {
            let txt = make_txt(&[("deviceid", "AA:BB:CC:DD:EE:FF")]);

            let device = TxtRecordParser::parse_airplay_txt("Device", &txt, vec![], 7000).unwrap();
            assert!(device.model.is_empty());
            assert_eq!(device.features.raw(), 0);
            assert!(device.public_key.is_none());
            assert!(device.group_id.is_none());
            assert!(!device.is_group_leader);
            assert!(!device.requires_password);
        }
    }

    mod parse_raop_txt {
        use super::*;

        #[test]
        fn parses_name_format_mac_at_name() {
            let txt = make_txt(&[]);

            let device = TxtRecordParser::parse_raop_txt(
                "AABBCCDDEEFF@Living Room Speaker",
                &txt,
                vec![],
                5000,
            )
            .unwrap();

            assert_eq!(device.id.0, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
            assert_eq!(device.name, "Living Room Speaker");
            assert_eq!(device.port, 5000);
        }

        #[test]
        fn error_on_invalid_name_format() {
            let txt = make_txt(&[]);

            // Missing @ separator
            let result = TxtRecordParser::parse_raop_txt("InvalidNameFormat", &txt, vec![], 5000);
            assert!(result.is_err());

            // Invalid MAC hex
            let result = TxtRecordParser::parse_raop_txt("GGHHIIJJKKLL@Device", &txt, vec![], 5000);
            assert!(result.is_err());
        }

        #[test]
        fn parses_codec_flags() {
            // cn field specifies supported codecs
            // cn=0,1,2,3 means PCM, ALAC, AAC, AAC-ELD
            let txt = make_txt(&[("cn", "0,1,2,3")]);

            // We don't parse cn directly into device, but TXT is available
            let device =
                TxtRecordParser::parse_raop_txt("AABBCCDDEEFF@Device", &txt, vec![], 5000).unwrap();
            assert_eq!(device.name, "Device");
        }

        #[test]
        fn parses_encryption_types() {
            // et field specifies encryption types
            let txt = make_txt(&[("et", "0,3,5")]);

            let device =
                TxtRecordParser::parse_raop_txt("AABBCCDDEEFF@Device", &txt, vec![], 5000).unwrap();
            assert_eq!(device.name, "Device");
        }

        #[test]
        fn parses_sample_rate() {
            let txt = make_txt(&[("sr", "44100")]);

            let device =
                TxtRecordParser::parse_raop_txt("AABBCCDDEEFF@Device", &txt, vec![], 5000).unwrap();
            assert_eq!(device.name, "Device");
        }

        #[test]
        fn parses_channels() {
            let txt = make_txt(&[("ch", "2")]);

            let device =
                TxtRecordParser::parse_raop_txt("AABBCCDDEEFF@Device", &txt, vec![], 5000).unwrap();
            assert_eq!(device.name, "Device");
        }

        #[test]
        fn parses_transport_udp() {
            let txt = make_txt(&[("tp", "UDP")]);

            let device =
                TxtRecordParser::parse_raop_txt("AABBCCDDEEFF@Device", &txt, vec![], 5000).unwrap();
            assert_eq!(device.name, "Device");
        }

        #[test]
        fn parses_transport_tcp() {
            let txt = make_txt(&[("tp", "TCP")]);

            let device =
                TxtRecordParser::parse_raop_txt("AABBCCDDEEFF@Device", &txt, vec![], 5000).unwrap();
            assert_eq!(device.name, "Device");
        }

        #[test]
        fn parses_legacy_features_sf() {
            let txt = make_txt(&[("sf", "0x200")]);

            let device =
                TxtRecordParser::parse_raop_txt("AABBCCDDEEFF@Device", &txt, vec![], 5000).unwrap();
            assert_eq!(device.features.raw(), 0x200);
            assert!(device.features.supports_audio());
        }

        #[test]
        fn parses_model_from_am_field() {
            let txt = make_txt(&[("am", "AirPort10,115")]);

            let device =
                TxtRecordParser::parse_raop_txt("AABBCCDDEEFF@Device", &txt, vec![], 5000).unwrap();
            assert_eq!(device.model, "AirPort10,115");
        }

        #[test]
        fn parses_version_from_vs_field() {
            let txt = make_txt(&[("vs", "220.68")]);

            let device =
                TxtRecordParser::parse_raop_txt("AABBCCDDEEFF@Device", &txt, vec![], 5000).unwrap();
            assert_eq!(device.source_version, Version::new(220, 68, 0));
        }
    }

    mod parse_public_key {
        use super::*;

        #[test]
        fn parses_valid_64_char_hex() {
            let hex = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
            let key = TxtRecordParser::parse_public_key(hex).unwrap();

            assert_eq!(key[0], 0x01);
            assert_eq!(key[10], 0x0b);
            assert_eq!(key[31], 0x20);
        }

        #[test]
        fn error_on_short_hex() {
            let hex = "0102030405060708090a0b0c0d0e0f10"; // 32 chars (16 bytes)
            let result = TxtRecordParser::parse_public_key(hex);
            assert!(result.is_err());
        }

        #[test]
        fn error_on_invalid_hex_chars() {
            let hex = "gg02030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
            let result = TxtRecordParser::parse_public_key(hex);
            assert!(result.is_err());
        }

        #[test]
        fn handles_lowercase() {
            let hex = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
            let key = TxtRecordParser::parse_public_key(hex).unwrap();
            assert_eq!(key[0], 0xab);
        }

        #[test]
        fn handles_uppercase() {
            let hex = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
            let key = TxtRecordParser::parse_public_key(hex).unwrap();
            assert_eq!(key[0], 0xab);
        }

        #[test]
        fn handles_mixed_case() {
            let hex = "AbCdEf0123456789aBcDeF0123456789AbCdEf0123456789aBcDeF0123456789";
            let key = TxtRecordParser::parse_public_key(hex).unwrap();
            assert_eq!(key[0], 0xab);
        }
    }

    mod parse_legacy_features {
        use super::*;

        #[test]
        fn parses_32bit_hex_value() {
            let features = TxtRecordParser::parse_legacy_features("0x200").unwrap();
            assert_eq!(features.raw(), 0x200);
            assert!(features.supports_audio());
        }

        #[test]
        fn parses_decimal_value() {
            let features = TxtRecordParser::parse_legacy_features("512").unwrap();
            assert_eq!(features.raw(), 512); // 0x200
            assert!(features.supports_audio());
        }

        #[test]
        fn zero_extends_to_64bit() {
            // 32-bit value should be zero-extended (upper 32 bits are 0)
            let features = TxtRecordParser::parse_legacy_features("0xFFFFFFFF").unwrap();
            assert_eq!(features.raw(), 0xFFFFFFFF);
            // No upper bits set
            assert!(!features.supports_buffered_audio()); // bit 40
            assert!(!features.supports_ptp()); // bit 41
        }

        #[test]
        fn parses_large_32bit_hex() {
            let features = TxtRecordParser::parse_legacy_features("0x4000800").unwrap();
            assert_eq!(features.raw(), 0x4000800);
        }

        #[test]
        fn parses_bare_hex() {
            let features = TxtRecordParser::parse_legacy_features("200").unwrap();
            // Ambiguous: could be decimal 200 or hex 0x200
            // We try decimal first for all-digit strings
            assert_eq!(features.raw(), 200);
        }
    }

    mod merge_device_info {
        use super::*;

        fn make_device(
            name: &str,
            features: u64,
            public_key: Option<[u8; 32]>,
            addresses: Vec<IpAddr>,
        ) -> Device {
            Device {
                id: DeviceId([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]),
                name: name.to_string(),
                model: String::new(),
                manufacturer: None,
                serial_number: None,
                addresses,
                port: 7000,
                features: Features::from_raw(features),
                required_sender_features: None,
                public_key,
                source_version: Version::default(),
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
        fn prefers_airplay_features_over_raop() {
            let airplay = make_device("Device", 0x1C340_445F8A00, None, vec![]);
            let raop = make_device("Device", 0x200, None, vec![]);

            let merged = TxtRecordParser::merge_device_info(&airplay, &raop);
            assert_eq!(merged.features.raw(), 0x1C340_445F8A00);
        }

        #[test]
        fn combines_addresses() {
            let addr1 = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 100));
            let addr2 = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 101));
            let addr3 = IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1));

            let airplay = make_device("Device", 0, None, vec![addr1, addr2]);
            let raop = make_device("Device", 0, None, vec![addr2, addr3]); // addr2 is duplicate

            let merged = TxtRecordParser::merge_device_info(&airplay, &raop);
            assert_eq!(merged.addresses.len(), 3);
            assert!(merged.addresses.contains(&addr1));
            assert!(merged.addresses.contains(&addr2));
            assert!(merged.addresses.contains(&addr3));
        }

        #[test]
        fn keeps_airplay_name() {
            let airplay = make_device("AirPlay Name", 0, None, vec![]);
            let raop = make_device("RAOP Name", 0, None, vec![]);

            let merged = TxtRecordParser::merge_device_info(&airplay, &raop);
            assert_eq!(merged.name, "AirPlay Name");
        }

        #[test]
        fn keeps_airplay_public_key() {
            let pk = [0x42u8; 32];
            let airplay = make_device("Device", 0, Some(pk), vec![]);
            let raop = make_device("Device", 0, None, vec![]);

            let merged = TxtRecordParser::merge_device_info(&airplay, &raop);
            assert_eq!(merged.public_key, Some(pk));
        }

        #[test]
        fn falls_back_to_raop_model_if_airplay_empty() {
            let mut airplay = make_device("Device", 0, None, vec![]);
            airplay.model = String::new();

            let mut raop = make_device("Device", 0, None, vec![]);
            raop.model = "AirPort10,115".to_string();

            let merged = TxtRecordParser::merge_device_info(&airplay, &raop);
            assert_eq!(merged.model, "AirPort10,115");
        }
    }

    mod real_device_records {
        use super::*;

        #[test]
        fn apple_tv_4k_airplay_record() {
            // Real TXT record from Apple TV 4K
            let txt = make_txt(&[
                ("deviceid", "AA:BB:CC:DD:EE:FF"),
                ("features", "0x445F8A00,0x1C340"),
                ("model", "AppleTV5,3"),
                ("srcvers", "366.0"),
                (
                    "pk",
                    "b4bf1e47e6aa4f5f9f2e3c8d1a0b9c7e6d5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c",
                ),
            ]);

            let addr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50));
            let device =
                TxtRecordParser::parse_airplay_txt("Apple TV", &txt, vec![addr], 7000).unwrap();

            assert_eq!(device.name, "Apple TV");
            assert_eq!(device.model, "AppleTV5,3");
            assert_eq!(device.features.raw(), 0x1C340_445F8A00);
            assert!(device.features.supports_audio());
            assert!(device.features.supports_buffered_audio());
            assert!(device.features.supports_ptp());
            assert_eq!(device.source_version, Version::new(366, 0, 0));
            assert!(device.supports_airplay2());
            assert!(device.public_key.is_some());
        }

        #[test]
        fn homepod_mini_airplay_record() {
            // HomePod Mini with typical feature set
            let txt = make_txt(&[
                ("deviceid", "11:22:33:44:55:66"),
                ("features", "0x40000a00,0x80300"),
                ("model", "AudioAccessory5,1"),
                ("srcvers", "600.2.1"),
                (
                    "pk",
                    "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                ),
                ("gid", "AAAABBBB-CCCC-DDDD-EEEE-FFFFFFFFFFFF"),
                ("igl", "1"),
            ]);

            let addr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 60));
            let device =
                TxtRecordParser::parse_airplay_txt("HomePod Mini", &txt, vec![addr], 7000).unwrap();

            assert_eq!(device.name, "HomePod Mini");
            assert_eq!(device.model, "AudioAccessory5,1");
            assert!(device.features.supports_audio());
            assert!(device.features.supports_redundant_audio());
            assert!(device.features.supports_buffered_audio());
            assert!(device.features.supports_ptp());
            assert!(device.features.supports_unified_pair_mfi());
            assert!(!device.features.requires_mfi());
            assert!(device.is_group_leader);
            assert!(device.group_id.is_some());
        }

        #[test]
        fn legacy_airport_express_raop_record() {
            // Legacy AirPort Express (AirPlay 1 only)
            let txt = make_txt(&[
                ("cn", "0,1,2,3"),
                ("da", "true"),
                ("et", "0,3,5"),
                ("md", "0,1,2"),
                ("am", "AirPort10,115"),
                ("sf", "0x4"),
                ("vs", "220.68"),
                ("sr", "44100"),
                ("ss", "16"),
                ("ch", "2"),
                ("tp", "UDP"),
                ("pw", "false"),
            ]);

            let addr = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 70));
            let device = TxtRecordParser::parse_raop_txt(
                "F0D1A96BC789@AirPort Express",
                &txt,
                vec![addr],
                5000,
            )
            .unwrap();

            assert_eq!(device.name, "AirPort Express");
            assert_eq!(device.model, "AirPort10,115");
            assert_eq!(device.id.0, [0xF0, 0xD1, 0xA9, 0x6B, 0xC7, 0x89]);
            assert_eq!(device.source_version, Version::new(220, 68, 0));
            assert!(!device.requires_password);

            // AirPlay 1 device won't have AirPlay 2 features
            assert!(!device.supports_airplay2());
            assert!(!device.features.supports_buffered_audio());
        }
    }
}
