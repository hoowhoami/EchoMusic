//! RTSP connection management.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use airplay_core::error::{Error as CoreError, Result, RtspError};
use airplay_crypto::chacha::ControlCipher;
use async_trait::async_trait;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::timeout;

use crate::traits::RtspTransport;
use crate::{RtspRequest, RtspResponse};

/// RTSP connection to an AirPlay receiver.
pub struct RtspConnection {
    addr: SocketAddr,
    cseq: u32,
    cipher: Option<ControlCipher>,
    stream: Option<TcpStream>,
    /// Session headers added to all requests
    session_headers: HashMap<String, String>,
}

impl RtspConnection {
    /// Create new connection (not yet connected).
    pub fn new(addr: SocketAddr) -> Self {
        Self {
            addr,
            cseq: 0,
            cipher: None,
            stream: None,
            session_headers: HashMap::new(),
        }
    }

    /// Connect to the receiver.
    pub async fn connect(&mut self) -> Result<()> {
        let stream = TcpStream::connect(self.addr)
            .await
            .map_err(|_| RtspError::ConnectionRefused)?;
        self.stream = Some(stream);
        Ok(())
    }

    /// Get local socket address if connected.
    pub fn local_addr(&self) -> Option<SocketAddr> {
        self.stream.as_ref().and_then(|s| s.local_addr().ok())
    }

    /// Set encryption cipher after pairing.
    pub fn set_cipher(&mut self, cipher: ControlCipher) {
        self.cipher = Some(cipher);
    }

    /// Clear the encryption cipher.
    pub fn clear_cipher(&mut self) {
        self.cipher = None;
    }

    /// Check if encryption is enabled.
    pub fn has_cipher(&self) -> bool {
        self.cipher.is_some()
    }

    /// Add a session header (added to all requests).
    pub fn add_session_header(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.session_headers.insert(key.into(), value.into());
    }

    /// Clear session headers.
    pub fn clear_session_headers(&mut self) {
        self.session_headers.clear();
    }

    /// Send request and receive response.
    pub async fn send(&mut self, mut request: RtspRequest) -> Result<RtspResponse> {
        if self.stream.is_none() {
            return Err(RtspError::ConnectionRefused.into());
        }

        // Add session headers
        for (key, value) in &self.session_headers {
            request = request.header(key.clone(), value.clone());
        }

        // Get next CSeq
        let cseq = self.next_cseq();

        // Serialize request
        let request_data = request.serialize(cseq);
        tracing::debug!(
            "RTSP -> {} {} (cseq={}, encrypted={}, body_len={})",
            request.method.as_str(),
            request.uri,
            cseq,
            self.cipher.is_some(),
            request.body.as_ref().map(|b| b.len()).unwrap_or(0)
        );

        // Log the full plaintext request for debugging SETUP/RECORD issues
        if request.method == crate::request::RtspMethod::Setup
            || request.method == crate::request::RtspMethod::Record {
            let request_str = String::from_utf8_lossy(&request_data);
            // Find the header/body boundary
            if let Some(boundary) = request_str.find("\r\n\r\n") {
                let headers = &request_str[..boundary];
                tracing::debug!("{} request headers:\n{}", request.method.as_str(), headers);
            }
        }

        // Encrypt if cipher is set
        let wire_data = if let Some(ref mut cipher) = self.cipher {
            let encrypted = cipher.encrypt(&request_data)?;
            tracing::debug!(
                plaintext_len = request_data.len(),
                encrypted_len = encrypted.len(),
                "Encrypted RTSP request"
            );
            encrypted
        } else {
            request_data
        };

        // Send request
        tracing::debug!(wire_len = wire_data.len(), "Sending wire data");
        let stream = self.stream.as_mut().unwrap();
        stream.write_all(&wire_data).await?;
        stream.flush().await?;
        tracing::debug!("Wire data sent and flushed");

        // Read response
        let response_data = if self.cipher.is_some() {
            timeout(std::time::Duration::from_secs(10), self.read_encrypted_response())
                .await
                .map_err(|_| CoreError::Timeout)??
        } else {
            timeout(std::time::Duration::from_secs(10), self.read_plaintext_response())
                .await
                .map_err(|_| CoreError::Timeout)??
        };

        // Parse response
        let response = RtspResponse::parse(&response_data)?;
        tracing::debug!(
            "RTSP <- {} {} (cseq={:?})",
            response.status_code,
            response.status_text,
            response.cseq()
        );

        // Verify CSeq matches (warning only, don't fail)
        if response.cseq() != Some(cseq) {
            tracing::warn!(
                "CSeq mismatch: expected {}, got {:?}",
                cseq,
                response.cseq()
            );
        }

        Ok(response)
    }

