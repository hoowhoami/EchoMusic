//! RTP packet formatting and transmission.

use airplay_core::error::{Error, Result};
use airplay_crypto::chacha::AudioCipher;
use crate::cipher::PacketCipher;
use std::net::{SocketAddr, UdpSocket};
use std::time::Duration;

/// Set QoS socket options for real-time audio traffic.
///
/// EchoMusic patch (research §3.5, AirSend fork rev 655b276 reference): the
/// original unconditionally imported `std::os::unix::io::AsRawFd`, which broke
/// Windows (MSVC) builds. QoS option tables differ per OS here, so the socket
/// tuning is isolated to Unix; Windows keeps the default socket behavior.
#[cfg(unix)]
fn set_socket_qos(socket: &UdpSocket) {
    use std::os::unix::io::AsRawFd;
    let fd = socket.as_raw_fd();

    // IP_TOS = DSCP EF (0xB8 = 184). The TOS byte is: DSCP (6 bits) + ECN (2 bits).
    // EF = 46 << 2 = 0xB8.
    let tos: libc::c_int = 0xB8;
    unsafe {
        let ret = libc::setsockopt(
            fd,
            libc::IPPROTO_IP,
            libc::IP_TOS,
            &tos as *const _ as *const libc::c_void,
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        );
        if ret != 0 {
            tracing::debug!("Failed to set IP_TOS (DSCP EF): errno={}", std::io::Error::last_os_error());
        }
    }

    // Enlarge send buffer to 1MB. Default is often 128-212KB which can cause
    // kernel-side drops when bursting to multiple group devices at once.
    unsafe {
        let buf_size: libc::c_int = 1024 * 1024; // 1MB
        let ret = libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_SNDBUF,
            &buf_size as *const _ as *const libc::c_void,
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        );
        if ret != 0 {
            tracing::debug!("Failed to set SO_SNDBUF: errno={}", std::io::Error::last_os_error());
        }
    }

    // On Linux, also set SO_PRIORITY = 6 (maps to TC prio band for AC_VO)
    #[cfg(target_os = "linux")]
    unsafe {
        let prio: libc::c_int = 6;
        let ret = libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PRIORITY,
            &prio as *const _ as *const libc::c_void,
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        );
        if ret != 0 {
            tracing::debug!("Failed to set SO_PRIORITY: errno={}", std::io::Error::last_os_error());
        }
    }
}

/// EchoMusic patch: no-op QoS on platforms without the Unix socket API.
#[cfg(not(unix))]
fn set_socket_qos(_socket: &UdpSocket) {}

/// RTP payload types for AirPlay.
pub mod payload_types {
    pub const TIMING_REQUEST: u8 = 82;
    pub const TIMING_RESPONSE: u8 = 83;
    pub const SYNC: u8 = 84;
    pub const RETRANSMIT_REQUEST: u8 = 85;
    pub const RETRANSMIT_RESPONSE: u8 = 86;
    pub const PTP_SYNC: u8 = 87;
    pub const AUDIO_REALTIME: u8 = 96;
    pub const AUDIO_BUFFERED: u8 = 103;
}

/// RTP header (12 bytes).
#[derive(Debug, Clone, Copy)]
pub struct RtpHeader {
    /// Version (2 bits) - always 2.
    pub version: u8,
    /// Padding flag.
    pub padding: bool,
    /// Extension flag.
    pub extension: bool,
    /// CSRC count.
    pub csrc_count: u8,
    /// Marker bit.
    pub marker: bool,
    /// Payload type.
    pub payload_type: u8,
    /// Sequence number.
    pub sequence: u16,
    /// Timestamp.
    pub timestamp: u32,
    /// SSRC identifier.
    pub ssrc: u32,
}

impl RtpHeader {
    /// Create new header with defaults.
    pub fn new(payload_type: u8, sequence: u16, timestamp: u32, ssrc: u32) -> Self {
        Self {
            version: 2,
            padding: false,
            extension: false,
            csrc_count: 0,
            marker: false,
            payload_type,
            sequence,
            timestamp,
            ssrc,
        }
    }

    /// Set marker bit.
    pub fn with_marker(mut self, marker: bool) -> Self {
        self.marker = marker;
        self
    }

    /// Set extension flag.
    pub fn with_extension(mut self, extension: bool) -> Self {
        self.extension = extension;
        self
    }

    /// Serialize to 12 bytes.
    pub fn serialize(&self) -> [u8; 12] {
        let mut buf = [0u8; 12];

        // Byte 0: V(2) P(1) X(1) CC(4)
        buf[0] = (self.version << 6)
            | ((self.padding as u8) << 5)
            | ((self.extension as u8) << 4)
            | (self.csrc_count & 0x0F);

        // Byte 1: M(1) PT(7)
        buf[1] = ((self.marker as u8) << 7) | (self.payload_type & 0x7F);

        // Bytes 2-3: Sequence
        buf[2..4].copy_from_slice(&self.sequence.to_be_bytes());

        // Bytes 4-7: Timestamp
        buf[4..8].copy_from_slice(&self.timestamp.to_be_bytes());

        // Bytes 8-11: SSRC
        buf[8..12].copy_from_slice(&self.ssrc.to_be_bytes());

        buf
    }

    /// Parse from bytes.
    pub fn parse(data: &[u8]) -> Result<Self> {
        if data.len() < 12 {
            return Err(Error::Parse(
                airplay_core::error::ParseError::InvalidFormat("RTP header too short".into())
            ));
        }

        Ok(Self {
            version: (data[0] >> 6) & 0x03,
            padding: (data[0] >> 5) & 0x01 != 0,
            extension: (data[0] >> 4) & 0x01 != 0,
            csrc_count: data[0] & 0x0F,
            marker: (data[1] >> 7) & 0x01 != 0,
            payload_type: data[1] & 0x7F,
            sequence: u16::from_be_bytes([data[2], data[3]]),
            timestamp: u32::from_be_bytes([data[4], data[5], data[6], data[7]]),
            ssrc: u32::from_be_bytes([data[8], data[9], data[10], data[11]]),
        })
    }
}

/// Complete RTP packet.
#[derive(Debug, Clone)]
pub struct RtpPacket {
    pub header: RtpHeader,
    pub payload: Vec<u8>,
    /// Encryption nonce (8 bytes, for encrypted packets).
    pub nonce: Option<[u8; 8]>,
    /// Authentication tag (16 bytes, for encrypted packets).
    pub tag: Option<[u8; 16]>,
}

impl RtpPacket {
    /// Create new packet.
    pub fn new(header: RtpHeader, payload: Vec<u8>) -> Self {
        Self {
            header,
            payload,
            nonce: None,
            tag: None,
        }
    }

    /// Encrypt payload and add nonce/tag.
    pub fn encrypt(mut self, cipher: &AudioCipher) -> Result<Self> {
        let (ciphertext, nonce, tag) = cipher.encrypt_with_seq(
            &self.payload,
            self.header.timestamp,
            self.header.ssrc,
            self.header.sequence,
        ).map_err(|e| Error::Crypto(e))?;

        self.payload = ciphertext;
        self.nonce = Some(nonce);
        self.tag = Some(tag);

        Ok(self)
    }

