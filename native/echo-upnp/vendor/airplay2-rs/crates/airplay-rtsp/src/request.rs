//! RTSP request formatting.

use std::collections::HashMap;
use std::io::Write;

/// RTSP method types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RtspMethod {
    Options,
    Announce,
    Setup,
    Record,
    Pause,
    Flush,
    Teardown,
    GetParameter,
    SetParameter,
    Post,  // For HTTP-style endpoints like /info
    Get,
    SetPeers,
}

/// RTSP request builder.
#[derive(Debug, Clone)]
pub struct RtspRequest {
    pub method: RtspMethod,
    pub uri: String,
    pub headers: HashMap<String, String>,
    pub body: Option<Vec<u8>>,
}

impl RtspRequest {
    pub fn new(method: RtspMethod, uri: impl Into<String>) -> Self {
        Self {
            method,
            uri: uri.into(),
            headers: HashMap::new(),
            body: None,
        }
    }

    pub fn header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.insert(key.into(), value.into());
        self
    }

    pub fn body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = Some(body.into());
        self
    }

    pub fn content_type_bplist(self) -> Self {
        self.header("Content-Type", "application/x-apple-binary-plist")
    }

    /// Serialize to wire format.
    ///
    /// Format:
    /// ```text
    /// METHOD URI RTSP/1.0\r\n
    /// CSeq: N\r\n
    /// Content-Length: M\r\n  (if body present)
    /// Header: Value\r\n
    /// ...
    /// \r\n
    /// [body]
    /// ```
    pub fn serialize(&self, cseq: u32) -> Vec<u8> {
        let mut out = Vec::new();

        // Request line - RTSP uses CRLF
        write!(&mut out, "{} {} RTSP/1.0\r\n", self.method.as_str(), self.uri).unwrap();

        // CSeq header (required)
        write!(&mut out, "CSeq: {}\r\n", cseq).unwrap();

        // Content-Length if body present
        if let Some(ref body) = self.body {
            write!(&mut out, "Content-Length: {}\r\n", body.len()).unwrap();
        }

        // Other headers (sorted for consistent output in tests)
        let mut sorted_headers: Vec<_> = self.headers.iter().collect();
        sorted_headers.sort_by(|a, b| a.0.cmp(b.0));

        for (key, value) in sorted_headers {
            write!(&mut out, "{}: {}\r\n", key, value).unwrap();
        }

        // Blank line ending headers
        out.extend_from_slice(b"\r\n");

        // Body if present
        if let Some(ref body) = self.body {
            out.extend_from_slice(body);
        }

        out
    }

    // Factory methods for common requests

    pub fn get_info() -> Self {
        Self::new(RtspMethod::Get, "/info")
            .content_type_bplist()
    }

    pub fn options() -> Self {
        Self::new(RtspMethod::Options, "*")
    }

    pub fn announce(uri: impl Into<String>, body: Vec<u8>) -> Self {
        Self::new(RtspMethod::Announce, uri)
            .header("Content-Type", "application/sdp")
            .body(body)
    }

    pub fn setup(uri: impl Into<String>, body: Vec<u8>) -> Self {
        Self::new(RtspMethod::Setup, uri)
            .content_type_bplist()
            .body(body)
    }

    pub fn record(uri: impl Into<String>) -> Self {
        Self::new(RtspMethod::Record, uri)
            .header("X-Apple-ProtocolVersion", "1")
    }

    pub fn teardown(uri: impl Into<String>) -> Self {
        Self::new(RtspMethod::Teardown, uri)
    }

    pub fn flush(uri: impl Into<String>) -> Self {
        Self::new(RtspMethod::Flush, uri)
    }

    pub fn flush_with_info(uri: impl Into<String>, seq: u16, rtptime: u32) -> Self {
        Self::new(RtspMethod::Flush, uri)
            .header("RTP-Info", format!("seq={};rtptime={}", seq, rtptime))
    }

    pub fn set_parameter(uri: impl Into<String>, body: Vec<u8>) -> Self {
        Self::new(RtspMethod::SetParameter, uri)
            .content_type_bplist()
            .body(body)
    }

    pub fn set_parameter_text(uri: impl Into<String>, body: Vec<u8>) -> Self {
        Self::new(RtspMethod::SetParameter, uri)
            .header("Content-Type", "text/parameters")
            .body(body)
    }

    pub fn setpeers(_session_id: &str, body: Vec<u8>) -> Self {
        Self::new(RtspMethod::SetPeers, "/peer-list-changed")
            .content_type_bplist()
            .body(body)
    }

    pub fn record_with_info(uri: impl Into<String>, seq: u16, rtptime: u32) -> Self {
        Self::new(RtspMethod::Record, uri)
            .header("X-Apple-ProtocolVersion", "1")
            .header("Range", "npt=0-")
            .header("RTP-Info", format!("seq={};rtptime={}", seq, rtptime))
    }

    /// Create a pair-setup request with the required headers for transient pairing.
    ///
    /// The `device_id` should be in MAC format (e.g., "AA:BB:CC:DD:EE:FF").
    /// `hkp` is the HomeKit Pairing version (typically 4 for transient pairing).
    pub fn pair_setup(body: Vec<u8>, device_id: &str, hkp: u8) -> Self {
        let dacp_id = device_id.replace(":", "");
        Self::new(RtspMethod::Post, "/pair-setup")
            .header("Content-Type", "application/octet-stream")
            .header("X-Apple-Device-ID", device_id)
            .header("X-Apple-HKP", hkp.to_string())
            .header("DACP-ID", dacp_id)
            .header("Active-Remote", "1234567890")
            .header("User-Agent", "AirPlay/745.83")
            .body(body)
    }

    pub fn pair_verify(body: Vec<u8>, hkp: u8) -> Self {
        Self::new(RtspMethod::Post, "/pair-verify")
            .header("Content-Type", "application/octet-stream")
            .header("X-Apple-HKP", hkp.to_string())
            .body(body)
    }

    /// Create a fruit pair-setup request (Apple TV pairing protocol).
    ///
    /// Uses binary plist content type. The body should be a binary plist dictionary.
    pub fn fruit_pair_setup(body: Vec<u8>) -> Self {
        Self::new(RtspMethod::Post, "/pair-setup")
            .header("Content-Type", "application/x-apple-binary-plist")
            .body(body)
    }

    /// Create a fruit pair-verify request (Apple TV pairing protocol).
    ///
    /// Uses raw binary format (no TLV8). M1 is 32-byte ECDH public key,
    /// M3 is 64-byte encrypted signature.
    pub fn fruit_pair_verify(body: Vec<u8>) -> Self {
        Self::new(RtspMethod::Post, "/pair-verify")
            .header("Content-Type", "application/octet-stream")
            .body(body)
    }

    pub fn fp_setup(body: Vec<u8>) -> Self {
        Self::new(RtspMethod::Post, "/fp-setup")
            .header("Content-Type", "application/octet-stream")
            .body(body)
    }

    /// Create a feedback request (keepalive/progress).
    ///
    /// AirPlay 2 receivers expect periodic feedback requests (~every 2 seconds).
    /// The response contains timing and buffer status from the receiver.
    pub fn feedback(uri: impl Into<String>) -> Self {
        Self::new(RtspMethod::Post, format!("{}/feedback", uri.into()))
            .content_type_bplist()
    }

    /// Create OPTIONS request with Apple-Challenge header (RAOP handshake).
    ///
    /// The challenge is a 16-byte random value, Base64-encoded (no padding).
    pub fn options_with_challenge(challenge: &str) -> Self {
        Self::new(RtspMethod::Options, "*")
            .header("Apple-Challenge", challenge)
    }

    /// Create RAOP-style SETUP request with Transport header.
    ///
    /// Unlike AirPlay 2 which uses binary plist for SETUP, RAOP uses a
    /// Transport header to negotiate UDP ports:
    /// `Transport: RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;control_port=N;timing_port=M`
    pub fn setup_raop(uri: impl Into<String>, transport_header: &str) -> Self {
        Self::new(RtspMethod::Setup, uri)
            .header("Transport", transport_header)
    }

}

