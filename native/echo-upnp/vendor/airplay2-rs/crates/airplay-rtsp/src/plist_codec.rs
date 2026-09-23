//! Binary plist encoding/decoding for RTSP payloads.

use airplay_core::error::{RtspError, Result};
use serde::{Deserialize, Serialize};

/// Encode value to binary plist.
pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    plist::to_writer_binary(std::io::Cursor::new(&mut buf), value)
        .map_err(|e| RtspError::PlistError(e.to_string()))?;
    Ok(buf)
}

/// Decode binary plist to value.
pub fn decode<T: for<'de> Deserialize<'de>>(data: &[u8]) -> Result<T> {
    plist::from_bytes(data)
        .map_err(|e| RtspError::PlistError(e.to_string()).into())
}

/// Device info response from /info endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct InfoResponse {
    pub features: Option<u64>,
    #[serde(rename = "statusFlags")]
    pub status_flags: Option<u32>,
    pub model: Option<String>,
    #[serde(rename = "sourceVersion")]
    pub source_version: Option<String>,
    /// Ed25519 public key - stored as plist Data
    #[serde(default, deserialize_with = "deserialize_data_option")]
    pub pk: Option<Vec<u8>>,
    pub pi: Option<String>,
    #[serde(rename = "deviceID")]
    pub device_id: Option<String>,
    pub name: Option<String>,
    #[serde(rename = "macAddress")]
    pub mac_address: Option<String>,
    #[serde(rename = "audioFormats", default)]
    pub audio_formats: Vec<AudioFormatInfo>,
}

/// Deserializer for optional plist Data to Vec<u8>
fn deserialize_data_option<'de, D>(deserializer: D) -> std::result::Result<Option<Vec<u8>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{Deserialize, Error};

    // Try to deserialize as plist::Value first
    let value: Option<plist::Value> = Option::deserialize(deserializer)?;

    match value {
        Some(plist::Value::Data(data)) => Ok(Some(data)),
        Some(_) => Err(D::Error::custom("expected data type for pk field")),
        None => Ok(None),
    }
}

/// Audio format descriptor from /info.
#[derive(Debug, Clone, Deserialize)]
pub struct AudioFormatInfo {
    #[serde(rename = "type")]
    pub format_type: Option<u32>,
    #[serde(rename = "audioInputFormats")]
    pub audio_input_formats: Option<u32>,
    #[serde(rename = "audioOutputFormats")]
    pub audio_output_formats: Option<u32>,
}

/// Timing peer info for PTP.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimingPeerInfo {
    #[serde(rename = "Addresses")]
    pub addresses: Vec<String>,
    #[serde(rename = "ID")]
    pub id: String,
    /// Only present in sender's request, not in receiver's response
    #[serde(rename = "SupportsClockPortMatchingOverride", default)]
    pub supports_clock_port_matching_override: bool,
}

/// SETUP phase 1 request body (minimal, owntone-style).
///
/// Note: We use the minimal 4-field format that owntone uses:
/// - deviceID
/// - sessionUUID
/// - timingPort (actual UDP port, not 0)
/// - timingProtocol ("NTP" or "PTP")
///
/// The encryption keys (eiv, ekey, et) are NOT sent in phase 1;
/// the stream key (shk) is sent in phase 2 with the streams array.
#[derive(Debug, Clone, Serialize)]
pub struct SetupPhase1Request {
    #[serde(rename = "deviceID")]
    pub device_id: String,
    #[serde(rename = "sessionUUID")]
    pub session_uuid: String,
    #[serde(rename = "timingPort")]
    pub timing_port: u16,
    #[serde(rename = "timingProtocol")]
    pub timing_protocol: String,
    /// Optional PTP peer info (only for PTP timing protocol).
    #[serde(rename = "timingPeerInfo", skip_serializing_if = "Option::is_none")]
    pub timing_peer_info: Option<TimingPeerInfo>,
    /// Optional PTP peer list (array form of timingPeerInfo, required by some receivers).
    #[serde(rename = "timingPeerList", skip_serializing_if = "Option::is_none")]
    pub timing_peer_list: Option<Vec<TimingPeerInfo>>,
}

