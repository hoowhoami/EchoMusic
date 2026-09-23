//! RTSP response parsing.

use std::collections::HashMap;
use airplay_core::error::{RtspError, Result};
use crate::plist_codec;

/// Parsed RTSP response.
#[derive(Debug, Clone)]
pub struct RtspResponse {
    pub status_code: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub body: Option<Vec<u8>>,
}

impl RtspResponse {
    /// Parse response from wire format.
    ///
    /// Format:
    /// ```text
    /// RTSP/1.0 200 OK\r\n
    /// CSeq: N\r\n
    /// Content-Length: M\r\n
    /// Header: Value\r\n
    /// ...
    /// \r\n
    /// [body]
    /// ```
    pub fn parse(data: &[u8]) -> Result<Self> {
        // Find header/body boundary (double CRLF)
        let header_end = data
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .ok_or_else(|| RtspError::InvalidResponse("missing header terminator".to_string()))?;

        let header_bytes = &data[..header_end];
        let body_start = header_end + 4;

        // Parse headers as UTF-8
        let header_str = std::str::from_utf8(header_bytes)
            .map_err(|_| RtspError::InvalidResponse("invalid UTF-8 in headers".to_string()))?;

        let mut lines = header_str.lines();

        // Parse status line: "RTSP/1.0 200 OK"
        let status_line = lines
            .next()
            .ok_or_else(|| RtspError::InvalidResponse("missing status line".to_string()))?;

        let (status_code, status_text) = parse_status_line(status_line)?;

        // Parse headers
        let mut headers = HashMap::new();
        for line in lines {
            if let Some((key, value)) = line.split_once(':') {
                headers.insert(key.trim().to_string(), value.trim().to_string());
            }
        }

        // Get Content-Length to determine body size
        let content_length = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("Content-Length"))
            .and_then(|(_, v)| v.parse::<usize>().ok())
            .unwrap_or(0);

        // Extract body
        let body = if content_length > 0 && data.len() >= body_start + content_length {
            Some(data[body_start..body_start + content_length].to_vec())
        } else if content_length > 0 {
            return Err(RtspError::InvalidResponse(format!(
                "body too short: expected {} bytes, got {}",
                content_length,
                data.len() - body_start
            ))
            .into());
        } else {
            None
        };

        Ok(Self {
            status_code,
            status_text,
            headers,
            body,
        })
    }

    /// Check if response indicates success (2xx).
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status_code)
    }

    /// Get header value (case-insensitive).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// Get CSeq from response.
    pub fn cseq(&self) -> Option<u32> {
        self.header("CSeq").and_then(|v| v.parse().ok())
    }

    /// Get Content-Length.
    pub fn content_length(&self) -> Option<usize> {
        self.header("Content-Length").and_then(|v| v.parse().ok())
    }

    /// Parse body as binary plist.
    pub fn body_as_plist<T: serde::de::DeserializeOwned>(&self) -> Result<T> {
        let body = self
            .body
            .as_ref()
            .ok_or_else(|| RtspError::InvalidResponse("no body to parse".to_string()))?;

        plist_codec::decode(body)
    }

    /// Ensure success, returning error if not.
    pub fn ensure_success(&self) -> Result<()> {
        if self.is_success() {
            Ok(())
        } else {
            Err(RtspError::UnexpectedStatus(self.status_code).into())
        }
    }
}