impl RtspMethod {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Options => "OPTIONS",
            Self::Announce => "ANNOUNCE",
            Self::Setup => "SETUP",
            Self::Record => "RECORD",
            Self::Pause => "PAUSE",
            Self::Flush => "FLUSH",
            Self::Teardown => "TEARDOWN",
            Self::GetParameter => "GET_PARAMETER",
            Self::SetParameter => "SET_PARAMETER",
            Self::Post => "POST",
            Self::Get => "GET",
            Self::SetPeers => "SETPEERS",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod request_building {
        use super::*;

        #[test]
        fn new_creates_request_with_method_and_uri() {
            let req = RtspRequest::new(RtspMethod::Get, "/info");
            assert_eq!(req.method, RtspMethod::Get);
            assert_eq!(req.uri, "/info");
            assert!(req.headers.is_empty());
            assert!(req.body.is_none());
        }

        #[test]
        fn header_adds_header() {
            let req = RtspRequest::new(RtspMethod::Get, "/info")
                .header("X-Custom", "value");
            assert_eq!(req.headers.get("X-Custom"), Some(&"value".to_string()));
        }

        #[test]
        fn body_sets_body() {
            let body = vec![0x01, 0x02, 0x03];
            let req = RtspRequest::new(RtspMethod::Post, "/test")
                .body(body.clone());
            assert_eq!(req.body, Some(body));
        }

        #[test]
        fn content_type_bplist_sets_header() {
            let req = RtspRequest::new(RtspMethod::Get, "/info")
                .content_type_bplist();
            assert_eq!(
                req.headers.get("Content-Type"),
                Some(&"application/x-apple-binary-plist".to_string())
            );
        }
    }

