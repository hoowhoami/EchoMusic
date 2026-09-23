//! Debug: Show raw mDNS TXT records for AirPlay devices.
//!
//! Usage: cargo run -p airplay-discovery --example debug_devices
//!
//! Options:
//!   --raw-only    Only show raw mDNS records (skip parsed output)
//!   --info        Query /info endpoint for each device

use airplay_discovery::{Discovery, ServiceBrowser, AIRPLAY_SERVICE_TYPE};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let raw_only = args.iter().any(|a| a == "--raw-only");
    let query_info = args.iter().any(|a| a == "--info");

    println!("=== AirPlay Device Debug ===\n");

    // Collect raw mDNS records with full TXT data
    println!("--- Scanning for devices (5 seconds) ---\n");
    let raw_records = collect_raw_mdns_records(Duration::from_secs(5)).await?;

    if raw_only {
        // Just show raw records and exit
        for (name, txt) in &raw_records {
            println!("╔══ {} ══", name);
            for (key, value) in txt {
                println!("║   {} = {}", key, value);
            }
            println!("╚════════════════════════════════════════\n");
        }
        return Ok(());
    }

    let browser = ServiceBrowser::new()?;
    let devices = browser.scan(Duration::from_secs(3)).await?;

    if devices.is_empty() {
        println!("No AirPlay devices found!");
        return Ok(());
    }

    for (i, device) in devices.iter().enumerate() {
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        println!("Device {}: {}", i + 1, device.name);
        println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        // Basic info
        println!("  Model:      {}", device.model);
        if let Some(ref mfr) = device.manufacturer {
            println!("  Manufacturer: {}", mfr);
        }
        if let Some(ref sn) = device.serial_number {
            println!("  Serial:     {}", sn);
        }
        println!("  Device ID:  {}", device.id.to_mac_string());
        if let Some(ref bt) = device.bluetooth_address {
            println!("  BT Addr:    {}", bt);
        }
        println!("  Addresses:  {:?}", device.addresses);
        println!("  Port:       {}", device.port);
        println!("  Version:    {}.{}.{}",
            device.source_version.major,
            device.source_version.minor,
            device.source_version.patch);
        if let Some(ref fv) = device.firmware_version {
            println!("  Firmware:   {}", fv);
        }
        if let Some(ref ov) = device.os_version {
            println!("  OS Version: {}", ov);
        }
        if let Some(ref pv) = device.protocol_version {
            println!("  Proto Ver:  {}", pv);
        }
        println!();

        // Status flags
        if device.status_flags != 0 {
            println!("  Status Flags: 0x{:X}", device.status_flags);
            decode_status_flags(device.status_flags);
            println!();
        }

        // Access control
        if let Some(acl) = device.access_control {
            println!("  Access Control: {}", acl);
            decode_acl(&acl.to_string());
            println!();
        }

        // Find raw TXT record for this device
        let raw_txt = raw_records.iter()
            .find(|(name, _)| name.contains(&device.name) || name.contains(&device.id.to_mac_string()))
            .map(|(_, txt)| txt);

        if let Some(txt) = raw_txt {
            if let Some(fex) = txt.get("fex") {
                println!("  Features Extended (fex): {}", fex);
            }
        }

        // Feature flag analysis
        let features = device.features.raw();
        println!("\n  Features:   0x{:016X}", features);
        println!("              (lower: 0x{:08X}, upper: 0x{:08X})",
            features & 0xFFFFFFFF,
            features >> 32);
        println!();

        // All feature bits
        println!("  Feature bits:");
        let feature_bits: &[(u8, &str, bool)] = &[
            ( 0, "Video V1",                    device.features.supports_video_v1()),
            ( 1, "Photo",                       device.features.supports_photo()),
            ( 5, "Slideshow",                   device.features.supports_slideshow()),
            ( 7, "Screen",                      device.features.supports_screen()),
            ( 9, "Audio",                       device.features.supports_audio()),
            (11, "Redundant Audio",             device.features.supports_redundant_audio()),
            (14, "FairPlay Auth",               device.features.requires_fairplay()),
            (23, "Authentication_1",            device.features.has_authentication_1()),
            (26, "MFi Auth Required",           device.features.requires_mfi()),
            (27, "Legacy Pairing",              device.features.supports_legacy_pairing()),
            (30, "Unified Advertiser Info",      device.features.has_unified_advertiser_info()),
            (32, "CarPlay / Volume",            device.features.is_carplay()),
            (33, "Video Play Queue",            device.features.supports_video_play_queue()),
            (34, "AirPlay from Cloud",          device.features.supports_airplay_from_cloud()),
            (35, "TLS_PSK",                     device.features.supports_tls_psk()),
            (38, "Unified Media Control",       device.features.supports_unified_media_control()),
            (40, "Buffered Audio",              device.features.supports_buffered_audio()),
            (41, "PTP",                         device.features.supports_ptp()),
            (42, "Screen Multi Codec",          device.features.supports_screen_multi_codec()),
            (43, "System Pairing",              device.features.supports_system_pairing()),
            (44, "Valeria Screen Sender",       device.features.is_ap_valeria_screen_sender()),
            (46, "HomeKit Pairing",             device.features.supports_homekit_pairing()),
            (48, "Transient Pairing",           device.features.supports_transient_pairing()),
            (49, "Video V2",                    device.features.supports_video_v2()),
            (51, "Unified Pair+MFi",            device.features.supports_unified_pair_mfi()),
            (52, "Set Peers Extended Msg",      device.features.supports_set_peers_extended_message()),
            (54, "AP Sync",                     device.features.supports_ap_sync()),
            (55, "Wake on LAN",                 device.features.supports_wol()),
            (58, "Hangdog Remote Control",      device.features.supports_hangdog_remote_control()),
            (59, "Audio Stream Conn Setup",     device.features.supports_audio_stream_connection_setup()),
            (60, "Audio Media Data Control",    device.features.supports_audio_media_data_control()),
            (61, "RFC2198 Redundancy",          device.features.supports_rfc2198_redundancy()),
        ];
        for (bit, name, set) in feature_bits {
            if *set {
                println!("    Bit {:2} {:30} YES", bit, name);
            }
        }
        println!("    Metadata features: {}", device.features.metadata_features());
        println!("    Audio formats:     {}", device.features.audio_formats());
        println!();

        // Auth & pairing
        println!("  Auth Method: {:?}", device.auth_method());
        println!("  Public Key:  {}", match &device.public_key {
            Some(pk) => format!("{}...", hex_encode(&pk[..8])),
            None => "Missing".to_string(),
        });
        println!("  Password:    {}", if device.requires_password { "Required" } else { "Not required" });
        if let Some(ref pi) = device.pairing_identity {
            println!("  Pairing ID:  {}", pi);
        }
        if let Some(ref psi) = device.system_pairing_identity {
            println!("  System Pair: {}", psi);
        }
        if let Some(ref hkid) = device.homekit_home_id {
            println!("  HK Home ID:  {}", hkid);
        }
        println!();

        // Group / multi-room
        println!("  Group ID:    {:?}", device.group_id);
        println!("  Group Leader: {}", device.is_group_leader);
        if let Some(ref gpn) = device.group_public_name {
            println!("  Group Name:  {}", gpn);
        }
        if device.group_contains_discoverable_leader {
            println!("  Group Contains Discoverable Leader: true");
        }
        if let Some(ref hgid) = device.home_group_id {
            println!("  Home Group:  {}", hgid);
        }
        if let Some(ref hmid) = device.household_id {
            println!("  Household:   {}", hmid);
        }
        if let Some(ref pgid) = device.parent_group_id {
            println!("  Parent Group: {}", pgid);
        }
        if device.parent_group_contains_discoverable_leader {
            println!("  Parent Group Contains Discoverable Leader: true");
        }
        if let Some(ref tsid) = device.tight_sync_id {
            println!("  Tight Sync:  {}", tsid);
        }
        println!();

        // AirPlay 2 support
        println!("  AirPlay 2:   {}", if device.supports_airplay2() { "Yes" } else { "No" });
        println!("  PTP Support: {}", if device.supports_ptp() { "Yes" } else { "No" });

        // Query /info if requested
        if query_info {
            println!();
            let addr = device.addresses.iter()
                .find(|a| a.is_ipv4())
                .or_else(|| device.addresses.first());

            if let Some(ip) = addr {
                let socket_addr = format!("{}:{}", ip, device.port);
                println!("  --- /info endpoint ---");
                match query_device_info(&socket_addr) {
                    Ok(info) => {
                        for (key, value) in info {
                            println!("    {}: {}", key, value);
                        }
                    }
                    Err(e) => println!("    Error: {}", e),
                }
            }
        }

        // Raw TXT records
        if let Some(txt) = raw_txt {
            println!("\n  --- Raw TXT Records ---");
            let mut keys: Vec<_> = txt.keys().collect();
            keys.sort();
            for key in keys {
                let value = &txt[key];
                // Truncate long values
                let display_value = if value.len() > 60 {
                    format!("{}...", &value[..60])
                } else {
                    value.clone()
                };
                println!("    {} = {}", key, display_value);
            }
        }

        println!();
    }

    Ok(())
}

