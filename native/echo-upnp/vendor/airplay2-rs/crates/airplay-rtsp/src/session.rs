//! RTSP session management.

use airplay_core::error::{Result, RtspError};
use airplay_core::stream::TimingProtocol;
use airplay_core::{Device, StreamConfig};
use rand::Rng;
use uuid::Uuid;

use crate::plist_codec::{
    self, SetupPhase1Request, SetupPhase1Response, SetupPhase2Request, SetupPhase2Response,
    StreamDef, TimingPeerInfo,
};

/// Session state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// Not connected.
    Disconnected,
    /// Connected, awaiting pairing.
    Connected,
    /// Pairing complete, awaiting setup.
    Paired,
    /// Setup phase 1 complete.
    SetupPhase1,
    /// Setup phase 2 complete, ready to stream.
    Ready,
    /// Currently streaming.
    Playing,
    /// Paused.
    Paused,
    /// Tearing down.
    TearingDown,
}

/// Ports allocated during SETUP.
#[derive(Debug, Clone, Copy)]
pub struct SessionPorts {
    pub data_port: u16,
    pub control_port: u16,
    pub timing_port: u16,
    pub event_port: u16,
}

/// Active RTSP session with a receiver.
pub struct RtspSession {
    session_id: Uuid,
    group_uuid: Uuid,
    state: SessionState,
    device: Device,
    client_device_id: String,
    stream_config: StreamConfig,
    ports: Option<SessionPorts>,
    /// Our local control port for receiving control messages
    local_control_port: u16,
    /// Stream connection ID (random u32, separate from session UUID)
    stream_connection_id: u32,
    /// Encryption IV (16 bytes) for audio stream
    eiv: [u8; 16],
    /// Encryption key (32 bytes wrapped with Curve25519 = 72 bytes)
    ekey: [u8; 72],
    /// Stream encryption key (32 bytes) for ChaCha20-Poly1305
    shk: [u8; 32],
    /// RTSP request host (local IP used in request URI)
    request_host: Option<String>,
}

impl RtspSession {
    /// Create new session for device.
    pub fn new(device: Device, stream_config: StreamConfig) -> Self {
        let mut rng = rand::thread_rng();

        // Generate random encryption keys
        let mut eiv = [0u8; 16];
        let mut ekey = [0u8; 72];
        let mut shk = [0u8; 32];
        rng.fill(&mut eiv);
        // rand's Fill trait doesn't support arrays > 32 bytes, so fill in chunks
        rng.fill(&mut ekey[..32]);
        rng.fill(&mut ekey[32..64]);
        rng.fill(&mut ekey[64..]);
        rng.fill(&mut shk);

        // Generate random local control port (ephemeral range)
        let local_control_port = rng.gen_range(49152..65535);

        // Generate random stream connection ID (separate from session UUID)
        let stream_connection_id: u32 = rng.gen();

        let client_device_id = device.id.to_mac_string();

        Self {
            session_id: Uuid::new_v4(),
            group_uuid: device.group_id.unwrap_or_else(Uuid::new_v4),
            state: SessionState::Disconnected,
            device,
            client_device_id,
            stream_config,
            ports: None,
            local_control_port,
            stream_connection_id,
            eiv,
            ekey,
            shk,
            request_host: None,
        }
    }

    /// Get session UUID.
    pub fn id(&self) -> Uuid {
        self.session_id
    }

    /// Get current state.
    pub fn state(&self) -> SessionState {
        self.state
    }

    /// Get device.
    pub fn device(&self) -> &Device {
        &self.device
    }

    /// Override the client device ID used in SETUP.
    pub fn set_client_device_id(&mut self, device_id: String) {
        self.client_device_id = device_id;
    }

    /// Set the host used in RTSP request URIs (typically local IP).
    pub fn set_request_host(&mut self, host: String) {
        self.request_host = Some(host);
    }

    /// Set the local control port (after binding a real UDP socket).
    pub fn set_local_control_port(&mut self, port: u16) {
        self.local_control_port = port;
    }

