//! Multi-speaker group streaming test.
//!
//! Streams audio to 2+ HomePods simultaneously using shared PTP clock synchronization.
//! The primary device runs BMCA yield flow; secondary devices share the same clock state.
//!
//! Run with: sudo cargo run --example test_group -- <ip1[:port]> <ip2[:port]> [<ip3[:port]> ...] <audio-file>
//! Example: sudo cargo run --example test_group -- 192.168.1.10 192.168.1.11:33330 test.mp3

#[allow(unused_imports)]
use airplay_audio::{AudioDecoder, AlacEncoder};
use airplay_client::Connection;
use airplay_core::device::{Device, DeviceId};
use airplay_core::features::Features;
use airplay_core::{StreamConfig, AudioFormat, AudioCodec};
use airplay_core::stream::{StreamType, TimingProtocol, PtpMode};
use std::net::IpAddr;
use std::time::{Duration, Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()?;

    runtime.block_on(async_main())
}

/// Build a synthetic Device struct from an IP address and port.
fn make_device(ip: IpAddr, port: u16, name: &str) -> Result<Device, Box<dyn std::error::Error>> {
    let device_id_str = match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            format!("{:02X}:{:02X}:{:02X}:{:02X}:00:00", o[0], o[1], o[2], o[3])
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            format!("{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
                (s[0] >> 8) as u8, s[0] as u8, (s[1] >> 8) as u8, s[1] as u8,
                (s[2] >> 8) as u8, s[2] as u8)
        }
    };

    let features = Features::from_txt_value("0x4A7FCA00,0x3C354BD0").unwrap_or_default();
    let device_id = DeviceId::from_mac_string(&device_id_str)?;

    Ok(Device {
        id: device_id,
        name: name.to_string(),
        model: "Unknown".to_string(),
        manufacturer: None,
        serial_number: None,
        addresses: vec![ip],
        port,
        features,
        required_sender_features: None,
        public_key: None,
        source_version: Default::default(),
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
    })
}

/// Build a PTP sync packet (PT=87, 28 bytes).
#[allow(dead_code)]
fn build_ptp_sync_packet(
    seq: u16,
    current_rtp_ts: u32,
    ptp_clock_ns: u64,
    next_rtp_ts: u32,
    master_clock_id: &[u8; 8],
    is_first: bool,
) -> Vec<u8> {
    let mut packet = [0u8; 28];

    // Byte 0: 0x90 for first sync (extension bit set), 0x80 for subsequent
    packet[0] = if is_first { 0x90 } else { 0x80 };

    // Byte 1: 0xD7 = marker (0x80) | PT 87 (0x57)
    packet[1] = 0xD7;

    // Sequence
    packet[2..4].copy_from_slice(&seq.to_be_bytes());

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

    packet.to_vec()
}

/// Build an RTP audio packet header (12 bytes).
#[allow(dead_code)]
fn build_rtp_header(seq: u16, timestamp: u32, payload_type: u8, ssrc: u32, marker: bool) -> [u8; 12] {
    let mut header = [0u8; 12];
    // V=2, P=0, X=0, CC=0
    header[0] = 0x80;
    // Marker + PT
    header[1] = if marker { 0x80 | payload_type } else { payload_type };
    // Sequence
    header[2..4].copy_from_slice(&seq.to_be_bytes());
    // Timestamp
    header[4..8].copy_from_slice(&timestamp.to_be_bytes());
    // SSRC
    header[8..12].copy_from_slice(&ssrc.to_be_bytes());
    header
}

