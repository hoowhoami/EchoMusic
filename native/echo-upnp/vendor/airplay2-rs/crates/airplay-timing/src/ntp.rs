//! NTP-like timing for AirPlay 1 devices.
//!
//! Uses RTP packet types 82 (request) and 83 (response).

use airplay_core::error::{Error, Result};
use async_trait::async_trait;
use std::net::{SocketAddr, UdpSocket};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::UdpSocket as TokioUdpSocket;
use tokio::sync::watch;
use crate::{Clock, ClockOffset, TimingProtocol, ntp_to_unix};

/// RTP payload type for timing request.
pub const TIMING_REQUEST_PT: u8 = 82;

/// RTP payload type for timing response.
pub const TIMING_RESPONSE_PT: u8 = 83;

/// NTP timing request packet (32 bytes total).
///
/// Format (per AirPlay spec / owntone / shairport-sync):
/// - Bytes 0-1: RTP header (0x80, 0xD2 = V2, PT=82 with marker)
/// - Bytes 2-3: Sequence number (big-endian)
/// - Bytes 4-7: Padding (zeros)
/// - Bytes 8-15: Origin timestamp (stale/zero in request)
/// - Bytes 16-23: Receive timestamp (zero in request)
/// - Bytes 24-31: Transmit timestamp = T1 (requester's send time)
#[derive(Debug, Clone, Copy)]
pub struct NtpRequest {
    /// Sequence number.
    pub sequence: u16,
    /// Reference timestamp (our send time as NTP).
    pub reference_time: u64,
}

impl NtpRequest {
    /// Create new request with current time.
    pub fn new(clock: &Clock) -> Self {
        Self {
            sequence: 0,
            reference_time: clock.now_ntp(),
        }
    }

    /// Create with specific sequence number.
    pub fn with_sequence(mut self, seq: u16) -> Self {
        self.sequence = seq;
        self
    }

    /// Serialize to 32 bytes.
    pub fn serialize(&self) -> [u8; 32] {
        let mut buf = [0u8; 32];

        // RTP header (8 bytes for timing)
        buf[0] = 0x80; // V=2, P=0, X=0, CC=0
        buf[1] = TIMING_REQUEST_PT | 0x80; // PT=82 with marker bit
        buf[2..4].copy_from_slice(&self.sequence.to_be_bytes());
        // Bytes 4-7: zeros (timestamp field, unused)

        // Timing payload (standard NTP field layout)
        // Bytes 8-15: origin (stale/zero in request)
        // Bytes 16-23: receive (zero in request)
        // Bytes 24-31: transmit = T1 (our send time)
        buf[24..32].copy_from_slice(&self.reference_time.to_be_bytes());

        buf
    }

    /// Parse from bytes.
    pub fn parse(data: &[u8]) -> Result<Self> {
        if data.len() < 32 {
            return Err(Error::Parse(
                airplay_core::error::ParseError::InvalidFormat(
                    "NTP request too short".into()
                )
            ));
        }

        // Verify RTP header
        let pt = data[1] & 0x7F;
        if pt != TIMING_REQUEST_PT {
            return Err(Error::Parse(
                airplay_core::error::ParseError::InvalidFormat(
                    format!("Expected PT={}, got {}", TIMING_REQUEST_PT, pt)
                )
            ));
        }

        let sequence = u16::from_be_bytes([data[2], data[3]]);
        // Transmit timestamp (T1) is at bytes 24-31 per standard NTP layout
        let reference_time = u64::from_be_bytes(data[24..32].try_into().unwrap());

        Ok(Self {
            sequence,
            reference_time,
        })
    }
}

impl Default for NtpRequest {
    fn default() -> Self {
        Self {
            sequence: 0,
            reference_time: 0,
        }
    }
}