    /// Read a plaintext RTSP response from the stream.
    async fn read_plaintext_response(&mut self) -> Result<Vec<u8>> {
        let stream = self.stream.as_mut().unwrap();
        let mut reader = BufReader::new(stream);
        let mut response_data = Vec::new();

        // Read headers until we see \r\n\r\n
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).await?;
            response_data.extend_from_slice(line.as_bytes());

            if line == "\r\n" {
                break;
            }
        }

        // Parse Content-Length from headers
        let header_str = String::from_utf8_lossy(&response_data);
        let content_length = header_str
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                if key.trim().eq_ignore_ascii_case("Content-Length") {
                    value.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);

        // Read body if present
        if content_length > 0 {
            let mut body = vec![0u8; content_length];
            reader.read_exact(&mut body).await?;
            response_data.extend_from_slice(&body);
        }

        Ok(response_data)
    }

    /// Read and decrypt an RTSP response using HomeKit framing.
    async fn read_encrypted_response(&mut self) -> Result<Vec<u8>> {
        let stream = self.stream.as_mut().unwrap();
        let mut response_data = Vec::new();

        tracing::debug!("Waiting for encrypted response...");

        loop {
            let mut len_buf = [0u8; 2];
            tracing::debug!("Reading 2-byte length prefix...");
            stream.read_exact(&mut len_buf).await?;
            let block_len = u16::from_le_bytes(len_buf);
            tracing::debug!("Received block length: {}", block_len);

            let mut cipher_block = vec![0u8; block_len as usize + 16];
            stream.read_exact(&mut cipher_block).await?;

            let plain_block = self
                .cipher
                .as_mut()
                .ok_or_else(|| RtspError::InvalidResponse("Missing cipher".to_string()))?
                .decrypt_block(&cipher_block, block_len)
                .map_err(CoreError::from)?;

            response_data.extend_from_slice(&plain_block);

            if let Some(end) = response_data
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
            {
                let header_str = String::from_utf8_lossy(&response_data[..end]);
                let content_length = header_str
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        if key.trim().eq_ignore_ascii_case("Content-Length") {
                            value.trim().parse::<usize>().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
                let total_len = end + 4 + content_length;
                if response_data.len() >= total_len {
                    response_data.truncate(total_len);
                    return Ok(response_data);
                }
            }
        }
    }

    /// Get next CSeq number.
    pub fn next_cseq(&mut self) -> u32 {
        self.cseq += 1;
        self.cseq
    }

    /// Get current CSeq (last used).
    pub fn current_cseq(&self) -> u32 {
        self.cseq
    }

    /// Close the connection.
    pub async fn close(&mut self) -> Result<()> {
        if let Some(stream) = self.stream.take() {
            drop(stream);
        }
        Ok(())
    }

    /// Check if connected.
    pub fn is_connected(&self) -> bool {
        self.stream.is_some()
    }

    /// Get the remote address.
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }
}

#[async_trait]
impl RtspTransport for RtspConnection {
    async fn send(&mut self, request: RtspRequest) -> Result<RtspResponse> {
        self.send(request).await
    }

    fn is_connected(&self) -> bool {
        self.is_connected()
    }

    async fn close(&mut self) -> Result<()> {
        self.close().await
    }
}

/// Thread-safe RTSP connection wrapper.
pub struct SharedRtspConnection {
    inner: Arc<Mutex<RtspConnection>>,
}

impl SharedRtspConnection {
    pub fn new(conn: RtspConnection) -> Self {
        Self {
            inner: Arc::new(Mutex::new(conn)),
        }
    }

    pub async fn send(&self, request: RtspRequest) -> Result<RtspResponse> {
        let mut conn = self.inner.lock().await;
        conn.send(request).await
    }

