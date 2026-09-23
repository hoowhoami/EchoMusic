//! RAOP (AirPlay 1) session state machine.
//!
//! Manages the RAOP connection lifecycle: OPTIONS → ANNOUNCE → SETUP → RECORD → streaming.
//! Unlike AirPlay 2 which uses HomeKit pairing and two-phase SETUP with binary plists,
//! RAOP uses SDP-based ANNOUNCE and single-phase SETUP with Transport headers.

use airplay_core::error::{Result, RtspError};
use airplay_core::{AudioFormat, StreamConfig};
use rand::Rng;

/// RAOP session states.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RaopSessionState {
    /// Not connected.
    Disconnected,
    /// TCP connected, ready for OPTIONS.
    Connected,
    /// ANNOUNCE sent, codec declared.
    Announced,
    /// SETUP complete, ports negotiated.
    SetupComplete,
    /// RECORD sent, streaming audio.
    Playing,
    /// Paused (FLUSH sent).
    Paused,
    /// Tearing down.
    TearingDown,
}

/// Ports extracted from the SETUP response Transport header.
#[derive(Debug, Clone, Copy)]
pub struct RaopPorts {
    /// Receiver's audio data port.
    pub server_port: u16,
    /// Receiver's control port.
    pub control_port: u16,
    /// Receiver's timing port.
    pub timing_port: u16,
}

/// RAOP session managing AirPlay 1 connection state and crypto keys.
pub struct RaopSession {
    state: RaopSessionState,
    /// Random 128-bit AES key for audio encryption.
    aes_key: [u8; 16],
    /// Random 128-bit IV for AES-CBC.
    aes_iv: [u8; 16],
    /// Stream connection ID (random u32, used in SDP session).
    stream_connection_id: u32,
    /// Audio format configuration.
    audio_format: AudioFormat,
    /// Stream configuration.
    stream_config: StreamConfig,
    /// Ports from SETUP response.
    ports: Option<RaopPorts>,
    /// Our local control port (sender side).
    local_control_port: u16,
    /// Our local timing port (sender side).
    local_timing_port: u16,
    /// RTSP request host (local IP used in request URI).
    request_host: Option<String>,
    /// Client device ID (MAC format).
    client_device_id: String,
}

impl RaopSession {
    /// Create a new RAOP session with random AES key and IV.
    pub fn new(stream_config: StreamConfig, client_device_id: String) -> Self {
        let mut rng = rand::thread_rng();

        let mut aes_key = [0u8; 16];
        let mut aes_iv = [0u8; 16];
        rng.fill(&mut aes_key);
        rng.fill(&mut aes_iv);

        let stream_connection_id: u32 = rng.gen();
        let local_control_port = rng.gen_range(49152..65535);
        let local_timing_port = rng.gen_range(49152..65535);

        Self {
            state: RaopSessionState::Disconnected,
            aes_key,
            aes_iv,
            stream_connection_id,
            audio_format: stream_config.audio_format.clone(),
            stream_config,
            ports: None,
            local_control_port,
            local_timing_port,
            request_host: None,
            client_device_id,
        }
    }

    /// Get current state.
    pub fn state(&self) -> RaopSessionState {
        self.state
    }

    /// Get the AES encryption key.
    pub fn aes_key(&self) -> &[u8; 16] {
        &self.aes_key
    }

    /// Get the AES initialization vector.
    pub fn aes_iv(&self) -> &[u8; 16] {
        &self.aes_iv
    }

    /// Get stream connection ID.
    pub fn stream_connection_id(&self) -> u32 {
        self.stream_connection_id
    }

    /// Get audio format.
    pub fn audio_format(&self) -> &AudioFormat {
        &self.audio_format
    }

    /// Get stream config.
    pub fn stream_config(&self) -> &StreamConfig {
        &self.stream_config
    }

    /// Get negotiated ports (after SETUP).
    pub fn ports(&self) -> Option<&RaopPorts> {
        self.ports.as_ref()
    }

    /// Get local control port.
    pub fn local_control_port(&self) -> u16 {
        self.local_control_port
    }

    /// Set local control port (after binding a real UDP socket).
    pub fn set_local_control_port(&mut self, port: u16) {
        self.local_control_port = port;
    }

    /// Get local timing port.
    pub fn local_timing_port(&self) -> u16 {
        self.local_timing_port
    }

    /// Set local timing port (after binding the NTP server).
    pub fn set_local_timing_port(&mut self, port: u16) {
        self.local_timing_port = port;
    }

    /// Set the host used in RTSP request URIs.
    pub fn set_request_host(&mut self, host: String) {
        self.request_host = Some(host);
    }