/// NTP timing response packet (32 bytes total).
///
/// Format:
/// - Bytes 0-1: RTP header (0x80, 0xD3 = V2, PT=83 with marker)
/// - Bytes 2-3: Sequence number
/// - Bytes 4-7: Padding
/// - Bytes 8-15: Reference time (echoed from request)
/// - Bytes 16-23: Receive time (when receiver got our request)
/// - Bytes 24-31: Send time (when receiver sent response)
#[derive(Debug, Clone, Copy)]
pub struct NtpResponse {
    /// Sequence number.
    pub sequence: u16,
    /// Reference time (echoed from our request).
    pub reference_time: u64,
    /// Receive time (when receiver got our request).
    pub receive_time: u64,
    /// Send time (when receiver sent response).
    pub send_time: u64,
}

impl NtpResponse {
    /// Create response from incoming request.
    pub fn from_request(request: &NtpRequest, receive_time: u64, send_time: u64) -> Self {
        Self {
            sequence: request.sequence,
            reference_time: request.reference_time, // Echo back sender's transmit time
            receive_time,
            send_time,
        }
    }

    /// Serialize to 32-byte NTP response packet.
    pub fn serialize(&self) -> [u8; 32] {
        let mut buf = [0u8; 32];
        buf[0] = 0x80; // V=2
        buf[1] = TIMING_RESPONSE_PT | 0x80; // PT=83 with marker
        buf[2..4].copy_from_slice(&self.sequence.to_be_bytes());
        // Bytes 4-7: zeros
        buf[8..16].copy_from_slice(&self.reference_time.to_be_bytes());
        buf[16..24].copy_from_slice(&self.receive_time.to_be_bytes());
        buf[24..32].copy_from_slice(&self.send_time.to_be_bytes());
        buf
    }

    /// Parse from bytes.
    pub fn parse(data: &[u8]) -> Result<Self> {
        if data.len() < 32 {
            return Err(Error::Parse(
                airplay_core::error::ParseError::InvalidFormat(
                    "NTP response too short".into()
                )
            ));
        }

        // Verify RTP header
        let pt = data[1] & 0x7F;
        if pt != TIMING_RESPONSE_PT {
            return Err(Error::Parse(
                airplay_core::error::ParseError::InvalidFormat(
                    format!("Expected PT={}, got {}", TIMING_RESPONSE_PT, pt)
                )
            ));
        }

        let sequence = u16::from_be_bytes([data[2], data[3]]);
        let reference_time = u64::from_be_bytes(data[8..16].try_into().unwrap());
        let receive_time = u64::from_be_bytes(data[16..24].try_into().unwrap());
        let send_time = u64::from_be_bytes(data[24..32].try_into().unwrap());

        Ok(Self {
            sequence,
            reference_time,
            receive_time,
            send_time,
        })
    }

    /// Calculate round-trip time in nanoseconds.
    ///
    /// RTT = (t4 - t1) - (t3 - t2)
    /// where:
    /// - t1 = reference_time (our send time)
    /// - t2 = receive_time (their receive time)
    /// - t3 = send_time (their send time)
    /// - t4 = local_recv_time (our receive time)
    pub fn round_trip_time(&self, local_recv_time: u64) -> i64 {
        let t1 = ntp_to_unix(self.reference_time) as i64;
        let t2 = ntp_to_unix(self.receive_time) as i64;
        let t3 = ntp_to_unix(self.send_time) as i64;
        let t4 = ntp_to_unix(local_recv_time) as i64;

        (t4 - t1) - (t3 - t2)
    }

    /// Calculate clock offset in nanoseconds.
    ///
    /// Offset = ((t2 - t1) + (t3 - t4)) / 2
    /// Positive offset means remote is ahead.
    pub fn clock_offset(&self, local_recv_time: u64) -> i64 {
        let t1 = ntp_to_unix(self.reference_time) as i64;
        let t2 = ntp_to_unix(self.receive_time) as i64;
        let t3 = ntp_to_unix(self.send_time) as i64;
        let t4 = ntp_to_unix(local_recv_time) as i64;

        ((t2 - t1) + (t3 - t4)) / 2
    }
}

