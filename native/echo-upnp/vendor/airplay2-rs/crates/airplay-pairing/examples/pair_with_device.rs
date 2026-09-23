//! Example: Pair with a real AirPlay device.
//!
//! This example discovers AirPlay devices on the network and lets you
//! choose a pairing method to try.
//!
//! Usage:
//!   cargo run -p airplay-pairing --example pair_with_device
//!   cargo run -p airplay-pairing --example pair_with_device -- --match "HomePod"
//!   AIRPLAY_DEVICE_MATCH="AudioAccessory5,1" cargo run -p airplay-pairing --example pair_with_device
//!
//! ## Pairing Methods
//!
//! 1. **True Transient Pairing (Ed25519)** - for devices with pw=false
//!    - Simple Ed25519 public key exchange (32 bytes each way)
//!    - No SRP, no PIN required
//!    - Used when device allows "Everyone" access
//!
//! 2. **SRP Transient Pair-Setup** - for devices with pw=true
//!    - POST /pair-setup M1-M4 with SRP-6a protocol
//!    - Uses Flags=0x10 (transient) and PIN "3939" or device password
//!    - Stops at M4 (no M5/M6 identity registration)
//!    - Then requires pair-verify to establish encrypted session
//!
//! 3. **Full SRP Pair-Setup** (requires PIN, persistent pairing)
//!    - POST /pair-setup M1-M6 with SRP-6a protocol
//!    - Uses PIN 3939 (transient) or displayed PIN
//!    - Registers your Ed25519 key with the device
//!    - THEN pair-verify works for future sessions
//!
//! 4. **Pair-Verify (TLV8)** - traditional format
//!    - POST /pair-verify M1-M4 with TLV8 encoding
//!    - Uses previously registered Ed25519 key
//!
//! 5. **Pair-Verify (Raw 68-byte)** - for transient pairing
//!    - POST /pair-verify with raw binary format
//!    - 68 bytes: {1,0,0,0} | ECDH_PK(32) | Ed25519_PK(32)
//!    - Used after true transient pair-setup

use airplay_core::Device;
use airplay_crypto::ed25519::IdentityKeyPair;
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Nonce,
};
use airplay_crypto::tlv::{Tlv8, TlvType};
use airplay_discovery::{Discovery, ServiceBrowser};
use airplay_pairing::{ControllerIdentity, PairSetup, PairVerify, PairingSession};
use plist::Dictionary;
use rand::Rng;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;
use std::io::Cursor;
use std::env;

/// Persistent sender identity - reused across pairing attempts
#[derive(serde::Serialize, serde::Deserialize)]
struct PersistentIdentity {
    /// MAC-like device ID (e.g., "4D:61:9C:74:68:D1")
    device_id: String,
    /// DACP-ID (device ID without colons)
    dacp_id: String,
    /// Ed25519 secret key bytes
    ed25519_secret: Vec<u8>,
    /// Controller UUID
    controller_id: String,
    /// Last known server LTPK (from pair-setup M6), if available
    server_ltpk: Option<Vec<u8>>,
    /// Last known server identifier (from pair-setup M6), if available
    server_identifier: Option<String>,
    /// Pair-verify identifier (16 hex chars, like pair_ap device_id_hex)
    pair_verify_id: String,
}

impl PersistentIdentity {
    fn generate() -> Self {
        let mut rng = rand::thread_rng();
        let device_id = format!("{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
            rng.gen::<u8>(), rng.gen::<u8>(), rng.gen::<u8>(),
            rng.gen::<u8>(), rng.gen::<u8>(), rng.gen::<u8>());
        let dacp_id = device_id.replace(":", "");

        // Generate Ed25519 keypair and get the seed (32 bytes)
        let keypair = IdentityKeyPair::generate();
        let ed25519_seed = keypair.seed().to_vec();

        // Generate controller UUID
        let controller_id = format!("{:08X}-{:04X}-{:04X}-{:04X}-{:012X}",
            rng.gen::<u32>(), rng.gen::<u16>(), rng.gen::<u16>(),
            rng.gen::<u16>(), rng.gen::<u64>() & 0xFFFFFFFFFFFF);

        // Pair-verify identifier: 16 hex chars (8 bytes), uppercase
        let pair_verify_id = format!("{:016X}", rng.gen::<u64>());

        Self {
            device_id,
            dacp_id,
            ed25519_secret: ed25519_seed,
            controller_id,
            server_ltpk: None,
            server_identifier: None,
            pair_verify_id,
        }
    }

    fn identity_file_for(target_device_id: &str) -> PathBuf {
        // Store per-target device to avoid cross-device collisions.
        let suffix = target_device_id.replace(":", "").to_lowercase();
        PathBuf::from(format!(".airplay_sender_identity_{}.json", suffix))
    }

    fn load_or_create(target_device_id: &str) -> Self {
        let path = Self::identity_file_for(target_device_id);
        if path.exists() {
            if let Ok(data) = fs::read_to_string(&path) {
                if let Ok(identity) = serde_json::from_str::<Self>(&data) {
                    println!("  Loaded persistent identity from {}", path.display());
                    return identity;
                }
            }
        }

        let identity = Self::generate();
        if let Ok(data) = serde_json::to_string_pretty(&identity) {
            let _ = fs::write(&path, data);
            println!("  Created new persistent identity at {}", path.display());
        }
        identity
    }

    fn save(&self, target_device_id: &str) {
        let path = Self::identity_file_for(target_device_id);
        if let Ok(data) = serde_json::to_string_pretty(self) {
            let _ = fs::write(&path, data);
        }
    }

    fn to_controller(&self) -> ControllerIdentity {
        // Reconstruct keypair from seed bytes (32 bytes)
        let seed: [u8; 32] = self.ed25519_secret.clone().try_into()
            .expect("Invalid seed length");
        let keypair = IdentityKeyPair::from_seed(&seed);
        // Use the stored controller_id to ensure stable pairing identifier.
        ControllerIdentity::with_id(keypair, self.controller_id.clone())
    }
}

/// Global host for HTTP requests
static mut CURRENT_HOST: Option<String> = None;

fn set_host(host: String) {
    unsafe { CURRENT_HOST = Some(host); }
}

fn get_host() -> String {
    unsafe { CURRENT_HOST.clone().unwrap_or_else(|| "localhost".to_string()) }
}

fn usage() {
    println!("Usage:");
    println!("  cargo run -p airplay-pairing --example pair_with_device");
    println!("  cargo run -p airplay-pairing --example pair_with_device -- --match \"HomePod\"");
    println!("  AIRPLAY_DEVICE_MATCH=\"AudioAccessory5,1\" cargo run -p airplay-pairing --example pair_with_device");
    println!("  cargo run -p airplay-pairing --example pair_with_device -- --mode transient-rtsp --pin 3939");
    println!();
    println!("Selection matching checks device name, model, device ID, and IP address.");
    println!("Modes: transient-rtsp, transient-http");
}