/// Parse status line: "RTSP/1.0 200 OK"
fn parse_status_line(line: &str) -> Result<(u16, String)> {
    let parts: Vec<&str> = line.splitn(3, ' ').collect();

    if parts.len() < 2 {
        return Err(RtspError::InvalidResponse(format!("malformed status line: {}", line)).into());
    }

    // Verify RTSP version
    if !parts[0].starts_with("RTSP/") {
        return Err(
            RtspError::InvalidResponse(format!("not an RTSP response: {}", parts[0])).into(),
        );
    }

    // Parse status code
    let code = parts[1]
        .parse()
        .map_err(|_| RtspError::InvalidResponse(format!("invalid status code: {}", parts[1])))?;

    // Status text is optional
    let text = parts.get(2).unwrap_or(&"").to_string();

    Ok((code, text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    mod parsing {
        use super::*;

        #[test]
        fn parse_simple_response() {
            let data = b"RTSP/1.0 200 OK\r\n\r\n";
            let response = RtspResponse::parse(data).unwrap();
            assert_eq!(response.status_code, 200);
            assert_eq!(response.status_text, "OK");
            assert!(response.body.is_none());
        }

        #[test]
        fn parse_response_with_headers() {
            let data = b"RTSP/1.0 200 OK\r\nCSeq: 42\r\nServer: AirPlay\r\n\r\n";
            let response = RtspResponse::parse(data).unwrap();
            assert_eq!(response.status_code, 200);
            assert_eq!(response.header("CSeq"), Some("42"));
            assert_eq!(response.header("Server"), Some("AirPlay"));
        }

        #[test]
        fn parse_response_with_body() {
            let body = b"Hello, World!";
            let header = format!(
                "RTSP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            let mut data = header.into_bytes();
            data.extend_from_slice(body);

            let response = RtspResponse::parse(&data).unwrap();
            assert_eq!(response.status_code, 200);
            assert_eq!(response.body, Some(body.to_vec()));
        }

        #[test]
        fn parse_error_on_malformed_status_line() {
            let data = b"INVALID\r\n\r\n";
            let result = RtspResponse::parse(data);
            assert!(result.is_err());
        }

        #[test]
        fn parse_error_on_truncated_body() {
            let data = b"RTSP/1.0 200 OK\r\nContent-Length: 100\r\n\r\nshort";
            let result = RtspResponse::parse(data);
            assert!(result.is_err());
        }

        #[test]
        fn parse_handles_no_status_text() {
            let data = b"RTSP/1.0 200\r\n\r\n";
            let response = RtspResponse::parse(data).unwrap();
            assert_eq!(response.status_code, 200);
            assert_eq!(response.status_text, "");
        }

        #[test]
        fn parse_missing_header_terminator() {
            let data = b"RTSP/1.0 200 OK\r\nCSeq: 1";
            let result = RtspResponse::parse(data);
            assert!(result.is_err());
        }
    }

    mod status_checking {
        use super::*;

        fn make_response(status_code: u16) -> RtspResponse {
            RtspResponse {
                status_code,
                status_text: "".to_string(),
                headers: HashMap::new(),
                body: None,
            }
        }

        #[test]
        fn is_success_for_200() {
            assert!(make_response(200).is_success());
        }

        #[test]
        fn is_success_for_201() {
            assert!(make_response(201).is_success());
        }

        #[test]
        fn is_success_for_299() {
            assert!(make_response(299).is_success());
        }

        #[test]
        fn not_success_for_199() {
            assert!(!make_response(199).is_success());
        }

        #[test]
        fn not_success_for_300() {
            assert!(!make_response(300).is_success());
        }

        #[test]
        fn not_success_for_400() {
            assert!(!make_response(400).is_success());
        }

        #[test]
        fn not_success_for_500() {
            assert!(!make_response(500).is_success());
        }

        #[test]
        fn ensure_success_ok_for_200() {
            assert!(make_response(200).ensure_success().is_ok());
        }

        #[test]
        fn ensure_success_error_for_400() {
            let result = make_response(400).ensure_success();
            assert!(result.is_err());
        }
    }

    mod header_access {
        use super::*;

        fn make_response_with_headers() -> RtspResponse {
            let mut headers = HashMap::new();
            headers.insert("CSeq".to_string(), "42".to_string());
            headers.insert("Content-Length".to_string(), "100".to_string());
            headers.insert("X-Custom".to_string(), "value".to_string());

            RtspResponse {
                status_code: 200,
                status_text: "OK".to_string(),
                headers,
                body: None,
            }
        }

        #[test]
        fn header_is_case_insensitive() {
            let response = make_response_with_headers();
            assert_eq!(response.header("cseq"), Some("42"));
            assert_eq!(response.header("CSEQ"), Some("42"));
            assert_eq!(response.header("CSeq"), Some("42"));
        }

        #[test]
        fn header_returns_none_for_missing() {
            let response = make_response_with_headers();
            assert_eq!(response.header("NonExistent"), None);
        }

        #[test]
        fn cseq_parses_numeric() {
            let response = make_response_with_headers();
            assert_eq!(response.cseq(), Some(42));
        }

        #[test]
        fn content_length_parses_numeric() {
            let response = make_response_with_headers();
            assert_eq!(response.content_length(), Some(100));
        }

        #[test]
        fn cseq_returns_none_for_missing() {
            let response = RtspResponse {
                status_code: 200,
                status_text: "OK".to_string(),
                headers: HashMap::new(),
                body: None,
            };
            assert_eq!(response.cseq(), None);
        }
    }

    mod plist_parsing {
        use super::*;
        use serde::Serialize;

        #[derive(Debug, Serialize, Deserialize, PartialEq)]
        struct TestPlist {
            name: String,
            value: u32,
        }

        #[test]
        fn body_as_plist_parses_valid_plist() {
            // Create a binary plist
            let plist_data = plist_codec::encode(&TestPlist {
                name: "test".to_string(),
                value: 42,
            })
            .unwrap();

            let response = RtspResponse {
                status_code: 200,
                status_text: "OK".to_string(),
                headers: HashMap::new(),
                body: Some(plist_data),
            };

            let parsed: TestPlist = response.body_as_plist().unwrap();
            assert_eq!(parsed.name, "test");
            assert_eq!(parsed.value, 42);
        }

        #[test]
        fn body_as_plist_error_on_missing_body() {
            let response = RtspResponse {
                status_code: 200,
                status_text: "OK".to_string(),
                headers: HashMap::new(),
                body: None,
            };

            let result: Result<TestPlist> = response.body_as_plist();
            assert!(result.is_err());
        }

        #[test]
        fn body_as_plist_error_on_invalid_plist() {
            let response = RtspResponse {
                status_code: 200,
                status_text: "OK".to_string(),
                headers: HashMap::new(),
                body: Some(b"not a valid plist".to_vec()),
            };

            let result: Result<TestPlist> = response.body_as_plist();
            assert!(result.is_err());
        }
    }
}