/// NTP timing client for AirPlay 1.
pub struct NtpTimingClient {
    remote_addr: SocketAddr,
    socket: Option<UdpSocket>,
    clock: Clock,
    sequence: u16,
    offset: ClockOffset,
    synchronized: bool,
}

impl NtpTimingClient {
    /// Create new client.
    pub fn new(remote_addr: SocketAddr, sample_rate: u32) -> Self {
        Self {
            remote_addr,
            socket: None,
            clock: Clock::new(sample_rate),
            sequence: 0,
            offset: ClockOffset::default(),
            synchronized: false,
        }
    }

    /// Bind to local port (0 = auto-assign).
    pub fn bind(&mut self, local_port: u16) -> Result<u16> {
        let socket = UdpSocket::bind(("0.0.0.0", local_port))?;
        socket.set_read_timeout(Some(Duration::from_secs(1)))?;
        let port = socket.local_addr()?.port();
        self.socket = Some(socket);
        Ok(port)
    }

    /// Get local port.
    pub fn local_port(&self) -> Option<u16> {
        self.socket.as_ref().and_then(|s| s.local_addr().ok().map(|a| a.port()))
    }

    /// Get clock offset in nanoseconds.
    pub fn offset_ns(&self) -> i64 {
        self.offset.offset_ns
    }

    /// Get last round-trip time in nanoseconds.
    pub fn rtt_ns(&self) -> u64 {
        self.offset.rtt_ns
    }
}

#[async_trait]
impl TimingProtocol for NtpTimingClient {
    async fn start(&mut self) -> Result<()> {
        if self.socket.is_none() {
            self.bind(0)?;
        }
        Ok(())
    }

    async fn stop(&mut self) -> Result<()> {
        self.socket = None;
        self.synchronized = false;
        Ok(())
    }

    async fn sync(&mut self) -> Result<ClockOffset> {
        let socket = self.socket.as_ref()
            .ok_or_else(|| Error::Rtsp(
                airplay_core::error::RtspError::NoSession
            ))?;

        // Build and send request
        let request = NtpRequest::new(&self.clock)
            .with_sequence(self.sequence);
        self.sequence = self.sequence.wrapping_add(1);

        socket.send_to(&request.serialize(), self.remote_addr)?;

        // Receive response
        let mut buf = [0u8; 64];
        let (len, _) = socket.recv_from(&mut buf)?;
        let recv_time = self.clock.now_ntp();

        let response = NtpResponse::parse(&buf[..len])?;

        // Calculate offset
        let offset_ns = response.clock_offset(recv_time);
        let rtt_ns = response.round_trip_time(recv_time);

        self.offset = ClockOffset {
            offset_ns,
            error_ns: (rtt_ns.abs() / 2) as u64,
            rtt_ns: rtt_ns.abs() as u64,
        };
        self.synchronized = true;

        Ok(self.offset)
    }

    fn offset(&self) -> ClockOffset {
        self.offset
    }

    fn is_synchronized(&self) -> bool {
        self.synchronized
    }

    fn local_to_remote(&self, local_ns: u64) -> u64 {
        (local_ns as i64 + self.offset.offset_ns) as u64
    }

    fn remote_to_local(&self, remote_ns: u64) -> u64 {
        (remote_ns as i64 - self.offset.offset_ns) as u64
    }
}

/// Background timing sync task.
pub async fn timing_sync_loop(
    client: &mut NtpTimingClient,
    interval: Duration,
    mut stop_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    loop {
        tokio::select! {
            _ = tokio::time::sleep(interval) => {
                if let Err(e) = client.sync().await {
                    tracing::warn!("Timing sync failed: {}", e);
                }
            }
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    break;
                }
            }
        }
    }
    Ok(())
}

/// NTP timing server that responds to incoming timing requests.
///
/// The AirPlay receiver sends NTP timing requests to verify clock synchronization.
/// This server listens on a UDP port and responds with accurate timestamps.
pub struct NtpTimingServer {
    socket: Arc<TokioUdpSocket>,
    port: u16,
    shutdown_tx: watch::Sender<bool>,
    task_handle: Option<tokio::task::JoinHandle<()>>,
}