fn device_matches(device: &Device, query: &str) -> bool {
    let query = query.to_lowercase();
    let id = device.id.to_mac_string().to_lowercase();
    let addresses = device.addresses.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(" ");
    let haystack = format!(
        "{} {} {} {}",
        device.name.to_lowercase(),
        device.model.to_lowercase(),
        id,
        addresses.to_lowercase(),
    );
    haystack.contains(&query)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== AirPlay Device Pairing ===\n");

    let mut match_query: Option<String> = None;
    let mut mode: Option<String> = None;
    let mut pin_arg: Option<String> = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--match" | "-m" => {
                match_query = args.next();
                if match_query.is_none() {
                    eprintln!("--match requires a value.");
                    usage();
                    return Ok(());
                }
            }
            "--mode" => {
                mode = args.next();
                if mode.is_none() {
                    eprintln!("--mode requires a value.");
                    usage();
                    return Ok(());
                }
            }
            "--pin" => {
                pin_arg = args.next();
                if pin_arg.is_none() {
                    eprintln!("--pin requires a value.");
                    usage();
                    return Ok(());
                }
            }
            "--help" | "-h" => {
                usage();
                return Ok(());
            }
            _ => {}
        }
    }
    if match_query.is_none() {
        match_query = env::var("AIRPLAY_DEVICE_MATCH").ok();
    }

    // Step 1: Discover devices
    println!("Scanning for AirPlay devices (5 seconds)...\n");

    let browser = ServiceBrowser::new()?;
    let devices = browser.scan(Duration::from_secs(5)).await?;

    if devices.is_empty() {
        println!("No AirPlay devices found!");
        return Ok(());
    }

    // Sort devices by name for consistent ordering
    let mut devices = devices;
    devices.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    for (i, device) in devices.iter().enumerate() {
        let addr = device.addresses.iter()
            .find(|a| a.is_ipv4())
            .or_else(|| device.addresses.first())
            .map(|a| a.to_string())
            .unwrap_or_default();

        let features = device.features.raw();
        println!(
            "  [{}] {} ({}) - {}:{}",
            i + 1,
            device.name,
            device.model,
            addr,
            device.port
        );
        println!("      Features: 0x{:08X},0x{:08X}", features & 0xFFFFFFFF, features >> 32);
        println!("      Auth: {:?} | Password: {} | AirPlay2: {}",
            device.features.auth_method(),
            if device.requires_password { "Yes" } else { "No" },
            if device.supports_airplay2() { "Yes" } else { "No" }
        );
        println!("      Bit26(MFi): {} | Bit48(Transient): {} | Bit51(UnifiedPair): {}",
            device.features.requires_mfi(),
            device.features.supports_transient_pairing(),
            device.features.supports_unified_pair_mfi()
        );
        if let Some(pk) = &device.public_key {
            println!("      Server PK: {}...", hex(&pk[..8]));
        }
        println!();
    }

    // Step 2: Select a device
    let selection = if let Some(query) = match_query.as_deref() {
        let matches: Vec<usize> = devices.iter()
            .enumerate()
            .filter(|(_, device)| device_matches(device, query))
            .map(|(idx, _)| idx)
            .collect();
        if matches.len() == 1 {
            let index = matches[0];
            println!("Auto-selected device via match \"{}\": {}", query, devices[index].name);
            index + 1
        } else if matches.len() > 1 {
            println!("\nMultiple devices matched \"{}\":", query);
            for (i, idx) in matches.iter().enumerate() {
                let device = &devices[*idx];
                let addr = device.addresses.iter()
                    .find(|a| a.is_ipv4())
                    .or_else(|| device.addresses.first())
                    .map(|a| a.to_string())
                    .unwrap_or_default();
                println!("  [{}] {} ({}) - {}:{}", i + 1, device.name, device.model, addr, device.port);
            }
            println!("\nSelect a matching device (1-{}):", matches.len());
            let selection = read_number(1, matches.len())?;
            matches[selection - 1] + 1
        } else {
            println!("No devices matched \"{}\". Falling back to manual selection.", query);
            println!("\nSelect a device (1-{}):", devices.len());
            read_number(1, devices.len())?
        }
    } else {
        println!("\nSelect a device (1-{}):", devices.len());
        read_number(1, devices.len())?
    };

    let device = &devices[selection - 1];
    let addr = device.addresses.iter()
        .find(|a| a.is_ipv4())
        .or_else(|| device.addresses.first())
        .ok_or("No address for device")?;

    let socket_addr = if addr.is_ipv6() {
        format!("[{}]:{}", addr, device.port)
    } else {
        format!("{}:{}", addr, device.port)
    };
    set_host(socket_addr.clone());

    println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("Selected: {} ({})", device.name, socket_addr);
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("  Model:       {}", device.model);
    let target_device_id = device.id.to_mac_string();
    println!("  Device ID:   {}", target_device_id);
    println!("  Version:     {}.{}.{}", device.source_version.major, device.source_version.minor, device.source_version.patch);

    let features = device.features.raw();
    println!("\n  Features:    0x{:08X},0x{:08X}", features & 0xFFFFFFFF, features >> 32);
    println!("  Auth Method: {:?}", device.features.auth_method());
    println!();
    println!("  Feature Bits:");
    println!("    Bit  9 (Audio):             {}", device.features.supports_audio());
    println!("    Bit 14 (FairPlay):          {}", device.features.requires_fairplay());
    println!("    Bit 26 (MFi Required):      {}", device.features.requires_mfi());
    println!("    Bit 40 (Buffered Audio):    {}", device.features.supports_buffered_audio());
    println!("    Bit 41 (PTP):               {}", device.features.supports_ptp());
    println!("    Bit 48 (Transient Pairing): {}", device.features.supports_transient_pairing());
    println!("    Bit 51 (Unified Pair+MFi):  {}", device.features.supports_unified_pair_mfi());

    if let Some(pk) = &device.public_key {
        println!("\n  Server LTPK: {}", hex(pk));
    }

    println!("\n  Password Required: {}", device.requires_password);
    println!("  AirPlay 2:         {}", device.supports_airplay2());

    // Group info - highlight leader status prominently
    if let Some(ref group_id) = device.group_id {
        println!();
        if device.is_group_leader {
            println!("  ✓ Group Leader: YES (this is the correct device to pair with)");
        } else {
            println!("  ⚠️  Group Member: This device is NOT the group leader!");
            println!("     → Pairing may fail. Try pairing with the group leader instead.");
        }
        println!("  Group ID: {}", group_id);
    }

    // Load or create persistent identity (stable across attempts)
    println!("\n  --- Sender Identity (persistent) ---");
    let mut persistent_id = PersistentIdentity::load_or_create(&target_device_id);
    let controller = persistent_id.to_controller();
    println!("  X-Apple-Device-ID: {}", persistent_id.device_id);
    println!("  DACP-ID:           {}", persistent_id.dacp_id);
    println!("  Controller ID:     {}", persistent_id.controller_id);
    println!("  Pair-Verify ID:    {}", persistent_id.pair_verify_id);
    println!("  Ed25519 Public:    {}", hex(&controller.public_key()));
    let identity_path = PersistentIdentity::identity_file_for(&target_device_id);
    println!("  (Identity persisted to {})", identity_path.display());

    // Check if device is HomeKitTransient (Apple device)
    let is_homekit_transient = matches!(device.features.auth_method(),
        airplay_core::features::AuthMethod::HomeKitTransient);

    // Detect if this is a real Apple device vs third-party receiver
    let is_apple_device = is_apple_model(&device.model);
    let recommended_protocol = if is_apple_device { "RTSP" } else { "HTTP" };

    println!("\n  Protocol Detection:");
    println!("    Model '{}' → {} ({})",
        device.model,
        if is_apple_device { "Apple device" } else { "Third-party receiver" },
        recommended_protocol
    );

    // Print policy diagnostics
    if is_homekit_transient {
        println!("\n  ⚠️  Policy Note: This device uses HomeKitTransient auth.");
        println!("     If SRP fails, check Home app → Home Settings → Speakers & TV → Allow Access");
        println!("     Set to 'Everyone' or 'Anyone on the Same Network' to allow pairing.");
    }

    // Non-interactive mode
    if let Some(mode) = mode.as_deref() {
        let pin = pin_arg.as_deref().unwrap_or("3939");
        match mode {
            "transient-rtsp" => {
                run_transient_pairing_rtsp(&socket_addr, &controller, &persistent_id, pin)?;
                return Ok(());
            }
            "transient-http" => {
                run_transient_pairing_http(&socket_addr, &controller, &persistent_id, pin)?;
                return Ok(());
            }
            _ => {
                eprintln!("Unknown mode: {}", mode);
                usage();
                return Ok(());
            }
        }
    }

    // Main menu loop
    loop {
        println!("\n=== Pairing Menu ===");

        // Only show raw Ed25519 option for non-HomeKitTransient devices
        if !is_homekit_transient {
            println!("  [1] True Transient (Ed25519 exchange, NO SRP) - some third-party receivers");
        } else {
            println!("  [1] (Not available - HomeKitTransient requires SRP TLV8)");
        }

        // Highlight recommended option based on device detection
        if is_apple_device {
            println!("  [2] SRP Transient via RTSP (M1-M4) ← RECOMMENDED for {}", device.model);
            println!("  [3] SRP Transient via HTTP (M1-M4)");
        } else {
            println!("  [2] SRP Transient via RTSP (M1-M4)");
            println!("  [3] SRP Transient via HTTP (M1-M4) ← RECOMMENDED for {}", device.model);
        }
        println!("  [4] Full SRP Pair-Setup (M1-M6, registers identity)");
        if !is_homekit_transient {
            println!("  [5] Pair-Verify (TLV8 format)");
        } else {
            println!("  (Pair-Verify is skipped for HomeKitTransient; use transient SRP then encrypted RTSP)");
        }
        println!("  [6] Pair-Verify (Raw 68-byte format)");
        println!("  [7] Query /info (check statusFlags for policy)");
        println!("  [8] Start One-Time PIN (POST /pair-pin-start)");
        println!("  [9] Exit");
        println!();

        let choice = read_number(1, 9)?;

        let result = match choice {
            1 => {
                if is_homekit_transient {
                    println!("\n❌ Raw Ed25519 exchange is NOT supported on Apple HomeKitTransient devices.");
                    println!("   Apple's /pair-setup endpoint expects TLV8 SRP protocol.");
                    println!("   Use option [2] SRP Transient instead.\n");
                    Ok(())
                } else {
                    println!("\n💡 Simple Ed25519 key exchange - no SRP, no PIN.");
                    println!("   Only works for third-party receivers (not Apple devices).\n");
                    try_true_transient_pairing(&socket_addr, &controller, &persistent_id)
                }
            }
            2 => {
                println!("\n💡 SRP Transient pairing over RTSP protocol (TLV8 M1-M4).");
                println!("   For Apple TV and HomePod (real Apple devices).");
                println!("   If connection fails, try option [3] HTTP instead.\n");
                try_transient_pair_setup_rtsp(&socket_addr, &controller, &persistent_id)
            }
            3 => {
                println!("\n💡 SRP Transient via HTTP protocol (TLV8 M1-M4).");
                println!("   For third-party receivers (shairport-sync, Airplay2-Receiver, etc.).\n");
                try_transient_pair_setup(&socket_addr, &controller, &persistent_id)
            }
            4 => try_srp_pair_setup(&socket_addr, &controller, &mut persistent_id, &target_device_id),
            5 => {
                if is_homekit_transient {
                    println!("\n❌ Pair-Verify is not used for HomeKitTransient devices.");
                    println!("   Use SRP Transient (option [2]) which now enables encrypted RTSP directly.\n");
                    Ok(())
                } else {
                    try_pair_verify(&socket_addr, &controller, &persistent_id, is_homekit_transient)
                }
            }
            6 => try_pair_verify_raw(&socket_addr, &controller),
            7 => query_info(&socket_addr),
            8 => start_pair_pin(&socket_addr),
            9 => {
                println!("Goodbye!");
                break;
            }
            _ => unreachable!(),
        };

        if let Err(e) = result {
            // Print error message directly (not with Debug format)
            eprintln!("{}", e);
        }
    }

    Ok(())
}