    /// Build RTSP request URI.
    pub fn request_uri(&self) -> String {
        let host = self.request_host.as_deref().unwrap_or("local");
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{}]", host)
        } else {
            host.to_string()
        };
        format!("rtsp://{}/{}", host, self.stream_connection_id)
    }

    /// Build the Transport header value for RAOP SETUP.
    pub fn build_transport_header(&self) -> String {
        format!(
            "RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;control_port={};timing_port={}",
            self.local_control_port, self.local_timing_port
        )
    }

    /// Transition to Connected state.
    pub fn set_connected(&mut self) -> Result<()> {
        if self.state != RaopSessionState::Disconnected {
            return Err(RtspError::SetupFailed(format!(
                "Cannot connect from state {:?}",
                self.state
            ))
            .into());
        }
        self.state = RaopSessionState::Connected;
        Ok(())
    }

    /// Transition to Announced state (after ANNOUNCE).
    pub fn set_announced(&mut self) -> Result<()> {
        if self.state != RaopSessionState::Connected {
            return Err(RtspError::SetupFailed(format!(
                "Cannot announce from state {:?}",
                self.state
            ))
            .into());
        }
        self.state = RaopSessionState::Announced;
        Ok(())
    }

    /// Process SETUP response Transport header and transition to SetupComplete.
    ///
    /// Parses a Transport header like:
    /// `RTP/AVP/UDP;unicast;mode=record;server_port=6000;control_port=6001;timing_port=6002`
    pub fn process_setup_response(&mut self, transport_header: &str) -> Result<()> {
        if self.state != RaopSessionState::Announced {
            return Err(RtspError::SetupFailed(format!(
                "Cannot process SETUP from state {:?}",
                self.state
            ))
            .into());
        }

        let ports = parse_transport_header(transport_header)?;
        self.ports = Some(ports);
        self.state = RaopSessionState::SetupComplete;
        Ok(())
    }

    /// Transition to Playing state (after RECORD).
    pub fn start_playing(&mut self) -> Result<()> {
        if self.state != RaopSessionState::SetupComplete && self.state != RaopSessionState::Paused {
            return Err(RtspError::SetupFailed(format!(
                "Cannot start playing from state {:?}",
                self.state
            ))
            .into());
        }
        self.state = RaopSessionState::Playing;
        Ok(())
    }

    /// Transition to Paused state.
    pub fn pause(&mut self) -> Result<()> {
        if self.state != RaopSessionState::Playing {
            return Err(RtspError::SetupFailed(format!(
                "Cannot pause from state {:?}",
                self.state
            ))
            .into());
        }
        self.state = RaopSessionState::Paused;
        Ok(())
    }

    /// Transition to TearingDown state.
    pub fn start_teardown(&mut self) -> Result<()> {
        match self.state {
            RaopSessionState::Disconnected => {
                return Err(RtspError::SetupFailed("Not connected".to_string()).into());
            }
            RaopSessionState::TearingDown => {
                return Err(RtspError::SetupFailed("Already tearing down".to_string()).into());
            }
            _ => {}
        }
        self.state = RaopSessionState::TearingDown;
        Ok(())
    }

    /// Get client device ID.
    pub fn client_device_id(&self) -> &str {
        &self.client_device_id
    }
}

