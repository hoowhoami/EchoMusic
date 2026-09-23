//! RAOP (AirPlay 1) connection orchestrator.
//!
//! Manages the complete AirPlay 1 flow without HomeKit pairing:
//! TCP connect → OPTIONS (Apple-Challenge) → ANNOUNCE (SDP) → SETUP (Transport) → RECORD → stream audio.
//!
//! Key differences from AirPlay 2 `Connection`:
//! - No HomeKit pairing (no pair-setup, no pair-verify)
//! - No RTSP encryption (plaintext control channel)
//! - Single-phase SETUP (Transport header, not binary plist)
//! - SDP-based codec declaration via ANNOUNCE
//! - AES-128-CBC audio encryption (not ChaCha20-Poly1305)

use airplay_core::error::{Error as CoreError, Result, RtspError};
use airplay_core::{Device, StreamConfig};
use airplay_audio::cipher::AesCbcPacketCipher;
use airplay_audio::{AudioDecoder, AudioStreamer, RtpReceiver, RtpSender};
use airplay_crypto::rsa::encrypt_aes_key;
use airplay_rtsp::{RaopSession, RtspConnection, RtspRequest};
use airplay_rtsp::raop_session::RaopSessionState;
use airplay_rtsp::sdp::SdpBuilder;
use airplay_timing::NtpTimingServer;
use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine;
use crate::PlaybackState;
use std::net::{IpAddr, SocketAddr};
use tracing::{debug, info, warn};

/// Generate a random MAC-like device ID for the client.
fn generate_device_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    format!(
        "{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
        rng.gen::<u8>(),
        rng.gen::<u8>(),
        rng.gen::<u8>(),
        rng.gen::<u8>(),
        rng.gen::<u8>(),
        rng.gen::<u8>()
    )
}

/// Select the best address from a device's address list.
fn select_best_address(addresses: &[IpAddr]) -> Option<&IpAddr> {
    // Prefer IPv4
    if let Some(addr) = addresses.iter().find(|a| a.is_ipv4()) {
        return Some(addr);
    }
    // Then global IPv6 (not link-local)
    if let Some(addr) = addresses.iter().find(|a| {
        match a {
            IpAddr::V6(v6) => {
                let segments = v6.segments();
                !v6.is_loopback() && (segments[0] & 0xffc0) != 0xfe80
            }
            _ => false,
        }
    }) {
        return Some(addr);
    }
    addresses.first()
}

/// Active RAOP (AirPlay 1) connection to a receiver.
pub struct RaopConnection {
    device: Device,
    rtsp: RtspConnection,
    session: RaopSession,
    streamer: Option<AudioStreamer>,
    playback_state: PlaybackState,
    volume: f32,
    stream_config: StreamConfig,
    timing_server: Option<NtpTimingServer>,
    /// Control port receiver (keeps the UDP socket alive)
    control_receiver: Option<RtpReceiver>,
    /// Password for digest auth (if needed)
    password: Option<String>,
    /// Render delay in ms added to NTP timestamps for extra retransmit headroom.
    render_delay_ms: u32,
}

impl RaopConnection {
    /// Connect to an AirPlay 1 device.
    pub async fn connect(device: Device, config: StreamConfig) -> Result<Self> {
        Self::connect_internal(device, config, None).await
    }

    /// Connect to an AirPlay 1 device with a password for digest authentication.
    pub async fn connect_with_password(
        device: Device,
        config: StreamConfig,
        password: &str,
    ) -> Result<Self> {
        Self::connect_internal(device, config, Some(password.to_string())).await
    }