    mod serialization {
        use super::*;

        #[test]
        fn serialize_includes_method_and_uri() {
            let req = RtspRequest::new(RtspMethod::Get, "/info");
            let data = req.serialize(1);
            let text = String::from_utf8_lossy(&data);
            assert!(text.starts_with("GET /info RTSP/1.0\r\n"));
        }

        #[test]
        fn serialize_includes_cseq() {
            let req = RtspRequest::new(RtspMethod::Get, "/info");
            let data = req.serialize(42);
            let text = String::from_utf8_lossy(&data);
            assert!(text.contains("CSeq: 42\r\n"));
        }

        #[test]
        fn serialize_includes_headers() {
            let req = RtspRequest::new(RtspMethod::Get, "/info")
                .header("X-Custom", "test-value");
            let data = req.serialize(1);
            let text = String::from_utf8_lossy(&data);
            assert!(text.contains("X-Custom: test-value\r\n"));
        }

        #[test]
        fn serialize_includes_content_length_for_body() {
            let body = vec![0x01, 0x02, 0x03, 0x04, 0x05];
            let req = RtspRequest::new(RtspMethod::Post, "/test")
                .body(body);
            let data = req.serialize(1);
            let text = String::from_utf8_lossy(&data);
            assert!(text.contains("Content-Length: 5\r\n"));
        }

        #[test]
        fn serialize_appends_body() {
            let body = vec![0xDE, 0xAD, 0xBE, 0xEF];
            let req = RtspRequest::new(RtspMethod::Post, "/test")
                .body(body.clone());
            let data = req.serialize(1);

            // Body should be after double CRLF
            let header_end = data.windows(4)
                .position(|w| w == b"\r\n\r\n")
                .expect("should have header terminator");

            let body_start = header_end + 4;
            assert_eq!(&data[body_start..], &body);
        }