fn parse_hex_or_decimal(s: &str) -> u64 {
    let s = s.trim();
    if s.starts_with("0x") || s.starts_with("0X") {
        u64::from_str_radix(&s[2..], 16).unwrap_or(0)
    } else {
        s.parse().unwrap_or(0)
    }
}

fn decode_status_flags(flags: u64) {
    // Known status flag bits
    let flag_meanings = [
        (0x4, "Problem detected"),
        (0x8, "Pairing required"),
        (0x10, "PIN required"),
        (0x20, "Supports HKP transient"),
        (0x40, "Temporary pairing allowed"),
        (0x80, "Supports AirPlay from Cloud"),
        (0x200, "Audio links supported"),
        (0x400, "Device is paired"),
        (0x800, "HK accessory connected"),
        (0x4000, "HomeKit managed"),
        (0x8000, "Is Apple device"),
        (0x10000, "Supports buffered audio"),
        (0x80000, "Supports unified pair setup"),
    ];

    for (bit, meaning) in flag_meanings {
        if flags & bit != 0 {
            println!("      ✓ {} (0x{:X})", meaning, bit);
        }
    }
}

fn decode_acl(acl: &str) {
    match acl {
        "0" => println!("      → Everyone can connect"),
        "1" => println!("      → Same network only"),
        "2" => println!("      → Home members only (HomeKit required)"),
        _ => println!("      → Unknown ACL level"),
    }
}