/// Method 1: True Transient Pairing (Ed25519 key exchange)
///
/// For devices with pw=false (Everyone access), the protocol is simple:
/// - Client sends 32-byte Ed25519 public key
/// - Server responds with 32-byte Ed25519 public key
/// - No SRP, no PIN, no TLV8 encoding
///
/// This is the correct method for HomePod with "Everyone" access setting.
fn try_true_transient_pairing(
    socket_addr: &str,
    controller: &ControllerIdentity,
    persistent_id: &PersistentIdentity,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("\n=== True Transient Pairing (Ed25519) ===");
    println!("Sending 32-byte Ed25519 public key (no SRP, no TLV8)\n");

    let mut stream = connect(socket_addr)?;
    let mut cseq = 1;

    // Use persistent device ID (stable across attempts)
    let client_device_id = &persistent_id.device_id;
    println!("Client Device ID: {} (persistent)", client_device_id);

    // Step 1: Query /info via RTSP first to establish connection
    println!("\n--- Step 1: Query /info via RTSP ---");
    let info_response = rtsp_get_info(&mut stream, &client_device_id, &mut cseq)?;

    if info_response.starts_with(b"bplist") {
        println!("Got /info response ({} bytes)", info_response.len());
        if let Ok(plist::Value::Dictionary(dict)) = plist::from_bytes::<plist::Value>(&info_response) {
            log_info_dict(&dict);
        }
    }

    // Step 2: Send pair-setup with our Ed25519 public key
    println!("\n--- Step 2: POST /pair-setup ---");

    // Get our Ed25519 public key (32 bytes)
    let our_pk = controller.public_key();
    println!("Our Ed25519 public key: {}", hex(&our_pk));

    // Send via RTSP POST /pair-setup with raw binary
    let response = rtsp_post_pair_setup(&mut stream, &our_pk, &client_device_id, &mut cseq)?;

    println!("\nReceived response: {} bytes", response.len());

    if response.len() == 32 {
        println!("✓ Received server Ed25519 public key (32 bytes)");
        println!("  Server PK: {}", hex(&response));
        println!("\n✓ Transient pair-setup complete!");
        println!("  Now run Pair-Verify (Raw 68-byte format) - option [5]");

        // Store server public key for pair-verify
        // (In a real implementation, we'd pass this to pair-verify)
        Ok(())
    } else if response.starts_with(b"bplist") {
        // Got a binary plist error response
        println!("✗ Received binary plist response (likely error)");
        if let Ok(plist::Value::Dictionary(dict)) = plist::from_bytes::<plist::Value>(&response) {
            for (key, value) in &dict {
                println!("  {}: {:?}", key, value);
            }
        }
        Err("Device returned plist instead of Ed25519 key".into())
    } else {
        // Check if it's TLV8 (device might expect SRP)
        if Tlv8::parse(&response).is_ok() {
            println!("✗ Received TLV8 response - device may require SRP pairing");
            dump_tlv8_verbose(&response, true);
            check_tlv8_error(&response, "True Transient")?;
        }
        println!("✗ Unexpected response format");
        println!("  Raw hex: {}", hex(&response[..response.len().min(128)]));
        Err(format!("Unexpected response: {} bytes", response.len()).into())
    }
}

/// Method 2: SRP Transient Pair-Setup via RTSP
///
/// For Apple TV and devices with HomeKit access control (OneTimePairingRequired).
/// Uses RTSP protocol with proper device identification headers.
fn try_transient_pair_setup_rtsp(
    socket_addr: &str,
    controller: &ControllerIdentity,
    persistent_id: &PersistentIdentity,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("\n=== SRP Transient Pair-Setup via RTSP ===");
    println!("This uses SRP with transient flags over RTSP protocol.\n");

    println!("Enter AirPlay password/PIN:");
    println!("  - Leave blank for NO password (empty string)");
    println!("  - Use '3939' for standard transient pairing");
    println!("  - Use your AirPlay password if statusFlags shows 'Password configured'");
    print!("> ");
    io::stdout().flush()?;

    let mut input = String::new();
    io::stdin().read_line(&mut input)?;
    let pin = input.trim();

    if pin.is_empty() {
        println!("\nUsing PIN/password: (empty)");
    } else {
        println!("\nUsing PIN/password: '{}'", pin);
    }

    run_transient_pairing_rtsp(socket_addr, controller, persistent_id, pin)
}

fn run_transient_pairing_rtsp(
    socket_addr: &str,
    controller: &ControllerIdentity,
    persistent_id: &PersistentIdentity,
    pin: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut stream = connect(socket_addr)?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;

    let mut cseq = 1;
    let client_device_id = &persistent_id.device_id;
    println!("Client Device ID: {} (persistent)", client_device_id);

    // Step 0: Query /info first
    println!("\n--- Step 0: Query /info ---");
    let info_response = rtsp_get_info(&mut stream, client_device_id, &mut cseq)?;
    if info_response.starts_with(b"bplist") {
        if let Ok(plist::Value::Dictionary(dict)) = plist::from_bytes::<plist::Value>(&info_response) {
            println!("Got /info response ({} bytes)", info_response.len());
            log_info_dict(&dict);
        }
    }

    let mut session = PairingSession::with_identity(
        airplay_core::features::AuthMethod::HomeKitTransient,
        controller.keypair().clone(),
    );

    // === M1 ===
    println!("\n--- M1: Initiate transient pairing ---");
    let m1 = session.start_transient_pairing_with_pin(pin)?;
    println!("Sending M1 ({} bytes):", m1.len());
    dump_tlv8_verbose(&m1, true);

    // Transient HomeKit pairing uses HKP=4 (per pair_ap).
    let m2 = rtsp_post_pair_setup_tlv(&mut stream, &m1, client_device_id, &mut cseq, 4)?;
    println!("\nReceived M2 ({} bytes):", m2.len());
    dump_tlv8_verbose(&m2, true);

    check_tlv8_error(&m2, "RTSP Transient M2")?;

    let m3 = session
        .continue_transient_pairing(&m2)?
        .ok_or("Expected M3 from transient pairing")?;
    println!("M2 processed: Got salt and SRP public key (B)");

    // === M3 ===
    println!("\n--- M3: Send client proof ---");
    println!("Sending M3 ({} bytes):", m3.len());
    dump_tlv8_verbose(&m3, true);

    let m4 = rtsp_post_pair_setup_tlv(&mut stream, &m3, client_device_id, &mut cseq, 4)?;
    println!("Received M4 ({} bytes):", m4.len());
    dump_tlv8_verbose(&m4, true);

    check_tlv8_error(&m4, "RTSP Transient M4")?;

    session.continue_transient_pairing(&m4)?;
    println!("M4 processed: SRP verification successful!");

    let session_keys = session
        .session_keys()
        .ok_or("Transient pairing did not produce session keys")?;

    println!("\n✓ SUCCESS - SRP Transient pair-setup complete!");
    println!("  No identity registered (transient mode).");

    // Match pair_ap/owntone: use transient shared secret directly for encrypted RTSP.
    run_encrypted_rtsp_diagnostics(&mut stream, session_keys, client_device_id, &mut cseq)?;

    Ok(())
}

/// Method 3: Transient Pair-Setup via HTTP (SRP with transient flags)
///
/// Transient pairing is standard SRP pair-setup (M1-M4) with:
/// - Flags=0x10 (kPairingFlag_Transient) as 4-byte LE
/// - PIN/password: defaults to "3939", but HomePods with PasswordRequired need AirPlay password
/// - Stop at M4 - no M5/M6 identity exchange needed
/// - Then pair-verify to establish encrypted session
fn try_transient_pair_setup(
    socket_addr: &str,
    controller: &ControllerIdentity,
    persistent_id: &PersistentIdentity,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("\n=== Transient Pair-Setup via HTTP ===");
    println!("This uses SRP with transient flags (Flags=0x10).");
    println!("Stops at M4, then requires pair-verify for encrypted session.\n");

    println!("Client Device ID: {} (persistent)", persistent_id.device_id);

    println!("\nEnter AirPlay password/PIN:");
    println!("  - Leave blank for NO password (empty string)");
    println!("  - Use '3939' for standard transient pairing (most devices)");
    println!("  - Use your AirPlay password if statusFlags shows 'Password configured'");
    print!("> ");
    io::stdout().flush()?;

    let mut input = String::new();
    io::stdin().read_line(&mut input)?;
    let pin = input.trim();

    if pin.is_empty() {
        println!("\nUsing PIN/password: (empty)");
    } else {
        println!("\nUsing PIN/password: '{}'", pin);
    }

    run_transient_pairing_http(socket_addr, controller, persistent_id, pin)
}

fn run_transient_pairing_http(
    socket_addr: &str,
    controller: &ControllerIdentity,
    persistent_id: &PersistentIdentity,
    pin: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    // Keep same connection for all pair-setup messages
    let mut stream = connect(socket_addr)?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?; // SRP can be slow

    let mut session = PairingSession::with_identity(
        airplay_core::features::AuthMethod::HomeKitTransient,
        controller.keypair().clone(),
    );

    // === M1 ===
    println!("--- M1: Initiate transient pairing ---");
    let m1 = session.start_transient_pairing_with_pin(pin)?;
    println!("Sending M1 ({} bytes):", m1.len());
    dump_tlv8_verbose(&m1, true);

    // Transient HomeKit pairing uses HKP=4 (per pair_ap).
    let m2 = http_post_pairing(&mut stream, "/pair-setup", &m1, 4)?;
    println!("\nReceived M2 ({} bytes):", m2.len());
    dump_tlv8_verbose(&m2, true);

    // Check for error before processing
    check_tlv8_error(&m2, "Transient M2")?;

    let m3 = session
        .continue_transient_pairing(&m2)?
        .ok_or("Expected M3 from transient pairing")?;
    println!("M2 processed: Got salt and SRP public key (B)");

    // === M3 ===
    println!("\n--- M3: Send client proof ---");
    println!("Sending M3 ({} bytes):", m3.len());
    dump_tlv8_verbose(&m3, true);

    let m4 = http_post_pairing(&mut stream, "/pair-setup", &m3, 4)?;
    println!("Received M4 ({} bytes):", m4.len());
    dump_tlv8_verbose(&m4, true);

    // Check for error (wrong PIN will fail here)
    check_tlv8_error(&m4, "Transient M4")?;

    session.continue_transient_pairing(&m4)?;
    println!("M4 processed: SRP verification successful!");

    let _session_keys = session
        .session_keys()
        .ok_or("Transient pairing did not produce session keys")?;

    println!("\n✓ SUCCESS - Transient pair-setup complete!");
    println!("  No identity registered (transient mode).");
    println!("  Session keys derived successfully.");

    Ok(())
}

