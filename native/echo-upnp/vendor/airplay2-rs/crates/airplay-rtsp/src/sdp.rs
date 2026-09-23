//! SDP builder for RAOP (AirPlay 1) ANNOUNCE requests.
//!
//! Constructs an SDP body declaring ALAC codec parameters and encryption
//! keys for the receiver's audio pipeline configuration.

use airplay_core::error::Result;
use airplay_core::AudioFormat;
use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine;

/// Builder for RAOP ANNOUNCE SDP bodies.
pub struct SdpBuilder {
    /// Session ID (random u32)
    session_id: u32,
    /// Sender's local IP address
    local_ip: String,
    /// Receiver's IP address
    remote_ip: String,
    /// Audio format configuration
    audio_format: AudioFormat,
    /// Minimum latency in samples
    latency_min: u32,
    /// RSA-encrypted AES key (256 bytes), if encryption is used
    rsa_aes_key: Option<Vec<u8>>,
    /// AES IV (16 bytes), if encryption is used
    aes_iv: Option<[u8; 16]>,
}

impl SdpBuilder {
    /// Create a new SDP builder.
    pub fn new(
        session_id: u32,
        local_ip: String,
        remote_ip: String,
        audio_format: AudioFormat,
        latency_min: u32,
    ) -> Self {
        Self {
            session_id,
            local_ip,
            remote_ip,
            audio_format,
            latency_min,
            rsa_aes_key: None,
            aes_iv: None,
        }
    }

    /// Set RSA-encrypted AES key and IV for encrypted RAOP streams.
    ///
    /// The `rsa_aes_key` should be the 256-byte RSA-OAEP ciphertext of the
    /// 16-byte AES key. The `aes_iv` is the raw 16-byte initialization vector.
    pub fn with_encryption(mut self, rsa_aes_key: Vec<u8>, aes_iv: [u8; 16]) -> Self {
        self.rsa_aes_key = Some(rsa_aes_key);
        self.aes_iv = Some(aes_iv);
        self
    }

    /// Build the complete SDP body as bytes.
    pub fn build(&self) -> Result<Vec<u8>> {
        let af = &self.audio_format;
        let spf = af.frames_per_packet;
        let sr = af.sample_rate.as_hz();
        let bd = af.bit_depth;
        let ch = af.channels;

        // Standard ALAC encoder defaults (match iTunes / owntone)
        let hist_mult = 40;
        let init_quant = 10;
        let rice_limit = 14;
        let max_run = 255;
        let max_frame_bytes = 0; // 0 = no limit
        let avg_bitrate = 0; // 0 = VBR

        let mut sdp = format!(
            "v=0\r\n\
             o=iTunes {} 0 IN IP4 {}\r\n\
             s=iTunes\r\n\
             c=IN IP4 {}\r\n\
             t=0 0\r\n\
             m=audio 0 RTP/AVP 96\r\n\
             a=rtpmap:96 AppleLossless\r\n\
             a=fmtp:96 {} 0 {} {} {} {} {} {} {} {} {}\r\n",
            self.session_id,
            self.local_ip,
            self.remote_ip,
            spf,
            bd,
            hist_mult,
            init_quant,
            rice_limit,
            ch,
            max_run,
            max_frame_bytes,
            avg_bitrate,
            sr,
        );

        // Add encryption attributes if set
        if let (Some(ref rsa_key), Some(ref iv)) = (&self.rsa_aes_key, &self.aes_iv) {
            let key_b64 = STANDARD_NO_PAD.encode(rsa_key);
            let iv_b64 = STANDARD_NO_PAD.encode(iv);
            sdp.push_str(&format!("a=rsaaeskey:{}\r\n", key_b64));
            sdp.push_str(&format!("a=aesiv:{}\r\n", iv_b64));
        }

        sdp.push_str(&format!("a=min-latency:{}\r\n", self.latency_min));

        tracing::debug!("ANNOUNCE SDP:\n{}", sdp);
        Ok(sdp.into_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_audio_format() -> AudioFormat {
        AudioFormat::default()
    }

    #[test]
    fn build_basic_sdp_has_required_fields() {
        let sdp_bytes = SdpBuilder::new(
            12345,
            "192.168.1.10".to_string(),
            "192.168.1.20".to_string(),
            default_audio_format(),
            11025,
        )
        .build()
        .unwrap();

        let sdp = String::from_utf8(sdp_bytes).unwrap();
        assert!(sdp.contains("v=0\r\n"));
        assert!(sdp.contains("o=iTunes 12345 0 IN IP4 192.168.1.10\r\n"));
        assert!(sdp.contains("s=iTunes\r\n"));
        assert!(sdp.contains("c=IN IP4 192.168.1.20\r\n"));
        assert!(sdp.contains("m=audio 0 RTP/AVP 96\r\n"));
        assert!(sdp.contains("a=rtpmap:96 AppleLossless\r\n"));
        assert!(sdp.contains("a=fmtp:96 "));
        assert!(sdp.contains("a=min-latency:11025\r\n"));
    }

    #[test]
    fn build_sdp_without_encryption_has_no_key_attrs() {
        let sdp_bytes = SdpBuilder::new(
            1,
            "10.0.0.1".to_string(),
            "10.0.0.2".to_string(),
            default_audio_format(),
            11025,
        )
        .build()
        .unwrap();

        let sdp = String::from_utf8(sdp_bytes).unwrap();
        assert!(!sdp.contains("a=rsaaeskey:"));
        assert!(!sdp.contains("a=aesiv:"));
    }

    #[test]
    fn build_sdp_with_encryption_includes_key_and_iv() {
        let fake_rsa_key = vec![0xAA; 256];
        let fake_iv = [0xBB; 16];

        let sdp_bytes = SdpBuilder::new(
            1,
            "10.0.0.1".to_string(),
            "10.0.0.2".to_string(),
            default_audio_format(),
            11025,
        )
        .with_encryption(fake_rsa_key, fake_iv)
        .build()
        .unwrap();

        let sdp = String::from_utf8(sdp_bytes).unwrap();
        assert!(sdp.contains("a=rsaaeskey:"));
        assert!(sdp.contains("a=aesiv:"));

        // Verify Base64 NO_PAD encoding (no trailing '=')
        let key_line = sdp.lines().find(|l| l.starts_with("a=rsaaeskey:")).unwrap();
        let key_b64 = &key_line["a=rsaaeskey:".len()..];
        assert!(!key_b64.contains('='), "Base64 should use NO_PAD");
        // Decode should succeed
        let decoded = STANDARD_NO_PAD.decode(key_b64).unwrap();
        assert_eq!(decoded.len(), 256);

        let iv_line = sdp.lines().find(|l| l.starts_with("a=aesiv:")).unwrap();
        let iv_b64 = &iv_line["a=aesiv:".len()..];
        assert!(!iv_b64.contains('='), "Base64 should use NO_PAD");
        let decoded_iv = STANDARD_NO_PAD.decode(iv_b64).unwrap();
        assert_eq!(decoded_iv.len(), 16);
    }

    #[test]
    fn build_sdp_uses_crlf_line_endings() {
        let sdp_bytes = SdpBuilder::new(
            1,
            "10.0.0.1".to_string(),
            "10.0.0.2".to_string(),
            default_audio_format(),
            11025,
        )
        .build()
        .unwrap();

        let sdp = String::from_utf8(sdp_bytes).unwrap();
        // Every \n should be preceded by \r
        for (i, ch) in sdp.char_indices() {
            if ch == '\n' {
                assert!(i > 0 && sdp.as_bytes()[i - 1] == b'\r', "bare LF at position {}", i);
            }
        }
    }
}