async fn collect_raw_mdns_records(
    timeout: Duration,
) -> Result<Vec<(String, HashMap<String, String>)>, Box<dyn std::error::Error>> {
    let daemon = ServiceDaemon::new()?;
    let airplay_receiver = daemon.browse(AIRPLAY_SERVICE_TYPE)?;

    let mut records = Vec::new();
    let start = std::time::Instant::now();

    while start.elapsed() < timeout {
        if let Ok(event) = airplay_receiver.recv_timeout(Duration::from_millis(100)) {
            if let ServiceEvent::ServiceResolved(info) = event {
                let name = info.get_fullname().to_string();
                let mut txt = HashMap::new();
                for prop in info.get_properties().iter() {
                    txt.insert(prop.key().to_string(), prop.val_str().to_string());
                }
                // Avoid duplicates
                if !records.iter().any(|(n, _)| n == &name) {
                    records.push((name, txt));
                }
            }
        }
    }

    let _ = daemon.stop_browse(AIRPLAY_SERVICE_TYPE);
    Ok(records)
}

fn query_device_info(socket_addr: &str) -> Result<Vec<(String, String)>, Box<dyn std::error::Error>> {
    let mut stream = TcpStream::connect_timeout(
        &socket_addr.parse()?,
        Duration::from_secs(5),
    )?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;

    let request = format!(
        "GET /info HTTP/1.1\r\n\
         Host: {}\r\n\
         User-Agent: AirPlay/860.7.1\r\n\
         Connection: close\r\n\
         \r\n",
        socket_addr
    );

    stream.write_all(request.as_bytes())?;
    stream.flush()?;

    // Read response
    let mut reader = BufReader::new(&stream);

    // Read status line
    let mut _status_line = String::new();
    reader.read_line(&mut _status_line)?;

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
            content_length = value.parse().unwrap_or(0);
        }
    }

    // Read body
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }

    // Parse binary plist (basic extraction of key fields)
    let mut results = Vec::new();

    // Look for common fields in the binary data
    let fields_to_find = [
        "deviceID", "features", "model", "name", "pk", "srcvers",
        "statusFlags", "pi", "vv", "osvers", "audioLatencies",
    ];

    for field in fields_to_find {
        if let Some(pos) = body.windows(field.len()).position(|w| w == field.as_bytes()) {
            results.push((field.to_string(), format!("found at offset {}", pos)));
        }
    }

    // Also report body size
    results.insert(0, ("Response size".to_string(), format!("{} bytes", body.len())));

    if body.starts_with(b"bplist") {
        results.insert(1, ("Format".to_string(), "Binary plist".to_string()));
    }

    Ok(results)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}
