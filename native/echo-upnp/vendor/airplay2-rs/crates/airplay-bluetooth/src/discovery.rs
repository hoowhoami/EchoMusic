//! Bluetooth device discovery.
//!
//! Scans for nearby Bluetooth devices and retrieves their properties.

use std::collections::HashSet;
use std::time::Duration;

use bluer::Device;
use futures::StreamExt;
use tokio::time::timeout;
use tracing::{debug, info, warn};

use crate::adapter::BluetoothAdapter;
use crate::device::{Address, BluetoothDevice};
use crate::error::{BluetoothError, Result};

/// Device discovery scanner.
pub struct DeviceScanner<'a> {
    adapter: &'a BluetoothAdapter,
}

impl<'a> DeviceScanner<'a> {
    /// Create a new scanner for the given adapter.
    pub fn new(adapter: &'a BluetoothAdapter) -> Self {
        Self { adapter }
    }

    /// Scan for devices for the specified duration.
    ///
    /// Returns all discovered devices, including previously paired devices.
    pub async fn scan(&self, duration: Duration) -> Result<Vec<BluetoothDevice>> {
        let adapter = self.adapter.adapter();

        // Ensure adapter is powered
        if !self.adapter.is_powered().await? {
            return Err(BluetoothError::AdapterPoweredOff);
        }

        info!("Starting Bluetooth scan for {:?}", duration);

        // Get already-known devices first
        let mut devices = self.get_known_devices().await?;
        let known_addresses: HashSet<_> = devices.iter().map(|d| d.address.clone()).collect();

        // Start discovery
        let discover = adapter.discover_devices().await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to start discovery: {}", e))
        })?;

        // Collect new devices during scan
        let scan_result = timeout(duration, async {
            let mut stream = discover;
            while let Some(event) = stream.next().await {
                match event {
                    bluer::AdapterEvent::DeviceAdded(addr) => {
                        if !known_addresses.contains(&Address::from(addr)) {
                            debug!("Discovered new device: {}", addr);
                            if let Ok(device) = self.get_device(addr).await {
                                devices.push(device);
                            }
                        }
                    }
                    bluer::AdapterEvent::DeviceRemoved(addr) => {
                        debug!("Device removed: {}", addr);
                    }
                    _ => {}
                }
            }
        })
        .await;

        // Timeout is expected - it just means scan duration elapsed
        if scan_result.is_err() {
            debug!("Scan completed (timeout)");
        }

        info!("Scan complete, found {} devices", devices.len());
        Ok(devices)
    }

    /// Get all known (previously discovered or paired) devices.
    pub async fn get_known_devices(&self) -> Result<Vec<BluetoothDevice>> {
        let adapter = self.adapter.adapter();

        let addresses = adapter.device_addresses().await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to list devices: {}", e))
        })?;

        let mut devices = Vec::new();
        for addr in addresses {
            match self.get_device(addr).await {
                Ok(device) => devices.push(device),
                Err(e) => {
                    warn!("Failed to get device {}: {}", addr, e);
                }
            }
        }

        Ok(devices)
    }

    /// Get all A2DP capable devices (devices that can send audio to us).
    pub async fn get_a2dp_devices(&self) -> Result<Vec<BluetoothDevice>> {
        let devices = self.get_known_devices().await?;
        Ok(devices.into_iter().filter(|d| d.supports_a2dp()).collect())
    }

    /// Get device by address.
    async fn get_device(&self, addr: bluer::Address) -> Result<BluetoothDevice> {
        let adapter = self.adapter.adapter();
        let device = adapter.device(addr).map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to get device {}: {}", addr, e))
        })?;

        Self::device_to_bluetooth_device(&device).await
    }

    /// Convert a bluer Device to our BluetoothDevice.
    pub(crate) async fn device_to_bluetooth_device(device: &Device) -> Result<BluetoothDevice> {
        let address = Address::from(device.address());

        // Get device properties, using defaults if unavailable
        let name = device.name().await.ok().flatten().unwrap_or_else(|| "Unknown".to_string());
        let alias = device.alias().await.ok();
        let paired = device.is_paired().await.unwrap_or(false);
        let connected = device.is_connected().await.unwrap_or(false);
        let trusted = device.is_trusted().await.unwrap_or(false);
        let rssi = device.rssi().await.ok().flatten();
        let icon = device.icon().await.ok().flatten();

        // Get UUIDs
        let uuids: HashSet<String> = device
            .uuids()
            .await
            .ok()
            .flatten()
            .map(|uuids| {
                uuids
                    .into_iter()
                    .map(|u| u.to_string().to_lowercase())
                    .collect()
            })
            .unwrap_or_default();

        Ok(BluetoothDevice {
            address,
            name,
            alias,
            paired,
            connected,
            trusted,
            uuids,
            rssi,
            icon,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires real Bluetooth hardware"]
    async fn scan_finds_devices() {
        if let Ok(adapter) = BluetoothAdapter::new().await {
            let scanner = DeviceScanner::new(&adapter);
            let devices = scanner.scan(Duration::from_secs(5)).await;
            assert!(devices.is_ok());
        }
    }
}
