//! Digest authentication (RFC 2617) for password-protected RAOP receivers.
//!
//! Some AirPlay 1 receivers require HTTP Digest authentication.
//! The scheme uses MD5:
//!   HA1 = MD5(username:realm:password)
//!   HA2 = MD5(method:uri)
//!   response = MD5(HA1:nonce:HA2)

use md5::{Digest, Md5};

/// Compute a Digest Authentication `Authorization` header value per RFC 2617.
///
/// `www_authenticate` is the value of the `WWW-Authenticate` header from the 401 response.
/// Returns a complete `Digest ...` string suitable for the `Authorization` header.
pub fn compute_digest_response(
    username: &str,
    password: &str,
    method: &str,
    uri: &str,
    www_authenticate: &str,
) -> Option<String> {
    let realm = extract_field(www_authenticate, "realm")?;
    let nonce = extract_field(www_authenticate, "nonce")?;

    let ha1 = md5_hex(&format!("{}:{}:{}", username, realm, password));
    let ha2 = md5_hex(&format!("{}:{}", method, uri));
    let response = md5_hex(&format!("{}:{}:{}", ha1, nonce, ha2));

    Some(format!(
        "Digest username=\"{}\", realm=\"{}\", nonce=\"{}\", uri=\"{}\", response=\"{}\"",
        username, realm, nonce, uri, response
    ))
}

/// Extract a quoted field value from a Digest challenge header.
///
/// Looks for `field="value"` in the header string.
fn extract_field<'a>(header: &'a str, field: &str) -> Option<&'a str> {
    let pattern = format!("{}=\"", field);
    let start = header.find(&pattern)? + pattern.len();
    let rest = &header[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

/// Compute MD5 hex digest of the given input.
fn md5_hex(input: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(input.as_bytes());
    let result = hasher.finalize();
    // Format as lowercase hex
    result.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_hex_produces_correct_output() {
        // MD5("") = d41d8cd98f00b204e9800998ecf8427e
        assert_eq!(md5_hex(""), "d41d8cd98f00b204e9800998ecf8427e");
        // MD5("abc") = 900150983cd24fb0d6963f7d28e17f72
        assert_eq!(md5_hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn extract_field_parses_quoted_value() {
        let header = r#"Digest realm="AirPlay", nonce="abc123""#;
        assert_eq!(extract_field(header, "realm"), Some("AirPlay"));
        assert_eq!(extract_field(header, "nonce"), Some("abc123"));
    }

    #[test]
    fn extract_field_returns_none_for_missing() {
        let header = r#"Digest realm="AirPlay""#;
        assert_eq!(extract_field(header, "nonce"), None);
    }

    #[test]
    fn compute_digest_response_rfc2617_test_vector() {
        // RFC 2617 Section 3.5 example (simplified, without qop)
        let www_auth = r#"Digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093""#;
        let result = compute_digest_response(
            "Mufasa",
            "Circle Of Life",
            "GET",
            "/dir/index.html",
            www_auth,
        );

        assert!(result.is_some());
        let auth = result.unwrap();
        assert!(auth.starts_with("Digest "));
        assert!(auth.contains("username=\"Mufasa\""));
        assert!(auth.contains("realm=\"testrealm@host.com\""));
        assert!(auth.contains("nonce=\"dcd98b7102dd2f0e8b11d0f600bfb0c093\""));
        assert!(auth.contains("uri=\"/dir/index.html\""));
        assert!(auth.contains("response=\""));

        // Verify via manual computation:
        // HA1 = MD5("Mufasa:testrealm@host.com:Circle Of Life")
        let ha1 = md5_hex("Mufasa:testrealm@host.com:Circle Of Life");
        // HA2 = MD5("GET:/dir/index.html")
        let ha2 = md5_hex("GET:/dir/index.html");
        // response = MD5(HA1:nonce:HA2)
        let expected = md5_hex(&format!(
            "{}:dcd98b7102dd2f0e8b11d0f600bfb0c093:{}",
            ha1, ha2
        ));
        assert!(
            auth.contains(&format!("response=\"{}\"", expected)),
            "Response mismatch. Got: {}\nExpected response: {}",
            auth,
            expected
        );
    }

    #[test]
    fn compute_digest_response_returns_none_for_bad_header() {
        let result = compute_digest_response("user", "pass", "GET", "/", "Basic realm=\"test\"");
        // Missing nonce field
        assert!(result.is_none());
    }
}
