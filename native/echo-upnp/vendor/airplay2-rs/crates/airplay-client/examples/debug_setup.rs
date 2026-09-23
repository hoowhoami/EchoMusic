//! Debug test for SETUP request
//!
//! Run with: cargo run --example debug_setup -- <ip> <port>
//! Example: cargo run --example debug_setup -- 192.168.0.103 7000

use airplay_client::Connection;
use airplay_core::device::{Device, DeviceId};
use airplay_core::features::Features;
use airplay_core::StreamConfig;
use std::net::IpAddr;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging with DEBUG level
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .with_target(true)
        .init();

    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: {} <ip> <port>", args[0]);
        eprintln!("Example: {} 192.168.0.103 7000", args[0]);
        std::process::exit(1);
    }

    let ip: IpAddr = args[1].parse()?;
    let port: u16 = args[2].parse()?;

    println!("=== AirPlay SETUP Debug Test ===");
    println!("Connecting to {}:{}", ip, port);

    // Create a minimal device for testing
    // Features from the HomePod log: 0x4A7FCA00,0x3C354BD0
    let features = Features::from_txt_value("0x4A7FCA00,0x3C354BD0")
        .unwrap_or_default();

    let device = Device {
        id: DeviceId::from_mac_string("DE:65:74:40:75:62").unwrap(),
        name: "Test HomePod".to_string(),
        model: "AudioAccessory5,1".to_string(),
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

    println!("Device: {} ({})", device.name, device.model);
    println!("Features: {:?}", device.features);

    // Connect and pair - use PTP timing (required by HomePod)
    let config = StreamConfig::airplay2_buffered();  // PTP + Buffered
    println!("Using config: stream_type={:?}, timing={:?}", config.stream_type, config.timing_protocol);

    println!("\n--- Connecting ---");
    let mut conn = match Connection::connect(device, config).await {
        Ok(c) => {
            println!("Connected and paired successfully!");
            c
        }
        Err(e) => {
            eprintln!("Connection failed: {:?}", e);
            return Err(e.into());
        }
    };

    // Try SETUP
    println!("\n--- Attempting SETUP ---");
    match conn.setup().await {
        Ok(()) => {
            println!("SETUP succeeded!");
        }
        Err(e) => {
            eprintln!("SETUP failed: {:?}", e);
            return Err(e.into());
        }
    }

    println!("\n=== Test Complete ===");
    Ok(())
}