/// Method 2: Full SRP Pair-Setup (M1-M6)
fn try_srp_pair_setup(
    socket_addr: &str,
    controller: &ControllerIdentity,
    persistent_id: &mut PersistentIdentity,
    target_device_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("\n=== Full SRP Pair-Setup ===");
    println!("This uses SRP-6a protocol with a PIN to register your identity.");
    println!("After success, pair-verify will work for future sessions.\n");

    // Get PIN
    println!("Enter PIN (default: 3939 for transient, or check device screen):");
    print!("> ");
    io::stdout().flush()?;

    let mut input = String::new();
    io::stdin().read_line(&mut input)?;
    let pin = input.trim();
    let pin = if pin.is_empty() { "3939" } else { pin };

    if pin.len() != 4 || !pin.chars().all(|c| c.is_ascii_digit()) {
        println!("Invalid PIN! Must be 4 digits.");
        return Ok(());
    }
    println!("Using PIN: {}", pin);

    // IMPORTANT: Keep the SAME connection for all pair-setup messages!
    let mut stream = connect(socket_addr)?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?; // SRP can be slow

    let mut pair_setup = PairSetup::new(pin);

    // === M1 ===
    println!("\n--- M1: Initiate pairing ---");
    let m1 = pair_setup.generate_m1()?;
    println!("Sending M1 ({} bytes):", m1.len());
    dump_tlv8_verbose(&m1, true);

    let m2 = http_post_pairing(&mut stream, "/pair-setup", &m1, 3)?;
    println!("\nReceived M2 ({} bytes):", m2.len());
    dump_tlv8_verbose(&m2, true);

    // Check for error before processing
    check_tlv8_error(&m2, "SRP M2")?;

    pair_setup.process_m2(&m2)?;
    println!("M2 processed: Got salt and SRP public key (B)");

    // === M3 ===
    println!("\n--- M3: Send client proof ---");
    let m3 = pair_setup.generate_m3()?;
    println!("Sending M3 ({} bytes):", m3.len());
    dump_tlv8_verbose(&m3, true);

    let m4 = http_post_pairing(&mut stream, "/pair-setup", &m3, 3)?;
    println!("Received M4 ({} bytes):", m4.len());
    dump_tlv8_verbose(&m4, true);

    // Check for error (wrong PIN will fail here)
    check_tlv8_error(&m4, "SRP M4")?;

    pair_setup.process_m4(&m4)?;
    println!("M4 processed: SRP verification successful!");

    // === M5 ===
    println!("\n--- M5: Register identity ---");
    let m5 = pair_setup.generate_m5_with_controller(controller)?;
    println!("Sending M5 ({} bytes):", m5.len());
    dump_tlv8_verbose(&m5, true);

    let m6 = http_post_pairing(&mut stream, "/pair-setup", &m5, 3)?;
    println!("Received M6 ({} bytes):", m6.len());
    dump_tlv8_verbose(&m6, true);

    // Check for error
    check_tlv8_error(&m6, "SRP M6")?;

    let shared_secret = pair_setup.process_m6(&m6)?;
    if let Some(server_ltpk) = pair_setup.server_ltpk() {
        persistent_id.server_ltpk = Some(server_ltpk.to_vec());
    }
    if let Some(server_id) = pair_setup.server_identifier() {
        if let Ok(id_str) = std::str::from_utf8(server_id) {
            persistent_id.server_identifier = Some(id_str.to_string());
        }
    }
    persistent_id.save(target_device_id);

    println!("\n✓ SUCCESS - SRP pair-setup complete!");
    println!("  Shared secret: {} bytes", shared_secret.as_bytes().len());
    println!("  Identity registered. Use pair-verify for future sessions.");

    Ok(())
}

/// Method 3: Pair-Verify (after successful pair-setup)
fn try_pair_verify(
    socket_addr: &str,
    controller: &ControllerIdentity,
    persistent_id: &PersistentIdentity,
    is_homekit_transient: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("\n=== Pair-Verify ===");
    println!("This verifies your previously registered identity.");
    println!("Only works AFTER successful pair-setup!\n");

    // Keep same connection for all pair-verify messages
    let mut stream = connect(socket_addr)?;

    let mut pair_verify = PairVerify::new_with_controller(controller);
    if is_homekit_transient {
        // Mirror pair_ap: transient verify skips server signature validation.
        // Do not set server LTPK in this mode.
    } else if let Some(ref stored) = persistent_id.server_ltpk {
        if stored.len() == 32 {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(stored);
            pair_verify.set_server_ltpk(arr);
        }
    } else if let Some(server_pk) = fetch_server_ltpk(socket_addr) {
        pair_verify.set_server_ltpk(server_pk);
    }

    let mut cseq = 1;
    let client_device_id = &persistent_id.device_id;

    // === M1 ===
    println!("--- M1: Send ECDH public key ---");
    let m1 = pair_verify.generate_m1()?;
    println!("Sending M1 ({} bytes):", m1.len());
    dump_tlv8_verbose(&m1, true);

    let m2 = rtsp_post_pair_verify_tlv(&mut stream, &m1, client_device_id, &mut cseq)?;
    println!("\nReceived M2 ({} bytes):", m2.len());
    dump_tlv8_verbose(&m2, true);

    // Check for error
    check_tlv8_error(&m2, "Verify M2")?;

    pair_verify.process_m2(&m2)?;
    println!("M2 processed: ECDH complete, server signature verified");

    // === M3 ===
    println!("\n--- M3: Send our signature ---");
    let m3 = if is_homekit_transient {
        pair_verify.generate_m3_with_identifier(Some(&persistent_id.pair_verify_id))?
    } else {
        pair_verify.generate_m3()?
    };
    println!("Sending M3 ({} bytes):", m3.len());
    dump_tlv8_verbose(&m3, true);

    let m4 = rtsp_post_pair_verify_tlv(&mut stream, &m3, client_device_id, &mut cseq)?;
    println!("\nReceived M4 ({} bytes):", m4.len());
    dump_tlv8_verbose(&m4, true);

    // Check for error (Error 0x01 = not paired, need to run pair-setup first)
    if let Ok(tlv) = Tlv8::parse(&m4) {
        if let Some(error_code) = tlv.error() {
            if error_code == 0x01 {
                return Err(
                    "\n\
                    ╭─ NOT PAIRED ───────────────────────────────────────╮\n\
                    │  Error 0x01: Unknown/Not paired                    \n\
                    │  Device doesn't recognize your identity.           \n\
                    │  Run Full SRP Pair-Setup (option 2) first.         \n\
                    │  Step: Verify M4                                   \n\
                    ╰────────────────────────────────────────────────────╯".into()
                );
            }
            check_tlv8_error(&m4, "Verify M4")?;
        }
    }

    let session_keys = pair_verify.process_m4(&m4)?;

    run_encrypted_rtsp_diagnostics(&mut stream, &session_keys, client_device_id, &mut cseq)?;

    Ok(())
}

fn run_encrypted_rtsp_diagnostics(
    stream: &mut TcpStream,
    session_keys: &airplay_crypto::keys::SessionKeys,
    client_device_id: &str,
    cseq: &mut u32,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("\n✓ SUCCESS - Session established!");
    println!("  Write key: {}", hex(session_keys.write_key.as_bytes()));
    println!("  Read key:  {}", hex(session_keys.read_key.as_bytes()));
    println!("  Ready for encrypted RTSP communication.");

    println!("\n--- Encrypted RTSP OPTIONS ---");
    let request = format!(
        "OPTIONS * RTSP/1.0\r\n\
         CSeq: {}\r\n\
         DACP-ID: {}\r\n\
         Active-Remote: 1234567890\r\n\
         User-Agent: AirPlay/745.83\r\n\
         X-Apple-Device-ID: {}\r\n\
         \r\n",
        *cseq,
        client_device_id.replace(":", ""),
        client_device_id
    );
    *cseq += 1;

    let mut out_counter = 0u64;
    let mut in_counter = 0u64;
    let encrypted =
        encrypt_control_frame(session_keys.write_key.as_bytes(), out_counter, request.as_bytes())?;
    out_counter += 1;
    println!(
        "  Encrypted frame: len={} bytes, first16={}",
        encrypted.len(),
        hex(&encrypted[..encrypted.len().min(16)])
    );
    stream.write_all(&encrypted)?;
    stream.flush()?;

    let response = read_encrypted_rtsp_response(
        stream,
        session_keys.read_key.as_bytes(),
        &mut in_counter,
    )?;
    print_rtsp_response_bytes(&response);

    println!("--- Encrypted RTSP GET /info ---");
    let request = format!(
        "GET /info RTSP/1.0\r\n\
         CSeq: {}\r\n\
         DACP-ID: {}\r\n\
         Active-Remote: 1234567890\r\n\
         User-Agent: AirPlay/745.83\r\n\
         X-Apple-Device-ID: {}\r\n\
         \r\n",
        *cseq,
        client_device_id.replace(":", ""),
        client_device_id
    );
    *cseq += 1;

    let encrypted =
        encrypt_control_frame(session_keys.write_key.as_bytes(), out_counter, request.as_bytes())?;
    out_counter += 1;
    println!(
        "  Encrypted frame: len={} bytes, first16={}",
        encrypted.len(),
        hex(&encrypted[..encrypted.len().min(16)])
    );
    stream.write_all(&encrypted)?;
    stream.flush()?;

    let response = read_encrypted_rtsp_response(
        stream,
        session_keys.read_key.as_bytes(),
        &mut in_counter,
    )?;
    print_rtsp_response_bytes(&response);

    Ok(())
}