    async fn connect_internal(
        device: Device,
        config: StreamConfig,
        password: Option<String>,
    ) -> Result<Self> {
        let client_device_id = generate_device_id();

        // TCP connect to RAOP port
        let ip_addr = select_best_address(&device.addresses)
            .ok_or_else(|| RtspError::ConnectionRefused)?;
        let port = device.raop_connection_port();
        let addr = SocketAddr::new(*ip_addr, port);
        info!("RAOP connecting to {} at {}", device.name, addr);

        let mut rtsp = RtspConnection::new(addr);
        rtsp.connect().await?;

        // Create RAOP session
        let mut session = RaopSession::new(config.clone(), client_device_id.clone());
        session.set_connected()?;
        session.set_request_host(ip_addr.to_string());

        // Add standard headers
        let client_instance = client_device_id.replace(":", "");
        rtsp.add_session_header("User-Agent", "AirPlay/745.83");
        rtsp.add_session_header("Client-Instance", &client_instance);
        rtsp.add_session_header("DACP-ID", &client_instance);

        // 1. OPTIONS with Apple-Challenge
        let challenge = {
            let mut buf = [0u8; 16];
            rand::Rng::fill(&mut rand::thread_rng(), &mut buf);
            STANDARD_NO_PAD.encode(&buf)
        };
        let options_req = RtspRequest::options_with_challenge(&challenge);
        let options_resp = rtsp.send(options_req).await?;

        // Handle 401 Unauthorized (digest auth)
        if options_resp.status_code == 401 {
            if let Some(ref pw) = password {
                if let Some(www_auth) = options_resp.header("WWW-Authenticate") {
                    if let Some(auth_header) = airplay_crypto::digest::compute_digest_response(
                        "", // RAOP typically uses empty username
                        pw,
                        "OPTIONS",
                        "*",
                        www_auth,
                    ) {
                        let retry_req = RtspRequest::options_with_challenge(&challenge)
                            .header("Authorization", auth_header);
                        let retry_resp = rtsp.send(retry_req).await?;
                        if retry_resp.status_code != 200 {
                            return Err(RtspError::SetupFailed(format!(
                                "OPTIONS failed after auth: {}",
                                retry_resp.status_code
                            ))
                            .into());
                        }
                    }
                }
            } else {
                return Err(
                    RtspError::SetupFailed("Device requires password (401 Unauthorized)".into())
                        .into(),
                );
            }
        }

        if let Some(public) = options_resp.header("Public") {
            info!("RAOP OPTIONS methods: {}", public);
        }

        Ok(Self {
            device,
            rtsp,
            session,
            streamer: None,
            playback_state: PlaybackState::Stopped,
            volume: 1.0,
            stream_config: config,
            timing_server: None,
            control_receiver: None,
            password,
            render_delay_ms: 0,
        })
    }

    /// Complete RAOP SETUP (ANNOUNCE → SETUP → RECORD).
    pub async fn setup(&mut self) -> Result<()> {
        info!("RAOP setup start");

        // Start NTP timing server (RAOP always uses NTP)
        let timing_server = NtpTimingServer::start(
            self.stream_config.audio_format.sample_rate.as_hz(),
        )
        .await?;
        let timing_port = timing_server.port();
        info!("Started NTP timing server on port {}", timing_port);
        self.session.set_local_timing_port(timing_port);
        self.timing_server = Some(timing_server);

        // Bind control port
        let mut control_receiver = RtpReceiver::new();
        let control_port = control_receiver.bind(0)?;
        self.session.set_local_control_port(control_port);
        info!("Control port bound to {}", control_port);
        self.control_receiver = Some(control_receiver);

        // 2. ANNOUNCE with SDP
        let local_ip = self
            .rtsp
            .local_addr()
            .map(|sa| sa.ip().to_string())
            .unwrap_or_else(|| "0.0.0.0".to_string());
        let remote_ip = self
            .device
            .addresses
            .first()
            .map(|a| a.to_string())
            .unwrap_or_else(|| "0.0.0.0".to_string());

        // Build SDP with optional RSA encryption
        let use_rsa = self.device.supports_rsa_encryption();
        info!(
            "DIAG RAOP encryption: supports_rsa={}, raop_encryption_types={:?}",
            use_rsa, self.device.raop_encryption_types
        );
        let sdp_body = if use_rsa {
            let rsa_key = encrypt_aes_key(self.session.aes_key())?;
            SdpBuilder::new(
                self.session.stream_connection_id(),
                local_ip,
                remote_ip,
                self.session.audio_format().clone(),
                self.stream_config.latency_min,
            )
            .with_encryption(rsa_key, *self.session.aes_iv())
            .build()?
        } else {
            SdpBuilder::new(
                self.session.stream_connection_id(),
                local_ip,
                remote_ip,
                self.session.audio_format().clone(),
                self.stream_config.latency_min,
            )
            .build()?
        };

        let announce_req = RtspRequest::announce(self.session.request_uri(), sdp_body);
        let announce_resp = self.rtsp.send(announce_req).await?;

        // Handle 401 on ANNOUNCE
        if announce_resp.status_code == 401 {
            if let Some(ref pw) = self.password {
                if let Some(www_auth) = announce_resp.header("WWW-Authenticate") {
                    if let Some(auth_header) = airplay_crypto::digest::compute_digest_response(
                        "",
                        pw,
                        "ANNOUNCE",
                        &self.session.request_uri(),
                        www_auth,
                    ) {
                        // Rebuild SDP for retry
                        let local_ip2 = self
                            .rtsp
                            .local_addr()
                            .map(|sa| sa.ip().to_string())
                            .unwrap_or_else(|| "0.0.0.0".to_string());
                        let remote_ip2 = self
                            .device
                            .addresses
                            .first()
                            .map(|a| a.to_string())
                            .unwrap_or_else(|| "0.0.0.0".to_string());
                        let sdp_retry = if use_rsa {
                            let rsa_key = encrypt_aes_key(self.session.aes_key())?;
                            SdpBuilder::new(
                                self.session.stream_connection_id(),
                                local_ip2,
                                remote_ip2,
                                self.session.audio_format().clone(),
                                self.stream_config.latency_min,
                            )
                            .with_encryption(rsa_key, *self.session.aes_iv())
                            .build()?
                        } else {
                            SdpBuilder::new(
                                self.session.stream_connection_id(),
                                local_ip2,
                                remote_ip2,
                                self.session.audio_format().clone(),
                                self.stream_config.latency_min,
                            )
                            .build()?
                        };
                        let retry_req =
                            RtspRequest::announce(self.session.request_uri(), sdp_retry)
                                .header("Authorization", auth_header);
                        let retry_resp = self.rtsp.send(retry_req).await?;
                        if retry_resp.status_code != 200 {
                            return Err(RtspError::SetupFailed(format!(
                                "ANNOUNCE failed after auth: {}",
                                retry_resp.status_code
                            ))
                            .into());
                        }
                    }
                }
            } else {
                return Err(
                    RtspError::SetupFailed("ANNOUNCE: device requires password".into()).into(),
                );
            }
        } else if announce_resp.status_code != 200 {
            return Err(RtspError::SetupFailed(format!(
                "ANNOUNCE failed: {}",
                announce_resp.status_code
            ))
            .into());
        }

        info!("ANNOUNCE response: {}", announce_resp.status_code);
        self.session.set_announced()?;

        // 3. SETUP with Transport header
        let transport_header = self.session.build_transport_header();
        let setup_req =
            RtspRequest::setup_raop(self.session.request_uri(), &transport_header);
        let setup_resp = self.rtsp.send(setup_req).await?;

        if setup_resp.status_code != 200 {
            return Err(RtspError::SetupFailed(format!(
                "SETUP failed: {}",
                setup_resp.status_code
            ))
            .into());
        }

        // Extract Transport header from response
        let resp_transport = setup_resp
            .header("Transport")
            .ok_or_else(|| {
                CoreError::Rtsp(RtspError::InvalidResponse(
                    "No Transport header in SETUP response".into(),
                ))
            })?
            .to_string();
        self.session.process_setup_response(&resp_transport)?;
        info!("SETUP complete: {}", resp_transport);

        // Add Session header for subsequent requests
        let session_id = setup_resp
            .headers
            .get("Session")
            .cloned()
            .unwrap_or_else(|| "1".to_string());
        self.rtsp.add_session_header("Session", session_id);

        // 4. RECORD
        let record_req = RtspRequest::record_with_info(self.session.request_uri(), 0, 0);
        let record_resp = self.rtsp.send(record_req).await?;
        if record_resp.status_code == 200 {
            info!("RECORD acknowledged");
        } else {
            warn!(
                "RECORD returned status {} (continuing anyway)",
                record_resp.status_code
            );
        }

        info!("RAOP setup complete");
        Ok(())
    }

