//! A2DP (Advanced Audio Distribution Profile) sink functionality.
//!
//! This module manages A2DP audio streaming from connected Bluetooth devices.
//! When acting as an A2DP sink, we receive audio from the remote device.

use std::time::Duration;

use futures::StreamExt;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tracing::{debug, info, warn};

use crate::adapter::BluetoothAdapter;
use crate::device::{Address, BluetoothDevice, A2DP_SOURCE_UUID};
use crate::discovery::DeviceScanner;
use crate::error::{BluetoothError, Result};

/// Default timeout for waiting for A2DP connection.
const A2DP_CONNECT_TIMEOUT: Duration = Duration::from_secs(60);

/// A2DP sink state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum A2dpState {
    /// No A2DP device connected.
    Disconnected,
    /// A2DP device connected but not streaming.
    Connected,
    /// A2DP device actively streaming audio.
    Streaming,
}

/// Event emitted by A2DP sink monitoring.
#[derive(Debug, Clone)]
pub enum A2dpEvent {
    /// A device connected with A2DP.
    DeviceConnected(BluetoothDevice),
    /// A device disconnected.
    DeviceDisconnected(Address),
    /// Streaming started.
    StreamingStarted(Address),
    /// Streaming stopped.
    StreamingStopped(Address),
}

/// A2DP sink manager.
///
/// Monitors for A2DP connections and provides the ALSA device name for audio capture.
pub struct A2dpSink<'a> {
    adapter: &'a BluetoothAdapter,
    connected_device: Option<BluetoothDevice>,
    state: A2dpState,
}

impl<'a> A2dpSink<'a> {
    /// Create a new A2DP sink manager.
    pub fn new(adapter: &'a BluetoothAdapter) -> Self {
        Self {
            adapter,
            connected_device: None,
            state: A2dpState::Disconnected,
        }
    }

    /// Get current A2DP state.
    pub fn state(&self) -> A2dpState {
        self.state.clone()
    }

    /// Get currently connected A2DP device (if any).
    pub fn connected_device(&self) -> Option<&BluetoothDevice> {
        self.connected_device.as_ref()
    }

    /// Get the ALSA device name for the connected A2DP device.
    ///
    /// Returns `None` if no device is connected.
    pub fn alsa_device(&self) -> Option<String> {
        self.connected_device.as_ref().map(|d| d.alsa_device())
    }