impl NtpTimingServer {
    /// Bind to a random port and start the background listener.
    pub async fn start(sample_rate: u32) -> Result<Self> {
        let socket = TokioUdpSocket::bind("0.0.0.0:0").await?;
        let port = socket.local_addr()?.port();
        let socket = Arc::new(socket);

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let clock = Clock::new(sample_rate);

        let task_socket = socket.clone();
        let task_handle = tokio::spawn(async move {
            Self::run_loop(task_socket, clock, shutdown_rx).await;
        });

        Ok(Self {
            socket,
            port,
            shutdown_tx,
            task_handle: Some(task_handle),
        })
    }

    /// Get the local port number.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Stop the timing server.
    pub async fn stop(&mut self) {
        let _ = self.shutdown_tx.send(true);
        if let Some(handle) = self.task_handle.take() {
            let _ = handle.await;
        }
    }

    async fn run_loop(
        socket: Arc<TokioUdpSocket>,
        clock: Clock,
        mut shutdown_rx: watch::Receiver<bool>,
    ) {
        let mut buf = [0u8; 64];
        loop {
            tokio::select! {
                result = socket.recv_from(&mut buf) => {
                    if let Ok((len, addr)) = result {
                        let recv_time = clock.now_ntp();
                        if let Ok(request) = NtpRequest::parse(&buf[..len]) {
                            let send_time = clock.now_ntp();
                            let response = NtpResponse::from_request(&request, recv_time, send_time);
                            let _ = socket.send_to(&response.serialize(), addr).await;
                            tracing::debug!("NTP timing: responded to request seq={}", request.sequence);
                        }
                    }
                }
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        break;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::unix_to_ntp;

    mod ntp_request {
        use super::*;

        #[test]
        fn new_sets_reference_time() {
            let clock = Clock::new(44100);
            let request = NtpRequest::new(&clock);
            // Reference time should be non-zero
            assert_ne!(request.reference_time, 0);
        }

        #[test]
        fn serialize_is_32_bytes() {
            let request = NtpRequest {
                sequence: 42,
                reference_time: unix_to_ntp(1_000_000_000),
            };
            let bytes = request.serialize();
            assert_eq!(bytes.len(), 32);
        }

        #[test]
        fn serialize_header_correct() {
            let request = NtpRequest {
                sequence: 0x1234,
                reference_time: 0,
            };
            let bytes = request.serialize();

            // Check RTP header
            assert_eq!(bytes[0], 0x80); // V=2
            assert_eq!(bytes[1], 0xD2); // PT=82 with marker
            assert_eq!(&bytes[2..4], &[0x12, 0x34]); // Sequence
        }

        #[test]
        fn parse_serialize_roundtrip() {
            let original = NtpRequest {
                sequence: 0xABCD,
                reference_time: unix_to_ntp(1_234_567_890_000_000_000),
            };
            let bytes = original.serialize();
            let parsed = NtpRequest::parse(&bytes).unwrap();

            assert_eq!(parsed.sequence, original.sequence);
            assert_eq!(parsed.reference_time, original.reference_time);
        }
    }

    mod ntp_response {
        use super::*;

        fn make_response(t1: u64, t2: u64, t3: u64) -> NtpResponse {
            NtpResponse {
                sequence: 0,
                reference_time: unix_to_ntp(t1),
                receive_time: unix_to_ntp(t2),
                send_time: unix_to_ntp(t3),
            }
        }

        #[test]
        fn parse_valid_response() {
            let mut data = [0u8; 32];
            data[0] = 0x80;
            data[1] = TIMING_RESPONSE_PT | 0x80;
            data[2..4].copy_from_slice(&42u16.to_be_bytes());

            let ref_time = unix_to_ntp(1_000_000_000);
            let recv_time = unix_to_ntp(1_000_010_000);
            let send_time = unix_to_ntp(1_000_020_000);

            data[8..16].copy_from_slice(&ref_time.to_be_bytes());
            data[16..24].copy_from_slice(&recv_time.to_be_bytes());
            data[24..32].copy_from_slice(&send_time.to_be_bytes());

            let response = NtpResponse::parse(&data).unwrap();
            assert_eq!(response.sequence, 42);
            assert_eq!(response.reference_time, ref_time);
            assert_eq!(response.receive_time, recv_time);
            assert_eq!(response.send_time, send_time);
        }

        #[test]
        fn round_trip_time_calculation() {
            // Symmetric delay scenario:
            // t1 = 0, t2 = 10ms, t3 = 10ms, t4 = 20ms
            // RTT = (t4 - t1) - (t3 - t2) = 20ms - 0ms = 20ms
            let response = make_response(
                0,
                10_000_000, // 10ms
                10_000_000, // 10ms
            );
            let t4 = unix_to_ntp(20_000_000); // 20ms

            let rtt = response.round_trip_time(t4);
            // Allow small rounding error from NTP conversion
            assert!((rtt - 20_000_000).abs() <= 2, "RTT {} not within tolerance of 20ms", rtt);
        }

        #[test]
        fn clock_offset_calculation() {
            // Scenario: Remote is 5ms ahead
            // t1 = 0, t2 = 15ms, t3 = 15ms, t4 = 20ms
            // offset = ((t2 - t1) + (t3 - t4)) / 2 = (15 + (15 - 20)) / 2 = 10 / 2 = 5ms
            let response = make_response(
                0,
                15_000_000, // 15ms
                15_000_000, // 15ms
            );
            let t4 = unix_to_ntp(20_000_000); // 20ms

            let offset = response.clock_offset(t4);
            // Allow small rounding error from NTP conversion
            assert!((offset - 5_000_000).abs() <= 2, "Offset {} not within tolerance of 5ms", offset);
        }

        #[test]
        fn offset_positive_when_remote_ahead() {
            // Remote is ahead: their clock shows later time
            let response = make_response(
                0,          // We sent at t=0
                50_000_000, // They received at t=50ms (their clock)
                50_000_000, // They sent at t=50ms
            );
            let t4 = unix_to_ntp(10_000_000); // We received at t=10ms (our clock)

            let offset = response.clock_offset(t4);
            // offset = ((50 - 0) + (50 - 10)) / 2 = (50 + 40) / 2 = 45ms
            assert!(offset > 0);
        }

        #[test]
        fn offset_negative_when_remote_behind() {
            // Remote is behind: their clock shows earlier time
            let response = make_response(
                50_000_000, // We sent at t=50ms
                10_000_000, // They received at t=10ms (their clock) - behind!
                10_000_000, // They sent at t=10ms
            );
            let t4 = unix_to_ntp(60_000_000); // We received at t=60ms

            let offset = response.clock_offset(t4);
            // offset = ((10 - 50) + (10 - 60)) / 2 = (-40 + -50) / 2 = -45ms
            assert!(offset < 0);
        }

        #[test]
        fn from_request_copies_sequence_and_reference() {
            let request = NtpRequest {
                sequence: 0x1234,
                reference_time: unix_to_ntp(100_000_000),
            };
            let recv_time = unix_to_ntp(110_000_000);
            let send_time = unix_to_ntp(120_000_000);

            let response = NtpResponse::from_request(&request, recv_time, send_time);

            assert_eq!(response.sequence, request.sequence);
            assert_eq!(response.reference_time, request.reference_time);
            assert_eq!(response.receive_time, recv_time);
            assert_eq!(response.send_time, send_time);
        }

        #[test]
        fn serialize_is_32_bytes() {
            let response = NtpResponse {
                sequence: 42,
                reference_time: unix_to_ntp(1_000_000_000),
                receive_time: unix_to_ntp(1_000_010_000),
                send_time: unix_to_ntp(1_000_020_000),
            };
            let bytes = response.serialize();
            assert_eq!(bytes.len(), 32);
        }

        #[test]
        fn serialize_header_correct() {
            let response = NtpResponse {
                sequence: 0x5678,
                reference_time: 0,
                receive_time: 0,
                send_time: 0,
            };
            let bytes = response.serialize();

            // Check RTP header
            assert_eq!(bytes[0], 0x80); // V=2
            assert_eq!(bytes[1], 0xD3); // PT=83 with marker
            assert_eq!(&bytes[2..4], &[0x56, 0x78]); // Sequence
        }

        #[test]
        fn serialize_parse_roundtrip() {
            let original = NtpResponse {
                sequence: 0xABCD,
                reference_time: unix_to_ntp(1_234_567_890_000_000_000),
                receive_time: unix_to_ntp(1_234_567_900_000_000_000),
                send_time: unix_to_ntp(1_234_567_910_000_000_000),
            };
            let bytes = original.serialize();
            let parsed = NtpResponse::parse(&bytes).unwrap();

            assert_eq!(parsed.sequence, original.sequence);
            assert_eq!(parsed.reference_time, original.reference_time);
            assert_eq!(parsed.receive_time, original.receive_time);
            assert_eq!(parsed.send_time, original.send_time);
        }
    }

    mod ntp_server {
        use super::*;

        #[tokio::test]
        async fn start_binds_to_port() {
            let mut server = NtpTimingServer::start(44100).await.unwrap();
            let port = server.port();
            assert!(port > 0);
            server.stop().await;
        }

        #[tokio::test]
        async fn responds_to_timing_request() {
            // Start server
            let mut server = NtpTimingServer::start(44100).await.unwrap();
            let port = server.port();

            // Create a client socket to send a request
            let client_socket = TokioUdpSocket::bind("127.0.0.1:0").await.unwrap();

            // Build and send a timing request
            let request = NtpRequest {
                sequence: 42,
                reference_time: unix_to_ntp(1_000_000_000),
            };
            client_socket
                .send_to(&request.serialize(), format!("127.0.0.1:{}", port))
                .await
                .unwrap();

            // Receive response with timeout
            let mut buf = [0u8; 64];
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                client_socket.recv_from(&mut buf),
            )
            .await;

            let (len, _addr) = result.expect("Timeout waiting for response").unwrap();
            let response = NtpResponse::parse(&buf[..len]).unwrap();

            // Verify response echoes request data
            assert_eq!(response.sequence, 42);
            assert_eq!(response.reference_time, request.reference_time);
            // Receive and send times should be valid NTP timestamps
            assert!(response.receive_time > 0);
            assert!(response.send_time > 0);

            server.stop().await;
        }
    }

    mod ntp_client {
        use super::*;

        #[test]
        fn new_starts_with_zero_offset() {
            let addr: SocketAddr = "127.0.0.1:7010".parse().unwrap();
            let client = NtpTimingClient::new(addr, 44100);
            assert_eq!(client.offset_ns(), 0);
            assert_eq!(client.rtt_ns(), 0);
        }

        #[tokio::test]
        async fn start_opens_socket() {
            let addr: SocketAddr = "127.0.0.1:7010".parse().unwrap();
            let mut client = NtpTimingClient::new(addr, 44100);

            client.start().await.unwrap();
            assert!(client.local_port().is_some());
        }

        #[test]
        fn local_to_remote_applies_offset() {
            let addr: SocketAddr = "127.0.0.1:7010".parse().unwrap();
            let mut client = NtpTimingClient::new(addr, 44100);
            client.offset.offset_ns = 1_000_000; // +1ms

            let remote = client.local_to_remote(5_000_000);
            assert_eq!(remote, 6_000_000);
        }

        #[test]
        fn remote_to_local_applies_offset() {
            let addr: SocketAddr = "127.0.0.1:7010".parse().unwrap();
            let mut client = NtpTimingClient::new(addr, 44100);
            client.offset.offset_ns = 1_000_000; // +1ms

            let local = client.remote_to_local(6_000_000);
            assert_eq!(local, 5_000_000);
        }
    }
}