    /// Serialize to bytes (with optional encryption).
    ///
    /// For encrypted packets, wire format:
    /// - RTP header (12 bytes)
    /// - Encrypted payload
    /// - 16-byte Poly1305 auth tag (at N-24)
    /// - 8-byte nonce (at N-8)
    pub fn serialize(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.size());

        out.extend_from_slice(&self.header.serialize());
        out.extend_from_slice(&self.payload);

        // Trailer: tag (16 bytes) then nonce (8 bytes)
        if let Some(tag) = &self.tag {
            out.extend_from_slice(tag);
        }
        if let Some(nonce) = &self.nonce {
            out.extend_from_slice(nonce);
        }

        out
    }

    /// Parse from bytes (unencrypted).
    pub fn parse(data: &[u8]) -> Result<Self> {
        if data.len() < 12 {
            return Err(Error::Parse(
                airplay_core::error::ParseError::InvalidFormat("RTP packet too short".into())
            ));
        }

        let header = RtpHeader::parse(data)?;
        let payload = data[12..].to_vec();

        Ok(Self {
            header,
            payload,
            nonce: None,
            tag: None,
        })
    }

    /// Parse encrypted packet (extracts nonce and tag from trailer).
    pub fn parse_encrypted(data: &[u8]) -> Result<Self> {
        // Minimum: 12 header + 8 nonce + 16 tag = 36 bytes
        if data.len() < 36 {
            return Err(Error::Parse(
                airplay_core::error::ParseError::InvalidFormat("Encrypted RTP packet too short".into())
            ));
        }

        let header = RtpHeader::parse(data)?;

        // Last 24 bytes are tag (16) + nonce (8)
        let trailer_start = data.len() - 24;
        let payload = data[12..trailer_start].to_vec();

        let mut tag = [0u8; 16];
        tag.copy_from_slice(&data[trailer_start..trailer_start + 16]);

        let mut nonce = [0u8; 8];
        nonce.copy_from_slice(&data[trailer_start + 16..]);

        Ok(Self {
            header,
            payload,
            nonce: Some(nonce),
            tag: Some(tag),
        })
    }

    /// Total size in bytes.
    pub fn size(&self) -> usize {
        12 + self.payload.len()
            + self.nonce.map(|_| 8).unwrap_or(0)
            + self.tag.map(|_| 16).unwrap_or(0)
    }
}

/// Retransmit request (payload type 85).
///
/// Sent by the receiver when audio packets are lost.
/// Format: 8-byte RTP header (no SSRC) + 2-byte start seq + 2-byte count.
#[derive(Debug, Clone, Copy)]
pub struct RetransmitRequest {
    /// Sequence number of the first lost packet.
    pub first_sequence: u16,
    /// Number of lost packets.
    pub count: u16,
}

impl RetransmitRequest {
    /// Parse a retransmit request from raw bytes.
    ///
    /// Wire format (12 bytes):
    /// - Bytes 0-7: RTP header without SSRC (8 bytes)
    /// - Bytes 8-9: First lost sequence number (big-endian)
    /// - Bytes 10-11: Number of lost packets (big-endian)
    pub fn parse(data: &[u8]) -> Result<Self> {
        if data.len() < 12 {
            return Err(Error::Parse(
                airplay_core::error::ParseError::InvalidFormat(
                    "Retransmit request too short".into(),
                ),
            ));
        }

        // Verify payload type is 85
        let payload_type = data[1] & 0x7F;
        if payload_type != payload_types::RETRANSMIT_REQUEST {
            return Err(Error::Parse(
                airplay_core::error::ParseError::InvalidFormat(
                    format!("Expected payload type 85, got {}", payload_type),
                ),
            ));
        }

        let first_sequence = u16::from_be_bytes([data[8], data[9]]);
        let count = u16::from_be_bytes([data[10], data[11]]);

        Ok(Self {
            first_sequence,
            count,
        })
    }
}

/// Build a retransmit response (payload type 86).
///
/// Format: 4-byte header (sequence number + padding) followed by the
/// original full RTP audio packet.
pub fn build_retransmit_response(original_packet: &[u8]) -> Vec<u8> {
    // Retransmit response: 4-byte retransmit header + original RTP packet
    // The 4-byte header contains the original sequence number.
    let mut response = Vec::with_capacity(4 + original_packet.len());

    // Byte 0-1: RTP-like header with marker + PT 86
    response.push(0x80); // V=2, P=0, X=0, CC=0
    response.push(0x80 | payload_types::RETRANSMIT_RESPONSE); // M=1, PT=86

    // Bytes 2-3: Original sequence number from the packet being retransmitted
    if original_packet.len() >= 4 {
        response.push(original_packet[2]);
        response.push(original_packet[3]);
    } else {
        response.push(0);
        response.push(0);
    }

    // Followed by the complete original RTP audio packet
    response.extend_from_slice(original_packet);

    response
}

/// Maximum number of recent packets to retain for retransmission.
const PACKET_HISTORY_SIZE: usize = 512;

/// RTP sender over UDP.
pub struct RtpSender {
    socket: Option<UdpSocket>,
    dest: SocketAddr,
    /// Separate destination for control/sync packets (if different from data port)
    control_dest: Option<SocketAddr>,
    /// Separate socket for sending sync/control packets from our declared control port.
    /// Without this, sync packets are sent from the data socket (wrong source port)
    /// and the receiver ignores them.
    control_socket: Option<UdpSocket>,
    sequence: u16,
    ssrc: u32,
    cipher: Option<Box<dyn PacketCipher>>,
    /// Sync packet sequence counter (increments each sync)
    sync_sequence: u16,
    /// Whether the first sync packet has been sent (needs extension bit)
    first_sync_sent: bool,
    /// Ring buffer of recently sent serialized packets, indexed by (sequence % PACKET_HISTORY_SIZE).
    packet_history: Vec<Option<Vec<u8>>>,
}

impl RtpSender {
    /// Create new sender.
    ///
    /// Sequence starts at 0 to match what's advertised in RECORD RTP-Info header.
    pub fn new(dest: SocketAddr, ssrc: u32) -> Self {
        let mut packet_history = Vec::with_capacity(PACKET_HISTORY_SIZE);
        packet_history.resize_with(PACKET_HISTORY_SIZE, || None);

        Self {
            socket: None,
            dest,
            control_dest: None,
            control_socket: None,
            sequence: 0,
            ssrc,
            cipher: None,
            sync_sequence: 0,
            first_sync_sent: false,
            packet_history,
        }
    }

    /// Set control port destination for sync packets.
    pub fn set_control_dest(&mut self, dest: SocketAddr) {
        self.control_dest = Some(dest);
    }

    /// Set a separate socket for sending sync/control packets.
    ///
    /// This socket should be bound to our declared control port (from SETUP phase 2).
    /// The receiver expects sync packets to arrive from this port, not from the
    /// data socket's random port.
    pub fn set_control_socket(&mut self, socket: UdpSocket) {
        self.control_socket = Some(socket);
    }