/// Parse a SETUP response Transport header to extract server_port, control_port, timing_port.
pub fn parse_transport_header(header: &str) -> Result<RaopPorts> {
    let mut server_port: Option<u16> = None;
    let mut control_port: Option<u16> = None;
    let mut timing_port: Option<u16> = None;

    for part in header.split(';') {
        let part = part.trim();
        if let Some(value) = part.strip_prefix("server_port=") {
            server_port = value.parse().ok();
        } else if let Some(value) = part.strip_prefix("control_port=") {
            control_port = value.parse().ok();
        } else if let Some(value) = part.strip_prefix("timing_port=") {
            timing_port = value.parse().ok();
        }
    }

    Ok(RaopPorts {
        server_port: server_port.unwrap_or(0),
        control_port: control_port.unwrap_or(0),
        timing_port: timing_port.unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use airplay_core::stream::TimingProtocol;

    fn test_config() -> StreamConfig {
        StreamConfig {
            timing_protocol: TimingProtocol::Ntp,
            ..StreamConfig::default()
        }
    }

    mod state_transitions {
        use super::*;

        #[test]
        fn starts_disconnected() {
            let session = RaopSession::new(test_config(), "AA:BB:CC:DD:EE:FF".into());
            assert_eq!(session.state(), RaopSessionState::Disconnected);
        }

        #[test]
        fn disconnected_to_connected() {
            let mut session = RaopSession::new(test_config(), "AA:BB:CC:DD:EE:FF".into());
            assert!(session.set_connected().is_ok());
            assert_eq!(session.state(), RaopSessionState::Connected);
        }

        #[test]
        fn connected_to_announced() {
            let mut session = RaopSession::new(test_config(), "AA:BB:CC:DD:EE:FF".into());
            session.set_connected().unwrap();
            assert!(session.set_announced().is_ok());
            assert_eq!(session.state(), RaopSessionState::Announced);
        }

        #[test]
        fn announced_to_setup_complete() {
            let mut session = RaopSession::new(test_config(), "AA:BB:CC:DD:EE:FF".into());
            session.set_connected().unwrap();
            session.set_announced().unwrap();

            let transport = "RTP/AVP/UDP;unicast;mode=record;server_port=6000;control_port=6001;timing_port=6002";
            assert!(session.process_setup_response(transport).is_ok());
            assert_eq!(session.state(), RaopSessionState::SetupComplete);
        }

        #[test]
        fn setup_complete_to_playing() {
            let mut session = RaopSession::new(test_config(), "AA:BB:CC:DD:EE:FF".into());
            session.set_connected().unwrap();
            session.set_announced().unwrap();
            session
                .process_setup_response("server_port=6000;control_port=6001;timing_port=6002")
                .unwrap();

            assert!(session.start_playing().is_ok());
            assert_eq!(session.state(), RaopSessionState::Playing);
        }

        #[test]
        fn playing_to_paused() {
            let mut session = RaopSession::new(test_config(), "AA:BB:CC:DD:EE:FF".into());
            session.set_connected().unwrap();
            session.set_announced().unwrap();
            session
                .process_setup_response("server_port=6000;control_port=6001;timing_port=6002")
                .unwrap();
            session.start_playing().unwrap();

            assert!(session.pause().is_ok());
            assert_eq!(session.state(), RaopSessionState::Paused);
        }

        #[test]
        fn paused_to_playing() {
            let mut session = RaopSession::new(test_config(), "AA:BB:CC:DD:EE:FF".into());
            session.set_connected().unwrap();
            session.set_announced().unwrap();
            session
                .process_setup_response("server_port=6000;control_port=6001;timing_port=6002")
                .unwrap();
            session.start_playing().unwrap();
            session.pause().unwrap();

            assert!(session.start_playing().is_ok());
            assert_eq!(session.state(), RaopSessionState::Playing);
        }

        #[test]
        fn teardown_from_playing() {
            let mut session = RaopSession::new(test_config(), "AA:BB:CC:DD:EE:FF".into());
            session.set_connected().unwrap();
            session.set_announced().unwrap();
            session
                .process_setup_response("server_port=6000;control_port=6001;timing_port=6002")
                .unwrap();
            session.start_playing().unwrap();

            assert!(session.start_teardown().is_ok());
            assert_eq!(session.state(), RaopSessionState::TearingDown);
        }

        #[test]
        fn invalid_transitions_error() {
            let mut session = RaopSession::new(test_config(), "AA:BB:CC:DD:EE:FF".into());

            // Can't announce before connecting
            assert!(session.set_announced().is_err());

            // Can't start playing before setup
            assert!(session.start_playing().is_err());

            // Can't pause before playing
            assert!(session.pause().is_err());

            // Can't teardown from disconnected
            assert!(session.start_teardown().is_err());
        }
    }

    mod transport_header {
        use super::*;

        #[test]
        fn parse_full_transport_header() {
            let header = "RTP/AVP/UDP;unicast;mode=record;server_port=6000;control_port=6001;timing_port=6002";
            let ports = parse_transport_header(header).unwrap();
            assert_eq!(ports.server_port, 6000);
            assert_eq!(ports.control_port, 6001);
            assert_eq!(ports.timing_port, 6002);
        }

        #[test]
        fn parse_transport_header_missing_fields_default_to_zero() {
            let header = "RTP/AVP/UDP;unicast;mode=record;server_port=6000";
            let ports = parse_transport_header(header).unwrap();
            assert_eq!(ports.server_port, 6000);
            assert_eq!(ports.control_port, 0);
            assert_eq!(ports.timing_port, 0);
        }

        #[test]
        fn parse_transport_header_with_spaces() {
            let header = "server_port=6000; control_port=6001; timing_port=6002";
            let ports = parse_transport_header(header).unwrap();
            assert_eq!(ports.server_port, 6000);
            assert_eq!(ports.control_port, 6001);
            assert_eq!(ports.timing_port, 6002);
        }
    }

    mod session_properties {
        use super::*;

        #[test]
        fn generates_random_aes_key_and_iv() {
            let s1 = RaopSession::new(test_config(), "AA:BB:CC:DD:EE:FF".into());
            let s2 = RaopSession::new(test_config(), "AA:BB:CC:DD:EE:FF".into());
            // With overwhelming probability, random keys should differ
            assert_ne!(s1.aes_key(), s2.aes_key());
            assert_ne!(s1.aes_iv(), s2.aes_iv());
        }

        #[test]
        fn request_uri_format() {
            let mut session = RaopSession::new(test_config(), "AA:BB:CC:DD:EE:FF".into());
            session.set_request_host("192.168.1.100".to_string());
            let uri = session.request_uri();
            assert!(uri.starts_with("rtsp://192.168.1.100/"));
        }

        #[test]
        fn request_uri_ipv6_bracketed() {
            let mut session = RaopSession::new(test_config(), "AA:BB:CC:DD:EE:FF".into());
            session.set_request_host("fe80::1".to_string());
            let uri = session.request_uri();
            assert!(uri.starts_with("rtsp://[fe80::1]/"));
        }

        #[test]
        fn build_transport_header_format() {
            let mut session = RaopSession::new(test_config(), "AA:BB:CC:DD:EE:FF".into());
            session.set_local_control_port(50000);
            session.set_local_timing_port(50001);
            let header = session.build_transport_header();
            assert!(header.contains("RTP/AVP/UDP"));
            assert!(header.contains("control_port=50000"));
            assert!(header.contains("timing_port=50001"));
        }
    }
}
