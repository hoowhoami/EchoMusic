//! Multi-room device group management.

use airplay_core::{Device, DeviceId, error::Result};
use uuid::Uuid;
use std::collections::HashMap;

/// Member of a device group.
#[derive(Debug, Clone)]
pub struct GroupMember {
    pub device: Device,
    pub volume: f32,
    pub is_leader: bool,
}

/// Multi-room device group.
pub struct DeviceGroup {
    id: Uuid,
    members: HashMap<DeviceId, GroupMember>,
    leader_id: DeviceId,
}

impl DeviceGroup {
    /// Create new group with leader device.
    pub fn new(leader: Device) -> Self {
        let leader_id = leader.id.clone();
        let mut members = HashMap::new();
        members.insert(leader.id.clone(), GroupMember {
            device: leader,
            volume: 1.0,
            is_leader: true,
        });
        
        Self {
            id: Uuid::new_v4(),
            members,
            leader_id,
        }
    }

    /// Get group UUID.
    pub fn id(&self) -> Uuid {
        self.id
    }

    /// Add device to group.
    pub fn add_member(&mut self, device: Device) -> Result<()> {
        let device_id = device.id.clone();

        // Don't allow adding duplicate members
        if self.members.contains_key(&device_id) {
            return Ok(()); // Already a member
        }

        self.members.insert(device_id, GroupMember {
            device,
            volume: 1.0,
            is_leader: false,
        });

        Ok(())
    }

    /// Remove device from group.
    pub fn remove_member(&mut self, id: &DeviceId) -> Result<()> {
        // Cannot remove the leader
        if id == &self.leader_id {
            return Err(airplay_core::error::RtspError::SetupFailed(
                "Cannot remove group leader".to_string()
            ).into());
        }

        self.members.remove(id);
        Ok(())
    }

    /// Get group members.
    pub fn members(&self) -> impl Iterator<Item = &GroupMember> {
        self.members.values()
    }

    /// Get member count.
    pub fn member_count(&self) -> usize {
        self.members.len()
    }

    /// Get leader device.
    pub fn leader(&self) -> &GroupMember {
        &self.members[&self.leader_id]
    }

    /// Set member volume.
    pub fn set_member_volume(&mut self, id: &DeviceId, volume: f32) -> Result<()> {
        if let Some(member) = self.members.get_mut(id) {
            // Clamp volume to valid range
            member.volume = volume.clamp(0.0, 1.0);
            Ok(())
        } else {
            Err(airplay_core::error::DiscoveryError::DeviceNotFound(
                id.to_mac_string()
            ).into())
        }
    }