    /// Bind to local port.
    pub fn bind(&mut self, local_port: u16) -> Result<u16> {
        let socket = UdpSocket::bind(("0.0.0.0", local_port))?;
        set_socket_qos(&socket);
        let port = socket.local_addr()?.port();
        self.socket = Some(socket);
        Ok(port)
    }

    /// Set encryption cipher.
    pub fn set_cipher(&mut self, cipher: Box<dyn PacketCipher>) {
        self.cipher = Some(cipher);
    }

    /// Reset sync state after FLUSH.
    ///
    /// Per the AirPlay spec, the extension bit must be set on the first sync
    /// packet after RECORD or FLUSH. This resets the flag so the next sync
    /// packet will have the extension bit set.
    pub fn reset_sync_state(&mut self) {
        self.first_sync_sent = false;
    }

    /// Send a raw packet.
    pub fn send(&mut self, packet: &RtpPacket) -> Result<()> {
        let socket = self.socket.as_ref()
            .ok_or_else(|| Error::Streaming(
                airplay_core::error::StreamingError::Encoding("Socket not bound".into())
            ))?;

        socket.send_to(&packet.serialize(), self.dest)?;
        Ok(())
    }

    /// Serialize an audio packet (encrypt if cipher set, store in history),
    /// returning the wire bytes. Shared logic for `send_audio` and `prepare_audio`.
    fn serialize_audio(
        &mut self,
        payload_type: u8,
        timestamp: u32,
        payload: &[u8],
        marker: bool,
    ) -> Result<Vec<u8>> {
        let header = RtpHeader::new(payload_type, self.sequence, timestamp, self.ssrc)
            .with_marker(marker);

        // Encrypt if cipher is set, then build serialized packet
        let serialized = if let Some(cipher) = &self.cipher {
            let seq_before = self.sequence;
            let encrypted = cipher.encrypt_payload(payload, timestamp, self.ssrc, self.sequence)?;

            // Debug: log nonce and tag for first few packets
            if seq_before % 500 == 0 {
                if let (Some(nonce), Some(tag)) = (&encrypted.nonce, &encrypted.tag) {
                    tracing::info!(
                        "Encrypted packet: seq={}, ts={}, ssrc={:08x}, nonce={:02x?}, tag_first4={:02x?}, payload_len={}",
                        seq_before, timestamp, self.ssrc, nonce, &tag[..4], payload.len()
                    );
                }
            }

            // Build wire format: header + encrypted payload + tag (16) + nonce (8)
            let header_bytes = header.serialize();
            let mut out = Vec::with_capacity(
                12 + encrypted.data.len()
                    + encrypted.tag.map(|_| 16).unwrap_or(0)
                    + encrypted.nonce.map(|_| 8).unwrap_or(0),
            );
            out.extend_from_slice(&header_bytes);
            out.extend_from_slice(&encrypted.data);
            // AirPlay 2 trailer: tag first, then nonce
            if let Some(tag) = &encrypted.tag {
                out.extend_from_slice(tag);
            }
            if let Some(nonce) = &encrypted.nonce {
                out.extend_from_slice(nonce);
            }
            out
        } else {
            let packet = RtpPacket::new(header, payload.to_vec());
            packet.serialize()
        };

        // Diagnostic: log first packet's wire format to verify structure
        if self.sequence == 0 {
            let has_cipher = self.cipher.is_some();
            tracing::info!(
                "DIAG first audio packet: wire_len={}, payload_len={}, encrypted={}, dest={}, \
                 header_first4={:02x?}, pt={}, marker={}, ssrc={:08x}",
                serialized.len(), payload.len(), has_cipher, self.dest,
                &serialized[..4.min(serialized.len())],
                payload_type, marker, self.ssrc,
            );
        }

        // Store serialized packet in history for retransmission (move instead of clone)
        let idx = self.sequence as usize % PACKET_HISTORY_SIZE;
        self.packet_history[idx] = Some(serialized);

        tracing::debug!("Audio packet prepared: seq={}, ts={}, len={}", self.sequence, timestamp, payload.len());
        self.sequence = self.sequence.wrapping_add(1);

        // Return a reference to the stored copy (avoids clone since we just stored it)
        Ok(self.packet_history[idx].as_ref().unwrap().clone())
    }

    /// Send encoded audio packet.
    pub fn send_audio(
        &mut self,
        payload_type: u8,
        timestamp: u32,
        payload: &[u8],
        marker: bool,
    ) -> Result<()> {
        let serialized = self.serialize_audio(payload_type, timestamp, payload, marker)?;

        let socket = self.socket.as_ref()
            .ok_or_else(|| Error::Streaming(
                airplay_core::error::StreamingError::Encoding("Socket not bound".into())
            ))?;
        socket.send_to(&serialized, self.dest)?;

        Ok(())
    }

    /// Prepare an audio packet for later sending: serialize, encrypt, store in
    /// history, and return the wire bytes without transmitting.
    pub fn prepare_audio(
        &mut self,
        payload_type: u8,
        timestamp: u32,
        payload: &[u8],
        marker: bool,
    ) -> Result<Vec<u8>> {
        self.serialize_audio(payload_type, timestamp, payload, marker)
    }

    /// Send sync packet to control port.
    ///
    /// Owntone's sync packet format (20 bytes):
    /// - Byte 0: Type (0x90 = start sync, 0x80 = regular sync)
    /// - Byte 1: 0xd4 (payload type 84 with marker bit)
    /// - Bytes 2-3: 0x00, 0x07 (fixed values)
    /// - Bytes 4-7: Current playback position in samples (BE)
    /// - Bytes 8-15: NTP timestamp (8 bytes BE - seconds + fraction)
    /// - Bytes 16-19: RTP timestamp (BE)
    pub fn send_sync(&mut self, rtp_timestamp: u32, ntp_timestamp: u64) -> Result<()> {
        // Get the destination - control port if set, otherwise data port
        let dest = self.control_dest.unwrap_or(self.dest);

        // Skip sync packets if destination port is 0 (AirPlay 2 buffered doesn't use sync packets)
        if dest.port() == 0 {
            tracing::debug!("Skipping sync packet (no control port for AirPlay 2 buffered)");
            return Ok(());
        }

        // Use control socket if available (sends from our declared control port),
        // otherwise fall back to data socket.
        let socket = self.control_socket.as_ref()
            .or(self.socket.as_ref())
            .ok_or_else(|| Error::Streaming(
                airplay_core::error::StreamingError::Encoding("Socket not bound".into())
            ))?;

        // Build owntone-style sync packet (20 bytes)
        let mut packet = [0u8; 20];

        // Byte 0: 0x90 for first sync (extension bit set), 0x80 for subsequent
        packet[0] = if !self.first_sync_sent {
            self.first_sync_sent = true;
            0x90
        } else {
            0x80
        };
        // Byte 1: 0xd4 = marker bit (0x80) | payload type 84 (0x54)
        packet[1] = 0xd4;
        // Bytes 2-3: Sync sequence counter (increment after use)
        packet[2..4].copy_from_slice(&self.sync_sequence.to_be_bytes());
        self.sync_sequence = self.sync_sequence.wrapping_add(1);
        // Bytes 4-7: Current playback position (use rtp_timestamp)
        packet[4..8].copy_from_slice(&rtp_timestamp.to_be_bytes());
        // Bytes 8-15: NTP timestamp (8 bytes BE)
        packet[8..16].copy_from_slice(&ntp_timestamp.to_be_bytes());
        // Bytes 16-19: RTP timestamp (BE)
        packet[16..20].copy_from_slice(&rtp_timestamp.to_be_bytes());

        socket.send_to(&packet, dest)?;
        // Diagnostic: log first sync packet in detail
        if self.sync_sequence <= 2 {
            let ntp_secs = (ntp_timestamp >> 32) as u32;
            let ntp_frac = ntp_timestamp as u32;
            tracing::info!(
                "DIAG sync #{}: dest={}, rtp_ts={}, ntp_secs={}, ntp_frac={}, first_byte=0x{:02x}, pkt={:02x?}",
                self.sync_sequence - 1, dest, rtp_timestamp, ntp_secs, ntp_frac,
                packet[0], &packet[..20]
            );
        }
        tracing::debug!("Sync packet sent to {}: rtp_ts={}, ntp_ts={}", dest, rtp_timestamp, ntp_timestamp);

        Ok(())
    }