/// SETUP phase 1 response body.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupPhase1Response {
    #[serde(rename = "eventPort", default)]
    pub event_port: u16,
    #[serde(rename = "timingPort", default)]
    pub timing_port: u16,
    #[serde(rename = "timingPeerInfo")]
    pub timing_peer_info: Option<TimingPeerInfo>,
}

/// Stream definition for SETUP phase 2.
#[derive(Debug, Clone, Serialize)]
pub struct StreamDef {
    #[serde(rename = "type")]
    pub stream_type: u32,
    #[serde(rename = "audioFormat")]
    pub audio_format: u32,
    #[serde(rename = "audioMode")]
    pub audio_mode: String,
    #[serde(rename = "sr")]
    pub sample_rate: u32,
    pub ct: u8,
    #[serde(rename = "controlPort")]
    pub control_port: u16,
    #[serde(rename = "isMedia")]
    pub is_media: bool,
    #[serde(rename = "latencyMin")]
    pub latency_min: u32,
    #[serde(rename = "latencyMax")]
    pub latency_max: u32,
    #[serde(with = "serde_bytes")]
    pub shk: Vec<u8>,
    /// AudioSpecificConfig for AAC streams (2 bytes).
    #[serde(with = "serde_bytes", skip_serializing_if = "Option::is_none")]
    pub asc: Option<Vec<u8>>,
    pub spf: u32,
    #[serde(rename = "supportsDynamicStreamID")]
    pub supports_dynamic_stream_id: bool,
    #[serde(rename = "streamConnectionID")]
    pub stream_connection_id: u32,
}

/// SETUP phase 2 request body.
#[derive(Debug, Clone, Serialize)]
pub struct SetupPhase2Request {
    pub streams: Vec<StreamDef>,
}

/// Stream response from SETUP phase 2.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamResponse {
    #[serde(rename = "type")]
    pub stream_type: u32,
    #[serde(rename = "dataPort")]
    pub data_port: u16,
    #[serde(rename = "controlPort")]
    pub control_port: u16,
    /// Stream ID - may be very large (use i64 to handle plist signed encoding)
    #[serde(rename = "streamID", default)]
    pub stream_id: i64,
}