    pub async fn close(&self) -> Result<()> {
        let mut conn = self.inner.lock().await;
        conn.close().await
    }

    pub async fn is_connected(&self) -> bool {
        let conn = self.inner.lock().await;
        conn.is_connected()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    fn test_addr() -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 7000)
    }

    mod connection_lifecycle {
        use super::*;

        #[test]
        fn new_is_not_connected() {
            let conn = RtspConnection::new(test_addr());
            assert!(!conn.is_connected());
        }

        #[tokio::test]
        async fn connect_fails_on_refused() {
            // Port 1 should refuse connections
            let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 1);
            let mut conn = RtspConnection::new(addr);
            let result = conn.connect().await;
            assert!(result.is_err());
        }

        #[tokio::test]
        async fn close_disconnects() {
            let mut conn = RtspConnection::new(test_addr());
            // Even if not connected, close should succeed
            let result = conn.close().await;
            assert!(result.is_ok());
            assert!(!conn.is_connected());
        }

        #[test]
        fn addr_returns_configured_address() {
            let addr = test_addr();
            let conn = RtspConnection::new(addr);
            assert_eq!(conn.addr(), addr);
        }
    }

    mod cseq_management {
        use super::*;

        #[test]
        fn cseq_starts_at_zero() {
            let conn = RtspConnection::new(test_addr());
            assert_eq!(conn.current_cseq(), 0);
        }

        #[test]
        fn next_cseq_increments() {
            let mut conn = RtspConnection::new(test_addr());
            assert_eq!(conn.next_cseq(), 1);
            assert_eq!(conn.next_cseq(), 2);
            assert_eq!(conn.next_cseq(), 3);
        }

        #[test]
        fn cseq_monotonically_increases() {
            let mut conn = RtspConnection::new(test_addr());
            let mut prev = 0;
            for _ in 0..100 {
                let current = conn.next_cseq();
                assert!(current > prev);
                prev = current;
            }
        }

        #[test]
        fn current_cseq_tracks_last_used() {
            let mut conn = RtspConnection::new(test_addr());
            conn.next_cseq();
            conn.next_cseq();
            conn.next_cseq();
            assert_eq!(conn.current_cseq(), 3);
        }
    }

    mod encryption {
        use super::*;

        #[test]
        fn starts_without_cipher() {
            let conn = RtspConnection::new(test_addr());
            assert!(!conn.has_cipher());
        }

        #[test]
        fn set_cipher_enables_encryption() {
            let mut conn = RtspConnection::new(test_addr());
            let cipher = ControlCipher::new_unidirectional([0u8; 32]);
            conn.set_cipher(cipher);
            assert!(conn.has_cipher());
        }

        #[test]
        fn clear_cipher_disables_encryption() {
            let mut conn = RtspConnection::new(test_addr());
            let cipher = ControlCipher::new_unidirectional([0u8; 32]);
            conn.set_cipher(cipher);
            assert!(conn.has_cipher());

            conn.clear_cipher();
            assert!(!conn.has_cipher());
        }
    }

    mod session_headers {
        use super::*;

        #[test]
        fn add_session_header() {
            let mut conn = RtspConnection::new(test_addr());
            conn.add_session_header("X-Apple-Device-ID", "0xAABBCCDDEEFF");
            assert_eq!(conn.session_headers.get("X-Apple-Device-ID"), Some(&"0xAABBCCDDEEFF".to_string()));
        }

        #[test]
        fn clear_session_headers() {
            let mut conn = RtspConnection::new(test_addr());
            conn.add_session_header("Header1", "Value1");
            conn.add_session_header("Header2", "Value2");
            assert_eq!(conn.session_headers.len(), 2);

            conn.clear_session_headers();
            assert!(conn.session_headers.is_empty());
        }
    }

    mod shared_connection {
        use super::*;

        #[tokio::test]
        async fn shared_connection_is_not_connected_initially() {
            let conn = RtspConnection::new(test_addr());
            let shared = SharedRtspConnection::new(conn);
            assert!(!shared.is_connected().await);
        }

        #[tokio::test]
        async fn shared_connection_close_works() {
            let conn = RtspConnection::new(test_addr());
            let shared = SharedRtspConnection::new(conn);
            let result = shared.close().await;
            assert!(result.is_ok());
        }
    }
}