    /// Wait for an A2DP device to connect.
    ///
    /// This blocks until a device with A2DP source capability connects,
    /// or until the timeout elapses.
    pub async fn wait_for_connection(
        &mut self,
        timeout_duration: Duration,
    ) -> Result<BluetoothDevice> {
        info!("Waiting for A2DP device connection...");

        // First check for already-connected A2DP devices
        if let Some(device) = self.find_connected_a2dp_device().await? {
            info!("Found already-connected A2DP device: {}", device.display_name());
            self.connected_device = Some(device.clone());
            self.state = A2dpState::Connected;
            return Ok(device);
        }

        // Monitor for new connections
        let adapter = self.adapter.adapter();
        let discover = adapter.discover_devices().await.map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to monitor devices: {}", e))
        })?;

        let result = timeout(timeout_duration, async {
            let mut stream = discover;
            while let Some(event) = stream.next().await {
                if let bluer::AdapterEvent::DeviceAdded(addr) = event {
                    // Check if this device has A2DP source capability
                    let device_result = adapter.device(addr);
                    if let Ok(device) = device_result {
                        if device.is_connected().await.unwrap_or(false) {
                            if let Ok(bt_device) =
                                DeviceScanner::device_to_bluetooth_device(&device).await
                            {
                                if bt_device.supports_a2dp_source() {
                                    info!(
                                        "A2DP device connected: {}",
                                        bt_device.display_name()
                                    );
                                    return Ok(bt_device);
                                }
                            }
                        }
                    }
                }
            }
            Err(BluetoothError::Timeout)
        })
        .await;

        match result {
            Ok(Ok(device)) => {
                self.connected_device = Some(device.clone());
                self.state = A2dpState::Connected;
                Ok(device)
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err(BluetoothError::Timeout),
        }
    }

    /// Find an already-connected A2DP source device.
    async fn find_connected_a2dp_device(&self) -> Result<Option<BluetoothDevice>> {
        let scanner = DeviceScanner::new(self.adapter);
        let devices = scanner.get_known_devices().await?;

        for device in devices {
            if device.connected && device.supports_a2dp_source() {
                return Ok(Some(device));
            }
        }

        Ok(None)
    }

    /// Monitor A2DP events.
    ///
    /// Returns a channel that receives A2DP events (connections, disconnections, etc.).
    pub async fn monitor(&self) -> Result<mpsc::Receiver<A2dpEvent>> {
        let (tx, rx) = mpsc::channel(32);
        let adapter = self.adapter.adapter().clone();

        tokio::spawn(async move {
            let discover = match adapter.discover_devices().await {
                Ok(d) => d,
                Err(e) => {
                    warn!("Failed to start device monitoring: {}", e);
                    return;
                }
            };

            let mut stream = discover;
            while let Some(event) = stream.next().await {
                match event {
                    bluer::AdapterEvent::DeviceAdded(addr) => {
                        if let Ok(device) = adapter.device(addr) {
                            if device.is_connected().await.unwrap_or(false) {
                                if let Ok(bt_device) =
                                    DeviceScanner::device_to_bluetooth_device(&device).await
                                {
                                    if bt_device.supports_a2dp_source() {
                                        let _ = tx
                                            .send(A2dpEvent::DeviceConnected(bt_device))
                                            .await;
                                    }
                                }
                            }
                        }
                    }
                    bluer::AdapterEvent::DeviceRemoved(addr) => {
                        let _ = tx
                            .send(A2dpEvent::DeviceDisconnected(Address::from(addr)))
                            .await;
                    }
                    _ => {}
                }
            }
        });

        Ok(rx)
    }

    /// Check if a specific device supports A2DP source (can send audio to us).
    pub async fn device_supports_a2dp(&self, address: &Address) -> Result<bool> {
        let addr: bluer::Address = address
            .0
            .parse()
            .map_err(|_| BluetoothError::DeviceNotFound(address.0.clone()))?;

        let device = self.adapter.adapter().device(addr).map_err(|e| {
            BluetoothError::BlueZ(format!("Failed to get device: {}", e))
        })?;

        let uuids = device.uuids().await.ok().flatten().unwrap_or_default();
        Ok(uuids.iter().any(|u| u.to_string().to_lowercase() == A2DP_SOURCE_UUID))
    }

    /// Set the connected device (for manual tracking).
    pub fn set_connected_device(&mut self, device: Option<BluetoothDevice>) {
        self.connected_device = device;
        self.state = if self.connected_device.is_some() {
            A2dpState::Connected
        } else {
            A2dpState::Disconnected
        };
    }

    /// Update state to streaming.
    pub fn set_streaming(&mut self, streaming: bool) {
        if self.connected_device.is_some() {
            self.state = if streaming {
                A2dpState::Streaming
            } else {
                A2dpState::Connected
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a2dp_state_transitions() {
        // Just verify the enum variants exist and can be compared
        assert_eq!(A2dpState::Disconnected, A2dpState::Disconnected);
        assert_ne!(A2dpState::Connected, A2dpState::Streaming);
    }

    #[tokio::test]
    #[ignore = "requires real Bluetooth hardware"]
    async fn find_connected_device() {
        if let Ok(adapter) = BluetoothAdapter::new().await {
            let mut sink = A2dpSink::new(&adapter);
            let device = sink.find_connected_a2dp_device().await;
            assert!(device.is_ok());
        }
    }
}
