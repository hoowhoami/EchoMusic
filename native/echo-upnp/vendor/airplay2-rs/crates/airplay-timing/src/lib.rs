//! # airplay-timing
//!
//! PTP and NTP timing synchronization for AirPlay 2.
//!
//! This crate provides:
//! - NTP-like timing for AirPlay 1 devices
//! - PTP (IEEE 1588) timing for AirPlay 2 multi-room
//! - BMCA yield flow (Mac-style gPTP: negotiate, yield master to HomePod, sync as slave)
//! - Clock offset calculation
//! - RTP timestamp correlation

mod ntp;
mod ptp;
mod clock;
mod traits;

pub use ntp::{NtpTimingClient, NtpTimingServer};
pub use ptp::{PtpClient, PtpMaster, PTP_EVENT_PORT, PTP_GENERAL_PORT, send_ptp_sync, send_ptp_announce, send_ptp_signaling, send_mac_style_signaling, send_stop_signaling, run_ptp_slave, run_bmca_yield_flow, run_ptp_group_master_flow};
pub use clock::{Clock, TimestampPair, ClockOffset, NTP_EPOCH_OFFSET, unix_to_ntp, ntp_to_unix, samples_to_ns, ns_to_samples};
pub use traits::TimingProtocol;