/// Method 5: Pair-Verify with raw 68-byte format
///
/// This is the correct format for pair-verify after true transient pair-setup.
/// Per UxPlay documentation:
/// - Client sends 68 bytes: {0x01,0x00,0x00,0x00} | ECDH_PK(32) | Ed25519_PK(32)
/// - Server responds with 96 bytes: ECDH_PK(32) | encrypted_signature(64)
fn try_pair_verify_raw(
    socket_addr: &str,
    controller: &ControllerIdentity,
) -> Result<(), Box<dyn std::error::Error>> {
    println!("\n=== Pair-Verify (Raw 68-byte format) ===");
    println!("This is for use AFTER true transient pair-setup.\n");

    let mut stream = connect(socket_addr)?;
    let mut cseq = 1;

    // Generate ephemeral X25519 key pair for ECDH
    use x25519_dalek::{EphemeralSecret, PublicKey as X25519PublicKey};
    use rand::rngs::OsRng;

    let ecdh_secret = EphemeralSecret::random_from_rng(OsRng);
    let ecdh_pk = X25519PublicKey::from(&ecdh_secret);

    // Get our Ed25519 public key
    let ed25519_pk = controller.public_key();

    // Build 68-byte payload: {0x01,0x00,0x00,0x00} | ECDH_PK(32) | Ed25519_PK(32)
    let mut payload = Vec::with_capacity(68);
    payload.extend_from_slice(&[0x01, 0x00, 0x00, 0x00]); // Magic/state bytes
    payload.extend_from_slice(ecdh_pk.as_bytes());        // 32-byte X25519 public key
    payload.extend_from_slice(&ed25519_pk);               // 32-byte Ed25519 public key

    println!("Sending 68-byte pair-verify request:");
    println!("  Magic:      01 00 00 00");
    println!("  ECDH PK:    {}", hex(ecdh_pk.as_bytes()));
    println!("  Ed25519 PK: {}", hex(&ed25519_pk));

    let response = rtsp_post_raw(&mut stream, "/pair-verify", &payload, &mut cseq)?;

    println!("\nReceived response: {} bytes", response.len());

    if response.len() == 96 {
        println!("✓ Received expected 96-byte response");

        // Parse response: ECDH_PK(32) | encrypted_signature(64)
        let server_ecdh_pk = &response[0..32];
        let encrypted_sig = &response[32..96];

        println!("  Server ECDH PK:    {}", hex(server_ecdh_pk));
        println!("  Encrypted sig:     {}...", hex(&encrypted_sig[..32]));

        // Compute shared secret
        let server_pk_array: [u8; 32] = server_ecdh_pk.try_into()?;
        let server_x25519_pk = X25519PublicKey::from(server_pk_array);
        let shared_secret = ecdh_secret.diffie_hellman(&server_x25519_pk);

        println!("\n  ECDH shared secret: {}", hex(shared_secret.as_bytes()));

        // Derive AES key and IV for decryption
        // Key = first 16 bytes of SHA512("Pair-Verify-AES-Key" | shared_secret)
        // IV = first 16 bytes of SHA512("Pair-Verify-AES-IV" | shared_secret)
        use sha2::{Sha512, Digest};

        let mut hasher = Sha512::new();
        hasher.update(b"Pair-Verify-AES-Key");
        hasher.update(shared_secret.as_bytes());
        let key_hash = hasher.finalize();
        let aes_key = &key_hash[0..16];

        let mut hasher = Sha512::new();
        hasher.update(b"Pair-Verify-AES-IV");
        hasher.update(shared_secret.as_bytes());
        let iv_hash = hasher.finalize();
        let aes_iv = &iv_hash[0..16];

        println!("  AES Key: {}", hex(aes_key));
        println!("  AES IV:  {}", hex(aes_iv));

        // Decrypt the signature using AES-CTR-128
        use aes::cipher::{KeyIvInit, StreamCipher};
        type Aes128Ctr = ctr::Ctr128BE<aes::Aes128>;

        let mut cipher = Aes128Ctr::new(aes_key.into(), aes_iv.into());
        let mut decrypted = encrypted_sig.to_vec();
        cipher.apply_keystream(&mut decrypted);

        // The decrypted data should be: Ed25519_PK(32) | Ed25519_signature(64)
        // But wait, 64 bytes only gives us signature, need to check protocol
        println!("  Decrypted data: {}", hex(&decrypted));

        // Now we need to send M3 (our signature)
        // Build signature data: ECDH_PK_client | ECDH_PK_server
        let mut sig_data = Vec::new();
        sig_data.extend_from_slice(ecdh_pk.as_bytes());
        sig_data.extend_from_slice(server_ecdh_pk);

        // Sign with our Ed25519 key
        let signature = controller.keypair().sign(&sig_data);

        // Encrypt our signature
        let mut cipher = Aes128Ctr::new(aes_key.into(), aes_iv.into());
        let mut encrypted_response = signature.to_vec();
        cipher.apply_keystream(&mut encrypted_response);

        // M3: {0x00,0x00,0x00,0x00} | encrypted_signature(64)
        let mut m3_payload = Vec::with_capacity(68);
        m3_payload.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        m3_payload.extend_from_slice(&encrypted_response);

        println!("\nSending M3 (68 bytes):");
        println!("  Magic:         00 00 00 00");
        println!("  Encrypted sig: {}...", hex(&encrypted_response[..32]));

        let m4_response = rtsp_post_raw(&mut stream, "/pair-verify", &m3_payload, &mut cseq)?;

        println!("\nReceived M4: {} bytes", m4_response.len());

        if m4_response.is_empty() {
            println!("✓ Empty M4 response - pair-verify successful!");

            // Derive session keys
            let mut hasher = Sha512::new();
            hasher.update(b"Pair-Verify-Encrypt-Salt");
            hasher.update(shared_secret.as_bytes());
            let session_hash = hasher.finalize();

            println!("\n✓ Session established!");
            println!("  Session key material: {}...", hex(&session_hash[..32]));
            println!("  Ready for encrypted RTSP communication.");
        } else {
            println!("  Response: {}", hex(&m4_response));
            // Check for TLV8 error
            if Tlv8::parse(&m4_response).is_ok() {
                dump_tlv8_verbose(&m4_response, true);
                check_tlv8_error(&m4_response, "Raw Verify M4")?;
            }
        }

        Ok(())
    } else if response.len() == 32 {
        // Some devices might just return their Ed25519 key
        println!("  Received 32-byte response (possibly Ed25519 key)");
        println!("  Data: {}", hex(&response));
        Err("Unexpected 32-byte response - device may use different protocol".into())
    } else {
        // Check if TLV8 error
        if Tlv8::parse(&response).is_ok() {
            println!("✗ Received TLV8 response");
            dump_tlv8_verbose(&response, true);
            check_tlv8_error(&response, "Raw Verify")?;
        }
        println!("✗ Unexpected response format");
        println!("  Raw hex: {}", hex(&response[..response.len().min(128)]));
        Err(format!("Unexpected response: {} bytes", response.len()).into())
    }
}

/// Query /info endpoint
fn log_info_dict(dict: &Dictionary) {
    // Model
    if let Some(plist::Value::String(model)) = dict.get("model") {
        println!("  model: {}", model);
    }

    // Device ID
    if let Some(plist::Value::String(device_id)) = dict.get("deviceID") {
        println!("  deviceID: {}", device_id);
    }

    // MAC Address
    if let Some(plist::Value::String(mac)) = dict.get("macAddress") {
        println!("  macAddress: {}", mac);
    }

    // Source Version
    if let Some(plist::Value::String(srcvers)) = dict.get("sourceVersion") {
        println!("  sourceVersion: {}", srcvers);
    }

    // Features (can be integer or string)
    if let Some(features_val) = dict.get("features") {
        match features_val {
            plist::Value::Integer(i) => {
                let f = i.as_unsigned().unwrap_or(0);
                println!(
                    "  features: 0x{:x} (0x{:08x},0x{:08x})",
                    f,
                    f & 0xFFFFFFFF,
                    f >> 32
                );
            }
            plist::Value::String(s) => {
                println!("  features: {}", s);
            }
            _ => {}
        }
    }

    // Status Flags - CRITICAL for understanding pairing requirements
    if let Some(plist::Value::Integer(i)) = dict.get("statusFlags") {
        let sf = i.as_unsigned().unwrap_or(0) as u32;
        println!("  statusFlags: 0x{:08x}", sf);
        dump_info_status_flags(sf);
    }

    // Server public key (pk)
    if let Some(plist::Value::Data(pk)) = dict.get("pk") {
        println!("  pk (Server LTPK): {} ({} bytes)", hex(pk), pk.len());
    }

    // Protocol version
    if let Some(plist::Value::String(pv)) = dict.get("protovers") {
        println!("  protovers: {}", pv);
    }

    // Pi (pairing identity UUID)
    if let Some(plist::Value::String(pi)) = dict.get("pi") {
        println!("  pi: {}", pi);
    }

    // VV (Vorbis version?)
    if let Some(plist::Value::Integer(vv)) = dict.get("vv") {
        println!("  vv: {}", vv.as_unsigned().unwrap_or(0));
    }

    // Audio formats
    if let Some(plist::Value::Array(arr)) = dict.get("audioFormats") {
        println!("  audioFormats: {} entries", arr.len());
    }

    // Audio latencies
    if let Some(plist::Value::Array(arr)) = dict.get("audioLatencies") {
        println!("  audioLatencies: {} entries", arr.len());
    }

    // Name
    if let Some(plist::Value::String(name)) = dict.get("name") {
        println!("  name: {}", name);
    }

    // Manufacturer
    if let Some(plist::Value::String(mfg)) = dict.get("manufacturer") {
        println!("  manufacturer: {}", mfg);
    }

    // Serial Number
    if let Some(plist::Value::String(sn)) = dict.get("serialNumber") {
        println!("  serialNumber: {}", sn);
    }

    // List all keys for debugging
    println!("\n  All keys: {:?}", dict.keys().collect::<Vec<_>>());
}

fn query_info(socket_addr: &str) -> Result<(), Box<dyn std::error::Error>> {
    println!("\n=== Query /info ===\n");

    let mut stream = connect(socket_addr)?;

    match http_get(&mut stream, "/info") {
        Ok(info) => {
            println!("Response: {} bytes", info.len());

            // Try to parse as binary plist
            if info.starts_with(b"bplist") {
                println!("Format: Binary plist\n");

                match plist::from_bytes::<plist::Value>(&info) {
                    Ok(plist::Value::Dictionary(dict)) => log_info_dict(&dict),
                    Ok(other) => {
                        println!("  Unexpected plist type: {:?}", other);
                    }
                    Err(e) => {
                        println!("  Failed to parse plist: {}", e);
                        println!("  Raw hex (first 128 bytes): {}", hex(&info[..info.len().min(128)]));
                    }
                }
            } else {
                println!("Raw hex (first 128 bytes): {}", hex(&info[..info.len().min(128)]));
            }
        }
        Err(e) => {
            println!("Error: {}", e);
        }
    }

    Ok(())
}

