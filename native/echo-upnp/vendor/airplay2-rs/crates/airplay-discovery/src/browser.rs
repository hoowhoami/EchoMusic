//! mDNS service browser implementation.

use crate::parser::TxtRecordParser;
use crate::traits::{BrowseEvent, Discovery};
use crate::{AIRPLAY_SERVICE_TYPE, RAOP_SERVICE_TYPE};
use airplay_core::error::DiscoveryError;
use airplay_core::{Device, DeviceId, Result};
use async_trait::async_trait;
use mdns_sd::{ServiceDaemon, ServiceEvent};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tokio_stream::Stream;
use tracing::{debug, trace, warn};

/// mDNS service browser for AirPlay device discovery.
pub struct ServiceBrowser {
    devices: Arc<RwLock<HashMap<DeviceId, Device>>>,
    daemon: ServiceDaemon,
    running: Arc<AtomicBool>,
}

impl ServiceBrowser {
    /// Create a new service browser.
    pub fn new() -> Result<Self> {
        let daemon = ServiceDaemon::new()
            .map_err(|e| DiscoveryError::Daemon(format!("Failed to create mDNS daemon: {}", e)))?;

        Ok(Self {
            devices: Arc::new(RwLock::new(HashMap::new())),
            daemon,
            running: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Parse a resolved mDNS service into a Device.
    fn parse_service_event(service_info: &mdns_sd::ServiceInfo, is_raop: bool) -> Option<Device> {
        let name = service_info.get_fullname();
        let port = service_info.get_port();

        // Collect addresses - mdns-sd returns IpAddr directly
        let addresses: Vec<IpAddr> = service_info.get_addresses().iter().copied().collect();

        if addresses.is_empty() {
            debug!("Service {} has no addresses, skipping", name);
            return None;
        }

        // Build TXT record map
        let txt: HashMap<String, String> = service_info
            .get_properties()
            .iter()
            .map(|prop| (prop.key().to_string(), prop.val_str().to_string()))
            .collect();

        // Extract service name (without domain suffix)
        let service_name = service_info
            .get_fullname()
            .split('.')
            .next()
            .unwrap_or(name);

        let result = if is_raop {
            TxtRecordParser::parse_raop_txt(service_name, &txt, addresses, port)
        } else {
            TxtRecordParser::parse_airplay_txt(service_name, &txt, addresses, port)
        };

        match result {
            Ok(device) => {
                debug!(
                    "Parsed device: {} ({})",
                    device.name,
                    device.id.to_mac_string()
                );
                Some(device)
            }
            Err(e) => {
                warn!("Failed to parse service {}: {}", name, e);
                None
            }
        }
    }

    /// Extract device ID from a service removal event.
    fn extract_device_id_from_removal(fullname: &str, is_raop: bool) -> Option<DeviceId> {
        let service_name = fullname.split('.').next()?;

        if is_raop {
            // RAOP format: "AABBCCDDEEFF@Device Name"
            let mac_hex = service_name.split('@').next()?;
            DeviceId::from_mac_string(mac_hex).ok()
        } else {
            // For AirPlay, we need to look up the device by name
            // This is a limitation - we can't extract device ID from just the service name
            // The caller should use the cached device info
            None
        }
    }

    /// Handle a service event and optionally return a browse event.
    async fn handle_service_event(
        event: ServiceEvent,
        is_raop: bool,
        devices: &Arc<RwLock<HashMap<DeviceId, Device>>>,
    ) -> Option<BrowseEvent> {
        match event {
            ServiceEvent::ServiceResolved(info) => {
                trace!("Service resolved: {}", info.get_fullname());
                if let Some(device) = Self::parse_service_event(&info, is_raop) {
                    let device_id = device.id.clone();
                    let mut devices_guard = devices.write().await;

                    let is_new = !devices_guard.contains_key(&device_id);

                    if is_new {
                        devices_guard.insert(device_id, device.clone());
                        Some(BrowseEvent::Added(device))
                    } else {
                        // Update existing device, potentially merging info
                        // merge_device_info expects (airplay, raop) order
                        let existing = devices_guard.get(&device_id).unwrap();
                        let merged = if is_raop {
                            // New device is RAOP, existing is (likely) AirPlay
                            TxtRecordParser::merge_device_info(existing, &device)
                        } else {
                            // New device is AirPlay (has richer features), existing is (likely) RAOP
                            TxtRecordParser::merge_device_info(&device, existing)
                        };
                        devices_guard.insert(device_id, merged.clone());
                        Some(BrowseEvent::Updated(merged))
                    }
                } else {
                    None
                }
            }
            ServiceEvent::ServiceRemoved(_, fullname) => {
                trace!("Service removed: {}", fullname);
                if let Some(device_id) = Self::extract_device_id_from_removal(&fullname, is_raop) {
                    let mut devices_guard = devices.write().await;
                    if devices_guard.remove(&device_id).is_some() {
                        Some(BrowseEvent::Removed(device_id))
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
            ServiceEvent::SearchStarted(_) => {
                trace!("Search started");
                None
            }
            ServiceEvent::SearchStopped(_) => {
                trace!("Search stopped");
                None
            }
            _ => None,
        }
    }
}

impl Default for ServiceBrowser {
    fn default() -> Self {
        Self::new().expect("Failed to create ServiceBrowser")
    }
}

#[async_trait]
impl Discovery for ServiceBrowser {
    async fn browse(&self) -> Result<Box<dyn Stream<Item = BrowseEvent> + Send + Unpin>> {
        self.running.store(true, Ordering::SeqCst);

        // Start browsing for both service types
        let airplay_receiver = self
            .daemon
            .browse(AIRPLAY_SERVICE_TYPE)
            .map_err(|e| DiscoveryError::Daemon(format!("Failed to browse AirPlay: {}", e)))?;

        let raop_receiver = self
            .daemon
            .browse(RAOP_SERVICE_TYPE)
            .map_err(|e| DiscoveryError::Daemon(format!("Failed to browse RAOP: {}", e)))?;

        let devices = Arc::clone(&self.devices);
        let running = Arc::clone(&self.running);

        // Create an async stream that processes events from both receivers
        let stream = async_stream::stream! {
            loop {
                if !running.load(Ordering::SeqCst) {
                    break;
                }

                // Try to receive from either channel with a short timeout
                let recv_timeout = Duration::from_millis(100);

                // Check AirPlay events
                if let Ok(event) = airplay_receiver.recv_timeout(recv_timeout) {
                    if let Some(browse_event) = Self::handle_service_event(event, false, &devices).await {
                        yield browse_event;
                    }
                }

                // Check RAOP events
                if let Ok(event) = raop_receiver.recv_timeout(recv_timeout) {
                    if let Some(browse_event) = Self::handle_service_event(event, true, &devices).await {
                        yield browse_event;
                    }
                }
            }
        };

        Ok(Box::new(Box::pin(stream)))
    }

    async fn scan(&self, timeout: Duration) -> Result<Vec<Device>> {
        self.running.store(true, Ordering::SeqCst);

        // Start browsing for both service types
        let airplay_receiver = self
            .daemon
            .browse(AIRPLAY_SERVICE_TYPE)
            .map_err(|e| DiscoveryError::Daemon(format!("Failed to browse AirPlay: {}", e)))?;

        let raop_receiver = self
            .daemon
            .browse(RAOP_SERVICE_TYPE)
            .map_err(|e| DiscoveryError::Daemon(format!("Failed to browse RAOP: {}", e)))?;

        let devices = Arc::clone(&self.devices);
        let start = std::time::Instant::now();

        // Process events until timeout
        while start.elapsed() < timeout && self.running.load(Ordering::SeqCst) {
            let remaining = timeout.saturating_sub(start.elapsed());
            let recv_timeout = remaining.min(Duration::from_millis(100));

            // Check AirPlay events
            if let Ok(event) = airplay_receiver.recv_timeout(recv_timeout) {
                Self::handle_service_event(event, false, &devices).await;
            }

            // Check RAOP events
            if let Ok(event) = raop_receiver.recv_timeout(recv_timeout) {
                Self::handle_service_event(event, true, &devices).await;
            }
        }

        // Stop browsing
        let _ = self.daemon.stop_browse(AIRPLAY_SERVICE_TYPE);
        let _ = self.daemon.stop_browse(RAOP_SERVICE_TYPE);

        self.running.store(false, Ordering::SeqCst);

        // Return all discovered devices
        Ok(self.get_all_devices().await)
    }

    async fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        let _ = self.daemon.stop_browse(AIRPLAY_SERVICE_TYPE);
        let _ = self.daemon.stop_browse(RAOP_SERVICE_TYPE);
    }

    async fn get_device(&self, id: &DeviceId) -> Option<Device> {
        self.devices.read().await.get(id).cloned()
    }

    async fn get_all_devices(&self) -> Vec<Device> {
        self.devices.read().await.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use airplay_core::{Features, Version};
    use std::net::Ipv4Addr;

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

    mod service_browser {
        use super::*;

        #[test]
        fn new_creates_empty_device_list() {
            // Note: This test requires mDNS to be available on the system
            // Skip if we can't create a daemon
            if let Ok(browser) = ServiceBrowser::new() {
                let devices = browser.devices.try_read().unwrap();
                assert!(devices.is_empty());
            }
        }
    }

    mod device_cache {
        use super::*;

        #[tokio::test]
        async fn get_device_returns_none_when_not_found() {
            if let Ok(browser) = ServiceBrowser::new() {
                let device_id = DeviceId([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
                let result = browser.get_device(&device_id).await;
                assert!(result.is_none());
            }
        }

        #[tokio::test]
        async fn get_device_returns_device_when_found() {
            if let Ok(browser) = ServiceBrowser::new() {
                let device = make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Test Device");
                let device_id = device.id.clone();

                // Insert device directly for testing
                browser
                    .devices
                    .write()
                    .await
                    .insert(device_id.clone(), device);

                let result = browser.get_device(&device_id).await;
                assert!(result.is_some());
                assert_eq!(result.unwrap().name, "Test Device");
            }
        }

        #[tokio::test]
        async fn get_all_devices_returns_all_cached() {
            if let Ok(browser) = ServiceBrowser::new() {
                let device1 = make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Device 1");
                let device2 = make_test_device([0x11, 0x22, 0x33, 0x44, 0x55, 0x66], "Device 2");

                {
                    let mut devices = browser.devices.write().await;
                    devices.insert(device1.id.clone(), device1);
                    devices.insert(device2.id.clone(), device2);
                }

                let all = browser.get_all_devices().await;
                assert_eq!(all.len(), 2);
            }
        }
    }

    mod extract_device_id {
        use super::*;

        #[test]
        fn extracts_from_raop_fullname() {
            let fullname = "AABBCCDDEEFF@Living Room._raop._tcp.local.";
            let id = ServiceBrowser::extract_device_id_from_removal(fullname, true);
            assert!(id.is_some());
            assert_eq!(id.unwrap().0, [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
        }

        #[test]
        fn returns_none_for_airplay_fullname() {
            // AirPlay doesn't encode MAC in the service name
            let fullname = "Living Room._airplay._tcp.local.";
            let id = ServiceBrowser::extract_device_id_from_removal(fullname, false);
            assert!(id.is_none());
        }

        #[test]
        fn returns_none_for_invalid_raop_format() {
            let fullname = "InvalidFormat._raop._tcp.local.";
            let id = ServiceBrowser::extract_device_id_from_removal(fullname, true);
            assert!(id.is_none());
        }
    }

    // Integration tests that require real mDNS on the network
    // These are marked as ignored by default
    mod integration {
        use super::*;

        #[tokio::test]
        #[ignore = "requires real AirPlay devices on network"]
        async fn scan_finds_real_devices() {
            let browser = ServiceBrowser::new().expect("Failed to create browser");
            let devices = browser.scan(Duration::from_secs(5)).await.unwrap();

            println!("Found {} devices:", devices.len());
            for device in &devices {
                println!(
                    "  - {} ({}) at {:?}:{}",
                    device.name,
                    device.id.to_mac_string(),
                    device.addresses,
                    device.port
                );
                println!("    Model: {}", device.model);
                println!("    Features: 0x{:X}", device.features.raw());
                println!("    AirPlay 2: {}", device.supports_airplay2());
            }
        }

        #[tokio::test]
        #[ignore = "requires real AirPlay devices on network"]
        async fn browse_emits_events_for_real_devices() {
            use futures::StreamExt;

            let browser = ServiceBrowser::new().expect("Failed to create browser");
            let mut stream = browser.browse().await.unwrap();

            println!("Browsing for devices (10 seconds)...");

            let timeout = tokio::time::sleep(Duration::from_secs(10));
            tokio::pin!(timeout);

            loop {
                tokio::select! {
                    event = stream.next() => {
                        match event {
                            Some(BrowseEvent::Added(device)) => {
                                println!("+ Added: {} ({})", device.name, device.id.to_mac_string());
                            }
                            Some(BrowseEvent::Updated(device)) => {
                                println!("~ Updated: {} ({})", device.name, device.id.to_mac_string());
                            }
                            Some(BrowseEvent::Removed(id)) => {
                                println!("- Removed: {}", id.to_mac_string());
                            }
                            None => break,
                        }
                    }
                    _ = &mut timeout => {
                        println!("Timeout reached");
                        break;
                    }
                }
            }

            browser.stop().await;
        }
    }
}