async fn async_main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .with_target(true)
        .init();

    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("Usage: {} <ip1[:port]> <ip2[:port]> [<ip3[:port]> ...] <audio-file>", args[0]);
        eprintln!("Example: sudo {} 192.168.1.10 192.168.1.11:33330 test.mp3", args[0]);
        eprintln!("\nStreams audio to multiple AirPlay devices simultaneously.");
        eprintln!("Port defaults to 7000 if not specified.");
        eprintln!("Requires root for PTP ports 319/320.");
        std::process::exit(1);
    }

    // Last arg is audio file, everything else is ip[:port] specs
    let audio_path = &args[args.len() - 1];
    let mut targets: Vec<(IpAddr, u16)> = Vec::new();
    for arg in &args[1..args.len() - 1] {
        // Try parsing as ip:port first, fallback to plain IP with default port 7000
        if let Some(colon_pos) = arg.rfind(':') {
            // Could be ip:port or just an IPv6 address
            let maybe_port = &arg[colon_pos + 1..];
            if let Ok(port) = maybe_port.parse::<u16>() {
                let ip_str = &arg[..colon_pos];
                let ip: IpAddr = ip_str.parse()?;
                targets.push((ip, port));
            } else {
                // It's an IPv6 address without port
                let ip: IpAddr = arg.parse()?;
                targets.push((ip, 7000));
            }
        } else {
            let ip: IpAddr = arg.parse()?;
            targets.push((ip, 7000));
        }
    }

    if targets.len() < 2 {
        eprintln!("Error: need at least 2 devices for group streaming");
        std::process::exit(1);
    }

    println!("========================================");
    println!(" Multi-Speaker Group Streaming Test");
    println!("========================================");
    for (i, (ip, port)) in targets.iter().enumerate() {
        println!(" Device {}: {}:{}", i + 1, ip, port);
    }
    println!(" Audio:  {}", audio_path);
    println!(" Mode:   AirPlay 2 + PTP + BMCA Yield");
    println!("========================================");

    // Open audio file and inspect format
    let decoder = AudioDecoder::open(audio_path)?;
    let duration_secs = decoder.duration_samples()
        .map(|s| s as f64 / decoder.sample_rate() as f64)
        .unwrap_or(0.0);
    println!("\nAudio: {}Hz, {} ch, {:.1}s", decoder.sample_rate(), decoder.channels(), duration_secs);

    // Build stream config
    let audio_format = AudioFormat::default();
    let asc = if audio_format.codec == AudioCodec::Alac {
        let temp_encoder = AlacEncoder::new(audio_format.clone())?;
        Some(temp_encoder.magic_cookie())
    } else {
        None
    };

    let config = StreamConfig {
        stream_type: StreamType::Realtime,
        audio_format: audio_format.clone(),
        timing_protocol: TimingProtocol::Ptp,
        ptp_mode: PtpMode::Master,
        latency_min: 22050,
        latency_max: 88200,
        supports_dynamic_stream_id: true,
        asc,
    };

    // Create devices
    let devices: Vec<Device> = targets.iter().enumerate()
        .map(|(i, (ip, port))| make_device(*ip, *port, &format!("Group Device {}", i + 1)))
        .collect::<Result<Vec<_>, _>>()?;

    // Collect all peer addresses (device IPs + our local IP, filled in after connect)
    let mut peer_addresses: Vec<String> = targets.iter().map(|(ip, _)| ip.to_string()).collect();

    // ===== Phase 1: Connect + pair all devices =====
    println!("\n--- Phase 1: Connect + Pair All Devices ---");
    let mut connections: Vec<Connection> = Vec::new();
    for (i, device) in devices.iter().enumerate() {
        let connect_start = Instant::now();
        let conn = Connection::connect_auto(device.clone(), config.clone(), "3939").await?;
        println!("  Device {} connected + paired in {:.1}s", i + 1, connect_start.elapsed().as_secs_f64());
        connections.push(conn);
    }

    // Add our local address to peer list
    if let Some(local_addr) = connections[0].local_addr() {
        peer_addresses.push(local_addr.ip().to_string());
    }
    println!("  Peer addresses: {:?}", peer_addresses);

    // ===== Phase 2: SETUP primary with BMCA yield (proven working) =====
    // PTP master mode didn't work — HomePods ignore our PTP Syncs.
    // Go back to BMCA yield (pri1=250, HomePod becomes PTP master).
    // Test: does adding secondary SETUP break primary playback?
    println!("\n--- Phase 2: SETUP Primary (BMCA Yield) ---");
    let setup_start = Instant::now();
    connections[0].setup().await?;
    println!("  Primary setup complete in {:.1}s", setup_start.elapsed().as_secs_f64());

    // Send SETPEERS to primary
    connections[0].send_setpeers(&peer_addresses).await?;
    println!("  SETPEERS sent to primary: {:?}", peer_addresses);

    // Get PTP state from primary
    let ptp_clock_id = connections[0].ptp_master_clock_id()
        .ok_or("Primary has no PTP clock ID — BMCA may have failed")?;
    let timing_offset = connections[0].timing_offset()
        .ok_or("Primary has no timing offset")?;

    println!("  PTP clock ID: {:02x?}", ptp_clock_id);
    println!("  Timing offset: {} ns", timing_offset.offset_ns);

    // ===== Phase 3: Setup secondary devices (shared PTP clock) =====
    // This is the test we've been trying to isolate: does secondary SETUP
    // break primary playback?
    println!("\n--- Phase 3: SETUP Secondary Devices ---");
    for i in 1..connections.len() {
        let setup_start = Instant::now();
        let timing_rx = connections[0].timing_rx()
            .ok_or("Primary has no timing channel for group member")?;
        connections[i].setup_for_group(ptp_clock_id, timing_offset, timing_rx).await?;
        println!("  Device {} group setup in {:.1}s", i + 1, setup_start.elapsed().as_secs_f64());

        // Send SETPEERS to secondary
        connections[i].send_setpeers(&peer_addresses).await?;
        println!("  SETPEERS sent to device {}", i + 1);
    }

    // ===== Phase 4: Verify streaming params available =====
    println!("\n--- Phase 4: Verify Streaming Params ---");
    for (i, conn) in connections.iter().enumerate() {
        let params = conn.streaming_params()?;
        println!("  Device {}: data={}, control={}", i + 1, params.data_dest, params.control_dest);
    }

    // ===== Phase 5: Stream to ALL devices =====
    // Full test: SETPEERS + secondary SETUP + stream to all.
    // Testing with non-paired devices to confirm stereo pair theory.
    println!("\n--- Phase 5: Streaming to ALL devices ---");
    println!("  SETPEERS=enabled, secondary SETUP=enabled\n");

    for i in 0..connections.len() {
        let decoder = AudioDecoder::open(audio_path)?;
        connections[i].start_streaming(decoder).await?;
        println!("  Streaming started on device {}!", i + 1);
    }

    let stream_duration_secs = 15u64;
    let mut feedback_timer = Instant::now();
    for elapsed in 1..=stream_duration_secs {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let pos = connections[0].playback_position();
        let state = connections[0].playback_state();
        println!("  [{}/{}s] Position: {:.1}s, State: {:?}", elapsed, stream_duration_secs, pos, state);

        if feedback_timer.elapsed() >= Duration::from_secs(2) {
            for conn in &mut connections {
                if let Err(e) = conn.send_feedback().await {
                    tracing::warn!("Feedback failed: {}", e);
                }
            }
            feedback_timer = Instant::now();
        }
    }

    for (i, conn) in connections.iter_mut().enumerate() {
        conn.stop().await?;
        println!("  Device {} stopped", i + 1);
    }
    println!("  Streaming complete.");

    // ===== Phase 6: Teardown =====
    println!("\n--- Phase 6: Teardown ---");
    for (i, conn) in connections.iter_mut().enumerate() {
        conn.disconnect().await?;
        println!("  Device {} disconnected", i + 1);
    }

    println!("\n========================================");
    println!(" Group Test Complete");
    println!("========================================");
    println!("If audio played on all {} devices in sync, group streaming works!", targets.len());

    Ok(())
}
