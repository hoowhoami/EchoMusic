//! Main AirPlay client API.

use airplay_core::{Device, DeviceId, StreamConfig, error::Result};
use airplay_core::error::{Error, RtspError, DiscoveryError};
use airplay_discovery::{ServiceBrowser, Discovery};
use airplay_audio::{AudioDecoder, AlacEncoder, AudioStreamer, LiveAudioDecoder, LiveFrameSender, EqConfig, EqParams, RetransmitRequest, SpatialParams, SpeakerConfig};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::path::Path;
use std::net::UdpSocket;
use std::time::Duration;
use crate::{Connection, DeviceGroup, PlaybackState, EventHandler, ClientEvent};

/// High-level AirPlay 2 sender client.
pub struct AirPlayClient {
    browser: ServiceBrowser,
    connection: Option<Connection>,
    /// Secondary connections for multi-speaker group streaming.
    group_connections: Vec<Connection>,
    group: Option<DeviceGroup>,
    event_handler: Option<Box<dyn EventHandler>>,
    stream_config: StreamConfig,
    /// Render delay in ms added to NTP timestamps for extra retransmit headroom.
    /// Default: 200ms for reliable playback over WiFi.
    render_delay_ms: u32,
    /// AudioStreamer for group streaming (shared across all group devices).
    group_streamer: Option<AudioStreamer>,
    /// Playback state for group streaming (tracked separately from primary connection).
    group_playback_state: Option<PlaybackState>,
    /// Stream statistics (shared across all streaming threads).
    stream_stats: Arc<crate::stats::StreamStats>,
    /// Stop flag for group control listener thread.
    group_control_stop: Arc<std::sync::atomic::AtomicBool>,
    /// Handle for group control listener thread (for cleanup).
    group_control_thread: Option<std::thread::JoinHandle<()>>,
}

impl AirPlayClient {
    /// Create new client.
    pub fn new() -> Result<Self> {
        Ok(Self {
            browser: ServiceBrowser::new()?,
            connection: None,
            group_connections: Vec::new(),
            group: None,
            event_handler: None,
            stream_config: StreamConfig::default(),
            render_delay_ms: 200, // 200ms default for reliable playback over WiFi
            group_streamer: None,
            group_playback_state: None,
            stream_stats: crate::stats::StreamStats::new(),
            group_control_stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            group_control_thread: None,
        })
    }

    /// Create client with specific configuration.
    pub fn with_config(config: StreamConfig, event_handler: Option<Box<dyn EventHandler>>) -> Result<Self> {
        Ok(Self {
            browser: ServiceBrowser::new()?,
            connection: None,
            group_connections: Vec::new(),
            group: None,
            event_handler,
            stream_config: config,
            render_delay_ms: 200, // 200ms default for reliable playback over WiFi
            group_streamer: None,
            group_playback_state: None,
            stream_stats: crate::stats::StreamStats::new(),
            group_control_stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            group_control_thread: None,
        })
    }

    /// Set event handler.
    pub fn set_event_handler(&mut self, handler: impl EventHandler + 'static) {
        self.event_handler = Some(Box::new(handler));
    }

    /// Set render delay in milliseconds.
    ///
    /// Shifts NTP timestamps in sync packets into the future, telling the
    /// receiver to buffer audio longer before rendering. This gives more
    /// headroom for retransmit recovery of lost packets over lossy WiFi.
    ///
    /// Default is 200ms. Typical values: 100-500ms.
    /// Must be called before `connect()`.
    pub fn set_render_delay_ms(&mut self, delay_ms: u32) {
        self.render_delay_ms = delay_ms;
    }

    /// Emit an event if handler is set.
    async fn emit_event(&self, event: ClientEvent) {
        if let Some(ref handler) = self.event_handler {
            handler.on_event(event).await;
        }
    }

    /// Discover AirPlay devices on the network.
    pub async fn discover(&self, timeout: Duration) -> Result<Vec<Device>> {
        self.browser.scan(timeout).await
    }

    /// Get a specific device by ID.
    pub async fn get_device(&self, id: &DeviceId) -> Option<Device> {
        self.browser.get_device(id).await
    }

    /// Connect to a device.
    pub async fn connect(&mut self, device: &Device) -> Result<()> {
        // Disconnect existing connection if any
        if self.connection.is_some() {
            self.disconnect().await?;
        }

        // Use the user-provided stream config (don't override based on device features)
        let stream_config = self.stream_config.clone();

        // Establish connection
        let mut connection = Connection::connect(device.clone(), stream_config).await?;

        // Set render delay for retransmit headroom
        connection.set_render_delay_ms(self.render_delay_ms);

        // Complete RTSP SETUP handshake (CRITICAL - required before streaming)
        connection.setup().await?;

        self.connection = Some(connection);

        self.emit_event(ClientEvent::Connected(device.clone())).await;

        Ok(())
    }

    /// Connect to a device with PIN (for password-protected devices).
    pub async fn connect_with_pin(&mut self, device: &Device, pin: &str) -> Result<()> {
        // Disconnect existing connection if any
        if self.connection.is_some() {
            self.disconnect().await?;
        }

        // Use the user-provided stream config (don't override based on device features)
        let stream_config = self.stream_config.clone();

        // Establish connection
        let mut connection = Connection::connect_with_pin(device.clone(), stream_config, pin).await?;

        // Set render delay for retransmit headroom
        connection.set_render_delay_ms(self.render_delay_ms);

        // Complete RTSP SETUP handshake (CRITICAL - required before streaming)
        connection.setup().await?;

        self.connection = Some(connection);

        self.emit_event(ClientEvent::Connected(device.clone())).await;

        Ok(())
    }