/// Trigger a one-time PIN on Apple devices that require it.
fn start_pair_pin(socket_addr: &str) -> Result<(), Box<dyn std::error::Error>> {
    println!("\n=== Start One-Time PIN (/pair-pin-start) ===\n");

    let mut stream = connect(socket_addr)?;
    let response = http_post_empty(&mut stream, "/pair-pin-start")?;

    if response.is_empty() {
        println!("Response: empty (PIN should appear on the device screen).");
        return Ok(());
    }

    println!("Response: {} bytes", response.len());
    if response.starts_with(b"bplist") {
        println!("Format: Binary plist");
        match plist::from_bytes::<plist::Value>(&response) {
            Ok(plist::Value::Dictionary(dict)) => {
                println!("  Keys: {:?}", dict.keys().collect::<Vec<_>>());
                for (key, value) in &dict {
                    println!("  {}: {:?}", key, value);
                }
            }
            Ok(other) => println!("  Unexpected plist type: {:?}", other),
            Err(e) => {
                println!("  Failed to parse plist: {}", e);
                println!("  Raw hex (first 128 bytes): {}", hex(&response[..response.len().min(128)]));
            }
        }
    } else {
        println!("Raw hex (first 128 bytes): {}", hex(&response[..response.len().min(128)]));
    }

    Ok(())
}

fn fetch_server_ltpk(socket_addr: &str) -> Option<[u8; 32]> {
    let mut stream = connect(socket_addr).ok()?;
    let info = http_get(&mut stream, "/info").ok()?;
    if !info.starts_with(b"bplist") {
        return None;
    }
    let plist = plist::from_bytes::<plist::Value>(&info).ok()?;
    let dict = match plist {
        plist::Value::Dictionary(dict) => dict,
        _ => return None,
    };
    let pk = dict.get("pk")?;
    if let plist::Value::Data(bytes) = pk {
        if bytes.len() == 32 {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(bytes);
            return Some(arr);
        }
    }
    None
}

/// Decode /info statusFlags bits
///
/// These flags are from the /info endpoint response and differ from mDNS TXT flags.
/// See: https://openairplay.github.io/airplay-spec/status_flags.html
fn dump_info_status_flags(sf: u32) {
    println!("    Decoded statusFlags:");

    let flags = [
        (1 << 0, "Problem detected"),
        (1 << 2, "Audio cable attached"),
        (1 << 3, "PINRequired"),
        (1 << 4, "Supports AirPlay from Cloud"),
        (1 << 5, "Password needed"),
        (1 << 6, "Password configured"),
        (1 << 7, "PasswordRequired"),
        (1 << 8, "One-time pairing setup required"),
        (1 << 9, "OneTimePairingRequired"),
        (1 << 10, "DeviceWasSetupForHKAccessControl"),
        (1 << 11, "Device supports Relay"),
        (1 << 15, "Device supports unified advertising"),
    ];

    let mut any_set = false;
    for (bit, name) in flags {
        if sf & bit != 0 {
            println!("      [x] {} (0x{:X})", name, bit);
            any_set = true;
        }
    }

    if !any_set {
        println!("      (no policy flags set - device should accept SRP transient with '3939')");
    }

    // Pairing strategy summary based on flags
    println!();
    println!("    ┌─ Pairing Strategy ────────────────────────────────────────┐");

    let has_hk_access = sf & (1 << 10) != 0;
    let has_password = sf & (1 << 7) != 0 || sf & (1 << 6) != 0;
    let needs_pin = sf & (1 << 3) != 0;
    let needs_onetime = sf & (1 << 9) != 0;

    if needs_pin {
        println!("    │  PINRequired: Use /pair-pin-start to show PIN on device  │");
        println!("    │  Then SRP pair-setup with the displayed PIN              │");
    } else if has_password {
        println!("    │  PasswordRequired: Use SRP with AirPlay password         │");
        println!("    │  (NOT '3939' - use the password from Home app settings)  │");
    } else if needs_onetime {
        println!("    │  OneTimePairing: Use /pair-pin-start for Apple TV        │");
        println!("    │  HomePod may show code in Home app notifications         │");
    } else if has_hk_access {
        println!("    │  HK Access Control: SRP transient should work with '3939'│");
        println!("    │  BUT Home policy may block - check 'Allow Access' setting│");
    } else {
        println!("    │  No restrictions: SRP transient with '3939' should work  │");
    }

    println!("    └─────────────────────────────────────────────────────────────┘");

    // Actionable warnings
    if has_hk_access && !has_password && !needs_pin {
        println!();
        println!("    ⚠️  DeviceWasSetupForHKAccessControl (bit 10) is set");
        println!("       This means pairing success depends on Home app policy:");
        println!("       → Home app → Home Settings → Speakers & TV → Allow Access");
        println!("       → Set to 'Everyone' or 'Anyone on the Same Network'");
        println!("       If policy blocks you, SRP will fail even with correct protocol.");
    }
}

// === Helper Functions ===

/// Detect if a model string indicates a real Apple device
fn is_apple_model(model: &str) -> bool {
    // Apple device model prefixes
    let apple_prefixes = [
        "AppleTV",       // Apple TV (e.g., AppleTV14,1)
        "AudioAccessory", // HomePod (e.g., AudioAccessory1,1)
        "MacBook",       // MacBook Pro/Air
        "iMac",          // iMac
        "Macmini",       // Mac mini
        "MacPro",        // Mac Pro
        "AirPort",       // AirPort Express
    ];

    for prefix in apple_prefixes {
        if model.starts_with(prefix) {
            return true;
        }
    }

    // Also check for Apple in the name (some older devices)
    if model.contains("Apple") {
        return true;
    }

    false
}

fn connect(socket_addr: &str) -> Result<TcpStream, Box<dyn std::error::Error>> {
    let stream = TcpStream::connect_timeout(&socket_addr.parse()?, Duration::from_secs(5))?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    Ok(stream)
}

fn read_number(min: usize, max: usize) -> Result<usize, Box<dyn std::error::Error>> {
    print!("> ");
    io::stdout().flush()?;

    let mut input = String::new();
    io::stdin().read_line(&mut input)?;
    let n: usize = input.trim().parse().unwrap_or(0);

    if n < min || n > max {
        Err(format!("Please enter a number between {} and {}", min, max).into())
    } else {
        Ok(n)
    }
}

fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join("")
}

fn dump_tlv8(data: &[u8]) {
    dump_tlv8_verbose(data, false);
}

fn dump_tlv8_verbose(data: &[u8], verbose: bool) {
    match Tlv8::parse(data) {
        Ok(tlv) => {
            let mut fields = Vec::new();

            if let Some(state) = tlv.state() {
                fields.push(format!("State=0x{:02x}", state));
            }
            if let Some(error) = tlv.error() {
                fields.push(format!("Error=0x{:02x} ({})", error, error_description(error)));
            }
            if let Some(retry) = tlv.get(TlvType::RetryDelay) {
                let seconds = match retry.len() {
                    1 => retry[0] as u32,
                    2 => u16::from_le_bytes([retry[0], retry[1]]) as u32,
                    4 => u32::from_le_bytes([retry[0], retry[1], retry[2], retry[3]]),
                    _ => 0,
                };
                fields.push(format!("RetryDelay={}", format_wait_time(seconds)));
            }
            if let Some(method) = tlv.get(TlvType::Method) {
                if !method.is_empty() {
                    fields.push(format!("Method=0x{:02x}", method[0]));
                }
            }
            if let Some(flags) = tlv.get(TlvType::Flags) {
                if !flags.is_empty() {
                    let flags_val = if flags.len() >= 4 {
                        u32::from_le_bytes([flags[0], flags[1], flags[2], flags[3]])
                    } else {
                        flags[0] as u32
                    };
                    fields.push(format!("Flags=0x{:x}", flags_val));
                }
            }
            if let Some(pk) = tlv.get(TlvType::PublicKey) {
                fields.push(format!("PublicKey={}B", pk.len()));
            }
            if let Some(salt) = tlv.get(TlvType::Salt) {
                fields.push(format!("Salt={}B", salt.len()));
            }
            if let Some(proof) = tlv.get(TlvType::Proof) {
                fields.push(format!("Proof={}B", proof.len()));
            }
            if let Some(enc) = tlv.get(TlvType::EncryptedData) {
                fields.push(format!("EncryptedData={}B", enc.len()));
            }
            if let Some(id) = tlv.get(TlvType::Identifier) {
                fields.push(format!("Identifier={}B", id.len()));
            }
            if let Some(sig) = tlv.get(TlvType::Signature) {
                fields.push(format!("Signature={}B", sig.len()));
            }

            println!("  [{}]", fields.join(", "));

            // Verbose mode: show hex of key values
            if verbose {
                if let Some(salt) = tlv.get(TlvType::Salt) {
                    println!("    Salt: {}", hex(salt));
                }
                if let Some(pk) = tlv.get(TlvType::PublicKey) {
                    println!("    PublicKey (first 32B): {}", hex(&pk[..pk.len().min(32)]));
                    if pk.len() > 32 {
                        println!("    PublicKey (last 32B):  {}", hex(&pk[pk.len()-32..]));
                    }
                }
                if let Some(proof) = tlv.get(TlvType::Proof) {
                    println!("    Proof (first 32B): {}", hex(&proof[..proof.len().min(32)]));
                }
                if let Some(id) = tlv.get(TlvType::Identifier) {
                    if let Ok(s) = std::str::from_utf8(id) {
                        println!("    Identifier: {}", s);
                    } else {
                        println!("    Identifier: {}", hex(id));
                    }
                }
            }
        }
        Err(_) => {
            println!("  (not TLV8)");
            // Show raw hex for debugging
            println!("  Raw (first 64B): {}", hex(&data[..data.len().min(64)]));
        }
    }
}

fn error_description(code: u8) -> &'static str {
    match code {
        0x01 => "Unknown",
        0x02 => "Authentication failed (wrong PIN?)",
        0x03 => "Backoff/Rate limited (wait 10 min)",
        0x04 => "Max peers reached",
        0x05 => "Max tries exceeded",
        0x06 => "Unavailable",
        _ => "Unknown error code",
    }
}

