//! Stream statistics for monitoring packet loss and retransmit activity.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Per-device streaming statistics (lock-free atomics).
#[derive(Debug)]
pub struct DeviceStreamStats {
    /// Retransmit requests received from this device.
    pub rtx_requested: AtomicU64,
    /// Packets successfully retransmitted to this device.
    pub rtx_fulfilled: AtomicU64,
}

impl DeviceStreamStats {
    fn new() -> Self {
        Self {
            rtx_requested: AtomicU64::new(0),
            rtx_fulfilled: AtomicU64::new(0),
        }
    }

    fn snapshot(&self) -> DeviceStatsSnapshot {
        DeviceStatsSnapshot {
            rtx_requested: self.rtx_requested.load(Ordering::Relaxed),
            rtx_fulfilled: self.rtx_fulfilled.load(Ordering::Relaxed),
        }
    }
}

/// Live streaming statistics shared across sender and control threads.
///
/// All fields are atomic, so reads/writes are lock-free.
/// Clone the `Arc<StreamStats>` to share between threads.
#[derive(Debug)]
pub struct StreamStats {
    /// Total audio data packets sent (aggregate, same for all devices).
    pub packets_sent: AtomicU64,
    /// Total retransmit requests received (aggregate across all devices).
    pub rtx_requested: AtomicU64,
    /// Total packets successfully retransmitted (aggregate across all devices).
    pub rtx_fulfilled: AtomicU64,
    /// Per-device stats. Set once via `with_device_count()` before threads start.
    device_stats: Vec<DeviceStreamStats>,
}

impl StreamStats {
    /// Create a new zeroed stats instance (no per-device tracking).
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            packets_sent: AtomicU64::new(0),
            rtx_requested: AtomicU64::new(0),
            rtx_fulfilled: AtomicU64::new(0),
            device_stats: Vec::new(),
        })
    }

    /// Create a new stats instance with per-device tracking.
    pub fn with_device_count(count: usize) -> Arc<Self> {
        let mut device_stats = Vec::with_capacity(count);
        for _ in 0..count {
            device_stats.push(DeviceStreamStats::new());
        }
        Arc::new(Self {
            packets_sent: AtomicU64::new(0),
            rtx_requested: AtomicU64::new(0),
            rtx_fulfilled: AtomicU64::new(0),
            device_stats,
        })
    }

    /// Get per-device stats by index (if available).
    pub fn device(&self, index: usize) -> Option<&DeviceStreamStats> {
        self.device_stats.get(index)
    }

    /// Number of tracked devices.
    pub fn device_count(&self) -> usize {
        self.device_stats.len()
    }

    /// Reset all counters to zero.
    pub fn reset(&self) {
        self.packets_sent.store(0, Ordering::Relaxed);
        self.rtx_requested.store(0, Ordering::Relaxed);
        self.rtx_fulfilled.store(0, Ordering::Relaxed);
        for ds in &self.device_stats {
            ds.rtx_requested.store(0, Ordering::Relaxed);
            ds.rtx_fulfilled.store(0, Ordering::Relaxed);
        }
    }

    /// Get a snapshot of current stats.
    pub fn snapshot(&self) -> StatsSnapshot {
        StatsSnapshot {
            packets_sent: self.packets_sent.load(Ordering::Relaxed),
            rtx_requested: self.rtx_requested.load(Ordering::Relaxed),
            rtx_fulfilled: self.rtx_fulfilled.load(Ordering::Relaxed),
            underruns: 0, // Populated by client from streamer counter
            devices: self.device_stats.iter().map(|d| d.snapshot()).collect(),
        }
    }
}

/// Point-in-time snapshot of per-device statistics.
#[derive(Debug, Clone, Copy, Default)]
pub struct DeviceStatsSnapshot {
    pub rtx_requested: u64,
    pub rtx_fulfilled: u64,
}

/// Point-in-time snapshot of stream statistics.
#[derive(Debug, Clone, Default)]
pub struct StatsSnapshot {
    pub packets_sent: u64,
    pub rtx_requested: u64,
    pub rtx_fulfilled: u64,
    /// Buffer underruns (buffer empty when a packet was due to send).
    pub underruns: u64,
    /// Per-device stats (empty for single-device streaming).
    pub devices: Vec<DeviceStatsSnapshot>,
}

impl StatsSnapshot {
    /// Packet loss rate as a percentage (requested / sent * 100).
    pub fn loss_percent(&self) -> f64 {
        if self.packets_sent == 0 {
            0.0
        } else {
            (self.rtx_requested as f64 / self.packets_sent as f64) * 100.0
        }
    }

    /// Per-device loss rate as a percentage.
    pub fn device_loss_percent(&self, index: usize) -> f64 {
        if self.packets_sent == 0 {
            return 0.0;
        }
        if let Some(dev) = self.devices.get(index) {
            (dev.rtx_requested as f64 / self.packets_sent as f64) * 100.0
        } else {
            0.0
        }
    }
}