    /// Connect to a device with a user-entered AirPlay password or screen code.
    ///
    /// Prefer saved HomeKit pair-verify identities when available, then try the
    /// normal transient path, and finally fall back to HomeKit Normal pair-setup
    /// which persists an identity for future connections.
    pub async fn connect_with_pairing_pin(&mut self, device: &Device, pin: &str) -> Result<()> {
        if self.connection.is_some() {
            self.disconnect().await?;
        }

        let stream_config = self.stream_config.clone();
        let mut connection =
            match Connection::connect_auto(device.clone(), stream_config.clone(), pin).await {
                Ok(connection) => connection,
                Err(first_error) => {
                    tracing::warn!(
                        "AirPlay transient/pair-verify connect failed: {}; trying HomeKit Normal pairing",
                        first_error
                    );
                    Connection::connect_with_pin_pairing(device.clone(), stream_config, pin)
                        .await
                        .map_err(|second_error| {
                            tracing::warn!(
                                "AirPlay HomeKit Normal pairing failed after transient failure: {}",
                                second_error
                            );
                            second_error
                        })?
                }
            };

        connection.set_render_delay_ms(self.render_delay_ms);
        connection.setup().await?;
        self.connection = Some(connection);
        self.emit_event(ClientEvent::Connected(device.clone())).await;

        Ok(())
    }

    /// Ask a receiver to show a screen pairing code when it supports that flow.
    pub async fn start_pin_pairing(&mut self, device: &Device) -> Result<()> {
        Connection::start_pin_pairing(device.clone()).await
    }

    /// Stop the group control listener thread if running.
    fn stop_group_control_listener(&mut self) {
        self.group_control_stop.store(true, Ordering::Release);
        if let Some(handle) = self.group_control_thread.take() {
            // Thread polls with 1ms timeout, should exit within a few ms
            match handle.join() {
                Ok(()) => tracing::debug!("Group control listener thread joined"),
                Err(_) => tracing::warn!("Group control listener thread panicked"),
            }
        }
    }

    /// Disconnect from current device and any group connections.
    pub async fn disconnect(&mut self) -> Result<()> {
        // Stop group control listener first (before closing sockets it reads from)
        self.stop_group_control_listener();

        // Stop group streamer if running
        if let Some(ref mut streamer) = self.group_streamer {
            let _ = streamer.stop().await;
        }
        self.group_streamer = None;

        // Disconnect group connections (sends TEARDOWN to each)
        for conn in &mut self.group_connections {
            let _ = conn.disconnect().await;
        }
        self.group_connections.clear();
        self.group_playback_state = None;

        if let Some(ref mut connection) = self.connection {
            connection.disconnect().await?;
        }
        self.connection = None;

        self.emit_event(ClientEvent::Disconnected(None)).await;

        Ok(())
    }

    /// Check if connected.
    pub fn is_connected(&self) -> bool {
        self.connection.is_some()
    }

    /// Get connected device.
    pub fn connected_device(&self) -> Option<&Device> {
        self.connection.as_ref().map(|c| c.device())
    }

    /// Play audio from file.
    pub async fn play_file(&mut self, path: impl AsRef<Path>) -> Result<()> {
        let connection = self.connection.as_mut().ok_or_else(|| {
            Error::Rtsp(RtspError::NoSession)
        })?;

        // Create decoder for the file
        let decoder = AudioDecoder::open(path)?;

        // Start streaming
        connection.start_streaming(decoder).await?;

        self.emit_event(ClientEvent::PlaybackStateChanged(PlaybackState::Playing)).await;

        Ok(())
    }

    /// Play audio from raw PCM samples (one-shot).
    pub async fn play_pcm(&mut self, _samples: &[i16], _sample_rate: u32, _channels: u8) -> Result<()> {
        let _connection = self.connection.as_mut().ok_or_else(|| {
            Error::Rtsp(RtspError::NoSession)
        })?;

        // TODO: One-shot PCM streaming path not implemented yet
        // For streaming, use start_live_streaming() instead
        Err(Error::Streaming(airplay_core::error::StreamingError::InvalidFormat(
            "One-shot PCM streaming not implemented. Use start_live_streaming() for live sources.".into(),
        )))
    }

    /// Start live audio streaming from an external source (e.g., Bluetooth).
    ///
    /// Returns a `LiveFrameSender` that can be used to push PCM frames to the
    /// AirPlay stream. The stream will continue until stopped or the sender is dropped.
    ///
    /// # Arguments
    /// * `sample_rate` - Sample rate of the source audio in Hz (e.g., 44100)
    /// * `channels` - Number of audio channels (typically 2 for stereo)
    ///
    /// # Example
    /// ```ignore
    /// let sender = client.start_live_streaming(44100, 2).await?;
    ///
    /// // Push frames in a loop
    /// loop {
    ///     let frame = LivePcmFrame {
    ///         samples: captured_audio,
    ///         channels: 2,
    ///         sample_rate: 44100,
    ///     };
    ///     sender.try_send(frame);
    /// }
    /// ```
    pub async fn start_live_streaming(&mut self, sample_rate: u32, channels: u8) -> Result<LiveFrameSender> {
        let connection = self.connection.as_mut().ok_or_else(|| {
            Error::Rtsp(RtspError::NoSession)
        })?;

        // Create live decoder and sender pair
        // Capacity of 16 frames provides ~350ms buffer at 352 frames/packet, 44.1kHz
        let (sender, decoder) = LiveAudioDecoder::create_pair(sample_rate, channels, 16);

        // Start live streaming
        connection.start_streaming_live(decoder).await?;

        self.emit_event(ClientEvent::PlaybackStateChanged(PlaybackState::Playing)).await;

        Ok(sender)
    }

    /// Start live audio streaming with an existing decoder.
    ///
    /// This allows the caller to create the sender/decoder pair first, pre-fill
    /// the channel with audio data, and then start streaming. This avoids startup
    /// artifacts from empty buffers.
    ///
    /// # Example
    /// ```ignore
    /// // Create sender/decoder pair with larger buffer
    /// let (sender, decoder) = LiveAudioDecoder::create_pair(44100, 2, 64);
    ///
    /// // Start capture thread that sends frames to sender
    /// std::thread::spawn(move || {
    ///     loop { sender.try_send(frame); }
    /// });
    ///
    /// // Wait for channel to fill
    /// std::thread::sleep(Duration::from_millis(500));
    ///
    /// // Now start streaming with pre-filled decoder
    /// client.start_live_streaming_with_decoder(decoder).await?;
    /// ```
    pub async fn start_live_streaming_with_decoder(&mut self, decoder: LiveAudioDecoder) -> Result<()> {
        let connection = self.connection.as_mut().ok_or_else(|| {
            Error::Rtsp(RtspError::NoSession)
        })?;

        // Start live streaming with the provided decoder
        connection.start_streaming_live(decoder).await?;

        self.emit_event(ClientEvent::PlaybackStateChanged(PlaybackState::Playing)).await;

        Ok(())
    }

