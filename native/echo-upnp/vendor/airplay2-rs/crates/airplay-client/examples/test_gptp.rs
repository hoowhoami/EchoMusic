//! gPTP AirPlay validation test.
//!
//! Hardcoded to AirPlay 2 + PTP + BMCA yield mode.
//! Tests the Mac-style gPTP flow: BMCA negotiation → yield to HomePod → slave sync → PT=87 audio.
//!
//! Run with: sudo cargo run --example test_gptp -- <ip> <port> <audio-file>
//! Example: sudo cargo run --example test_gptp -- <device-ip> 7000 test.mp3

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

async fn async_main() -> Result<(), Box<dyn std::error::Error>> {
    // TRACE-level logging for protocol validation
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_target(true)
        .init();

    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("Usage: {} <ip> <port> <audio-file>", args[0]);
        eprintln!("Example: sudo {} <device-ip> 7000 test.mp3", args[0]);
        eprintln!("\nThis test validates gPTP AirPlay with BMCA yield flow.");
        eprintln!("Requires root for PTP ports 319/320.");
        std::process::exit(1);
    }

    let ip: IpAddr = args[1].parse()?;
    let port: u16 = args[2].parse()?;
    let audio_path = &args[3];

    println!("========================================");
    println!(" gPTP AirPlay Validation Test");
    println!("========================================");
    println!(" Target: {}:{}", ip, port);
    println!(" Audio:  {}", audio_path);
    println!(" Mode:   AirPlay 2 + PTP + BMCA Yield");
    println!("========================================");

    // Open audio file
    let decoder = AudioDecoder::open(audio_path)?;
    let duration_secs = decoder.duration_samples()
        .map(|s| s as f64 / decoder.sample_rate() as f64)
        .unwrap_or(0.0);
    println!("\nAudio: {}Hz, {} ch, {:.1}s", decoder.sample_rate(), decoder.channels(), duration_secs);

    // Create device with HomePod-like features
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
    let device = Device {
        id: device_id,
        name: "gPTP Test Device".to_string(),
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
    };

    let audio_format = AudioFormat::default();
    let asc = if audio_format.codec == AudioCodec::Alac {
        let temp_encoder = AlacEncoder::new(audio_format.clone())?;
        Some(temp_encoder.magic_cookie())
    } else {
        None
    };

    // Force PTP + Master (which triggers BMCA yield)
    let config = StreamConfig {
        stream_type: StreamType::Realtime,
        audio_format,
        timing_protocol: TimingProtocol::Ptp,
        ptp_mode: PtpMode::Master,
        latency_min: 22050,
        latency_max: 88200,
        supports_dynamic_stream_id: true,
        asc,
    };

    // Phase 1: Connect + pair
    println!("\n--- Phase 1: Connect + Pair ---");
    let connect_start = Instant::now();
    let mut conn = Connection::connect_auto(device, config, "3939").await?;
    println!("Connected + paired in {:.1}s", connect_start.elapsed().as_secs_f64());

    // Phase 2: SETUP (triggers BMCA yield flow)
    println!("\n--- Phase 2: SETUP (triggers BMCA) ---");
    let setup_start = Instant::now();
    conn.setup().await?;
    println!("Setup complete in {:.1}s", setup_start.elapsed().as_secs_f64());

    // Phase 3: Stream audio for 15 seconds
    println!("\n--- Phase 3: Stream (15s) ---");
    conn.start_streaming(decoder).await?;
    println!("Streaming started!");

    let stream_duration = 15;
    let mut feedback_counter = 0u32;
    for elapsed in 1..=stream_duration {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let pos = conn.playback_position();
        let state = conn.playback_state();
        println!("[{}/{}s] Position: {:.1}s, State: {:?}", elapsed, stream_duration, pos, state);

        feedback_counter += 1;
        if feedback_counter % 2 == 0 {
            if let Err(e) = conn.send_feedback().await {
                tracing::warn!("Feedback failed: {}", e);
            }
        }
    }

    // Phase 4: Teardown
    println!("\n--- Phase 4: Teardown ---");
    conn.stop().await?;
    conn.disconnect().await?;

    println!("\n========================================");
    println!(" Test Complete");
    println!("========================================");
    println!("If audio played on the HomePod, gPTP is working!");

    Ok(())
}
