//! Bluetooth adapter management.
//!
//! Provides high-level control over the Bluetooth adapter (power, discoverable, etc.).

use bluer::{Adapter, Session};
use tracing::{debug, info, warn};

use crate::error::{BluetoothError, Result};

/// Wrapper around the Bluetooth adapter for simplified management.
pub struct BluetoothAdapter {
    session: Session,
    adapter: Adapter,
}

impl BluetoothAdapter {
    /// Create a new adapter manager using the default adapter.
    pub async fn new() -> Result<Self> {
        let session = Session::new().await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to create BlueZ session: {}", e))
        })?;

        let adapter = session.default_adapter().await.map_err(|e| {
            if e.to_string().contains("No default adapter") {
                BluetoothError::AdapterNotFound
            } else {
                BluetoothError::BlueZ(format!("Failed to get adapter: {}", e))
            }
        })?;

        let name = adapter.name();
        info!("Using Bluetooth adapter: {}", name);

        Ok(Self { session, adapter })
    }

    /// Get the adapter name (e.g., "hci0").
    pub fn name(&self) -> &str {
        self.adapter.name()
    }

    /// Check if the adapter is powered on.
    pub async fn is_powered(&self) -> Result<bool> {
        self.adapter.is_powered().await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to get power state: {}", e))
        })
    }

    /// Power on/off the adapter.
    pub async fn set_powered(&self, powered: bool) -> Result<()> {
        self.adapter.set_powered(powered).await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to set power state: {}", e))
        })?;

        if powered {
            info!("Bluetooth adapter powered on");
        } else {
            info!("Bluetooth adapter powered off");
        }

        Ok(())
    }

    /// Check if the adapter is discoverable.
    pub async fn is_discoverable(&self) -> Result<bool> {
        self.adapter.is_discoverable().await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to get discoverable state: {}", e))
        })
    }

    /// Set whether the adapter is discoverable by other devices.
    pub async fn set_discoverable(&self, discoverable: bool) -> Result<()> {
        self.adapter.set_discoverable(discoverable).await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to set discoverable state: {}", e))
        })?;

        if discoverable {
            debug!("Bluetooth adapter is now discoverable");
        } else {
            debug!("Bluetooth adapter is no longer discoverable");
        }

        Ok(())
    }

    /// Check if the adapter is pairable.
    pub async fn is_pairable(&self) -> Result<bool> {
        self.adapter.is_pairable().await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to get pairable state: {}", e))
        })
    }

    /// Set whether the adapter accepts pairing requests.
    pub async fn set_pairable(&self, pairable: bool) -> Result<()> {
        self.adapter.set_pairable(pairable).await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to set pairable state: {}", e))
        })?;

        if pairable {
            debug!("Bluetooth adapter is now pairable");
        } else {
            debug!("Bluetooth adapter is no longer pairable");
        }

        Ok(())
    }

    /// Get the adapter's Bluetooth address.
    pub async fn address(&self) -> Result<String> {
        let addr = self.adapter.address().await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to get adapter address: {}", e))
        })?;
        Ok(addr.to_string())
    }

    /// Get the adapter's discoverable timeout in seconds (0 = no timeout).
    pub async fn discoverable_timeout(&self) -> Result<u32> {
        self.adapter.discoverable_timeout().await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to get discoverable timeout: {}", e))
        })
    }

    /// Set the discoverable timeout in seconds (0 = no timeout).
    pub async fn set_discoverable_timeout(&self, timeout: u32) -> Result<()> {
        self.adapter
            .set_discoverable_timeout(timeout)
            .await
            .map_err(|e| {
                BluetoothError::BlueZ(format!("Failed to set discoverable timeout: {}", e))
            })?;
        debug!("Set discoverable timeout to {} seconds", timeout);
        Ok(())
    }

    /// Get the adapter's alias (friendly name).
    pub async fn alias(&self) -> Result<String> {
        self.adapter.alias().await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to get adapter alias: {}", e))
        })
    }

    /// Set the adapter's alias (friendly name).
    pub async fn set_alias(&self, alias: &str) -> Result<()> {
        self.adapter.set_alias(alias.to_string()).await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to set adapter alias: {}", e))
        })?;
        info!("Set adapter alias to: {}", alias);
        Ok(())
    }

    /// Make the adapter ready to receive connections.
    ///
    /// This powers on the adapter and makes it discoverable and pairable.
    pub async fn make_connectable(&self) -> Result<()> {
        // Ensure powered on
        if !self.is_powered().await? {
            self.set_powered(true).await?;
        }

        // Make discoverable (with infinite timeout)
        self.set_discoverable_timeout(0).await?;
        self.set_discoverable(true).await?;

        // Make pairable
        self.set_pairable(true).await?;

        info!("Adapter is now ready to receive connections");
        Ok(())
    }

    /// Get a reference to the underlying bluer session.
    pub fn session(&self) -> &Session {
        &self.session
    }

    /// Get a reference to the underlying bluer adapter.
    pub fn adapter(&self) -> &Adapter {
        &self.adapter
    }
}

#[cfg(test)]
mod tests {
    // Note: These tests require a real Bluetooth adapter and BlueZ running.
    // They are marked as ignored by default.

    use super::*;

    #[tokio::test]
    #[ignore = "requires real Bluetooth hardware"]
    async fn adapter_creation() {
        let adapter = BluetoothAdapter::new().await;
        assert!(adapter.is_ok() || matches!(adapter.err(), Some(BluetoothError::AdapterNotFound)));
    }

    #[tokio::test]
    #[ignore = "requires real Bluetooth hardware"]
    async fn adapter_power_state() {
        if let Ok(adapter) = BluetoothAdapter::new().await {
            let powered = adapter.is_powered().await;
            assert!(powered.is_ok());
        }
    }
}