    /// Get addresses for SETPEERS command.
    pub fn peer_addresses(&self) -> Vec<String> {
        self.members
            .values()
            .flat_map(|member| {
                member.device.addresses.iter()
                    .filter(|addr| {
                        // Exclude IPv6 link-local addresses (fe80::)
                        match addr {
                            std::net::IpAddr::V6(v6) => {
                                // Link-local addresses start with fe80::
                                let segments = v6.segments();
                                segments[0] != 0xfe80
                            }
                            std::net::IpAddr::V4(_) => true,
                        }
                    })
                    .map(|addr| addr.to_string())
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use airplay_core::features::Features;
    use airplay_core::device::Version;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    fn make_test_device(mac: [u8; 6], name: &str) -> Device {
        Device {
            id: DeviceId(mac),
            name: name.to_string(),
            model: "AppleTV5,3".to_string(),
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

    mod group_creation {
        use super::*;

        #[test]
        fn new_creates_group_with_leader() {
            let device = make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Leader");
            let group = DeviceGroup::new(device.clone());

            assert_eq!(group.member_count(), 1);
            assert_eq!(group.leader().device.name, "Leader");
            assert!(group.leader().is_leader);
        }

        #[test]
        fn id_is_unique() {
            let device1 = make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Leader1");
            let device2 = make_test_device([0x11, 0x22, 0x33, 0x44, 0x55, 0x66], "Leader2");

            let group1 = DeviceGroup::new(device1);
            let group2 = DeviceGroup::new(device2);

            assert_ne!(group1.id(), group2.id());
        }
    }

    mod membership {
        use super::*;

        #[test]
        fn add_member_adds_device() {
            let leader = make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Leader");
            let member = make_test_device([0x11, 0x22, 0x33, 0x44, 0x55, 0x66], "Member");

            let mut group = DeviceGroup::new(leader);
            assert_eq!(group.member_count(), 1);

            group.add_member(member).unwrap();
            assert_eq!(group.member_count(), 2);
        }

        #[test]
        fn add_member_not_leader() {
            let leader = make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Leader");
            let member = make_test_device([0x11, 0x22, 0x33, 0x44, 0x55, 0x66], "Member");

            let mut group = DeviceGroup::new(leader);
            group.add_member(member.clone()).unwrap();

            // Find the member and verify it's not a leader
            for m in group.members() {
                if m.device.name == "Member" {
                    assert!(!m.is_leader);
                }
            }
        }

        #[test]
        fn remove_member_removes_device() {
            let leader = make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Leader");
            let member = make_test_device([0x11, 0x22, 0x33, 0x44, 0x55, 0x66], "Member");
            let member_id = member.id.clone();

            let mut group = DeviceGroup::new(leader);
            group.add_member(member).unwrap();
            assert_eq!(group.member_count(), 2);

            group.remove_member(&member_id).unwrap();
            assert_eq!(group.member_count(), 1);
        }

        #[test]
        fn cannot_remove_leader() {
            let leader = make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Leader");
            let leader_id = leader.id.clone();

            let mut group = DeviceGroup::new(leader);
            let result = group.remove_member(&leader_id);
            assert!(result.is_err());
        }

        #[test]
        fn member_count_tracks_size() {
            let leader = make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Leader");
            let member1 = make_test_device([0x11, 0x22, 0x33, 0x44, 0x55, 0x66], "Member1");
            let member2 = make_test_device([0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC], "Member2");

            let mut group = DeviceGroup::new(leader);
            assert_eq!(group.member_count(), 1);

            group.add_member(member1).unwrap();
            assert_eq!(group.member_count(), 2);

            group.add_member(member2).unwrap();
            assert_eq!(group.member_count(), 3);
        }
    }

    mod volume {
        use super::*;

        #[test]
        fn set_member_volume_updates() {
            let leader = make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Leader");
            let leader_id = leader.id.clone();

            let mut group = DeviceGroup::new(leader);
            group.set_member_volume(&leader_id, 0.5).unwrap();

            assert_eq!(group.leader().volume, 0.5);
        }

        #[test]
        fn volume_clamped_to_range() {
            let leader = make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Leader");
            let leader_id = leader.id.clone();

            let mut group = DeviceGroup::new(leader);

            // Test clamping above 1.0
            group.set_member_volume(&leader_id, 1.5).unwrap();
            assert_eq!(group.leader().volume, 1.0);

            // Test clamping below 0.0
            group.set_member_volume(&leader_id, -0.5).unwrap();
            assert_eq!(group.leader().volume, 0.0);
        }
    }

    mod peer_addresses {
        use super::*;

        #[test]
        fn returns_all_member_addresses() {
            let mut leader = make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Leader");
            leader.addresses = vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 100))];

            let mut member = make_test_device([0x11, 0x22, 0x33, 0x44, 0x55, 0x66], "Member");
            member.addresses = vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 101))];

            let mut group = DeviceGroup::new(leader);
            group.add_member(member).unwrap();

            let addresses = group.peer_addresses();
            assert_eq!(addresses.len(), 2);
            assert!(addresses.contains(&"192.168.1.100".to_string()));
            assert!(addresses.contains(&"192.168.1.101".to_string()));
        }

        #[test]
        fn excludes_ipv6_link_local() {
            let mut leader = make_test_device([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], "Leader");
            leader.addresses = vec![
                IpAddr::V4(Ipv4Addr::new(192, 168, 1, 100)),
                // Link-local IPv6 (fe80::)
                IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1)),
                // Global IPv6 (not link-local)
                IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1)),
            ];

            let group = DeviceGroup::new(leader);
            let addresses = group.peer_addresses();

            assert_eq!(addresses.len(), 2);
            assert!(addresses.contains(&"192.168.1.100".to_string()));
            assert!(addresses.contains(&"2001:db8::1".to_string()));
            // Link-local should be excluded
            assert!(!addresses.iter().any(|a| a.starts_with("fe80")));
        }
    }
}