    /// Build RTSP request URI for this session.
    ///
    /// The session UUID in the URI must match the case of sessionUUID in the plist payload.
    /// We use uppercase to match the sessionUUID field in SetupPhase1Request.
    pub fn request_uri(&self) -> String {
        let host = self.request_host.as_deref().unwrap_or("local");
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{}]", host)
        } else {
            host.to_string()
        };
        // Use uppercase UUID to match sessionUUID in plist payload
        format!("rtsp://{}/{}", host, self.session_id.to_string().to_uppercase())
    }

    /// Get stream config.
    pub fn stream_config(&self) -> &StreamConfig {
        &self.stream_config
    }

    /// Get allocated ports (after setup).
    pub fn ports(&self) -> Option<&SessionPorts> {
        self.ports.as_ref()
    }

    /// Get the stream encryption key (for audio encryption).
    pub fn stream_key(&self) -> &[u8; 32] {
        &self.shk
    }

    /// Override stream encryption key (HomeKit shared secret).
    pub fn set_stream_key(&mut self, shk: [u8; 32]) {
        self.shk = shk;
    }

    /// Override stream encryption keys (FairPlay-derived).
    pub fn set_stream_keys(&mut self, ekey: [u8; 72], eiv: [u8; 16], shk: [u8; 32]) {
        self.ekey = ekey;
        self.eiv = eiv;
        self.shk = shk;
    }

    /// Transition to connected state.
    pub fn set_connected(&mut self) -> Result<()> {
        if self.state != SessionState::Disconnected {
            return Err(RtspError::SetupFailed(format!(
                "Cannot connect from state {:?}",
                self.state
            ))
            .into());
        }
        self.state = SessionState::Connected;
        Ok(())
    }

    /// Transition to paired state.
    pub fn set_paired(&mut self) -> Result<()> {
        if self.state != SessionState::Connected {
            return Err(RtspError::SetupFailed(format!(
                "Cannot pair from state {:?}",
                self.state
            ))
            .into());
        }
        self.state = SessionState::Paired;
        Ok(())
    }

    /// Build ANNOUNCE request body (SDP) for AirPlay 1 (NTP) mode.
    ///
    /// The SDP declares codec parameters so the receiver can configure its
    /// audio pipeline before SETUP. Only needed for NTP timing; AirPlay 2
    /// (PTP) uses plist-based SETUP phases instead.
    ///
    /// `local_ip` is the sender's IP address (from the RTSP TCP connection).
    pub fn build_announce_sdp(&self, local_ip: &str) -> Result<Vec<u8>> {
        let remote_ip = self
            .device
            .addresses
            .first()
            .map(|a| a.to_string())
            .unwrap_or_else(|| "0.0.0.0".to_string());

        crate::sdp::SdpBuilder::new(
            self.stream_connection_id,
            local_ip.to_string(),
            remote_ip,
            self.stream_config.audio_format.clone(),
            self.stream_config.latency_min,
        )
        .build()
    }

    /// Build SETUP phase 1 request body (binary plist).
    ///
    /// Uses the minimal owntone-style payload with only 4 fields:
    /// - deviceID
    /// - sessionUUID
    /// - timingPort (must be a real UDP port, not 0)
    /// - timingProtocol ("NTP" or "PTP")
    ///
    /// `local_timing_port` should be the port of a pre-bound UDP socket
    /// that will be used for timing synchronization.
    pub fn build_setup_phase1(&self, local_timing_port: u16, local_addresses: Option<Vec<String>>) -> Result<Vec<u8>> {
        let timing_protocol = match self.stream_config.timing_protocol {
            TimingProtocol::Ntp => "NTP",
            TimingProtocol::Ptp => "PTP",
        };

        // Build timing peer info for PTP — must contain the SENDER's addresses
        // so the receiver knows where to find our PTP master clock.
        let (timing_peer_info, timing_peer_list) = if self.stream_config.timing_protocol == TimingProtocol::Ptp {
            let addresses = local_addresses.unwrap_or_default();

            let peer_info = TimingPeerInfo {
                addresses,
                id: self.session_id.to_string(),
                supports_clock_port_matching_override: true,
            };
            let peer_list = vec![peer_info.clone()];
            (Some(peer_info), Some(peer_list))
        } else {
            (None, None)
        };

        let request = SetupPhase1Request {
            device_id: self.client_device_id.clone(),
            session_uuid: self.session_id.to_string().to_uppercase(),
            timing_port: local_timing_port,
            timing_protocol: timing_protocol.to_string(),
            timing_peer_info,
            timing_peer_list,
        };

        tracing::debug!(
            device_id = %request.device_id,
            session_uuid = %request.session_uuid,
            timing_port = request.timing_port,
            timing_protocol = %request.timing_protocol,
            has_timing_peer_info = request.timing_peer_info.is_some(),
            "SETUP phase1 payload (minimal owntone-style)"
        );

        // Log the full plist for debugging
        let encoded = plist_codec::encode(&request)?;
        if let Ok(dict) = plist_codec::decode::<plist::Dictionary>(&encoded) {
            tracing::debug!("SETUP phase1 plist keys: {:?}", dict.keys().collect::<Vec<_>>());
            // Log the decoded values
            for (key, value) in dict.iter() {
                match value {
                    plist::Value::String(s) => tracing::debug!("  {}: \"{}\"", key, s),
                    plist::Value::Integer(i) => tracing::debug!("  {}: {}", key, i.as_unsigned().unwrap_or(0)),
                    _ => tracing::debug!("  {}: {:?}", key, value),
                }
            }
        }
        // Log first 64 bytes of the binary plist
        let hex: String = encoded.iter().take(64).map(|b| format!("{:02x}", b)).collect();
        tracing::debug!("SETUP phase1 plist hex (first 64 bytes): {}", hex);

        Ok(encoded)
    }

    /// Process SETUP phase 1 response.
    pub fn process_setup_phase1_response(&mut self, response: &[u8]) -> Result<()> {
        if self.state != SessionState::Paired {
            return Err(RtspError::SetupFailed(format!(
                "Cannot process phase 1 from state {:?}",
                self.state
            ))
            .into());
        }

        let phase1_response: SetupPhase1Response = plist_codec::decode(response)?;

        tracing::info!(
            "SETUP phase 1 response: event_port={}, timing_port={}, has_timing_peer_info={}",
            phase1_response.event_port,
            phase1_response.timing_port,
            phase1_response.timing_peer_info.is_some()
        );

        // Log receiver's timing peer info (important for PTP)
        if let Some(ref peer_info) = phase1_response.timing_peer_info {
            tracing::info!(
                "Receiver timing peer info: addresses={:?}, id={}",
                peer_info.addresses,
                peer_info.id
            );
            // For PTP: timing_port should be 0 (PTP uses ports 319/320 directly)
            if self.stream_config.timing_protocol == TimingProtocol::Ptp && phase1_response.timing_port != 0 {
                tracing::warn!(
                    "Receiver reported timing_port={} for PTP (expected 0)",
                    phase1_response.timing_port
                );
            }
        }

        // Store the ports from phase 1 (data and control will come in phase 2)
        self.ports = Some(SessionPorts {
            data_port: 0,    // Will be set in phase 2
            control_port: 0, // Will be set in phase 2
            timing_port: phase1_response.timing_port,
            event_port: phase1_response.event_port,
        });

        self.state = SessionState::SetupPhase1;
        Ok(())
    }

    /// Build SETUP phase 2 request body (binary plist).
    pub fn build_setup_phase2(&self) -> Result<Vec<u8>> {
        use airplay_core::codec::AudioCodec;

        if self.state != SessionState::SetupPhase1 {
            return Err(RtspError::SetupFailed(format!(
                "Cannot build phase 2 from state {:?}",
                self.state
            ))
            .into());
        }

        // Generate AudioSpecificConfig for AAC codecs.
        // Use ASC from StreamConfig if provided (e.g. ALAC magic cookie),
        // otherwise generate for AAC if needed
        let asc = if let Some(ref asc) = self.stream_config.asc {
            Some(asc.clone())
        } else {
            match self.stream_config.audio_format.codec {
                AudioCodec::Aac | AudioCodec::AacEld => {
                    // ASC is a 2-byte value that tells the receiver how to decode AAC audio:
                    // - Object type (AAC-LC = 2) in 5 bits
                    // - Sample rate index in 4 bits
                    // - Channel configuration in 4 bits
                    // For 44100Hz stereo AAC-LC: 0x12, 0x10
                    // Object type: AAC-LC = 2 (5 bits)
                    // Sample rate index: 4 = 44100Hz (4 bits)
                    // Channel config: 2 = stereo (4 bits)
                    // Byte 0: (object_type << 3) | (sample_rate_index >> 1) = (2 << 3) | (4 >> 1) = 0x12
                    // Byte 1: ((sample_rate_index & 1) << 7) | (channel_config << 3) = ((4 & 1) << 7) | (2 << 3) = 0x10
                    Some(vec![0x12, 0x10])
                }
                _ => None,
            }
        };

        let stream_def = StreamDef {
            stream_type: self.stream_config.stream_type as u32,
            audio_format: self.stream_config.audio_format.codec.audio_format_value(),
            audio_mode: "default".to_string(),
            sample_rate: self.stream_config.audio_format.sample_rate.as_hz(),
            ct: self.stream_config.audio_format.codec.compression_type(),
            control_port: self.local_control_port,
            is_media: true,
            latency_min: self.stream_config.latency_min,
            latency_max: self.stream_config.latency_max,
            shk: self.shk.to_vec(),
            asc,
            spf: self.stream_config.audio_format.frames_per_packet,
            supports_dynamic_stream_id: self.stream_config.supports_dynamic_stream_id,
            stream_connection_id: self.stream_connection_id,
        };

        let request = SetupPhase2Request {
            streams: vec![stream_def],
        };

        tracing::debug!(
            stream_type = request.streams[0].stream_type,
            audio_format = request.streams[0].audio_format,
            sample_rate = request.streams[0].sample_rate,
            ct = request.streams[0].ct,
            control_port = request.streams[0].control_port,
            latency_min = request.streams[0].latency_min,
            latency_max = request.streams[0].latency_max,
            spf = request.streams[0].spf,
            has_asc = request.streams[0].asc.is_some(),
            asc = ?request.streams[0].asc,
            stream_connection_id = self.stream_connection_id,
            "SETUP phase2 payload"
        );
        tracing::debug!("SETUP phase2 shk (first 8 bytes): {:02x?}", &self.shk[..8]);

        plist_codec::encode(&request)
    }

    /// Process SETUP phase 2 response.
    pub fn process_setup_phase2_response(&mut self, response: &[u8]) -> Result<()> {
        if self.state != SessionState::SetupPhase1 {
            return Err(RtspError::SetupFailed(format!(
                "Cannot process phase 2 from state {:?}",
                self.state
            ))
            .into());
        }

        let phase2_response: SetupPhase2Response = plist_codec::decode(response)?;

        // Debug: log the raw response
        if let Ok(raw) = plist::from_bytes::<plist::Dictionary>(response) {
            tracing::debug!("SETUP phase2 response raw: {:?}", raw);
        }

        // Find our audio stream in the response
        let audio_stream = phase2_response
            .streams
            .iter()
            .find(|s| s.stream_type == self.stream_config.stream_type as u32)
            .ok_or_else(|| {
                RtspError::SetupFailed("No matching stream in phase 2 response".to_string())
            })?;

        // Update ports with the actual data/control ports
        tracing::debug!(
            "SETUP phase2 response stream: type={}, data_port={}, control_port={}, stream_id={}",
            audio_stream.stream_type,
            audio_stream.data_port,
            audio_stream.control_port,
            audio_stream.stream_id
        );

        if let Some(ref mut ports) = self.ports {
            ports.data_port = audio_stream.data_port;
            ports.control_port = audio_stream.control_port;
        }

        self.state = SessionState::Ready;
        Ok(())
    }

    /// Transition to playing state.
    pub fn start_playing(&mut self) -> Result<()> {
        if self.state != SessionState::Ready && self.state != SessionState::Paused {
            return Err(RtspError::SetupFailed(format!(
                "Cannot start playing from state {:?}",
                self.state
            ))
            .into());
        }
        self.state = SessionState::Playing;
        Ok(())
    }

    /// Transition to paused state.
    pub fn pause(&mut self) -> Result<()> {
        if self.state != SessionState::Playing {
            return Err(RtspError::SetupFailed(format!(
                "Cannot pause from state {:?}",
                self.state
            ))
            .into());
        }
        self.state = SessionState::Paused;
        Ok(())
    }

    /// Transition to tearing down state.
    pub fn start_teardown(&mut self) -> Result<()> {
        // Can teardown from most states
        match self.state {
            SessionState::Disconnected => {
                return Err(RtspError::SetupFailed("Not connected".to_string()).into());
            }
            SessionState::TearingDown => {
                return Err(RtspError::SetupFailed("Already tearing down".to_string()).into());
            }
            _ => {}
        }
        self.state = SessionState::TearingDown;
        Ok(())
    }

    /// Build SET_PARAMETER request for volume.
    pub fn build_set_volume(&self, volume: f32) -> Result<Vec<u8>> {
        // Volume is sent as text/parameters: "volume: -xx.xx"
        // AirPlay uses a dB scale; use -144 for mute.
        let volume_db = if volume <= 0.0 {
            -144.0_f32 // Mute
        } else if volume >= 1.0 {
            0.0_f32 // Max volume
        } else {
            20.0 * volume.log10()
        };
        Ok(format!("volume: {:.2}\r\n", volume_db).into_bytes())
    }

    /// Build SETPEERS request for multi-room.
    pub fn build_setpeers(&self, peer_addresses: &[String]) -> Result<Vec<u8>> {
        // SETPEERS body is a simple plist array of peer addresses
        plist_codec::encode(&peer_addresses.to_vec())
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use airplay_core::device::DeviceId;
    use airplay_core::features::Features;
    use airplay_core::stream::StreamType;
    use std::net::IpAddr;

    fn make_test_device() -> Device {
        Device {
            id: DeviceId([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]),
            name: "Test Device".to_string(),
            model: "AppleTV5,3".to_string(),
            manufacturer: None,
            serial_number: None,
            addresses: vec!["192.168.1.100".parse::<IpAddr>().unwrap()],
            port: 7000,
            features: Features::default(),
            required_sender_features: None,
            public_key: None,
            source_version: airplay_core::device::Version::default(),
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

    mod session_creation {
        use super::*;

        #[test]
        fn new_generates_unique_session_id() {
            let device = make_test_device();
            let session1 = RtspSession::new(device.clone(), StreamConfig::default());
            let session2 = RtspSession::new(device, StreamConfig::default());

            assert_ne!(session1.id(), session2.id());
        }

        #[test]
        fn new_starts_disconnected() {
            let device = make_test_device();
            let session = RtspSession::new(device, StreamConfig::default());

            assert_eq!(session.state(), SessionState::Disconnected);
        }

        #[test]
        fn new_stores_device_and_config() {
            let device = make_test_device();
            let config = StreamConfig::airplay2_buffered();
            let session = RtspSession::new(device.clone(), config.clone());

            assert_eq!(session.device().name, device.name);
            assert_eq!(
                session.stream_config().stream_type,
                StreamType::Buffered
            );
        }
    }

    mod state_transitions {
        use super::*;

        #[test]
        fn disconnected_to_connected() {
            let device = make_test_device();
            let mut session = RtspSession::new(device, StreamConfig::default());

            assert!(session.set_connected().is_ok());
            assert_eq!(session.state(), SessionState::Connected);
        }

        #[test]
        fn connected_to_paired() {
            let device = make_test_device();
            let mut session = RtspSession::new(device, StreamConfig::default());

            session.set_connected().unwrap();
            assert!(session.set_paired().is_ok());
            assert_eq!(session.state(), SessionState::Paired);
        }

        #[test]
        fn paired_to_setup_phase1() {
            let device = make_test_device();
            let mut session = RtspSession::new(device, StreamConfig::default());

            session.set_connected().unwrap();
            session.set_paired().unwrap();

            // Create a mock phase 1 response
            let response = SetupPhase1Response {
                event_port: 58168,
                timing_port: 58169,
                timing_peer_info: None,
            };
            let response_data = plist_codec::encode(&response).unwrap();

            assert!(session.process_setup_phase1_response(&response_data).is_ok());
            assert_eq!(session.state(), SessionState::SetupPhase1);
        }

        #[test]
        fn setup_phase1_to_ready() {
            let device = make_test_device();
            let mut session = RtspSession::new(device, StreamConfig::default());

            session.set_connected().unwrap();
            session.set_paired().unwrap();

            // Phase 1
            let response1 = SetupPhase1Response {
                event_port: 58168,
                timing_port: 58169,
                timing_peer_info: None,
            };
            session
                .process_setup_phase1_response(&plist_codec::encode(&response1).unwrap())
                .unwrap();

            // Phase 2
            let response2 = SetupPhase2Response {
                streams: vec![crate::plist_codec::StreamResponse {
                    stream_type: 96,
                    data_port: 58170,
                    control_port: 58171,
                    stream_id: 1,
                }],
            };
            assert!(session
                .process_setup_phase2_response(&plist_codec::encode(&response2).unwrap())
                .is_ok());
            assert_eq!(session.state(), SessionState::Ready);
        }

        #[test]
        fn ready_to_playing() {
            let device = make_test_device();
            let mut session = RtspSession::new(device, StreamConfig::default());

            session.set_connected().unwrap();
            session.set_paired().unwrap();

            // Complete setup
            let response1 = SetupPhase1Response {
                event_port: 58168,
                timing_port: 58169,
                timing_peer_info: None,
            };
            session
                .process_setup_phase1_response(&plist_codec::encode(&response1).unwrap())
                .unwrap();

            let response2 = SetupPhase2Response {
                streams: vec![crate::plist_codec::StreamResponse {
                    stream_type: 96,
                    data_port: 58170,
                    control_port: 58171,
                    stream_id: 1,
                }],
            };
            session
                .process_setup_phase2_response(&plist_codec::encode(&response2).unwrap())
                .unwrap();

            assert!(session.start_playing().is_ok());
            assert_eq!(session.state(), SessionState::Playing);
        }

        #[test]
        fn playing_to_paused() {
            let device = make_test_device();
            let mut session = RtspSession::new(device, StreamConfig::default());

            // Setup to playing
            session.set_connected().unwrap();
            session.set_paired().unwrap();

            let response1 = SetupPhase1Response {
                event_port: 58168,
                timing_port: 58169,
                timing_peer_info: None,
            };
            session
                .process_setup_phase1_response(&plist_codec::encode(&response1).unwrap())
                .unwrap();

            let response2 = SetupPhase2Response {
                streams: vec![crate::plist_codec::StreamResponse {
                    stream_type: 96,
                    data_port: 58170,
                    control_port: 58171,
                    stream_id: 1,
                }],
            };
            session
                .process_setup_phase2_response(&plist_codec::encode(&response2).unwrap())
                .unwrap();

            session.start_playing().unwrap();

            assert!(session.pause().is_ok());
            assert_eq!(session.state(), SessionState::Paused);
        }

        #[test]
        fn invalid_transitions_error() {
            let device = make_test_device();
            let mut session = RtspSession::new(device, StreamConfig::default());

            // Can't pair before connecting
            assert!(session.set_paired().is_err());

            // Can't start playing before setup
            assert!(session.start_playing().is_err());

            // Can't pause before playing
            assert!(session.pause().is_err());
        }
    }

    mod setup_phase1 {
        use super::*;

        #[test]
        fn build_setup_phase1_includes_device_id() {
            let device = make_test_device();
            let session = RtspSession::new(device, StreamConfig::default());

            // Pass a timing port (e.g., 7011)
            let data = session.build_setup_phase1(7011, None).unwrap();
            let decoded: plist::Dictionary = plist_codec::decode(&data).unwrap();

            assert_eq!(
                decoded.get("deviceID").and_then(|v| v.as_string()),
                Some("AA:BB:CC:DD:EE:FF")
            );
        }

        #[test]
        fn build_setup_phase1_includes_timing_protocol() {
            let device = make_test_device();

            // NTP timing
            let session = RtspSession::new(device.clone(), StreamConfig::default());
            let data = session.build_setup_phase1(7011, None).unwrap();
            let decoded: plist::Dictionary = plist_codec::decode(&data).unwrap();
            assert_eq!(
                decoded.get("timingProtocol").and_then(|v| v.as_string()),
                Some("NTP")
            );

            // PTP timing
            let mut config = StreamConfig::default();
            config.timing_protocol = TimingProtocol::Ptp;
            let session = RtspSession::new(device, config);
            let data = session.build_setup_phase1(7011, None).unwrap();
            let decoded: plist::Dictionary = plist_codec::decode(&data).unwrap();
            assert_eq!(
                decoded.get("timingProtocol").and_then(|v| v.as_string()),
                Some("PTP")
            );
        }

        #[test]
        fn build_setup_phase1_includes_timing_port() {
            let device = make_test_device();
            let session = RtspSession::new(device, StreamConfig::default());

            let data = session.build_setup_phase1(54321, None).unwrap();
            let decoded: plist::Dictionary = plist_codec::decode(&data).unwrap();

            // timingPort should be the port we passed
            assert_eq!(
                decoded.get("timingPort").and_then(|v| v.as_unsigned_integer()),
                Some(54321)
            );
        }

        #[test]
        fn build_setup_phase1_minimal_fields() {
            // Verify we only include the 4 minimal fields (plus optional timingPeerInfo for PTP)
            let device = make_test_device();
            let session = RtspSession::new(device, StreamConfig::default());

            let data = session.build_setup_phase1(7011, None).unwrap();
            let decoded: plist::Dictionary = plist_codec::decode(&data).unwrap();

            // Should have exactly 4 keys for NTP
            let keys: Vec<_> = decoded.keys().collect();
            assert_eq!(keys.len(), 4, "Expected 4 keys, got {:?}", keys);
            assert!(decoded.contains_key("deviceID"));
            assert!(decoded.contains_key("sessionUUID"));
            assert!(decoded.contains_key("timingPort"));
            assert!(decoded.contains_key("timingProtocol"));

            // Should NOT have the old fields
            assert!(!decoded.contains_key("eiv"), "Should not have eiv");
            assert!(!decoded.contains_key("ekey"), "Should not have ekey");
            assert!(!decoded.contains_key("et"), "Should not have et");
            assert!(!decoded.contains_key("groupUUID"), "Should not have groupUUID");
            assert!(!decoded.contains_key("macAddress"), "Should not have macAddress");
            assert!(!decoded.contains_key("model"), "Should not have model");
            assert!(!decoded.contains_key("name"), "Should not have name");
            assert!(!decoded.contains_key("sourceVersion"), "Should not have sourceVersion");
        }

        #[test]
        fn process_response_extracts_event_port() {
            let device = make_test_device();
            let mut session = RtspSession::new(device, StreamConfig::default());
            session.set_connected().unwrap();
            session.set_paired().unwrap();

            let response = SetupPhase1Response {
                event_port: 58168,
                timing_port: 58169,
                timing_peer_info: None,
            };
            let response_data = plist_codec::encode(&response).unwrap();

            session.process_setup_phase1_response(&response_data).unwrap();

            assert_eq!(session.ports().unwrap().event_port, 58168);
        }

        #[test]
        fn process_response_extracts_timing_port() {
            let device = make_test_device();
            let mut session = RtspSession::new(device, StreamConfig::default());
            session.set_connected().unwrap();
            session.set_paired().unwrap();

            let response = SetupPhase1Response {
                event_port: 58168,
                timing_port: 58169,
                timing_peer_info: None,
            };
            let response_data = plist_codec::encode(&response).unwrap();

            session.process_setup_phase1_response(&response_data).unwrap();

            assert_eq!(session.ports().unwrap().timing_port, 58169);
        }
    }

    mod setup_phase2 {
        use super::*;

        fn setup_phase1(session: &mut RtspSession) {
            session.set_connected().unwrap();
            session.set_paired().unwrap();

            let response = SetupPhase1Response {
                event_port: 58168,
                timing_port: 58169,
                timing_peer_info: None,
            };
            session
                .process_setup_phase1_response(&plist_codec::encode(&response).unwrap())
                .unwrap();
        }

        #[test]
        fn build_setup_phase2_includes_streams() {
            let device = make_test_device();
            let mut session = RtspSession::new(device, StreamConfig::default());
            setup_phase1(&mut session);

            let data = session.build_setup_phase2().unwrap();
            let decoded: plist::Dictionary = plist_codec::decode(&data).unwrap();

            let streams = decoded.get("streams").and_then(|v| v.as_array()).unwrap();
            assert_eq!(streams.len(), 1);
        }

        #[test]
        fn build_setup_phase2_includes_audio_format() {
            let device = make_test_device();
            let mut session = RtspSession::new(device, StreamConfig::default());
            setup_phase1(&mut session);

            let data = session.build_setup_phase2().unwrap();
            let decoded: plist::Dictionary = plist_codec::decode(&data).unwrap();

            let streams = decoded.get("streams").and_then(|v| v.as_array()).unwrap();
            let stream = streams[0].as_dictionary().unwrap();

            // Default is ALAC = 0x40000
            assert_eq!(
                stream.get("audioFormat").and_then(|v| v.as_unsigned_integer()),
                Some(0x40000)
            );
        }

        #[test]
        fn build_setup_phase2_includes_latency() {
            let device = make_test_device();
            let mut session = RtspSession::new(device, StreamConfig::default());
            setup_phase1(&mut session);

            let data = session.build_setup_phase2().unwrap();
            let decoded: plist::Dictionary = plist_codec::decode(&data).unwrap();

            let streams = decoded.get("streams").and_then(|v| v.as_array()).unwrap();
            let stream = streams[0].as_dictionary().unwrap();

            assert!(stream.get("latencyMin").is_some());
            assert!(stream.get("latencyMax").is_some());
        }

        #[test]
        fn process_response_extracts_data_port() {
            let device = make_test_device();
            let mut session = RtspSession::new(device, StreamConfig::default());
            setup_phase1(&mut session);

            let response = SetupPhase2Response {
                streams: vec![crate::plist_codec::StreamResponse {
                    stream_type: 96,
                    data_port: 58170,
                    control_port: 58171,
                    stream_id: 1,
                }],
            };
            session
                .process_setup_phase2_response(&plist_codec::encode(&response).unwrap())
                .unwrap();

            assert_eq!(session.ports().unwrap().data_port, 58170);
        }

        #[test]
        fn process_response_extracts_control_port() {
            let device = make_test_device();
            let mut session = RtspSession::new(device, StreamConfig::default());
            setup_phase1(&mut session);

            let response = SetupPhase2Response {
                streams: vec![crate::plist_codec::StreamResponse {
                    stream_type: 96,
                    data_port: 58170,
                    control_port: 58171,
                    stream_id: 1,
                }],
            };
            session
                .process_setup_phase2_response(&plist_codec::encode(&response).unwrap())
                .unwrap();

            assert_eq!(session.ports().unwrap().control_port, 58171);
        }
    }

    mod parameter_setting {
        use super::*;

        #[test]
        fn build_set_volume_valid_range() {
            let device = make_test_device();
            let session = RtspSession::new(device, StreamConfig::default());

            // Test various volume levels
            let data = session.build_set_volume(1.0).unwrap();
            let text = String::from_utf8(data).unwrap();
            assert!(text.starts_with("volume: 0.00")); // Max volume = 0 dB

            let data = session.build_set_volume(0.5).unwrap();
            let text = String::from_utf8(data).unwrap();
            assert!(text.starts_with("volume: -")); // Should be negative dB

            let data = session.build_set_volume(0.0).unwrap();
            let text = String::from_utf8(data).unwrap();
            assert!(text.starts_with("volume: -144.00")); // Mute = -144 dB
        }

        #[test]
        fn build_setpeers_includes_addresses() {
            let device = make_test_device();
            let session = RtspSession::new(device, StreamConfig::default());

            let peers = vec!["192.168.1.100".to_string(), "192.168.1.101".to_string()];
            let data = session.build_setpeers(&peers).unwrap();

            let decoded: Vec<String> = plist_codec::decode(&data).unwrap();
            assert_eq!(decoded.len(), 2);
            assert_eq!(decoded[0], "192.168.1.100");
            assert_eq!(decoded[1], "192.168.1.101");
        }
    }
}