    /// Prepare a sync packet without sending. Returns the 20-byte packet data,
    /// or None if the control port is 0 (buffered mode skips sync).
    pub fn prepare_sync(&mut self, rtp_timestamp: u32, ntp_timestamp: u64) -> Result<Option<Vec<u8>>> {
        let dest = self.control_dest.unwrap_or(self.dest);

        if dest.port() == 0 {
            tracing::debug!("Skipping sync packet (no control port for AirPlay 2 buffered)");
            return Ok(None);
        }

        let mut packet = [0u8; 20];

        packet[0] = if !self.first_sync_sent {
            self.first_sync_sent = true;
            0x90
        } else {
            0x80
        };
        packet[1] = 0xd4;
        packet[2..4].copy_from_slice(&self.sync_sequence.to_be_bytes());
        self.sync_sequence = self.sync_sequence.wrapping_add(1);
        packet[4..8].copy_from_slice(&rtp_timestamp.to_be_bytes());
        packet[8..16].copy_from_slice(&ntp_timestamp.to_be_bytes());
        packet[16..20].copy_from_slice(&rtp_timestamp.to_be_bytes());

        if self.sync_sequence <= 2 {
            let ntp_secs = (ntp_timestamp >> 32) as u32;
            let ntp_frac = ntp_timestamp as u32;
            tracing::info!(
                "DIAG sync #{}: dest={}, rtp_ts={}, ntp_secs={}, ntp_frac={}, first_byte=0x{:02x}, pkt={:02x?}",
                self.sync_sequence - 1, dest, rtp_timestamp, ntp_secs, ntp_frac,
                packet[0], &packet[..20]
            );
        }

        Ok(Some(packet.to_vec()))
    }

    /// Prepare a PTP-mode sync packet (PT=87, 28 bytes) without sending.
    ///
    /// PTP sync uses a different format than NTP sync (PT=84):
    /// - 28 bytes instead of 20
    /// - PTP clock time (device uptime) instead of NTP epoch
    /// - Includes the PTP master clock ID
    ///
    /// Format (28 bytes):
    /// - Byte 0: 0x90 (first sync, extension bit) or 0x80 (subsequent)
    /// - Byte 1: 0xD7 (marker | PT=87)
    /// - Bytes 2-3: sequence number (BE u16)
    /// - Bytes 4-7: current RTP timestamp (BE u32)
    /// - Bytes 8-11: PTP seconds (BE u32)
    /// - Bytes 12-15: PTP fractional seconds (BE u32, fixed-point)
    /// - Bytes 16-19: next RTP timestamp (BE u32)
    /// - Bytes 20-27: master clock ID (8 bytes)
    pub fn prepare_ptp_sync(
        &mut self,
        current_rtp_ts: u32,
        ptp_clock_ns: u64,
        next_rtp_ts: u32,
        master_clock_id: &[u8; 8],
    ) -> Result<Option<Vec<u8>>> {
        let dest = self.control_dest.unwrap_or(self.dest);

        if dest.port() == 0 {
            tracing::debug!("Skipping PTP sync packet (no control port)");
            return Ok(None);
        }

        let mut packet = [0u8; 28];

        packet[0] = if !self.first_sync_sent {
            self.first_sync_sent = true;
            0x90
        } else {
            0x80
        };

        // 0xD7 = marker (0x80) | PT 87 (0x57)
        packet[1] = 0xD7;

        // Sequence
        packet[2..4].copy_from_slice(&self.sync_sequence.to_be_bytes());
        self.sync_sequence = self.sync_sequence.wrapping_add(1);

        // Current RTP timestamp
        packet[4..8].copy_from_slice(&current_rtp_ts.to_be_bytes());

        // PTP time: seconds(32) + fraction(32)
        let ptp_secs = (ptp_clock_ns / 1_000_000_000) as u32;
        let ptp_nanos = ptp_clock_ns % 1_000_000_000;
        let ptp_frac = ((ptp_nanos << 32) / 1_000_000_000) as u32;
        packet[8..12].copy_from_slice(&ptp_secs.to_be_bytes());
        packet[12..16].copy_from_slice(&ptp_frac.to_be_bytes());

        // Next RTP timestamp
        packet[16..20].copy_from_slice(&next_rtp_ts.to_be_bytes());

        // Master clock ID
        packet[20..28].copy_from_slice(master_clock_id);

        if self.sync_sequence <= 2 {
            tracing::info!(
                "DIAG PTP sync #{}: dest={}, rtp_ts={}, ptp_secs={}, ptp_frac={}, clock_id={:02x?}",
                self.sync_sequence - 1, dest, current_rtp_ts, ptp_secs, ptp_frac, master_clock_id
            );
        }

        Ok(Some(packet.to_vec()))
    }

    /// Send a PTP-mode sync packet (PT=87, 28 bytes).
    pub fn send_ptp_sync(
        &mut self,
        current_rtp_ts: u32,
        ptp_clock_ns: u64,
        next_rtp_ts: u32,
        master_clock_id: &[u8; 8],
    ) -> Result<()> {
        let packet = match self.prepare_ptp_sync(current_rtp_ts, ptp_clock_ns, next_rtp_ts, master_clock_id)? {
            Some(p) => p,
            None => return Ok(()),
        };

        let dest = self.control_dest.unwrap_or(self.dest);
        let socket = self.control_socket.as_ref()
            .or(self.socket.as_ref())
            .ok_or_else(|| Error::Streaming(
                airplay_core::error::StreamingError::Encoding("Socket not bound".into())
            ))?;

        socket.send_to(&packet, dest)?;
        tracing::debug!("PTP sync packet sent to {}: rtp_ts={}", dest, current_rtp_ts);

        Ok(())
    }

