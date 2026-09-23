//! Bluetooth device representation.

use std::collections::HashSet;
use std::fmt;

/// A2DP Source UUID (the remote device sends audio to us).
pub const A2DP_SOURCE_UUID: &str = "0000110a-0000-1000-8000-00805f9b34fb";

/// A2DP Sink UUID (we receive audio from the remote device).
pub const A2DP_SINK_UUID: &str = "0000110b-0000-1000-8000-00805f9b34fb";

/// Bluetooth device address.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Address(pub String);

impl Address {
    /// Create from a MAC address string (e.g., "00:11:22:33:44:55").
    pub fn new(addr: impl Into<String>) -> Self {
        Self(addr.into().to_uppercase())
    }

    /// Get the bluez-alsa device string format.
    pub fn to_bluealsa_device(&self) -> String {
        format!("bluealsa:DEV={},PROFILE=a2dp", self.0)
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<bluer::Address> for Address {
    fn from(addr: bluer::Address) -> Self {
        Self(addr.to_string().to_uppercase())
    }
}

/// Represents a discovered Bluetooth device.
#[derive(Debug, Clone)]
pub struct BluetoothDevice {
    /// Device Bluetooth address.
    pub address: Address,
    /// Device name (may be "Unknown" if not yet resolved).
    pub name: String,
    /// Device alias (user-friendly name).
    pub alias: Option<String>,
    /// Whether the device is paired.
    pub paired: bool,
    /// Whether the device is connected.
    pub connected: bool,
    /// Whether the device is trusted.
    pub trusted: bool,
    /// Service UUIDs advertised by the device.
    pub uuids: HashSet<String>,
    /// Received Signal Strength Indicator.
    pub rssi: Option<i16>,
    /// Device icon hint (e.g., "audio-card", "phone").
    pub icon: Option<String>,
}

impl BluetoothDevice {
    /// Check if device supports A2DP audio source (can send audio to us).
    pub fn supports_a2dp_source(&self) -> bool {
        self.uuids.contains(A2DP_SOURCE_UUID)
    }

    /// Check if device supports A2DP audio sink (can receive audio from us).
    pub fn supports_a2dp_sink(&self) -> bool {
        self.uuids.contains(A2DP_SINK_UUID)
    }

    /// Check if device supports any A2DP profile.
    pub fn supports_a2dp(&self) -> bool {
        self.supports_a2dp_source() || self.supports_a2dp_sink()
    }

    /// Get display name (alias if available, otherwise name).
    pub fn display_name(&self) -> &str {
        self.alias.as_deref().unwrap_or(&self.name)
    }

    /// Get the bluez-alsa ALSA device name for capturing audio from this device.
    pub fn alsa_device(&self) -> String {
        self.address.to_bluealsa_device()
    }
}

impl Default for BluetoothDevice {
    fn default() -> Self {
        Self {
            address: Address::new("00:00:00:00:00:00"),
            name: "Unknown".to_string(),
            alias: None,
            paired: false,
            connected: false,
            trusted: false,
            uuids: HashSet::new(),
            rssi: None,
            icon: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod address {
        use super::*;

        #[test]
        fn normalizes_to_uppercase() {
            let addr = Address::new("aa:bb:cc:dd:ee:ff");
            assert_eq!(addr.0, "AA:BB:CC:DD:EE:FF");
        }

        #[test]
        fn to_bluealsa_device_format() {
            let addr = Address::new("00:11:22:33:44:55");
            assert_eq!(
                addr.to_bluealsa_device(),
                "bluealsa:DEV=00:11:22:33:44:55,PROFILE=a2dp"
            );
        }
    }

    mod bluetooth_device {
        use super::*;

        #[test]
        fn supports_a2dp_source_with_uuid() {
            let mut device = BluetoothDevice::default();
            device.uuids.insert(A2DP_SOURCE_UUID.to_string());
            assert!(device.supports_a2dp_source());
            assert!(!device.supports_a2dp_sink());
            assert!(device.supports_a2dp());
        }

        #[test]
        fn supports_a2dp_sink_with_uuid() {
            let mut device = BluetoothDevice::default();
            device.uuids.insert(A2DP_SINK_UUID.to_string());
            assert!(!device.supports_a2dp_source());
            assert!(device.supports_a2dp_sink());
            assert!(device.supports_a2dp());
        }

        #[test]
        fn display_name_prefers_alias() {
            let mut device = BluetoothDevice::default();
            device.name = "Unknown Device".to_string();
            device.alias = Some("My Speaker".to_string());
            assert_eq!(device.display_name(), "My Speaker");
        }

        #[test]
        fn display_name_falls_back_to_name() {
            let mut device = BluetoothDevice::default();
            device.name = "BT Device".to_string();
            device.alias = None;
            assert_eq!(device.display_name(), "BT Device");
        }
    }
}