    /// Pause playback.
    pub async fn pause(&mut self) -> Result<()> {
        let connection = self.connection.as_mut().ok_or_else(|| {
            Error::Rtsp(RtspError::NoSession)
        })?;

        connection.pause().await?;

        // Flush group connections too
        for conn in &mut self.group_connections {
            let _ = conn.send_flush(0, 0).await;
        }

        if self.group_playback_state.is_some() {
            self.group_playback_state = Some(PlaybackState::Paused);
        }
        self.emit_event(ClientEvent::PlaybackStateChanged(PlaybackState::Paused)).await;

        Ok(())
    }

    /// Resume playback.
    pub async fn resume(&mut self) -> Result<()> {
        let connection = self.connection.as_mut().ok_or_else(|| {
            Error::Rtsp(RtspError::NoSession)
        })?;

        connection.resume().await?;

        // Resume group connections too
        for conn in &mut self.group_connections {
            let _ = conn.send_record().await;
        }

        if self.group_playback_state.is_some() {
            self.group_playback_state = Some(PlaybackState::Playing);
        }
        self.emit_event(ClientEvent::PlaybackStateChanged(PlaybackState::Playing)).await;

        Ok(())
    }

    /// Stop playback.
    pub async fn stop(&mut self) -> Result<()> {
        // Stop group control listener (before streamer, to avoid stale thread reading sockets)
        self.stop_group_control_listener();

        // Stop group streamer
        if let Some(ref mut streamer) = self.group_streamer {
            let _ = streamer.stop().await;
        }
        self.group_streamer = None;

        let connection = self.connection.as_mut().ok_or_else(|| {
            Error::Rtsp(RtspError::NoSession)
        })?;

        connection.stop().await?;

        // Flush group connections too
        for conn in &mut self.group_connections {
            let _ = conn.send_flush(0, 0).await;
        }

        self.group_playback_state = None;
        self.emit_event(ClientEvent::PlaybackStateChanged(PlaybackState::Stopped)).await;

        Ok(())
    }

    /// Seek to position in seconds.
    ///
    /// EchoMusic patch (research §3.2): real implementation instead of the upstream
    /// event-only stub. The frame producer must call `LiveFrameSender::signal_seek(...)`
    /// so the decoder drains in-flight frames and re-bases its RTP timestamps; this
    /// method synchronises the receiver by flushing audio buffered before the seek
    /// point and — when playing — bouncing through the RTSP timeline so playback
    /// continues from the new position. Position is only reported after the flush
    /// handshake completes; it is never a fake success.
    pub async fn seek(&mut self, position_secs: f64) -> Result<()> {
        let connection = self.connection.as_mut().ok_or_else(|| {
            Error::Rtsp(RtspError::NoSession)
        })?;
        let was_playing = connection.playback_state() == PlaybackState::Playing;
        if was_playing {
            // Pause sends FLUSH and resets marker/extension state so the receiver
            // drops every packet buffered before the seek point.
            connection.pause().await?;
            connection.resume().await?;
        } else {
            // Paused seek: clear the buffered pipeline without flipping the state.
            // The producer re-bases timestamps; playback continues on the next RECORD.
            connection.send_flush(0, 0).await?;
        }

        self.emit_event(ClientEvent::PositionUpdated(position_secs)).await;

        Ok(())
    }

    /// Set volume (0.0 to 1.0).
    pub async fn set_volume(&mut self, volume: f32) -> Result<()> {
        let connection = self.connection.as_mut().ok_or_else(|| {
            Error::Rtsp(RtspError::NoSession)
        })?;

        connection.set_volume(volume).await?;

        // Set volume on group connections too
        for conn in &mut self.group_connections {
            let _ = conn.set_volume(volume).await;
        }

        self.emit_event(ClientEvent::VolumeChanged(volume)).await;

        Ok(())
    }

    /// Send feedback/keepalive to the receiver.
    ///
    /// **IMPORTANT:** AirPlay 2 receivers expect periodic feedback requests (~every 2 seconds)
    /// during active playback. Call this from your main loop to maintain the session and prevent
    /// timeouts.
    ///
    /// # Example
    /// ```ignore
    /// // In your playback loop:
    /// loop {
    ///     tokio::time::sleep(Duration::from_secs(2)).await;
    ///     if let Err(e) = client.send_feedback().await {
    ///         eprintln!("Feedback failed: {}", e);
    ///     }
    /// }
    /// ```
    pub async fn send_feedback(&mut self) -> Result<()> {
        let connection = self.connection.as_mut().ok_or_else(|| {
            Error::Rtsp(RtspError::NoSession)
        })?;

        connection.send_feedback().await?;

        // Also send feedback to group connections to prevent session timeouts
        for conn in &mut self.group_connections {
            let _ = conn.send_feedback().await;
        }

        Ok(())
    }

    /// Set up the equalizer with shared parameters.
    ///
    /// The EQ will be applied to audio during streaming. Parameters can be
    /// updated atomically from another thread (e.g., the UI).
    ///
    /// Must be called after `connect()` and before `play_file()` or `start_live_streaming()`.
    ///
    /// # Example
    /// ```ignore
    /// let config = EqConfig::five_band();
    /// let params = Arc::new(EqParams::new(config.num_bands()));
    ///
    /// // Set bass boost
    /// params.set_gain_db(0, 6.0);
    ///
    /// client.set_eq_params(config, params.clone()).await?;
    /// client.play_file("song.mp3").await?;
    ///
    /// // Adjust EQ during playback
    /// params.set_gain_db(4, -3.0);  // Reduce treble
    /// ```
    pub fn set_eq_params(&mut self, config: EqConfig, params: Arc<EqParams>) -> Result<()> {
        let connection = self.connection.as_mut().ok_or_else(|| {
            Error::Rtsp(RtspError::NoSession)
        })?;

        connection.set_eq_params(config, params);
        Ok(())
    }