    /// Clone the data socket and destination for external use (e.g. sender thread).
    pub fn clone_data_socket(&self) -> Result<Option<(UdpSocket, SocketAddr)>> {
        match &self.socket {
            Some(s) => Ok(Some((s.try_clone()?, self.dest))),
            None => Ok(None),
        }
    }

    /// Clone the control socket and get control destination for external use.
    pub fn clone_control_socket(&self) -> Result<Option<(UdpSocket, SocketAddr)>> {
        match (&self.control_socket, self.control_dest) {
            (Some(s), Some(dest)) => Ok(Some((s.try_clone()?, dest))),
            _ => Ok(None),
        }
    }

    /// Get current sequence number.
    pub fn sequence(&self) -> u16 {
        self.sequence
    }

    /// Get SSRC.
    pub fn ssrc(&self) -> u32 {
        self.ssrc
    }

    /// Get local port (after bind).
    pub fn local_port(&self) -> Option<u16> {
        self.socket.as_ref().and_then(|s| s.local_addr().ok().map(|a| a.port()))
    }

    /// Handle a retransmit request by resending the requested packets.
    ///
    /// Looks up the requested sequence numbers in the packet history
    /// and sends retransmit responses (payload type 86) to the control port.
    /// Returns the number of packets successfully retransmitted.
    pub fn handle_retransmit(&self, request: &RetransmitRequest) -> Result<u16> {
        // Use control socket for retransmit responses (same port as sync)
        let socket = self.control_socket.as_ref()
            .or(self.socket.as_ref())
            .ok_or_else(|| Error::Streaming(
                airplay_core::error::StreamingError::Encoding("Socket not bound".into())
            ))?;

        let dest = self.control_dest.unwrap_or(self.dest);
        let mut retransmitted = 0u16;

        for i in 0..request.count {
            let seq = request.first_sequence.wrapping_add(i);
            let idx = seq as usize % PACKET_HISTORY_SIZE;

            if let Some(ref original) = self.packet_history[idx] {
                // Verify the stored packet has the right sequence number
                if original.len() >= 4 {
                    let stored_seq = u16::from_be_bytes([original[2], original[3]]);
                    if stored_seq != seq {
                        tracing::debug!(
                            "Retransmit: seq {} not in history (slot has seq {})",
                            seq, stored_seq
                        );
                        continue;
                    }
                }

                let response = build_retransmit_response(original);
                socket.send_to(&response, dest)?;
                retransmitted += 1;
            } else {
                tracing::debug!("Retransmit: seq {} not in history (empty slot)", seq);
            }
        }

        if retransmitted > 0 {
            tracing::debug!(
                "Retransmitted {}/{} packets (seq {}..{})",
                retransmitted, request.count,
                request.first_sequence,
                request.first_sequence.wrapping_add(request.count - 1)
            );
        }

        Ok(retransmitted)
    }
}

/// RTP receiver for control/retransmit channel.
pub struct RtpReceiver {
    socket: Option<UdpSocket>,
}

impl RtpReceiver {
    /// Create new receiver.
    pub fn new() -> Self {
        Self { socket: None }
    }

    /// Bind to local port.
    pub fn bind(&mut self, local_port: u16) -> Result<u16> {
        let socket = UdpSocket::bind(("0.0.0.0", local_port))?;
        set_socket_qos(&socket);
        socket.set_read_timeout(Some(Duration::from_secs(1)))?;
        let port = socket.local_addr()?.port();
        self.socket = Some(socket);
        Ok(port)
    }

