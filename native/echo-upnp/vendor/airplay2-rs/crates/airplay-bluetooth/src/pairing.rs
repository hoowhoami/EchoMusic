//! Bluetooth device pairing and connection management.
//!
//! Handles pairing, trusting, and connecting to Bluetooth devices.

use std::time::Duration;

use bluer::Device;
use tokio::time::timeout;
use tracing::{debug, info, warn};

use crate::adapter::BluetoothAdapter;
use crate::device::{Address, BluetoothDevice};
use crate::discovery::DeviceScanner;
use crate::error::{BluetoothError, Result};

/// Default timeout for pairing operations.
const PAIRING_TIMEOUT: Duration = Duration::from_secs(30);

/// Default timeout for connection operations.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Manages device pairing and connections.
pub struct PairingManager<'a> {
    adapter: &'a BluetoothAdapter,
}

impl<'a> PairingManager<'a> {
    /// Create a new pairing manager.
    pub fn new(adapter: &'a BluetoothAdapter) -> Self {
        Self { adapter }
    }

    /// Get a bluer Device from an address.
    fn get_device(&self, address: &Address) -> Result<Device> {
        let addr: bluer::Address = address
            .0
            .parse()
            .map_err(|_| BluetoothError::DeviceNotFound(address.0.clone()))?;

        self.adapter.adapter().device(addr).map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to get device {}: {}", address, e))
        })
    }

    /// Pair with a device.
    ///
    /// This initiates the pairing process. The device may require user interaction
    /// (e.g., confirming a PIN) depending on its security requirements.
    pub async fn pair(&self, address: &Address) -> Result<BluetoothDevice> {
        let device = self.get_device(address)?;

        // Check if already paired
        if device.is_paired().await.unwrap_or(false) {
            info!("Device {} is already paired", address);
            return DeviceScanner::device_to_bluetooth_device(&device).await;
        }

        info!("Initiating pairing with {}", address);

        // Attempt to pair with timeout
        let pair_result = timeout(PAIRING_TIMEOUT, device.pair()).await;

        match pair_result {
            Ok(Ok(())) => {
                info!("Successfully paired with {}", address);
            }
            Ok(Err(e)) => {
                return Err(BluetoothError::PairingFailed(e.to_string()));
            }
            Err(_) => {
                return Err(BluetoothError::Timeout);
            }
        }

        // Auto-trust after successful pairing
        if let Err(e) = self.trust(address).await {
            warn!("Failed to auto-trust device: {}", e);
        }

        DeviceScanner::device_to_bluetooth_device(&device).await
    }

    /// Trust a device (allows it to connect without explicit authorization).
    pub async fn trust(&self, address: &Address) -> Result<()> {
        let device = self.get_device(address)?;

        device.set_trusted(true).await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to trust device: {}", e))
        })?;

        debug!("Device {} is now trusted", address);
        Ok(())
    }

    /// Untrust a device.
    pub async fn untrust(&self, address: &Address) -> Result<()> {
        let device = self.get_device(address)?;

        device.set_trusted(false).await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to untrust device: {}", e))
        })?;

        debug!("Device {} is no longer trusted", address);
        Ok(())
    }

    /// Connect to a device.
    ///
    /// The device should be paired first, though some devices allow connection
    /// without prior pairing.
    pub async fn connect(&self, address: &Address) -> Result<BluetoothDevice> {
        let device = self.get_device(address)?;

        // Check if already connected
        if device.is_connected().await.unwrap_or(false) {
            info!("Device {} is already connected", address);
            return DeviceScanner::device_to_bluetooth_device(&device).await;
        }

        info!("Connecting to {}", address);

        // Attempt connection with timeout
        let connect_result = timeout(CONNECT_TIMEOUT, device.connect()).await;

        match connect_result {
            Ok(Ok(())) => {
                info!("Successfully connected to {}", address);
            }
            Ok(Err(e)) => {
                return Err(BluetoothError::ConnectionFailed(e.to_string()));
            }
            Err(_) => {
                return Err(BluetoothError::Timeout);
            }
        }

        DeviceScanner::device_to_bluetooth_device(&device).await
    }

    /// Disconnect from a device.
    pub async fn disconnect(&self, address: &Address) -> Result<()> {
        let device = self.get_device(address)?;

        // Check if connected
        if !device.is_connected().await.unwrap_or(false) {
            debug!("Device {} is not connected", address);
            return Ok(());
        }

        info!("Disconnecting from {}", address);

        device.disconnect().await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to disconnect: {}", e))
        })?;

        info!("Disconnected from {}", address);
        Ok(())
    }

    /// Remove a device (unpair and forget).
    pub async fn remove(&self, address: &Address) -> Result<()> {
        let addr: bluer::Address = address
            .0
            .parse()
            .map_err(|_| BluetoothError::DeviceNotFound(address.0.clone()))?;

        info!("Removing device {}", address);

        self.adapter.adapter().remove_device(addr).await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to remove device: {}", e))
        })?;

        info!("Device {} removed", address);
        Ok(())
    }

    /// Pair, trust, and connect to a device in one operation.
    pub async fn pair_and_connect(&self, address: &Address) -> Result<BluetoothDevice> {
        // Pair (skips if already paired)
        self.pair(address).await?;

        // Trust (allows future auto-reconnects)
        self.trust(address).await?;

        // Connect
        self.connect(address).await
    }

    /// Get the current state of a device.
    pub async fn get_device_state(&self, address: &Address) -> Result<BluetoothDevice> {
        let device = self.get_device(address)?;
        DeviceScanner::device_to_bluetooth_device(&device).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_parsing() {
        let addr = Address::new("00:11:22:33:44:55");
        assert_eq!(addr.0, "00:11:22:33:44:55");
    }

    #[tokio::test]
    #[ignore = "requires real Bluetooth hardware"]
    async fn pair_and_connect_flow() {
        // This test requires a real device to pair with
        // It's ignored by default
    }
}