/// SETUP phase 2 response body.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupPhase2Response {
    pub streams: Vec<StreamResponse>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use plist::Dictionary;

    /// Helper to encode a plist directly (like old to_vec_binary)
    fn encode_raw<T: Serialize>(value: &T) -> std::result::Result<Vec<u8>, plist::Error> {
        let mut buf = Vec::new();
        plist::to_writer_binary(std::io::Cursor::new(&mut buf), value)?;
        Ok(buf)
    }

    mod encoding {
        use super::*;

        #[test]
        fn encode_produces_binary_plist() {
            // Binary plist starts with "bplist00"
            let data: Dictionary = Dictionary::new();
            let encoded = encode(&data).unwrap();
            assert!(encoded.starts_with(b"bplist"));
        }

        #[test]
        fn encode_decode_roundtrip() {
            #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
            struct TestStruct {
                name: String,
                value: u32,
            }

            let original = TestStruct {
                name: "test".to_string(),
                value: 42,
            };

            let encoded = encode(&original).unwrap();
            let decoded: TestStruct = decode(&encoded).unwrap();

            assert_eq!(original, decoded);
        }
    }

    mod info_response {
        use super::*;

        #[test]
        fn decode_minimal_info() {
            // Create a minimal plist with just a few fields
            let mut dict = Dictionary::new();
            dict.insert("model".to_string(), plist::Value::String("AppleTV5,3".to_string()));

            let encoded = encode_raw(&dict).unwrap();
            let info: InfoResponse = decode(&encoded).unwrap();

            assert_eq!(info.model, Some("AppleTV5,3".to_string()));
            assert!(info.features.is_none());
            assert!(info.pk.is_none());
        }

        #[test]
        fn decode_full_info() {
            let mut dict = Dictionary::new();
            dict.insert("model".to_string(), plist::Value::String("AppleTV5,3".to_string()));
            dict.insert("sourceVersion".to_string(), plist::Value::String("366.0".to_string()));
            dict.insert("features".to_string(), plist::Value::Integer(0x445F8A00i64.into()));
            dict.insert("statusFlags".to_string(), plist::Value::Integer(0x404i64.into()));
            dict.insert("pk".to_string(), plist::Value::Data(vec![0xAAu8; 32]));
            dict.insert("pi".to_string(), plist::Value::String("abc-123".to_string()));
            dict.insert("deviceID".to_string(), plist::Value::String("AA:BB:CC:DD:EE:FF".to_string()));
            dict.insert("name".to_string(), plist::Value::String("Living Room".to_string()));

            let encoded = encode_raw(&dict).unwrap();
            let info: InfoResponse = decode(&encoded).unwrap();

            assert_eq!(info.model, Some("AppleTV5,3".to_string()));
            assert_eq!(info.source_version, Some("366.0".to_string()));
            assert_eq!(info.features, Some(0x445F8A00));
            assert_eq!(info.status_flags, Some(0x404));
            assert_eq!(info.pk, Some(vec![0xAAu8; 32]));
            assert_eq!(info.pi, Some("abc-123".to_string()));
            assert_eq!(info.device_id, Some("AA:BB:CC:DD:EE:FF".to_string()));
            assert_eq!(info.name, Some("Living Room".to_string()));
        }
    }

    mod setup_requests {
        use super::*;

        #[test]
        fn setup_phase1_serializes_minimal_fields() {
            // Test the minimal owntone-style SETUP phase 1 request
            let request = SetupPhase1Request {
                device_id: "AA:BB:CC:DD:EE:FF".to_string(),
                session_uuid: "session-456".to_string(),
                timing_port: 60373,
                timing_protocol: "NTP".to_string(),
                timing_peer_info: None,
                timing_peer_list: None,
            };

            let encoded = encode(&request).unwrap();

            // Decode as dictionary to verify fields
            let dict: Dictionary = decode(&encoded).unwrap();

            assert_eq!(
                dict.get("deviceID").and_then(|v| v.as_string()),
                Some("AA:BB:CC:DD:EE:FF")
            );
            assert_eq!(
                dict.get("sessionUUID").and_then(|v| v.as_string()),
                Some("session-456")
            );
            assert_eq!(
                dict.get("timingPort").and_then(|v| v.as_unsigned_integer()),
                Some(60373)
            );
            assert_eq!(
                dict.get("timingProtocol").and_then(|v| v.as_string()),
                Some("NTP")
            );

            // Should have exactly 4 keys (no timingPeerInfo/timingPeerList when None)
            assert_eq!(dict.len(), 4);
        }

        #[test]
        fn setup_phase1_with_ptp_peer_info() {
            let peer_info = TimingPeerInfo {
                addresses: vec!["192.168.1.100".to_string()],
                id: "peer-789".to_string(),
                supports_clock_port_matching_override: true,
            };
            let request = SetupPhase1Request {
                device_id: "AA:BB:CC:DD:EE:FF".to_string(),
                session_uuid: "session-456".to_string(),
                timing_port: 60373,
                timing_protocol: "PTP".to_string(),
                timing_peer_info: Some(peer_info.clone()),
                timing_peer_list: Some(vec![peer_info]),
            };

            let encoded = encode(&request).unwrap();
            let dict: Dictionary = decode(&encoded).unwrap();

            assert_eq!(
                dict.get("timingProtocol").and_then(|v| v.as_string()),
                Some("PTP")
            );
            assert!(dict.get("timingPeerInfo").is_some());
            assert!(dict.get("timingPeerList").is_some());
            // Should have 6 keys (including timingPeerInfo and timingPeerList)
            assert_eq!(dict.len(), 6);
        }

        #[test]
        fn setup_phase2_serializes_streams() {
            let request = SetupPhase2Request {
                streams: vec![StreamDef {
                    stream_type: 96,
                    audio_format: 0x40000,
                    audio_mode: "default".to_string(),
                    sample_rate: 44100,
                    ct: 2,
                    control_port: 60242,
                    is_media: true,
                    latency_min: 11025,
                    latency_max: 88200,
                    shk: vec![0x42; 32],
                    asc: None,
                    spf: 352,
                    supports_dynamic_stream_id: true,
                    stream_connection_id: 1234,
                }],
            };

            let encoded = encode(&request).unwrap();
            let dict: Dictionary = decode(&encoded).unwrap();

            let streams = dict.get("streams").and_then(|v| v.as_array()).unwrap();
            assert_eq!(streams.len(), 1);

            let stream = streams[0].as_dictionary().unwrap();
            assert_eq!(stream.get("type").and_then(|v| v.as_unsigned_integer()), Some(96));
            assert_eq!(stream.get("audioFormat").and_then(|v| v.as_unsigned_integer()), Some(0x40000));
            assert_eq!(stream.get("audioMode").and_then(|v| v.as_string()), Some("default"));
            assert_eq!(stream.get("sr").and_then(|v| v.as_unsigned_integer()), Some(44100));
            assert_eq!(stream.get("ct").and_then(|v| v.as_unsigned_integer()), Some(2));
            assert_eq!(stream.get("controlPort").and_then(|v| v.as_unsigned_integer()), Some(60242));
            assert_eq!(stream.get("isMedia").and_then(|v| v.as_boolean()), Some(true));
            assert_eq!(stream.get("latencyMin").and_then(|v| v.as_unsigned_integer()), Some(11025));
            assert_eq!(stream.get("latencyMax").and_then(|v| v.as_unsigned_integer()), Some(88200));
            assert_eq!(stream.get("spf").and_then(|v| v.as_unsigned_integer()), Some(352));
            assert_eq!(stream.get("supportsDynamicStreamID").and_then(|v| v.as_boolean()), Some(true));
            assert_eq!(stream.get("streamConnectionID").and_then(|v| v.as_unsigned_integer()), Some(1234));
        }
    }

    mod setup_responses {
        use super::*;

        #[test]
        fn setup_phase1_response_extracts_ports() {
            let mut dict = Dictionary::new();
            dict.insert("eventPort".to_string(), plist::Value::Integer(58168i64.into()));
            dict.insert("timingPort".to_string(), plist::Value::Integer(58169i64.into()));

            let encoded = encode_raw(&dict).unwrap();
            let response: SetupPhase1Response = decode(&encoded).unwrap();

            assert_eq!(response.event_port, 58168);
            assert_eq!(response.timing_port, 58169);
            assert!(response.timing_peer_info.is_none());
        }

        #[test]
        fn setup_phase2_response_extracts_streams() {
            let mut stream_dict = Dictionary::new();
            stream_dict.insert("type".to_string(), plist::Value::Integer(96i64.into()));
            stream_dict.insert("dataPort".to_string(), plist::Value::Integer(58170i64.into()));
            stream_dict.insert("controlPort".to_string(), plist::Value::Integer(58171i64.into()));

            let mut dict = Dictionary::new();
            dict.insert("streams".to_string(), plist::Value::Array(vec![
                plist::Value::Dictionary(stream_dict),
            ]));

            let encoded = encode_raw(&dict).unwrap();
            let response: SetupPhase2Response = decode(&encoded).unwrap();

            assert_eq!(response.streams.len(), 1);
            assert_eq!(response.streams[0].stream_type, 96);
            assert_eq!(response.streams[0].data_port, 58170);
            assert_eq!(response.streams[0].control_port, 58171);
        }
    }
}