/// Format a duration in seconds as a human-readable string
fn format_wait_time(seconds: u32) -> String {
    let mins = seconds / 60;
    let secs = seconds % 60;
    if mins > 0 && secs > 0 {
        format!("{} min {} sec", mins, secs)
    } else if mins > 0 {
        format!("{} min", mins)
    } else {
        format!("{} sec", secs)
    }
}

/// Check TLV8 response for errors and return descriptive error if found
fn check_tlv8_error(data: &[u8], step: &str) -> Result<(), Box<dyn std::error::Error>> {
    if let Ok(tlv) = Tlv8::parse(data) {
        if let Some(error_code) = tlv.error() {
            let desc = error_description(error_code);

            // Check for RetryDelay field (little-endian)
            let retry_seconds = tlv.get(TlvType::RetryDelay).and_then(|v| {
                match v.len() {
                    1 => Some(v[0] as u32),
                    2 => Some(u16::from_le_bytes([v[0], v[1]]) as u32),
                    4 => Some(u32::from_le_bytes([v[0], v[1], v[2], v[3]])),
                    _ => None,
                }
            });

            let msg = match error_code {
                0x03 => {
                    let wait = retry_seconds
                        .map(|s| format!("Wait {} before retrying.", format_wait_time(s)))
                        .unwrap_or_else(|| "Wait ~10 min before retrying.".to_string());
                    format!(
"\n\
╭─ RATE LIMITED ─────────────────────────────────────╮
│  Error 0x03: {}
│  Too many pairing attempts.
│  {}
│  Step: {}
╰────────────────────────────────────────────────────╯",
                        desc, wait, step
                    )
                }
                0x02 => format!(
"\n\
╭─ AUTHENTICATION FAILED ────────────────────────────╮
│  Error 0x02: {}
│  Check device screen for PIN, or try '3939'.
│  Step: {}
╰────────────────────────────────────────────────────╯",
                    desc, step
                ),
                0x04 => format!(
"\n\
╭─ MAX PEERS REACHED ────────────────────────────────╮
│  Error 0x04: {}
│  Unpair some devices in HomePod settings.
│  Step: {}
╰────────────────────────────────────────────────────╯",
                    desc, step
                ),
                0x05 => {
                    let wait = retry_seconds
                        .map(|s| format!("Wait {} before retrying.", format_wait_time(s)))
                        .unwrap_or_else(|| "Wait before retrying.".to_string());
                    format!(
"\n\
╭─ MAX TRIES EXCEEDED ───────────────────────────────╮
│  Error 0x05: {}
│  Too many failed attempts.
│  {}
│  Step: {}
╰────────────────────────────────────────────────────╯",
                        desc, wait, step
                    )
                }
                _ => format!(
"\n\
╭─ PAIRING ERROR ────────────────────────────────────╮
│  Error 0x{:02x}: {}
│  Step: {}
╰────────────────────────────────────────────────────╯",
                    error_code, desc, step
                ),
            };

            return Err(msg.into());
        }
    }
    Ok(())
}

fn http_get(
    stream: &mut TcpStream,
    path: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let request = format!(
        "GET {} HTTP/1.1\r\n\
         Host: {}\r\n\
         User-Agent: AirPlay/860.7.1\r\n\
         Connection: keep-alive\r\n\
         \r\n",
        path,
        get_host()
    );

    stream.write_all(request.as_bytes())?;
    stream.flush()?;

    read_http_response(stream)
}

fn http_post_pairing(
    stream: &mut TcpStream,
    path: &str,
    body: &[u8],
    hkp: u8,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {

    let request = format!(
        "POST {} HTTP/1.1\r\n\
         Host: {}\r\n\
         Content-Type: application/octet-stream\r\n\
         Content-Length: {}\r\n\
         User-Agent: AirPlay/860.7.1\r\n\
         X-Apple-HKP: {}\r\n\
         Connection: keep-alive\r\n\
         \r\n",
        path,
        get_host(),
        body.len(),
        hkp
    );

    stream.write_all(request.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()?;

    read_http_response(stream)
}

fn http_post_empty(
    stream: &mut TcpStream,
    path: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let request = format!(
        "POST {} HTTP/1.1\r\n\
         Host: {}\r\n\
         Content-Type: application/octet-stream\r\n\
         Content-Length: 0\r\n\
         User-Agent: AirPlay/860.7.1\r\n\
         Connection: keep-alive\r\n\
         \r\n",
        path,
        get_host()
    );

    stream.write_all(request.as_bytes())?;
    stream.flush()?;

    read_http_response(stream)
}

fn read_http_response(stream: &mut TcpStream) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut reader = BufReader::new(stream.try_clone()?);

    // Read status line
    let mut status_line = String::new();
    reader.read_line(&mut status_line)?;
    let status_line = status_line.trim().to_string();

    // Read headers
    let mut content_length = 0;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let line_trimmed = line.trim();

        if line_trimmed.is_empty() {
            break;
        }

        if let Some(value) = line_trimmed.strip_prefix("Content-Length: ") {
            content_length = value.parse()?;
        }
    }

    // Check status
    if !status_line.contains("200") {
        return Err(format!("HTTP error: {}", status_line).into());
    }

    // Read body
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }

    Ok(body)
}

/// Send RTSP GET /info request
fn rtsp_get_info(
    stream: &mut TcpStream,
    client_device_id: &str,
    cseq: &mut u32,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let request = format!(
        "GET /info RTSP/1.0\r\n\
         Content-Type: application/x-apple-binary-plist\r\n\
         CSeq: {}\r\n\
         DACP-ID: {}\r\n\
         Active-Remote: 1234567890\r\n\
         User-Agent: AirPlay/745.83\r\n\
         X-Apple-Device-ID: {}\r\n\
         \r\n",
        *cseq,
        client_device_id.replace(":", ""),
        client_device_id
    );

    *cseq += 1;

    println!(">>> RTSP Request:");
    println!("{}", request.trim());
    println!();

    stream.write_all(request.as_bytes())?;
    stream.flush()?;

    read_rtsp_response(stream)
}

/// Send RTSP POST /pair-setup request with raw binary body
fn rtsp_post_pair_setup(
    stream: &mut TcpStream,
    body: &[u8],
    client_device_id: &str,
    cseq: &mut u32,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let request = format!(
        "POST /pair-setup RTSP/1.0\r\n\
         Content-Type: application/octet-stream\r\n\
         Content-Length: {}\r\n\
         CSeq: {}\r\n\
         DACP-ID: {}\r\n\
         Active-Remote: 1234567890\r\n\
         User-Agent: AirPlay/745.83\r\n\
         X-Apple-Device-ID: {}\r\n\
         X-Apple-HKP: 3\r\n\
         \r\n",
        body.len(),
        *cseq,
        client_device_id.replace(":", ""),
        client_device_id
    );

    *cseq += 1;

    println!(">>> RTSP Request:");
    println!("{}", request.trim());
    if body.len() <= 128 {
        println!("Body: {}", hex(body));
    } else {
        println!("Body: {} bytes", body.len());
    }
    println!();

    stream.write_all(request.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()?;

    read_rtsp_response(stream)
}

/// Send RTSP POST /pair-setup request with TLV8 body (for SRP pairing)
fn rtsp_post_pair_setup_tlv(
    stream: &mut TcpStream,
    body: &[u8],
    client_device_id: &str,
    cseq: &mut u32,
    hkp: u8,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    // For TLV8/SRP pairing, use application/x-apple-binary-plist or application/octet-stream
    let request = format!(
        "POST /pair-setup RTSP/1.0\r\n\
         Content-Type: application/octet-stream\r\n\
         Content-Length: {}\r\n\
         CSeq: {}\r\n\
         DACP-ID: {}\r\n\
         Active-Remote: 1234567890\r\n\
         User-Agent: AirPlay/745.83\r\n\
         X-Apple-Device-ID: {}\r\n\
         X-Apple-HKP: {}\r\n\
         \r\n",
        body.len(),
        *cseq,
        client_device_id.replace(":", ""),
        client_device_id,
        hkp
    );

    *cseq += 1;

    println!(">>> RTSP Request:");
    for line in request.lines().take(8) {
        println!("{}", line);
    }
    println!();

    stream.write_all(request.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()?;

    read_rtsp_response(stream)
}

/// Send RTSP POST /pair-verify request with TLV8 body
fn rtsp_post_pair_verify_tlv(
    stream: &mut TcpStream,
    body: &[u8],
    client_device_id: &str,
    cseq: &mut u32,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let request = format!(
        "POST /pair-verify RTSP/1.0\r\n\
         Content-Type: application/octet-stream\r\n\
         Content-Length: {}\r\n\
         CSeq: {}\r\n\
         DACP-ID: {}\r\n\
         Active-Remote: 1234567890\r\n\
         User-Agent: AirPlay/745.83\r\n\
         X-Apple-Device-ID: {}\r\n\
         X-Apple-HKP: 3\r\n\
         \r\n",
        body.len(),
        *cseq,
        client_device_id.replace(":", ""),
        client_device_id
    );

    *cseq += 1;

    println!(">>> RTSP Request:");
    for line in request.lines().take(8) {
        println!("{}", line);
    }
    println!();

    stream.write_all(request.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()?;

    read_rtsp_response(stream)
}

/// Send RTSP POST request with raw binary body (for true transient pairing)
fn rtsp_post_raw(
    stream: &mut TcpStream,
    path: &str,
    body: &[u8],
    cseq: &mut u32,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let request = format!(
        "POST {} RTSP/1.0\r\n\
         Content-Type: application/octet-stream\r\n\
         Content-Length: {}\r\n\
         CSeq: {}\r\n\
         User-Agent: AirPlay/745.83\r\n\
         \r\n",
        path,
        body.len(),
        *cseq
    );

    *cseq += 1;

    println!(">>> RTSP Request:");
    println!("{}", request.trim());
    if body.len() <= 128 {
        println!("Body: {}", hex(body));
    } else {
        println!("Body: {} bytes", body.len());
    }
    println!();

    stream.write_all(request.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()?;

    read_rtsp_response(stream)
}

/// Read RTSP response
fn read_rtsp_response(stream: &mut TcpStream) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut reader = BufReader::new(stream.try_clone()?);

    // Read status line
    let mut status_line = String::new();
    reader.read_line(&mut status_line)?;
    let status_line = status_line.trim().to_string();

    println!("<<< RTSP Response:");
    println!("{}", status_line);

    // Check if we got an empty response (server doesn't understand RTSP)
    if status_line.is_empty() {
        return Err("Empty response - server may not support RTSP protocol. Try HTTP (option [3]).".into());
    }

    // Check if server returned HTTP instead of RTSP
    if status_line.starts_with("HTTP/") {
        println!("    (Note: Server responded with HTTP, not RTSP)");
    }

    // Read headers
    let mut content_length = 0;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let line_trimmed = line.trim();

        if line_trimmed.is_empty() {
            break;
        }

        println!("{}", line_trimmed);

        if let Some(value) = line_trimmed.strip_prefix("Content-Length: ") {
            content_length = value.parse()?;
        } else if let Some(value) = line_trimmed.to_lowercase().strip_prefix("content-length: ") {
            content_length = value.parse()?;
        }
    }
    println!();

    // Check status - RTSP uses same status codes as HTTP
    if !status_line.contains("200") {
        // Read error body if present
        let mut body = vec![0u8; content_length];
        if content_length > 0 {
            reader.read_exact(&mut body)?;
        }

        // Provide targeted error messages for common RTSP error codes
        let error_msg = if status_line.contains("470") {
            format!(
                "\n\
╭─ RTSP 470: Connection Authorization Required ──────────────────╮\n\
│  The receiver requires authorization before this operation.    │\n\
│                                                                │\n\
│  For Apple HomeKitTransient devices:                           │\n\
│  • Raw Ed25519 exchange is NOT supported                       │\n\
│  • Use SRP TLV8 pair-setup (option [2]) instead                │\n\
│                                                                │\n\
│  If SRP also fails, check Home app policy:                     │\n\
│  • Home Settings → Speakers & TV → Allow Access                │\n\
│  • Set to 'Everyone' or 'Anyone on Same Network'               │\n\
╰────────────────────────────────────────────────────────────────╯"
            )
        } else if status_line.contains("403") {
            format!(
                "RTSP 403 Forbidden: Access denied by receiver policy.\n\
                 Check Home app access settings."
            )
        } else if status_line.contains("401") {
            format!(
                "RTSP 401 Unauthorized: Authentication required.\n\
                 Try pair-setup first, then pair-verify."
            )
        } else {
            format!("RTSP error: {} (body: {} bytes)", status_line, body.len())
        };

        return Err(error_msg.into());
    }

    // Read body
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }

    Ok(body)
}

/// Encrypt a control-channel RTSP request with length-as-AAD framing (LE length).
fn encrypt_control_frame(
    key: &[u8; 32],
    counter: u64,
    plaintext: &[u8],
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, format!("chacha key: {e}")))?;
    let mut nonce = [0u8; 12];
    nonce[4..12].copy_from_slice(&counter.to_le_bytes());
    let nonce = Nonce::from_slice(&nonce);

    let len = plaintext.len() as u16;
    let aad = len.to_le_bytes();
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::Other, format!("chacha encrypt: {e}"))
        })?;

    let mut framed = Vec::with_capacity(2 + ciphertext.len());
    framed.extend_from_slice(&aad);
    framed.extend_from_slice(&ciphertext);
    Ok(framed)
}