        #[test]
        fn serialize_uses_crlf_line_endings() {
            let req = RtspRequest::new(RtspMethod::Get, "/info");
            let data = req.serialize(1);

            // Verify no bare LF (all \n should be preceded by \r)
            for (i, &byte) in data.iter().enumerate() {
                if byte == b'\n' {
                    assert!(i > 0 && data[i - 1] == b'\r', "bare LF at position {}", i);
                }
            }
        }

        #[test]
        fn serialize_ends_with_double_crlf_when_no_body() {
            let req = RtspRequest::new(RtspMethod::Get, "/info");
            let data = req.serialize(1);
            assert!(data.ends_with(b"\r\n\r\n"));
        }
    }

    mod factory_methods {
        use super::*;

        #[test]
        fn get_info_creates_correct_request() {
            let req = RtspRequest::get_info();
            assert_eq!(req.method, RtspMethod::Get);
            assert_eq!(req.uri, "/info");
            assert_eq!(
                req.headers.get("Content-Type"),
                Some(&"application/x-apple-binary-plist".to_string())
            );
        }

        #[test]
        fn setup_creates_correct_request() {
            let body = vec![0x01, 0x02];
            let req = RtspRequest::setup("rtsp://local/session-123", body.clone());
            assert_eq!(req.method, RtspMethod::Setup);
            assert_eq!(req.uri, "rtsp://local/session-123");
            assert_eq!(req.body, Some(body));
            assert_eq!(
                req.headers.get("Content-Type"),
                Some(&"application/x-apple-binary-plist".to_string())
            );
        }

        #[test]
        fn record_creates_correct_request() {
            let req = RtspRequest::record("rtsp://local/session-123");
            assert_eq!(req.method, RtspMethod::Record);
            assert_eq!(req.uri, "rtsp://local/session-123");
            assert!(req.body.is_none());
        }

        #[test]
        fn teardown_creates_correct_request() {
            let req = RtspRequest::teardown("rtsp://local/session-123");
            assert_eq!(req.method, RtspMethod::Teardown);
            assert_eq!(req.uri, "rtsp://local/session-123");
        }

        #[test]
        fn flush_creates_correct_request() {
            let req = RtspRequest::flush("rtsp://local/session-123");
            assert_eq!(req.method, RtspMethod::Flush);
            assert_eq!(req.uri, "rtsp://local/session-123");
        }

        #[test]
        fn setpeers_creates_correct_request() {
            let body = vec![0x01, 0x02];
            let req = RtspRequest::setpeers("session-123", body.clone());
            assert_eq!(req.method, RtspMethod::SetPeers);
            assert_eq!(req.uri, "/peer-list-changed");
            assert_eq!(req.body, Some(body));
            assert_eq!(
                req.headers.get("Content-Type"),
                Some(&"application/x-apple-binary-plist".to_string())
            );
        }
    }

    mod method_strings {
        use super::*;

        #[test]
        fn all_methods_have_correct_string() {
            assert_eq!(RtspMethod::Options.as_str(), "OPTIONS");
            assert_eq!(RtspMethod::Announce.as_str(), "ANNOUNCE");
            assert_eq!(RtspMethod::Setup.as_str(), "SETUP");
            assert_eq!(RtspMethod::Record.as_str(), "RECORD");
            assert_eq!(RtspMethod::Pause.as_str(), "PAUSE");
            assert_eq!(RtspMethod::Flush.as_str(), "FLUSH");
            assert_eq!(RtspMethod::Teardown.as_str(), "TEARDOWN");
            assert_eq!(RtspMethod::GetParameter.as_str(), "GET_PARAMETER");
            assert_eq!(RtspMethod::SetParameter.as_str(), "SET_PARAMETER");
            assert_eq!(RtspMethod::Post.as_str(), "POST");
            assert_eq!(RtspMethod::Get.as_str(), "GET");
            assert_eq!(RtspMethod::SetPeers.as_str(), "SETPEERS");
        }
    }
}