    /// Receive packet with timeout.
    pub fn recv_timeout(&self, timeout: Duration) -> Result<Option<RtpPacket>> {
        let socket = self.socket.as_ref()
            .ok_or_else(|| Error::Streaming(
                airplay_core::error::StreamingError::Encoding("Socket not bound".into())
            ))?;

        socket.set_read_timeout(Some(timeout))?;

        let mut buf = [0u8; 2048];
        match socket.recv_from(&mut buf) {
            Ok((len, _)) => Ok(Some(RtpPacket::parse(&buf[..len])?)),
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Receive raw bytes with timeout (for packets that may not be standard RTP).
    ///
    /// Returns `Ok(Some((data, addr)))` on success, `Ok(None)` on timeout.
    pub fn recv_raw_timeout(&self, timeout: Duration) -> Result<Option<(Vec<u8>, std::net::SocketAddr)>> {
        let socket = self.socket.as_ref()
            .ok_or_else(|| Error::Streaming(
                airplay_core::error::StreamingError::Encoding("Socket not bound".into())
            ))?;

        socket.set_read_timeout(Some(timeout))?;

        let mut buf = [0u8; 2048];
        match socket.recv_from(&mut buf) {
            Ok((len, addr)) => Ok(Some((buf[..len].to_vec(), addr))),
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Get local port (after bind).
    pub fn local_port(&self) -> Option<u16> {
        self.socket.as_ref().and_then(|s| s.local_addr().ok().map(|a| a.port()))
    }

    /// Clone the underlying socket (for sharing with RtpSender for sync packets).
    ///
    /// The cloned socket shares the same underlying OS socket, so both handles
    /// send from the same local port. This lets the RtpSender send sync packets
    /// from our declared control port.
    pub fn try_clone_socket(&self) -> Result<Option<UdpSocket>> {
        match &self.socket {
            Some(s) => Ok(Some(s.try_clone()?)),
            None => Ok(None),
        }
    }
}

impl Default for RtpReceiver {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod rtp_header {
        use super::*;

        #[test]
        fn new_sets_version_2() {
            let header = RtpHeader::new(96, 0, 0, 0);
            assert_eq!(header.version, 2);
        }

        #[test]
        fn new_stores_payload_type() {
            let header = RtpHeader::new(96, 0, 0, 0);
            assert_eq!(header.payload_type, 96);

            let header = RtpHeader::new(103, 0, 0, 0);
            assert_eq!(header.payload_type, 103);
        }

        #[test]
        fn new_stores_sequence() {
            let header = RtpHeader::new(96, 12345, 0, 0);
            assert_eq!(header.sequence, 12345);
        }

        #[test]
        fn new_stores_timestamp() {
            let header = RtpHeader::new(96, 0, 0xDEADBEEF, 0);
            assert_eq!(header.timestamp, 0xDEADBEEF);
        }

        #[test]
        fn new_stores_ssrc() {
            let header = RtpHeader::new(96, 0, 0, 0x12345678);
            assert_eq!(header.ssrc, 0x12345678);
        }

        #[test]
        fn with_marker_sets_bit() {
            let header = RtpHeader::new(96, 0, 0, 0);
            assert!(!header.marker);

            let header = header.with_marker(true);
            assert!(header.marker);
        }

        #[test]
        fn serialize_produces_12_bytes() {
            let header = RtpHeader::new(96, 0, 0, 0);
            let bytes = header.serialize();
            assert_eq!(bytes.len(), 12);
        }

        #[test]
        fn serialize_version_in_high_bits() {
            let header = RtpHeader::new(96, 0, 0, 0);
            let bytes = header.serialize();
            // Version 2 in bits 6-7 = 0x80
            assert_eq!(bytes[0] & 0xC0, 0x80);
        }

        #[test]
        fn serialize_marker_in_correct_position() {
            let header = RtpHeader::new(96, 0, 0, 0).with_marker(true);
            let bytes = header.serialize();
            // Marker bit is bit 7 of byte 1
            assert_eq!(bytes[1] & 0x80, 0x80);

            let header = RtpHeader::new(96, 0, 0, 0).with_marker(false);
            let bytes = header.serialize();
            assert_eq!(bytes[1] & 0x80, 0x00);
        }

        #[test]
        fn parse_serialize_roundtrip() {
            let original = RtpHeader::new(96, 12345, 0xDEADBEEF, 0x12345678)
                .with_marker(true);

            let bytes = original.serialize();
            let parsed = RtpHeader::parse(&bytes).unwrap();

            assert_eq!(parsed.version, original.version);
            assert_eq!(parsed.marker, original.marker);
            assert_eq!(parsed.payload_type, original.payload_type);
            assert_eq!(parsed.sequence, original.sequence);
            assert_eq!(parsed.timestamp, original.timestamp);
            assert_eq!(parsed.ssrc, original.ssrc);
        }
    }

    mod rtp_packet {
        use super::*;

        #[test]
        fn new_creates_unencrypted_packet() {
            let header = RtpHeader::new(96, 0, 0, 0);
            let packet = RtpPacket::new(header, vec![1, 2, 3, 4]);

            assert!(packet.nonce.is_none());
            assert!(packet.tag.is_none());
            assert_eq!(packet.payload, vec![1, 2, 3, 4]);
        }

        #[test]
        fn serialize_unencrypted() {
            let header = RtpHeader::new(96, 0, 0, 0);
            let packet = RtpPacket::new(header, vec![1, 2, 3, 4]);
            let bytes = packet.serialize();

            // 12 header + 4 payload
            assert_eq!(bytes.len(), 16);
            assert_eq!(&bytes[12..], &[1, 2, 3, 4]);
        }

        #[test]
        fn serialize_encrypted_appends_tag_then_nonce() {
            let header = RtpHeader::new(96, 0, 0, 0);
            let mut packet = RtpPacket::new(header, vec![1, 2, 3, 4]);
            packet.nonce = Some([0xAA; 8]);
            packet.tag = Some([0xBB; 16]);

            let bytes = packet.serialize();

            // 12 header + 4 payload + 16 tag + 8 nonce = 40
            assert_eq!(bytes.len(), 40);

            // Tag comes first (at N-24)
            assert_eq!(&bytes[16..32], &[0xBB; 16]);
            // Nonce is last 8 bytes (at N-8)
            assert_eq!(&bytes[32..40], &[0xAA; 8]);
        }

        #[test]
        fn size_correct_for_unencrypted() {
            let header = RtpHeader::new(96, 0, 0, 0);
            let packet = RtpPacket::new(header, vec![0; 100]);
            assert_eq!(packet.size(), 12 + 100);
        }

        #[test]
        fn size_correct_for_encrypted() {
            let header = RtpHeader::new(96, 0, 0, 0);
            let mut packet = RtpPacket::new(header, vec![0; 100]);
            packet.nonce = Some([0; 8]);
            packet.tag = Some([0; 16]);
            assert_eq!(packet.size(), 12 + 100 + 8 + 16);
        }

        #[test]
        fn parse_serialize_roundtrip() {
            let original = RtpPacket::new(
                RtpHeader::new(96, 1234, 5678, 0xABCD),
                vec![1, 2, 3, 4, 5, 6, 7, 8],
            );

            let bytes = original.serialize();
            let parsed = RtpPacket::parse(&bytes).unwrap();

            assert_eq!(parsed.header.payload_type, original.header.payload_type);
            assert_eq!(parsed.header.sequence, original.header.sequence);
            assert_eq!(parsed.header.timestamp, original.header.timestamp);
            assert_eq!(parsed.payload, original.payload);
        }
    }

    mod rtp_sender {
        use super::*;

        #[test]
        fn new_starts_at_sequence_zero() {
            let addr: SocketAddr = "127.0.0.1:5000".parse().unwrap();
            let sender = RtpSender::new(addr, 1234);
            assert_eq!(sender.sequence(), 0);
        }

        #[test]
        fn bind_opens_udp_socket() {
            let addr: SocketAddr = "127.0.0.1:5000".parse().unwrap();
            let mut sender = RtpSender::new(addr, 1234);

            let port = sender.bind(0).unwrap();
            assert!(port > 0);
            assert_eq!(sender.local_port(), Some(port));
        }

        #[test]
        fn local_port_available_after_bind() {
            let addr: SocketAddr = "127.0.0.1:5000".parse().unwrap();
            let mut sender = RtpSender::new(addr, 1234);

            assert!(sender.local_port().is_none());

            sender.bind(0).unwrap();
            assert!(sender.local_port().is_some());
        }

        #[test]
        fn sync_sent_from_control_socket_not_data_socket() {
            // The receiver expects sync packets from our declared control port.
            // This test verifies that when a control_socket is set, sync packets
            // are sent from it (and thus from the correct source port), NOT from
            // the data socket.

            // Listener to receive the sync packet
            let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
            let listener_addr = listener.local_addr().unwrap();
            listener.set_read_timeout(Some(Duration::from_secs(1))).unwrap();

            // Create sender with data socket on one port
            let mut sender = RtpSender::new(listener_addr, 0xABCD);
            sender.set_control_dest(listener_addr);
            let data_port = sender.bind(0).unwrap();

            // Create a separate control socket on a DIFFERENT port
            let control_socket = UdpSocket::bind("127.0.0.1:0").unwrap();
            let control_port = control_socket.local_addr().unwrap().port();
            assert_ne!(data_port, control_port, "ports must differ for this test");
            sender.set_control_socket(control_socket);

            // Send a sync packet
            sender.send_sync(0, 0).unwrap();

            // Receive it and check the source port
            let mut buf = [0u8; 64];
            let (_len, src_addr) = listener.recv_from(&mut buf).unwrap();

            // Sync must arrive from the control port, NOT the data port
            assert_eq!(
                src_addr.port(), control_port,
                "sync packet came from port {} but expected control port {}",
                src_addr.port(), control_port
            );
            assert_ne!(
                src_addr.port(), data_port,
                "sync packet must NOT come from the data port"
            );
        }

        #[test]
        fn sync_falls_back_to_data_socket_without_control_socket() {
            // When no control_socket is set, sync should still work via the data socket.
            let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
            let listener_addr = listener.local_addr().unwrap();
            listener.set_read_timeout(Some(Duration::from_secs(1))).unwrap();

            let mut sender = RtpSender::new(listener_addr, 0xABCD);
            sender.set_control_dest(listener_addr);
            let data_port = sender.bind(0).unwrap();
            // No set_control_socket call

            sender.send_sync(0, 0).unwrap();

            let mut buf = [0u8; 64];
            let (_len, src_addr) = listener.recv_from(&mut buf).unwrap();

            // Falls back to data socket
            assert_eq!(src_addr.port(), data_port);
        }

        #[test]
        fn sync_packet_is_20_bytes_with_correct_format() {
            let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
            let listener_addr = listener.local_addr().unwrap();
            listener.set_read_timeout(Some(Duration::from_secs(1))).unwrap();

            let mut sender = RtpSender::new(listener_addr, 0xABCD);
            sender.set_control_dest(listener_addr);
            sender.bind(0).unwrap();

            let rtp_ts: u32 = 44100;
            let ntp_ts: u64 = 0xAAAABBBBCCCCDDDD;
            sender.send_sync(rtp_ts, ntp_ts).unwrap();

            let mut buf = [0u8; 64];
            let (len, _) = listener.recv_from(&mut buf).unwrap();

            assert_eq!(len, 20, "sync packet must be 20 bytes");

            // First sync: byte 0 = 0x90 (extension bit set)
            assert_eq!(buf[0], 0x90);
            // Byte 1: 0xD4 = marker (0x80) | PT 84 (0x54)
            assert_eq!(buf[1], 0xD4);
            // Bytes 4-7: RTP timestamp (big-endian)
            assert_eq!(&buf[4..8], &rtp_ts.to_be_bytes());
            // Bytes 8-15: NTP timestamp (big-endian)
            assert_eq!(&buf[8..16], &ntp_ts.to_be_bytes());
            // Bytes 16-19: RTP timestamp again
            assert_eq!(&buf[16..20], &rtp_ts.to_be_bytes());
        }

        #[test]
        fn second_sync_clears_extension_bit() {
            let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
            let listener_addr = listener.local_addr().unwrap();
            listener.set_read_timeout(Some(Duration::from_secs(1))).unwrap();

            let mut sender = RtpSender::new(listener_addr, 0xABCD);
            sender.set_control_dest(listener_addr);
            sender.bind(0).unwrap();

            // First sync
            sender.send_sync(0, 0).unwrap();
            let mut buf = [0u8; 64];
            listener.recv_from(&mut buf).unwrap();
            assert_eq!(buf[0], 0x90, "first sync should have extension bit");

            // Second sync
            sender.send_sync(352, 1000).unwrap();
            listener.recv_from(&mut buf).unwrap();
            assert_eq!(buf[0], 0x80, "subsequent syncs should NOT have extension bit");
        }
    }

    mod rtp_receiver {
        use super::*;

        #[test]
        fn bind_opens_udp_socket() {
            let mut receiver = RtpReceiver::new();
            let port = receiver.bind(0).unwrap();
            assert!(port > 0);
        }

        #[test]
        fn recv_timeout_returns_none_on_timeout() {
            let mut receiver = RtpReceiver::new();
            receiver.bind(0).unwrap();

            // Should return None on timeout, not error
            let result = receiver.recv_timeout(Duration::from_millis(10));
            assert!(result.is_ok());
            assert!(result.unwrap().is_none());
        }

        #[test]
        fn try_clone_socket_shares_port() {
            let mut receiver = RtpReceiver::new();
            let port = receiver.bind(0).unwrap();

            let cloned = receiver.try_clone_socket().unwrap().unwrap();
            let cloned_port = cloned.local_addr().unwrap().port();

            // Cloned socket must be on the same port (same underlying OS socket)
            assert_eq!(port, cloned_port);
        }

        #[test]
        fn try_clone_socket_returns_none_before_bind() {
            let receiver = RtpReceiver::new();
            let result = receiver.try_clone_socket().unwrap();
            assert!(result.is_none());
        }

        #[test]
        fn cloned_socket_can_send_from_control_port() {
            // This is the key integration test: verify that a cloned receiver socket
            // can be used by the sender to send sync packets from the control port.
            let mut receiver = RtpReceiver::new();
            let control_port = receiver.bind(0).unwrap();

            // Clone the socket for the sender
            let control_socket = receiver.try_clone_socket().unwrap().unwrap();

            // Set up a listener to receive the sync
            let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
            let listener_addr = listener.local_addr().unwrap();
            listener.set_read_timeout(Some(Duration::from_secs(1))).unwrap();

            // Create sender and give it the cloned control socket
            let mut sender = RtpSender::new(listener_addr, 0x1234);
            sender.set_control_dest(listener_addr);
            sender.bind(0).unwrap();
            sender.set_control_socket(control_socket);

            // Send sync
            sender.send_sync(0, 0).unwrap();

            // Verify it arrived from the control port
            let mut buf = [0u8; 64];
            let (_len, src_addr) = listener.recv_from(&mut buf).unwrap();
            assert_eq!(
                src_addr.port(), control_port,
                "sync must arrive from control port {}, got {}",
                control_port, src_addr.port()
            );
        }
    }

    mod packet_formats {
        use super::*;

        #[test]
        fn audio_packet_type_96() {
            assert_eq!(payload_types::AUDIO_REALTIME, 96);
        }

        #[test]
        fn buffered_audio_packet_type_103() {
            assert_eq!(payload_types::AUDIO_BUFFERED, 103);
        }

        #[test]
        fn sync_packet_type_84() {
            assert_eq!(payload_types::SYNC, 84);
        }

        #[test]
        fn timing_request_type_82() {
            assert_eq!(payload_types::TIMING_REQUEST, 82);
        }

        #[test]
        fn timing_response_type_83() {
            assert_eq!(payload_types::TIMING_RESPONSE, 83);
        }

        #[test]
        fn retransmit_request_type_85() {
            assert_eq!(payload_types::RETRANSMIT_REQUEST, 85);
        }

        #[test]
        fn retransmit_response_type_86() {
            assert_eq!(payload_types::RETRANSMIT_RESPONSE, 86);
        }
    }

    mod retransmit {
        use super::*;

        #[test]
        fn parse_retransmit_request() {
            // Build a type-85 retransmit request: 8-byte header (no SSRC) + 2-byte seq + 2-byte count
            let mut data = [0u8; 12];
            data[0] = 0x80; // V=2
            data[1] = 0x80 | payload_types::RETRANSMIT_REQUEST; // M=1, PT=85
            // Bytes 2-3: sequence (irrelevant for parsing)
            // Bytes 4-7: timestamp (irrelevant)
            // Bytes 8-9: first lost sequence = 100
            data[8..10].copy_from_slice(&100u16.to_be_bytes());
            // Bytes 10-11: count = 3
            data[10..12].copy_from_slice(&3u16.to_be_bytes());

            let req = RetransmitRequest::parse(&data).unwrap();
            assert_eq!(req.first_sequence, 100);
            assert_eq!(req.count, 3);
        }

        #[test]
        fn parse_retransmit_request_wrong_payload_type() {
            let mut data = [0u8; 12];
            data[0] = 0x80;
            data[1] = 0x80 | 96; // Wrong type (audio)
            assert!(RetransmitRequest::parse(&data).is_err());
        }

        #[test]
        fn parse_retransmit_request_too_short() {
            let data = [0u8; 8]; // Too short
            assert!(RetransmitRequest::parse(&data).is_err());
        }

        #[test]
        fn build_retransmit_response_wraps_original() {
            // Simulate an original audio packet (12-byte header + 4-byte payload)
            let header = RtpHeader::new(96, 42, 1000, 0xABCD);
            let original = RtpPacket::new(header, vec![0xDE, 0xAD, 0xBE, 0xEF]);
            let original_bytes = original.serialize();

            let response = build_retransmit_response(&original_bytes);

            // 4-byte retransmit header + original packet
            assert_eq!(response.len(), 4 + original_bytes.len());

            // Check retransmit header
            assert_eq!(response[0], 0x80); // V=2
            assert_eq!(response[1], 0x80 | payload_types::RETRANSMIT_RESPONSE); // M=1, PT=86

            // Bytes 2-3: original sequence number (42)
            let seq = u16::from_be_bytes([response[2], response[3]]);
            assert_eq!(seq, 42);

            // Rest is the original packet
            assert_eq!(&response[4..], &original_bytes);
        }

        #[test]
        fn reset_sync_state_clears_flag() {
            let addr: SocketAddr = "127.0.0.1:5000".parse().unwrap();
            let mut sender = RtpSender::new(addr, 1234);
            sender.first_sync_sent = true;
            sender.reset_sync_state();
            assert!(!sender.first_sync_sent);
        }
    }

    mod ptp_sync {
        use super::*;

        #[test]
        fn ptp_sync_constant_is_87() {
            assert_eq!(payload_types::PTP_SYNC, 87);
        }

        #[test]
        fn ptp_sync_packet_is_28_bytes() {
            let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
            let listener_addr = listener.local_addr().unwrap();
            listener.set_read_timeout(Some(Duration::from_secs(1))).unwrap();

            let mut sender = RtpSender::new(listener_addr, 0xABCD);
            sender.set_control_dest(listener_addr);
            sender.bind(0).unwrap();

            let clock_id = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11];
            sender.send_ptp_sync(44100, 188_748_000_000_000, 44100 + 352, &clock_id).unwrap();

            let mut buf = [0u8; 64];
            let (len, _) = listener.recv_from(&mut buf).unwrap();
            assert_eq!(len, 28, "PTP sync packet must be 28 bytes");
        }

        #[test]
        fn ptp_sync_has_pt_87() {
            let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
            let listener_addr = listener.local_addr().unwrap();
            listener.set_read_timeout(Some(Duration::from_secs(1))).unwrap();

            let mut sender = RtpSender::new(listener_addr, 0xABCD);
            sender.set_control_dest(listener_addr);
            sender.bind(0).unwrap();

            let clock_id = [0x01; 8];
            sender.send_ptp_sync(0, 0, 0, &clock_id).unwrap();

            let mut buf = [0u8; 64];
            listener.recv_from(&mut buf).unwrap();

            // Byte 1: 0xD7 = marker (0x80) | PT 87 (0x57)
            assert_eq!(buf[1], 0xD7);
            // Verify PT extraction
            assert_eq!(buf[1] & 0x7F, payload_types::PTP_SYNC);
        }

        #[test]
        fn ptp_sync_first_has_extension_bit() {
            let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
            let listener_addr = listener.local_addr().unwrap();
            listener.set_read_timeout(Some(Duration::from_secs(1))).unwrap();

            let mut sender = RtpSender::new(listener_addr, 0xABCD);
            sender.set_control_dest(listener_addr);
            sender.bind(0).unwrap();

            let clock_id = [0x01; 8];

            // First PTP sync: extension bit set
            sender.send_ptp_sync(0, 0, 0, &clock_id).unwrap();
            let mut buf = [0u8; 64];
            listener.recv_from(&mut buf).unwrap();
            assert_eq!(buf[0], 0x90, "first PTP sync should have extension bit");

            // Second PTP sync: no extension bit
            sender.send_ptp_sync(352, 1000000000, 704, &clock_id).unwrap();
            listener.recv_from(&mut buf).unwrap();
            assert_eq!(buf[0], 0x80, "subsequent PTP syncs should NOT have extension bit");
        }

        #[test]
        fn ptp_sync_timestamp_encoding() {
            let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
            let listener_addr = listener.local_addr().unwrap();
            listener.set_read_timeout(Some(Duration::from_secs(1))).unwrap();

            let mut sender = RtpSender::new(listener_addr, 0xABCD);
            sender.set_control_dest(listener_addr);
            sender.bind(0).unwrap();

            let clock_id = [0x01; 8];
            // 188748.5 seconds = 188748500000000 ns
            let ptp_ns: u64 = 188_748_500_000_000;
            sender.send_ptp_sync(44100, ptp_ns, 44452, &clock_id).unwrap();

            let mut buf = [0u8; 64];
            listener.recv_from(&mut buf).unwrap();

            // Bytes 8-11: PTP seconds
            let secs = u32::from_be_bytes([buf[8], buf[9], buf[10], buf[11]]);
            assert_eq!(secs, 188748, "PTP seconds should be device uptime");

            // Bytes 12-15: PTP fraction (0.5s = 0x80000000)
            let frac = u32::from_be_bytes([buf[12], buf[13], buf[14], buf[15]]);
            assert_eq!(frac, 0x80000000, "PTP fraction for 0.5s should be 0x80000000");
        }

        #[test]
        fn ptp_sync_clock_id_placement() {
            let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
            let listener_addr = listener.local_addr().unwrap();
            listener.set_read_timeout(Some(Duration::from_secs(1))).unwrap();

            let mut sender = RtpSender::new(listener_addr, 0xABCD);
            sender.set_control_dest(listener_addr);
            sender.bind(0).unwrap();

            let clock_id: [u8; 8] = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11];
            sender.send_ptp_sync(0, 0, 0, &clock_id).unwrap();

            let mut buf = [0u8; 64];
            listener.recv_from(&mut buf).unwrap();

            // Bytes 20-27: master clock ID
            assert_eq!(&buf[20..28], &clock_id, "master clock ID must be in bytes 20-27");
        }

        #[test]
        fn ptp_sync_rtp_timestamps() {
            let listener = UdpSocket::bind("127.0.0.1:0").unwrap();
            let listener_addr = listener.local_addr().unwrap();
            listener.set_read_timeout(Some(Duration::from_secs(1))).unwrap();

            let mut sender = RtpSender::new(listener_addr, 0xABCD);
            sender.set_control_dest(listener_addr);
            sender.bind(0).unwrap();

            let clock_id = [0x01; 8];
            let current_rtp: u32 = 44100;
            let next_rtp: u32 = 44452;
            sender.send_ptp_sync(current_rtp, 0, next_rtp, &clock_id).unwrap();

            let mut buf = [0u8; 64];
            listener.recv_from(&mut buf).unwrap();

            // Bytes 4-7: current RTP timestamp
            let got_current = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
            assert_eq!(got_current, current_rtp);

            // Bytes 16-19: next RTP timestamp
            let got_next = u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]]);
            assert_eq!(got_next, next_rtp);
        }

        #[test]
        fn prepare_ptp_sync_returns_none_for_port_zero() {
            let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
            let mut sender = RtpSender::new(addr, 0xABCD);
            // control_dest port is 0

            let clock_id = [0x01; 8];
            let result = sender.prepare_ptp_sync(0, 0, 0, &clock_id).unwrap();
            assert!(result.is_none());
        }
    }
}