    /// Start audio streaming from a decoder source.
    pub async fn start_streaming(&mut self, decoder: AudioDecoder) -> Result<()> {
        // Ensure setup is complete
        if self.session.state() != RaopSessionState::SetupComplete {
            self.setup().await?;
        }

        let ports = self.session.ports().ok_or_else(|| {
            RtspError::SetupFailed("Missing ports from SETUP".into())
        })?;

        let dest_addr = select_best_address(&self.device.addresses)
            .ok_or_else(|| RtspError::ConnectionRefused)?;
        let dest = SocketAddr::new(*dest_addr, ports.server_port);
        let control_dest = SocketAddr::new(*dest_addr, ports.control_port);

        let mut sender = RtpSender::new(dest, rand::random());
        sender.set_control_dest(control_dest);
        sender.bind(0)?;
        info!(
            "RTP sender bound, data: {}, control: {}",
            dest, control_dest
        );

        // Enable AES-CBC encryption if RSA key exchange was used
        if self.device.supports_rsa_encryption() {
            let cipher = AesCbcPacketCipher::new(
                *self.session.aes_key(),
                *self.session.aes_iv(),
            );
            sender.set_cipher(Box::new(cipher));
            info!("DIAG: AES-CBC audio encryption ENABLED");
        } else {
            info!("DIAG: Audio encryption DISABLED (no RSA key exchange) - sending plaintext ALAC");
        }

        // Start streamer
        let mut streamer = AudioStreamer::new(self.stream_config.clone());
        streamer.set_rtp_sender(sender).await;
        if self.render_delay_ms > 0 {
            streamer.set_render_delay_ms(self.render_delay_ms).await;
        }
        // NTP timing: sender is reference clock, offset is zero
        streamer
            .set_timing_offset(airplay_timing::ClockOffset::default())
            .await;
        streamer.start(decoder).await?;

        self.session.start_playing()?;

        // Send initial volume
        if let Err(e) = self.set_volume(self.volume).await {
            warn!("Failed to set volume: {}", e);
        }

        self.streamer = Some(streamer);
        self.playback_state = PlaybackState::Playing;

        Ok(())
    }

