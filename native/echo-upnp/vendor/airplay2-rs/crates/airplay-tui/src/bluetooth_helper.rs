//! Bluetooth and BlueALSA helper functions for the TUI.
//!
//! Provides functions to interact with bluetoothctl and BlueALSA
//! using subprocess commands.

use std::process::Stdio;
use tokio::process::Command;
use tracing::{error, info};

use crate::state::BluetoothDeviceEntry;

/// Check if BlueALSA service is running.
pub async fn is_bluealsa_running() -> bool {
    let output = Command::new("systemctl")
        .args(["is-active", "--quiet", "bluealsa"])
        .status()
        .await;

    match output {
        Ok(status) => status.success(),
        Err(_) => false,
    }
}

/// Check if Bluetooth service is running.
pub async fn is_bluetooth_running() -> bool {
    let output = Command::new("systemctl")
        .args(["is-active", "bluetooth"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await;

    match output {
        Ok(o) => {
            let status = String::from_utf8_lossy(&o.stdout);
            status.trim() == "active"
        }
        Err(_) => false,
    }
}

/// Get list of paired Bluetooth devices from bluetoothctl.
pub async fn get_paired_devices() -> Vec<BluetoothDeviceEntry> {
    let output = Command::new("bluetoothctl")
        .args(["devices", "Paired"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await;

    let mut devices = Vec::new();

    if let Ok(o) = output {
        let stdout = String::from_utf8_lossy(&o.stdout);
        for line in stdout.lines() {
            // Format: "Device XX:XX:XX:XX:XX:XX Name"
            if let Some(rest) = line.strip_prefix("Device ") {
                let parts: Vec<&str> = rest.splitn(2, ' ').collect();
                if parts.len() == 2 {
                    let address = parts[0].to_string();
                    let name = parts[1].to_string();

                    // Get detailed info for this device
                    let info = get_device_info(&address).await;

                    devices.push(BluetoothDeviceEntry {
                        address,
                        name,
                        paired: true,
                        connected: info.connected,
                        trusted: info.trusted,
                        supports_a2dp: info.supports_a2dp,
                        rssi: info.rssi,
                    });
                }
            }
        }
    }

    devices
}

/// Device info from bluetoothctl.
struct DeviceInfo {
    connected: bool,
    trusted: bool,
    supports_a2dp: bool,
    rssi: Option<i16>,
}

/// Get detailed info for a Bluetooth device.
async fn get_device_info(address: &str) -> DeviceInfo {
    let output = Command::new("bluetoothctl")
        .args(["info", address])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await;

    let mut info = DeviceInfo {
        connected: false,
        trusted: false,
        supports_a2dp: false,
        rssi: None,
    };

    if let Ok(o) = output {
        let stdout = String::from_utf8_lossy(&o.stdout);
        for line in stdout.lines() {
            let line = line.trim();
            if line.starts_with("Connected: yes") {
                info.connected = true;
            } else if line.starts_with("Trusted: yes") {
                info.trusted = true;
            } else if line.contains("Audio Source") || line.contains("0000110a") {
                info.supports_a2dp = true;
            } else if line.starts_with("RSSI:") {
                if let Some(rssi_str) = line.strip_prefix("RSSI: ") {
                    if let Ok(rssi) = rssi_str.trim().parse::<i16>() {
                        info.rssi = Some(rssi);
                    }
                }
            }
        }
    }

    info
}

/// Start Bluetooth scanning.
pub async fn start_scan() -> Result<(), String> {
    info!("Starting Bluetooth scan");

    let output = Command::new("bluetoothctl")
        .args(["--timeout", "10", "scan", "on"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to start scan: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Scan failed: {}", stderr))
    }
}

/// Get all discovered Bluetooth devices (not just paired).
pub async fn get_discovered_devices() -> Vec<BluetoothDeviceEntry> {
    let output = Command::new("bluetoothctl")
        .args(["devices"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await;

    let mut devices = Vec::new();

    if let Ok(o) = output {
        let stdout = String::from_utf8_lossy(&o.stdout);
        for line in stdout.lines() {
            // Format: "Device XX:XX:XX:XX:XX:XX Name"
            if let Some(rest) = line.strip_prefix("Device ") {
                let parts: Vec<&str> = rest.splitn(2, ' ').collect();
                if parts.len() == 2 {
                    let address = parts[0].to_string();
                    let name = parts[1].to_string();

                    // Get detailed info for this device
                    let info = get_device_info(&address).await;

                    devices.push(BluetoothDeviceEntry {
                        address,
                        name,
                        paired: false, // Will be updated below
                        connected: info.connected,
                        trusted: info.trusted,
                        supports_a2dp: info.supports_a2dp,
                        rssi: info.rssi,
                    });
                }
            }
        }
    }

    // Also get paired devices to mark them
    let paired = get_paired_devices().await;
    for device in &mut devices {
        if paired.iter().any(|p| p.address == device.address) {
            device.paired = true;
        }
    }

    devices
}

/// Connect to a Bluetooth device.
pub async fn connect_device(address: &str) -> Result<(), String> {
    info!("Connecting to Bluetooth device: {}", address);

    let output = Command::new("bluetoothctl")
        .args(["connect", address])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to connect: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.contains("Connection successful") {
        info!("Connected to {}", address);
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        error!("Connection failed: {} {}", stdout, stderr);
        Err(format!("Connection failed: {}", stdout.trim()))
    }
}

/// Disconnect from a Bluetooth device.
pub async fn disconnect_device(address: &str) -> Result<(), String> {
    info!("Disconnecting from Bluetooth device: {}", address);

    let output = Command::new("bluetoothctl")
        .args(["disconnect", address])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to disconnect: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.contains("Disconnection successful") || stdout.contains("not connected") {
        info!("Disconnected from {}", address);
        Ok(())
    } else {
        Err(format!("Disconnect failed: {}", stdout.trim()))
    }
}

/// Trust a Bluetooth device.
pub async fn trust_device(address: &str) -> Result<(), String> {
    info!("Trusting Bluetooth device: {}", address);

    let output = Command::new("bluetoothctl")
        .args(["trust", address])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to trust: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.contains("trust succeeded") || stdout.contains("Trusted: yes") {
        Ok(())
    } else {
        Err(format!("Trust failed: {}", stdout.trim()))
    }
}

/// Pair with a Bluetooth device.
pub async fn pair_device(address: &str) -> Result<(), String> {
    info!("Pairing with Bluetooth device: {}", address);

    // First trust the device
    trust_device(address).await?;

    let output = Command::new("bluetoothctl")
        .args(["pair", address])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to pair: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.contains("Pairing successful") || stdout.contains("already paired") {
        Ok(())
    } else {
        Err(format!("Pairing failed: {}", stdout.trim()))
    }
}

/// Get BlueALSA PCM devices.
///
/// Returns a list of available PCM paths from bluealsactl.
/// Example output: `/org/bluealsa/hci0/dev_XX_XX_XX_XX_XX_XX/a2dpsnk/source`
pub async fn get_bluealsa_pcms() -> Vec<String> {
    let output = Command::new("bluealsactl")
        .args(["list-pcms"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await;

    let mut pcms = Vec::new();

    if let Ok(o) = output {
        let stdout = String::from_utf8_lossy(&o.stdout);
        for line in stdout.lines() {
            let line = line.trim();
            if !line.is_empty() {
                pcms.push(line.to_string());
            }
        }
    }

    pcms
}

/// Check if a specific Bluetooth device has an active BlueALSA audio stream.
pub async fn has_active_audio_stream(address: &str) -> bool {
    let pcms = get_bluealsa_pcms().await;
    let address_underscored = address.replace(':', "_").to_uppercase();
    pcms.iter().any(|s| s.contains(&address_underscored))
}

/// Set Bluetooth adapter power state.
pub async fn set_adapter_power(on: bool) -> Result<(), String> {
    let state = if on { "on" } else { "off" };
    info!("Setting Bluetooth adapter power {}", state);

    let output = Command::new("bluetoothctl")
        .args(["power", state])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to set adapter power: {}", e))?;

    if output.status.success() {
        info!("Bluetooth adapter power set to {}", state);
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to set power {}: {}", state, stderr))
    }
}

/// Check if Bluetooth adapter is powered on.
pub async fn is_adapter_powered() -> bool {
    let output = Command::new("bluetoothctl")
        .args(["show"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await;

    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout.lines().any(|line| {
                let trimmed = line.trim();
                trimmed.starts_with("Powered:") && trimmed.contains("yes")
            })
        }
        Err(_) => false,
    }
}

/// Get BlueALSA status summary.
///
/// Returns info about the BlueALSA service and available PCMs.
pub async fn get_bluealsa_status() -> Option<String> {
    let running = is_bluealsa_running().await;
    let pcms = get_bluealsa_pcms().await;

    let mut status = String::new();
    status.push_str(&format!("BlueALSA service: {}\n", if running { "active" } else { "inactive" }));
    status.push_str(&format!("Available PCMs: {}\n", pcms.len()));
    for pcm in &pcms {
        status.push_str(&format!("  {}\n", pcm));
    }

    Some(status)
}