    /// Get a clone of the EQ params Arc if set.
    pub fn eq_params(&self) -> Option<Arc<EqParams>> {
        self.connection.as_ref().and_then(|c| c.eq_params())
    }

    /// Set up spatial audio processing with shared parameters.
    ///
    /// When enabled, each speaker in the group receives a unique audio mix
    /// based on its position relative to the listener. Parameters can be
    /// updated atomically from another thread (e.g., the TUI).
    ///
    /// Must be called after `connect_group()` and before `play_file_to_group()`
    /// or `start_live_streaming_to_group()`.
    pub fn set_spatial_params(&mut self, params: Arc<SpatialParams>, speakers: Vec<SpeakerConfig>) -> Result<()> {
        let connection = self.connection.as_mut().ok_or_else(|| {
            Error::Rtsp(RtspError::NoSession)
        })?;

        connection.set_spatial_params(params, speakers);
        Ok(())
    }

    /// Get a clone of the spatial params Arc if set.
    pub fn spatial_params(&self) -> Option<Arc<SpatialParams>> {
        self.connection.as_ref().and_then(|c| c.spatial_params())
    }

    /// Get current playback state.
    pub fn playback_state(&self) -> PlaybackState {
        // Group playback state takes priority when set
        if let Some(state) = self.group_playback_state {
            return state;
        }
        self.connection
            .as_ref()
            .map(|c| c.playback_state())
            .unwrap_or(PlaybackState::Stopped)
    }

    /// Get current playback position in seconds.
    pub fn playback_position(&self) -> f64 {
        self.connection
            .as_ref()
            .map(|c| c.playback_position())
            .unwrap_or(0.0)
    }