    /// Pause streaming.
    pub async fn pause(&mut self) -> Result<()> {
        if let Some(ref mut streamer) = self.streamer {
            streamer.pause().await?;
        }

        let flush_req = RtspRequest::flush(self.session.request_uri());
        self.rtsp.send(flush_req).await?;

        if let Some(ref mut streamer) = self.streamer {
            streamer.reset_after_flush().await;
        }

        self.session.pause()?;
        self.playback_state = PlaybackState::Paused;
        Ok(())
    }

    /// Resume streaming.
    pub async fn resume(&mut self) -> Result<()> {
        if let Some(ref mut streamer) = self.streamer {
            streamer.resume().await?;
        }

        let record_req = RtspRequest::record_with_info(self.session.request_uri(), 0, 0);
        self.rtsp.send(record_req).await?;
        self.session.start_playing()?;
        self.playback_state = PlaybackState::Playing;
        Ok(())
    }

    /// Stop streaming.
    pub async fn stop(&mut self) -> Result<()> {
        if let Some(ref mut streamer) = self.streamer {
            streamer.stop().await?;
        }

        let flush_req = RtspRequest::flush(self.session.request_uri());
        let _ = self.rtsp.send(flush_req).await;

        if let Some(ref mut streamer) = self.streamer {
            streamer.reset_after_flush().await;
        }

        self.playback_state = PlaybackState::Stopped;
        Ok(())
    }

    /// Set render delay in milliseconds.
    ///
    /// Shifts NTP timestamps in sync packets into the future, telling the
    /// receiver to buffer audio longer before rendering. Must be called
    /// before `start_streaming()`. Typical values: 100-500ms.
    pub fn set_render_delay_ms(&mut self, delay_ms: u32) {
        self.render_delay_ms = delay_ms;
    }

    /// Set volume (0.0 to 1.0).
    pub async fn set_volume(&mut self, volume: f32) -> Result<()> {
        let clamped = volume.clamp(0.0, 1.0);
        self.volume = clamped;

        // Volume is sent as text/parameters: "volume: -xx.xx"
        let volume_db = if clamped <= 0.0 {
            -144.0_f32
        } else if clamped >= 1.0 {
            0.0_f32
        } else {
            20.0 * clamped.log10()
        };
        let body = format!("volume: {:.2}\r\n", volume_db).into_bytes();
        let req = RtspRequest::set_parameter_text(self.session.request_uri(), body);
        self.rtsp.send(req).await?;
        Ok(())
    }

    /// Disconnect and clean up.
    pub async fn disconnect(&mut self) -> Result<()> {
        if let Some(ref mut streamer) = self.streamer {
            streamer.stop().await?;
        }

        // Stop timing server
        if let Some(mut server) = self.timing_server.take() {
            server.stop().await;
        }

        // Drop control receiver
        self.control_receiver = None;

        // Send TEARDOWN
        if self.session.state() != RaopSessionState::Disconnected {
            let _ = self.session.start_teardown();
            let teardown_req = RtspRequest::teardown(self.session.request_uri());
            let _ = self.rtsp.send(teardown_req).await;
        }

        self.rtsp.close().await?;
        self.playback_state = PlaybackState::Stopped;
        Ok(())
    }

    /// Get connected device.
    pub fn device(&self) -> &Device {
        &self.device
    }

    /// Get RAOP session state.
    pub fn session_state(&self) -> RaopSessionState {
        self.session.state()
    }

    /// Get playback state.
    pub fn playback_state(&self) -> PlaybackState {
        self.playback_state
    }

    /// Get current playback position in seconds.
    pub fn playback_position(&self) -> f64 {
        self.streamer
            .as_ref()
            .map(|s| {
                s.position() as f64 / self.stream_config.audio_format.sample_rate.as_hz() as f64
            })
            .unwrap_or(0.0)
    }

    /// Get current volume.
    pub fn volume(&self) -> f32 {
        self.volume
    }

    /// Send feedback/keepalive.
    pub async fn send_feedback(&mut self) -> Result<()> {
        // RAOP uses SET_PARAMETER or GET_PARAMETER as keepalive
        // Some receivers accept simple OPTIONS as keepalive
        let req = RtspRequest::options();
        match tokio::time::timeout(std::time::Duration::from_secs(2), self.rtsp.send(req)).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => {
                debug!("Keepalive failed: {}", e);
                Err(e)
            }
            Err(_) => {
                debug!("Keepalive timed out");
                Ok(())
            }
        }
    }
}