/// Read and decrypt a single control-channel RTSP response frame.
fn read_encrypted_rtsp_response(
    stream: &mut TcpStream,
    key: &[u8; 32],
    counter: &mut u64,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let first_frame = read_encrypted_rtsp_frame(stream, key, counter)?;

    let Some((headers, body_slice)) = split_rtsp_response_bytes(&first_frame) else {
        return Ok(first_frame);
    };
    let mut body = body_slice.to_vec();

    let content_length = headers
        .lines()
        .find_map(|line| {
            let lower = line.to_lowercase();
            lower
                .strip_prefix("content-length: ")
                .and_then(|v| v.parse::<usize>().ok())
        })
        .unwrap_or(body.len());

    while body.len() < content_length {
        let chunk = read_encrypted_rtsp_frame(stream, key, counter)?;
        body.extend_from_slice(&chunk);
    }

    let mut combined = headers.into_bytes();
    combined.extend_from_slice(b"\r\n\r\n");
    combined.extend_from_slice(&body[..content_length]);
    Ok(combined)
}

fn read_encrypted_rtsp_frame(
    stream: &mut TcpStream,
    key: &[u8; 32],
    counter: &mut u64,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut len_buf = [0u8; 2];
    stream.read_exact(&mut len_buf)?;

    println!(
        "  Encrypted response prefix: {:02x} {:02x}",
        len_buf[0], len_buf[1]
    );

    if len_buf == [b'R', b'T'] || len_buf == [b'H', b'T'] {
        println!("  Detected plaintext RTSP response (no encryption).");
        return read_rtsp_response_with_prefix(stream, len_buf);
    }

    let len = u16::from_le_bytes(len_buf) as usize;
    let ct_len = len + 16;
    println!(
        "  Encrypted response length: {} bytes (ciphertext+tag={})",
        len, ct_len
    );

    let mut ciphertext = vec![0u8; ct_len];
    stream.read_exact(&mut ciphertext)?;
    println!(
        "  Encrypted response ciphertext first16={}",
        hex(&ciphertext[..ciphertext.len().min(16)])
    );

    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, format!("chacha key: {e}")))?;
    let mut last_err = None;
    let mut plaintext = None;
    let mut attempts = Vec::new();
    let mut next_counter = *counter;

    for (label, ctr, use_aad) in [
        ("ctr0_aad", *counter, true),
        ("ctr0_noaad", *counter, false),
        ("ctr1_aad", *counter + 1, true),
        ("ctr1_noaad", *counter + 1, false),
    ] {
        let mut nonce = [0u8; 12];
        nonce[4..12].copy_from_slice(&ctr.to_le_bytes());
        let nonce = Nonce::from_slice(&nonce);
        let aad = if use_aad { &len_buf[..] } else { &[] };

        match cipher.decrypt(nonce, Payload { msg: &ciphertext, aad }) {
            Ok(data) => {
                plaintext = Some(data);
                attempts.push(format!("{label}: ok"));
                next_counter = ctr + 1;
                break;
            }
            Err(e) => {
                last_err = Some(e);
                attempts.push(format!("{label}: err"));
            }
        }
    }

    println!("  Decrypt attempts: {}", attempts.join(", "));

    let plaintext = plaintext.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("chacha decrypt: {:?}", last_err),
        )
    })?;

    *counter = next_counter;
    Ok(plaintext)
}

/// Print a decrypted RTSP response (headers + body length).
fn print_rtsp_response_bytes(data: &[u8]) {
    println!("<<< Encrypted RTSP Response:");
    if let Some((headers, body)) = split_rtsp_response_bytes(data) {
        for line in headers.lines() {
            println!("{}", line);
        }
        if !body.is_empty() {
            println!("\nBody: {} bytes", body.len());
        }

        if headers
            .lines()
            .any(|line| line.to_lowercase() == "content-type: application/x-apple-binary-plist")
        {
            println!("\nParsed plist:");
            match plist::Value::from_reader(Cursor::new(body)) {
                Ok(plist::Value::Dictionary(dict)) => {
                    println!("  Keys: {}", dict.keys().cloned().collect::<Vec<_>>().join(", "));
                    if let Some(value) = dict.get("statusFlags") {
                        println!("  statusFlags: {:?}", value);
                    }
                    if let Some(value) = dict.get("model") {
                        println!("  model: {:?}", value);
                    }
                    if let Some(value) = dict.get("deviceid") {
                        println!("  deviceid: {:?}", value);
                    }
                    if let Some(value) = dict.get("features") {
                        println!("  features: {:?}", value);
                    }
                }
                Ok(other) => {
                    println!("  plist: {:?}", other);
                }
                Err(e) => {
                    println!("  plist parse error: {e}");
                }
            }
        }
    } else {
        let text = String::from_utf8_lossy(data);
        println!("{}", text.trim());
    }
    println!();
}

/// Split RTSP response bytes into headers text and body bytes.
fn split_rtsp_response_bytes(data: &[u8]) -> Option<(String, &[u8])> {
    let sep = b"\r\n\r\n";
    let pos = data.windows(sep.len()).position(|w| w == sep)?;
    let headers = String::from_utf8_lossy(&data[..pos]).to_string();
    let body = &data[(pos + sep.len())..];
    Some((headers, body))
}

/// Read a plaintext RTSP response after consuming the first two bytes.
fn read_rtsp_response_with_prefix(
    stream: &mut TcpStream,
    prefix: [u8; 2],
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut reader = BufReader::new(stream.try_clone()?);

    let mut status_line = String::from_utf8_lossy(&prefix).to_string();
    reader.read_line(&mut status_line)?;
    let status_line_trimmed = status_line.trim_end().to_string();

    let mut headers_bytes = Vec::new();
    headers_bytes.extend_from_slice(status_line_trimmed.as_bytes());
    headers_bytes.extend_from_slice(b"\r\n");

    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let line_trimmed = line.trim_end().to_string();

        if line_trimmed.is_empty() {
            headers_bytes.extend_from_slice(b"\r\n");
            break;
        }

        if let Some(value) = line_trimmed.strip_prefix("Content-Length: ") {
            content_length = value.parse()?;
        } else if let Some(value) = line_trimmed.to_lowercase().strip_prefix("content-length: ") {
            content_length = value.parse()?;
        }

        headers_bytes.extend_from_slice(line_trimmed.as_bytes());
        headers_bytes.extend_from_slice(b"\r\n");
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }

    headers_bytes.extend_from_slice(&body);
    Ok(headers_bytes)
}