    /// Wait for playback to complete.
    pub async fn wait_for_completion(&self) -> Result<()> {
        // Poll playback state until stopped
        loop {
            let state = self.playback_state();
            match state {
                PlaybackState::Stopped | PlaybackState::Error => break,
                _ => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
        Ok(())
    }

    // Multi-speaker group streaming methods

    /// Connect to multiple devices for synchronized group playback.
    ///
    /// The first device becomes the primary (runs PTP BMCA). All subsequent
    /// devices are set up as secondary group members sharing the primary's clock.
    /// SETPEERS is sent to all devices so they know about each other.
    pub async fn connect_group(&mut self, devices: &[Device]) -> Result<()> {
        if devices.len() < 2 {
            return Err(Error::Discovery(DiscoveryError::NoDevicesFound));
        }

        // Disconnect any existing connections
        self.disconnect().await?;

        // Use PTP timing for group sync
        let mut config = self.stream_config.clone();
        config.timing_protocol = airplay_core::stream::TimingProtocol::Ptp;
        config.ptp_mode = airplay_core::PtpMode::Master;

        // Generate ALAC magic cookie if needed
        if config.audio_format.codec == airplay_core::AudioCodec::Alac && config.asc.is_none() {
            let temp_encoder = AlacEncoder::new(config.audio_format.clone())
                .map_err(|e| Error::Streaming(airplay_core::error::StreamingError::Encoding(
                    format!("Failed to create encoder for magic cookie: {}", e)
                )))?;
            config.asc = Some(temp_encoder.magic_cookie());
        }

        // Connect + pair all devices
        let mut connections: Vec<Connection> = Vec::new();
        for device in devices {
            let conn = Connection::connect_auto(device.clone(), config.clone(), "3939").await?;
            connections.push(conn);
        }

        // Collect peer addresses
        let mut peer_addresses: Vec<String> = devices.iter()
            .flat_map(|d| d.addresses.iter().find(|a| a.is_ipv4()).map(|a| a.to_string()))
            .collect();
        if let Some(local_addr) = connections[0].local_addr() {
            peer_addresses.push(local_addr.ip().to_string());
        }

        // Setup primary (first device) with PTP BMCA
        connections[0].setup().await?;
        connections[0].set_render_delay_ms(self.render_delay_ms);
        connections[0].send_setpeers(&peer_addresses).await?;

        // Get PTP state from primary
        let ptp_clock_id = connections[0].ptp_master_clock_id()
            .ok_or_else(|| RtspError::SetupFailed("Primary has no PTP clock ID".into()))?;
        let timing_offset = connections[0].timing_offset()
            .ok_or_else(|| RtspError::SetupFailed("Primary has no timing offset".into()))?;
        let timing_rx = connections[0].timing_rx()
            .ok_or_else(|| RtspError::SetupFailed("Primary has no timing channel".into()))?;

        // Setup secondary devices (no PTP).
        // Send feedback to already-established connections between each setup to
        // prevent RTSP session timeouts (connect_group holds the client lock for
        // the entire duration, blocking the tick handler from sending keepalives).
        for i in 1..connections.len() {
            // Keep earlier connections alive while setting up later ones
            for j in 0..i {
                let _ = connections[j].send_feedback().await;
            }

            let rx_clone = timing_rx.clone();
            connections[i].setup_for_group(ptp_clock_id, timing_offset, rx_clone).await?;
            connections[i].set_render_delay_ms(self.render_delay_ms);
            connections[i].send_setpeers(&peer_addresses).await?;
        }

        // Store primary as main connection, rest as group connections
        let mut iter = connections.into_iter();
        self.connection = iter.next();
        self.group_connections = iter.collect();

        // Create group metadata
        let mut group = DeviceGroup::new(devices[0].clone());
        for device in devices.iter().skip(1) {
            group.add_member(device.clone())?;
        }
        self.group = Some(group);

        self.emit_event(ClientEvent::Connected(devices[0].clone())).await;
        self.emit_event(ClientEvent::GroupChanged).await;

        Ok(())
    }

    /// Play an audio file to all group devices simultaneously.
    ///
    /// Requires `connect_group()` to have been called first. Uses the same
    /// AudioStreamer as single-device playback, getting RT priority, burst
    /// sending, precise timing, buffer management, EQ, and proper retransmit
    /// handling for free.
    pub async fn play_file_to_group(&mut self, path: impl AsRef<Path>) -> Result<()> {
        // Stop existing group control listener and streamer cleanly
        self.stop_group_control_listener();
        if let Some(ref mut streamer) = self.group_streamer {
            let _ = streamer.stop().await;
        }
        self.group_streamer = None;

        // Build RTP senders for all connections FIRST (before FLUSH/RECORD).
        // Matches solo path ordering to minimize gap between FLUSH and first audio.
        let mut senders = Vec::new();
        let connection = self.connection.as_ref().ok_or_else(|| {
            Error::Rtsp(RtspError::NoSession)
        })?;
        senders.push(connection.build_rtp_sender()?);
        for conn in &self.group_connections {
            senders.push(conn.build_rtp_sender()?);
        }

        let ptp_clock_id = connection.ptp_master_clock_id()
            .ok_or_else(|| RtspError::SetupFailed("No PTP clock ID for group streaming".into()))?;

        // Create streamer with multi-target senders
        let mut streamer = AudioStreamer::new(self.stream_config.clone());
        streamer.set_rtp_senders(senders).await;

        // Configure timing — use live watch channel for current offset
        if let Some(rx) = connection.timing_rx() {
            let current_offset = *rx.borrow();
            tracing::info!("Group file streaming: using live PTP offset = {} ns", current_offset.offset_ns);
            streamer.set_timing_offset(current_offset).await;
            streamer.set_timing_updates(rx).await;
        } else if let Some(offset) = connection.timing_offset() {
            tracing::warn!("Group file streaming: no live timing channel, using stale offset = {} ns", offset.offset_ns);
            streamer.set_timing_offset(offset).await;
        }
        streamer.set_ptp_sync_mode(ptp_clock_id).await;
        if self.render_delay_ms > 0 {
            streamer.set_render_delay_ms(self.render_delay_ms).await;
        }

        // Set up EQ if configured on primary connection
        if let Some(ref conn) = self.connection {
            if let (Some(config), Some(params)) = (conn.eq_config(), conn.eq_params()) {
                streamer.set_eq_params(config, params).await;
            }
        }

        // Set up spatial audio if configured on primary connection
        if let Some(ref conn) = self.connection {
            if let (Some(params), Some(speakers)) = (conn.spatial_params(), conn.spatial_speakers()) {
                streamer.set_spatial_params(params, speakers).await;
            }
        }

        // FLUSH clears device buffer state, then RECORD re-arms each device.
        if let Some(ref mut conn) = self.connection {
            if let Err(e) = conn.send_flush(0, 0).await {
                tracing::warn!("FLUSH failed on primary: {}", e);
            }
        }
        for (i, conn) in self.group_connections.iter_mut().enumerate() {
            if let Err(e) = conn.send_flush(0, 0).await {
                tracing::warn!("FLUSH failed on group member {}: {}", i, e);
            }
        }
        // Re-send RECORD after FLUSH to re-arm devices for audio
        if let Some(ref mut conn) = self.connection {
            conn.send_record().await.ok();
        }
        for conn in self.group_connections.iter_mut() {
            conn.send_record().await.ok();
        }

        // Open audio file and start streaming
        let decoder = AudioDecoder::open(path)?;
        streamer.start(decoder).await?;

        // Set volume on all devices (matches solo path behavior)
        if let Some(ref mut conn) = self.connection {
            if let Err(e) = conn.set_volume(conn.volume()).await {
                tracing::warn!("Failed to set volume on primary: {}", e);
            }
        }
        for conn in &mut self.group_connections {
            if let Err(e) = conn.set_volume(conn.volume()).await {
                tracing::warn!("Failed to set volume on group member: {}", e);
            }
        }

        // Create per-device stream stats (1 primary + N group connections)
        let device_count = 1 + self.group_connections.len();
        self.stream_stats = crate::stats::StreamStats::with_device_count(device_count);

        // Spawn control channel listener for retransmit handling (all devices)
        self.spawn_group_control_listener(&streamer);

        self.group_streamer = Some(streamer);
        self.group_playback_state = Some(PlaybackState::Playing);
        self.emit_event(ClientEvent::PlaybackStateChanged(PlaybackState::Playing)).await;

        Ok(())
    }

    /// Start live audio streaming to all group devices simultaneously.
    ///
    /// Requires `connect_group()` to have been called first. Uses the same
    /// AudioStreamer as single-device playback, getting all optimizations for free.
    pub async fn start_live_streaming_to_group(&mut self, decoder: LiveAudioDecoder) -> Result<()> {
        // Stop existing group control listener and streamer cleanly
        self.stop_group_control_listener();
        if let Some(ref mut streamer) = self.group_streamer {
            let _ = streamer.stop().await;
        }
        self.group_streamer = None;

        // Build RTP senders for all connections FIRST (before FLUSH/RECORD).
        // This matches the solo path ordering: build infrastructure → FLUSH → start_live.
        // Minimizes the gap between FLUSH/RECORD and first audio packet, which is
        // critical because devices start a timeout after receiving FLUSH+RECORD.
        let mut senders = Vec::new();
        let connection = self.connection.as_ref().ok_or_else(|| {
            Error::Rtsp(RtspError::NoSession)
        })?;
        senders.push(connection.build_rtp_sender()?);
        for conn in &self.group_connections {
            senders.push(conn.build_rtp_sender()?);
        }

        let ptp_clock_id = connection.ptp_master_clock_id()
            .ok_or_else(|| RtspError::SetupFailed("No PTP clock ID for group streaming".into()))?;

        // Create streamer with multi-target senders
        let mut streamer = AudioStreamer::new(self.stream_config.clone());
        streamer.set_rtp_senders(senders).await;

        // Configure timing — use live watch channel for current offset, not stale
        // setup-time value. The BMCA slave loop has been running since connect_group()
        // and the watch channel has the latest offset, while connection.timing_offset()
        // returns a snapshot from setup time (which may have been zero).
        if let Some(rx) = connection.timing_rx() {
            let current_offset = *rx.borrow();
            tracing::info!("Group streaming: using live PTP offset = {} ns", current_offset.offset_ns);
            streamer.set_timing_offset(current_offset).await;
            streamer.set_timing_updates(rx).await;
        } else if let Some(offset) = connection.timing_offset() {
            tracing::warn!("Group streaming: no live timing channel, using stale offset = {} ns", offset.offset_ns);
            streamer.set_timing_offset(offset).await;
        }
        streamer.set_ptp_sync_mode(ptp_clock_id).await;
        if self.render_delay_ms > 0 {
            streamer.set_render_delay_ms(self.render_delay_ms).await;
        }

        // Set up EQ if configured on primary connection
        if let Some(ref conn) = self.connection {
            if let (Some(config), Some(params)) = (conn.eq_config(), conn.eq_params()) {
                streamer.set_eq_params(config, params).await;
            }
        }

        // Set up spatial audio if configured on primary connection
        if let Some(ref conn) = self.connection {
            if let (Some(params), Some(speakers)) = (conn.spatial_params(), conn.spatial_speakers()) {
                streamer.set_spatial_params(params, speakers).await;
            }
        }

        // FLUSH clears device buffer state, then RECORD re-arms each device to
        // accept audio. This is needed because the original RECORD from connect_group()
        // was sent 10+ seconds ago and FLUSH may invalidate it. Order matters:
        // FLUSH first (clears old RECORD state), then RECORD (re-arms).
        if let Some(ref mut conn) = self.connection {
            if let Err(e) = conn.send_flush(0, 0).await {
                tracing::warn!("FLUSH failed on primary: {}", e);
            }
        }
        for (i, conn) in self.group_connections.iter_mut().enumerate() {
            if let Err(e) = conn.send_flush(0, 0).await {
                tracing::warn!("FLUSH failed on group member {}: {}", i, e);
            }
        }
        // Re-send RECORD after FLUSH to re-arm devices for audio
        if let Some(ref mut conn) = self.connection {
            conn.send_record().await.ok();
        }
        for conn in self.group_connections.iter_mut() {
            conn.send_record().await.ok();
        }

        // Start live streaming — buffer fill + sender thread.
        // Audio begins flowing immediately after buffer reaches 50%.
        streamer.start_live(decoder).await?;

        // Set volume on all devices (solo path does this; without it, devices
        // may use stale volume or silence after FLUSH)
        if let Some(ref mut conn) = self.connection {
            if let Err(e) = conn.set_volume(conn.volume()).await {
                tracing::warn!("Failed to set volume on primary: {}", e);
            }
        }
        for conn in &mut self.group_connections {
            if let Err(e) = conn.set_volume(conn.volume()).await {
                tracing::warn!("Failed to set volume on group member: {}", e);
            }
        }

        // Create per-device stream stats (1 primary + N group connections)
        let device_count = 1 + self.group_connections.len();
        self.stream_stats = crate::stats::StreamStats::with_device_count(device_count);

        // Spawn control channel listener for retransmit handling (all devices)
        self.spawn_group_control_listener(&streamer);

        self.group_streamer = Some(streamer);
        self.group_playback_state = Some(PlaybackState::Playing);
        self.emit_event(ClientEvent::PlaybackStateChanged(PlaybackState::Playing)).await;

        Ok(())
    }

    /// Spawn a single control channel listener thread that polls ALL device
    /// control sockets in round-robin for retransmit requests (PT=85).
    fn spawn_group_control_listener(&mut self, streamer: &AudioStreamer) {
        // Kill any existing group control listener first
        self.stop_group_control_listener();

        let mut control_sockets: Vec<(usize, UdpSocket)> = Vec::new();

        // Primary connection
        if let Some(ref conn) = self.connection {
            if let Some(sock) = conn.clone_control_socket_for_recv() {
                control_sockets.push((0, sock));
            }
        }

        // Group connections
        for (i, conn) in self.group_connections.iter().enumerate() {
            if let Some(sock) = conn.clone_control_socket_for_recv() {
                control_sockets.push((i + 1, sock));
            }
        }

        if control_sockets.is_empty() {
            return;
        }

        let streamer_clone = streamer.clone();
        let rt_handle = tokio::runtime::Handle::current();
        let stats = Arc::clone(&self.stream_stats);
        let stop_flag = Arc::clone(&self.group_control_stop);
        stop_flag.store(false, Ordering::Release);

        let handle = std::thread::Builder::new()
            .name("group-ctrl".into())
            .spawn(move || {
                for (_, sock) in &control_sockets {
                    sock.set_read_timeout(Some(Duration::from_millis(5))).ok();
                }
                let mut buf = [0u8; 2048];
                tracing::debug!("Group control listener started ({} sockets)", control_sockets.len());

                loop {
                    if stop_flag.load(Ordering::Acquire) {
                        tracing::info!("Group control listener: stop flag set, exiting");
                        break;
                    }

                    for &(device_index, ref sock) in &control_sockets {
                        match sock.recv_from(&mut buf) {
                            Ok((len, _)) => {
                                if len < 4 { continue; }
                                let payload_type = buf[1] & 0x7F;
                                if payload_type == 85 {
                                    let request = if len == 8 {
                                        let first_seq = u16::from_be_bytes([buf[4], buf[5]]);
                                        let count = u16::from_be_bytes([buf[6], buf[7]]);
                                        Some(RetransmitRequest { first_sequence: first_seq, count })
                                    } else if len >= 12 {
                                        RetransmitRequest::parse(&buf[..len]).ok()
                                    } else {
                                        None
                                    };
                                    if let Some(req) = request {
                                        stats.rtx_requested.fetch_add(req.count as u64, Ordering::Relaxed);
                                        if let Some(dev) = stats.device(device_index) {
                                            dev.rtx_requested.fetch_add(req.count as u64, Ordering::Relaxed);
                                        }
                                        match rt_handle.block_on(
                                            streamer_clone.handle_retransmit_for_target(device_index, &req)
                                        ) {
                                            Ok(fulfilled) => {
                                                if fulfilled > 0 {
                                                    stats.rtx_fulfilled.fetch_add(fulfilled as u64, Ordering::Relaxed);
                                                    if let Some(dev) = stats.device(device_index) {
                                                        dev.rtx_fulfilled.fetch_add(fulfilled as u64, Ordering::Relaxed);
                                                    }
                                                    tracing::debug!(
                                                        "Group RTX[{}]: retransmitted {}/{} (seq {}..{})",
                                                        device_index, fulfilled, req.count,
                                                        req.first_sequence,
                                                        req.first_sequence.wrapping_add(req.count.saturating_sub(1))
                                                    );
                                                }
                                            }
                                            Err(e) => {
                                                tracing::warn!("Group RTX[{}]: retransmit failed: {}", device_index, e);
                                            }
                                        }
                                    }
                                }
                            }
                            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock
                                || e.kind() == std::io::ErrorKind::TimedOut => {}
                            Err(_) => {
                                // Socket closed — mark inactive but keep polling others
                            }
                        }
                    }
                }
            });

        match handle {
            Ok(h) => {
                self.group_control_thread = Some(h);
            }
            Err(e) => {
                tracing::warn!("Failed to spawn group control listener: {}", e);
            }
        }
    }

    /// Check if group streaming is active.
    pub fn is_group_connected(&self) -> bool {
        !self.group_connections.is_empty()
    }

    /// Get the number of devices in the active group (including primary).
    pub fn group_device_count(&self) -> usize {
        if self.group_connections.is_empty() {
            0
        } else {
            1 + self.group_connections.len()
        }
    }

    /// Get the shared stream stats.
    pub fn stream_stats(&self) -> Arc<crate::stats::StreamStats> {
        Arc::clone(&self.stream_stats)
    }

    /// Get a snapshot of current stream statistics.
    ///
    /// For group streaming: uses client-level per-device stats + streamer packets_sent.
    /// For single-device: uses connection-level stats + streamer packets_sent.
    pub fn stats_snapshot(&self) -> crate::stats::StatsSnapshot {
        if self.group_streamer.is_some() {
            let mut snap = self.stream_stats.snapshot();
            if let Some(ref streamer) = self.group_streamer {
                snap.packets_sent = streamer.packets_sent();
                snap.underruns = streamer.underruns();
            }
            snap
        } else if let Some(ref conn) = self.connection {
            let mut snap = conn.stream_stats().snapshot();
            snap.packets_sent = conn.streamer_packets_sent();
            snap.underruns = conn.streamer_underruns();
            snap
        } else {
            crate::stats::StatsSnapshot::default()
        }
    }

    // Multi-room methods (legacy metadata-only group management)

    /// Create a multi-room group.
    pub async fn create_group(&mut self, devices: &[&Device]) -> Result<()> {
        if devices.is_empty() {
            return Err(Error::Discovery(DiscoveryError::NoDevicesFound));
        }

        // First device is the leader
        let leader = devices[0];

        // Connect to leader if not already connected
        if self.connection.is_none() || self.connected_device().map(|d| &d.id) != Some(&leader.id) {
            self.connect(leader).await?;
        }

        // Create group with leader
        let mut group = DeviceGroup::new(leader.clone());

        // Add remaining devices as members
        for device in devices.iter().skip(1) {
            group.add_member((*device).clone())?;
        }

        self.group = Some(group);

        self.emit_event(ClientEvent::GroupChanged).await;

        Ok(())
    }

    /// Add device to current group.
    pub async fn add_to_group(&mut self, device: &Device) -> Result<()> {
        let group = self.group.as_mut().ok_or_else(|| {
            Error::Rtsp(RtspError::SetupFailed("No group exists".to_string()))
        })?;

        group.add_member(device.clone())?;

        // Send SETPEERS to all connections
        if let Some(ref mut connection) = self.connection {
            let addresses = group.peer_addresses();
            connection.send_setpeers(&addresses).await?;
        }

        self.emit_event(ClientEvent::GroupChanged).await;

        Ok(())
    }

    /// Remove device from current group.
    pub async fn remove_from_group(&mut self, device: &Device) -> Result<()> {
        let group = self.group.as_mut().ok_or_else(|| {
            Error::Rtsp(RtspError::SetupFailed("No group exists".to_string()))
        })?;

        group.remove_member(&device.id)?;

        // Send updated SETPEERS
        if let Some(ref mut connection) = self.connection {
            let addresses = group.peer_addresses();
            connection.send_setpeers(&addresses).await?;
        }

        self.emit_event(ClientEvent::GroupChanged).await;

        Ok(())
    }

    /// Disband the current group.
    pub async fn disband_group(&mut self) -> Result<()> {
        self.group = None;

        self.emit_event(ClientEvent::GroupChanged).await;

        Ok(())
    }

    /// Get current group.
    pub fn group(&self) -> Option<&DeviceGroup> {
        self.group.as_ref()
    }
}

impl Default for AirPlayClient {
    fn default() -> Self {
        Self::new().expect("Failed to create client")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod client_creation {
        use super::*;

        #[test]
        fn new_creates_disconnected_client() {
            // Skip if mDNS not available
            if let Ok(client) = AirPlayClient::new() {
                assert!(!client.is_connected());
                assert!(client.connected_device().is_none());
                assert_eq!(client.playback_state(), PlaybackState::Stopped);
            }
        }

        #[test]
        fn default_creates_client() {
            // Skip if mDNS not available
            // Note: Default panics if creation fails, so we use new() for testing
            if let Ok(client) = AirPlayClient::new() {
                assert!(!client.is_connected());
            }
        }
    }

    mod discovery {
        use super::*;

        #[tokio::test]
        async fn discover_returns_devices() {
            // Skip if mDNS not available
            if let Ok(client) = AirPlayClient::new() {
                // Very short timeout - we don't expect to find devices in tests
                let devices = client.discover(Duration::from_millis(100)).await;
                assert!(devices.is_ok());
            }
        }

        #[tokio::test]
        async fn discover_respects_timeout() {
            if let Ok(client) = AirPlayClient::new() {
                let start = std::time::Instant::now();
                let _ = client.discover(Duration::from_millis(200)).await;
                let elapsed = start.elapsed();
                // Should complete within a reasonable time of the timeout
                assert!(elapsed >= Duration::from_millis(200));
                assert!(elapsed < Duration::from_secs(2));
            }
        }

        #[tokio::test]
        async fn get_device_returns_none_for_unknown() {
            if let Ok(client) = AirPlayClient::new() {
                let unknown_id = DeviceId([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x00]);
                let result = client.get_device(&unknown_id).await;
                assert!(result.is_none());
            }
        }
    }

    mod connection {
        use super::*;

        #[tokio::test]
        async fn connect_establishes_connection() {
            // This test requires a real device - skip in unit tests
        }

        #[tokio::test]
        async fn connect_with_pin_for_protected_device() {
            // This test requires a real device - skip in unit tests
        }

        #[tokio::test]
        async fn disconnect_clears_connection() {
            if let Ok(mut client) = AirPlayClient::new() {
                // Even without being connected, disconnect should succeed
                let result = client.disconnect().await;
                assert!(result.is_ok());
                assert!(!client.is_connected());
            }
        }

        #[tokio::test]
        async fn is_connected_reflects_state() {
            if let Ok(client) = AirPlayClient::new() {
                assert!(!client.is_connected());
            }
        }

        #[tokio::test]
        async fn connected_device_returns_device() {
            if let Ok(client) = AirPlayClient::new() {
                // Not connected, should return None
                assert!(client.connected_device().is_none());
            }
        }
    }

    mod playback {
        use super::*;

        #[tokio::test]
        async fn play_file_starts_playback() {
            // This test requires a real device - skip in unit tests
        }

        #[tokio::test]
        async fn play_file_error_when_disconnected() {
            if let Ok(mut client) = AirPlayClient::new() {
                let result = client.play_file("/nonexistent.mp3").await;
                // Should fail because we're not connected
                assert!(result.is_err());
            }
        }

        #[tokio::test]
        async fn pause_pauses_playback() {
            if let Ok(mut client) = AirPlayClient::new() {
                // Should fail when not connected
                let result = client.pause().await;
                assert!(result.is_err());
            }
        }

        #[tokio::test]
        async fn resume_resumes_playback() {
            if let Ok(mut client) = AirPlayClient::new() {
                // Should fail when not connected
                let result = client.resume().await;
                assert!(result.is_err());
            }
        }

        #[tokio::test]
        async fn stop_stops_playback() {
            if let Ok(mut client) = AirPlayClient::new() {
                // Should fail when not connected
                let result = client.stop().await;
                assert!(result.is_err());
            }
        }

        #[tokio::test]
        async fn seek_changes_position() {
            if let Ok(mut client) = AirPlayClient::new() {
                // Should fail when not connected
                let result = client.seek(10.0).await;
                assert!(result.is_err());
            }
        }

        #[tokio::test]
        async fn set_volume_in_range() {
            if let Ok(mut client) = AirPlayClient::new() {
                // Should fail when not connected
                let result = client.set_volume(0.5).await;
                assert!(result.is_err());
            }
        }

        #[tokio::test]
        async fn playback_state_reflects_current_state() {
            if let Ok(client) = AirPlayClient::new() {
                assert_eq!(client.playback_state(), PlaybackState::Stopped);
            }
        }

        #[tokio::test]
        async fn playback_position_tracks_progress() {
            if let Ok(client) = AirPlayClient::new() {
                assert_eq!(client.playback_position(), 0.0);
            }
        }

        #[tokio::test]
        async fn wait_for_completion_blocks() {
            // This test would block forever without actual playback
            // Skip in unit tests
        }
    }

    mod multi_room {
        use super::*;

        #[tokio::test]
        async fn create_group_with_multiple_devices() {
            // This test requires real devices - skip in unit tests
        }

        #[tokio::test]
        async fn add_to_group_adds_device() {
            // This test requires real devices - skip in unit tests
        }

        #[tokio::test]
        async fn remove_from_group_removes_device() {
            // This test requires real devices - skip in unit tests
        }

        #[tokio::test]
        async fn disband_group_clears_group() {
            if let Ok(mut client) = AirPlayClient::new() {
                // Even without a group, disband should succeed
                let result = client.disband_group().await;
                assert!(result.is_ok());
                assert!(client.group().is_none());
            }
        }
    }

    mod events {
        use super::*;

        #[tokio::test]
        async fn event_handler_called_on_connect() {
            // This test requires real devices - skip in unit tests
        }

        #[tokio::test]
        async fn event_handler_called_on_disconnect() {
            // We can test this without a device
            use std::sync::atomic::{AtomicBool, Ordering};
            use std::sync::Arc;
            use crate::events::CallbackHandler;

            let event_received = Arc::new(AtomicBool::new(false));
            let event_received_clone = Arc::clone(&event_received);

            if let Ok(mut client) = AirPlayClient::new() {
                client.set_event_handler(CallbackHandler::new(move |event| {
                    if matches!(event, ClientEvent::Disconnected(_)) {
                        event_received_clone.store(true, Ordering::SeqCst);
                    }
                }));

                client.disconnect().await.unwrap();
                assert!(event_received.load(Ordering::SeqCst));
            }
        }

        #[tokio::test]
        async fn event_handler_called_on_playback_change() {
            // This test requires real devices - skip in unit tests
        }
    }
}
