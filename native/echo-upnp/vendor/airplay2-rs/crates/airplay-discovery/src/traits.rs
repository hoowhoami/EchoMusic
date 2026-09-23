//! Trait definitions for service discovery (enables mocking in tests).

use airplay_core::{Device, DeviceId, Result};
use async_trait::async_trait;
use std::time::Duration;
use tokio_stream::Stream;

/// Event emitted during device browsing.
#[derive(Debug, Clone)]
pub enum BrowseEvent {
    /// New device discovered.
    Added(Device),
    /// Existing device updated (e.g., IP changed).
    Updated(Device),
    /// Device went offline.
    Removed(DeviceId),
}

impl BrowseEvent {
    /// Get the device from an Added or Updated event.
    pub fn device(&self) -> Option<&Device> {
        match self {
            BrowseEvent::Added(d) | BrowseEvent::Updated(d) => Some(d),
            BrowseEvent::Removed(_) => None,
        }
    }

    /// Get the device ID from any event.
    pub fn device_id(&self) -> &DeviceId {
        match self {
            BrowseEvent::Added(d) | BrowseEvent::Updated(d) => &d.id,
            BrowseEvent::Removed(id) => id,
        }
    }

    /// Check if this is an Added event.
    pub fn is_added(&self) -> bool {
        matches!(self, BrowseEvent::Added(_))
    }

    /// Check if this is an Updated event.
    pub fn is_updated(&self) -> bool {
        matches!(self, BrowseEvent::Updated(_))
    }

    /// Check if this is a Removed event.
    pub fn is_removed(&self) -> bool {
        matches!(self, BrowseEvent::Removed(_))
    }
}

/// Trait for service discovery implementations.
///
/// This trait enables testing with mock implementations.
#[async_trait]
#[cfg_attr(test, mockall::automock)]
pub trait Discovery: Send + Sync {
    /// Start continuous browsing for AirPlay devices.
    ///
    /// Returns a stream of browse events.
    async fn browse(&self) -> Result<Box<dyn Stream<Item = BrowseEvent> + Send + Unpin>>;

    /// Perform a one-shot scan with timeout.
    ///
    /// Collects all devices found within the timeout period.
    async fn scan(&self, timeout: Duration) -> Result<Vec<Device>>;

    /// Stop all browsing activity.
    async fn stop(&self);

    /// Get a specific device by ID if currently known.
    async fn get_device(&self, id: &DeviceId) -> Option<Device>;

    /// Get all currently known devices.
    async fn get_all_devices(&self) -> Vec<Device>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use airplay_core::{Features, Version};
    use std::net::{IpAddr, Ipv4Addr};

    fn make_test_device(mac: [u8; 6], name: &str) -> Device {
        Device {
            id: DeviceId(mac),
            name: name.to_string(),
            model: "TestModel".to_string(),
            manufacturer: None,
            serial_number: None,
            addresses: vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 100))],
            port: 7000,
            features: Features::default(),
            required_sender_features: None,
            public_key: None,
            source_version: Version::default(),
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
        }
    }

    mod browse_event {
        use super::*;

        #[test]
        fn added_event_contains_device() {
            let device = make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Test Device");
            let event = BrowseEvent::Added(device.clone());

            assert!(event.is_added());
            assert!(!event.is_updated());
            assert!(!event.is_removed());
            assert_eq!(event.device().unwrap().name, "Test Device");
            assert_eq!(event.device_id().0, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
        }

        #[test]
        fn updated_event_contains_device() {
            let device = make_test_device([0x11, 0x22, 0x33, 0x44, 0x55, 0x66], "Updated Device");
            let event = BrowseEvent::Updated(device.clone());

            assert!(!event.is_added());
            assert!(event.is_updated());
            assert!(!event.is_removed());
            assert_eq!(event.device().unwrap().name, "Updated Device");
            assert_eq!(event.device_id().0, [0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
        }

        #[test]
        fn removed_event_contains_device_id() {
            let device_id = DeviceId([0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE]);
            let event = BrowseEvent::Removed(device_id.clone());

            assert!(!event.is_added());
            assert!(!event.is_updated());
            assert!(event.is_removed());
            assert!(event.device().is_none());
            assert_eq!(event.device_id().0, [0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE]);
        }
    }

    mod mock_discovery {
        use super::*;

        #[tokio::test]
        async fn mock_scan_returns_configured_devices() {
            let mut mock = MockDiscovery::new();

            let devices = vec![
                make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Device 1"),
                make_test_device([0x11, 0x22, 0x33, 0x44, 0x55, 0x66], "Device 2"),
            ];

            mock.expect_scan().returning(move |_| {
                let d = devices.clone();
                Box::pin(async move { Ok(d) })
            });

            let result = mock.scan(Duration::from_secs(5)).await.unwrap();
            assert_eq!(result.len(), 2);
            assert_eq!(result[0].name, "Device 1");
            assert_eq!(result[1].name, "Device 2");
        }

        #[tokio::test]
        async fn mock_get_device_returns_device() {
            let mut mock = MockDiscovery::new();

            let device = make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Test Device");

            mock.expect_get_device().returning(move |_| {
                let d = device.clone();
                Box::pin(async move { Some(d) })
            });

            let device_id = DeviceId([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
            let result = mock.get_device(&device_id).await;
            assert!(result.is_some());
            assert_eq!(result.unwrap().name, "Test Device");
        }

        #[tokio::test]
        async fn mock_get_all_devices_returns_all() {
            let mut mock = MockDiscovery::new();

            let devices = vec![
                make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Device 1"),
                make_test_device([0x11, 0x22, 0x33, 0x44, 0x55, 0x66], "Device 2"),
            ];

            mock.expect_get_all_devices().returning(move || {
                let d = devices.clone();
                Box::pin(async move { d })
            });

            let result = mock.get_all_devices().await;
            assert_eq!(result.len(), 2);
        }

        #[tokio::test]
        async fn mock_stop_is_callable() {
            let mut mock = MockDiscovery::new();

            mock.expect_stop().returning(|| Box::pin(async {}));

            mock.stop().await;
            // Test passes if stop() doesn't panic
        }
    }
}
