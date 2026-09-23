//! Clock utilities and timestamp management.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// NTP epoch: January 1, 1900 (seconds from 1900 to 1970).
pub const NTP_EPOCH_OFFSET: u64 = 2_208_988_800;

/// Paired RTP and wall-clock timestamps.
#[derive(Debug, Clone, Copy)]
pub struct TimestampPair {
    /// RTP timestamp (in samples).
    pub rtp: u32,
    /// Wall-clock time in nanoseconds since Unix epoch.
    pub wall_ns: u64,
}

/// Clock offset between local and remote.
#[derive(Debug, Clone, Copy, Default)]
pub struct ClockOffset {
    /// Offset in nanoseconds (positive = remote ahead).
    pub offset_ns: i64,
    /// Estimated error in nanoseconds.
    pub error_ns: u64,
    /// Round-trip time in nanoseconds.
    pub rtt_ns: u64,
}

/// High-resolution clock interface.
pub struct Clock {
    /// Instant at construction for monotonic time.
    start_instant: Instant,
    /// System time at construction for wall-clock correlation.
    start_system: SystemTime,
    /// Sample rate for RTP timestamp conversion.
    sample_rate: u32,
}

impl Clock {
    /// Create new clock with sample rate.
    pub fn new(sample_rate: u32) -> Self {
        Self {
            start_instant: Instant::now(),
            start_system: SystemTime::now(),
            sample_rate,
        }
    }

    /// Get current monotonic time in nanoseconds since start.
    pub fn now_mono_ns(&self) -> u64 {
        self.start_instant.elapsed().as_nanos() as u64
    }

    /// Get current wall-clock time in nanoseconds since Unix epoch.
    pub fn now_wall_ns(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_nanos() as u64
    }

    /// Get current time as NTP timestamp (64-bit: 32-bit seconds + 32-bit fraction).
    pub fn now_ntp(&self) -> u64 {
        unix_to_ntp(self.now_wall_ns())
    }

    /// Convert wall-clock nanoseconds to RTP timestamp.
    pub fn wall_to_rtp(&self, wall_ns: u64) -> u32 {
        let start_ns = self.start_system
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_nanos() as u64;
        let elapsed_ns = wall_ns.saturating_sub(start_ns);
        ns_to_samples(elapsed_ns, self.sample_rate)
    }

    /// Convert RTP timestamp to wall-clock nanoseconds.
    pub fn rtp_to_wall(&self, rtp: u32) -> u64 {
        let start_ns = self.start_system
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_nanos() as u64;
        let elapsed_ns = samples_to_ns(rtp, self.sample_rate);
        start_ns + elapsed_ns
    }

    /// Create timestamp pair for current time.
    pub fn timestamp_pair(&self) -> TimestampPair {
        let wall_ns = self.now_wall_ns();
        TimestampPair {
            rtp: self.wall_to_rtp(wall_ns),
            wall_ns,
        }
    }

    /// Apply clock offset to get remote time.
    pub fn apply_offset(&self, local_ns: u64, offset: &ClockOffset) -> u64 {
        (local_ns as i64 + offset.offset_ns) as u64
    }

    /// Convert samples to nanoseconds.
    pub fn samples_to_ns(&self, samples: u32) -> u64 {
        samples_to_ns(samples, self.sample_rate)
    }

    /// Convert nanoseconds to samples.
    pub fn ns_to_samples(&self, ns: u64) -> u32 {
        ns_to_samples(ns, self.sample_rate)
    }

    /// Get the sample rate.
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

// Conversion helpers

/// Convert samples to nanoseconds at given sample rate.
pub fn samples_to_ns(samples: u32, sample_rate: u32) -> u64 {
    (samples as u64 * 1_000_000_000) / sample_rate as u64
}

/// Convert nanoseconds to samples at given sample rate.
pub fn ns_to_samples(ns: u64, sample_rate: u32) -> u32 {
    ((ns as u128 * sample_rate as u128) / 1_000_000_000) as u32
}

/// Convert Unix nanoseconds to NTP timestamp (64-bit: 32-bit seconds + 32-bit fraction).
pub fn unix_to_ntp(unix_ns: u64) -> u64 {
    let unix_secs = unix_ns / 1_000_000_000;
    let frac_ns = unix_ns % 1_000_000_000;

    let ntp_secs = unix_secs + NTP_EPOCH_OFFSET;
    // Convert fractional nanoseconds to NTP fraction (32-bit)
    // frac_ntp = frac_ns * 2^32 / 10^9
    let ntp_frac = ((frac_ns as u128) << 32) / 1_000_000_000;

    (ntp_secs << 32) | (ntp_frac as u64)
}

/// Convert NTP timestamp to Unix nanoseconds.
pub fn ntp_to_unix(ntp: u64) -> u64 {
    let ntp_secs = ntp >> 32;
    let ntp_frac = ntp & 0xFFFFFFFF;

    let unix_secs = ntp_secs.saturating_sub(NTP_EPOCH_OFFSET);
    // Convert NTP fraction to nanoseconds
    // frac_ns = ntp_frac * 10^9 / 2^32
    let frac_ns = ((ntp_frac as u128) * 1_000_000_000) >> 32;

    unix_secs * 1_000_000_000 + frac_ns as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    mod timestamp_pair {
        use super::*;

        #[test]
        fn stores_rtp_and_wall() {
            let pair = TimestampPair {
                rtp: 44100,
                wall_ns: 1_000_000_000,
            };
            assert_eq!(pair.rtp, 44100);
            assert_eq!(pair.wall_ns, 1_000_000_000);
        }
    }

    mod clock_offset {
        use super::*;

        #[test]
        fn default_is_zero() {
            let offset = ClockOffset::default();
            assert_eq!(offset.offset_ns, 0);
            assert_eq!(offset.error_ns, 0);
            assert_eq!(offset.rtt_ns, 0);
        }
    }

    mod clock {
        use super::*;
        use std::thread;
        use std::time::Duration;

        #[test]
        fn new_captures_start_time() {
            let clock = Clock::new(44100);
            // Immediately after creation, monotonic time should be very small
            assert!(clock.now_mono_ns() < 1_000_000_000); // Less than 1 second
        }

        #[test]
        fn now_mono_ns_increases() {
            let clock = Clock::new(44100);
            let t1 = clock.now_mono_ns();
            thread::sleep(Duration::from_millis(10));
            let t2 = clock.now_mono_ns();
            assert!(t2 > t1);
            // Should have elapsed at least 10ms (10_000_000 ns)
            assert!(t2 - t1 >= 9_000_000); // Allow some tolerance
        }

        #[test]
        fn now_wall_ns_reasonable() {
            let clock = Clock::new(44100);
            let wall = clock.now_wall_ns();
            // Should be after year 2020: Jan 1 2020 = ~1577836800 seconds
            let jan_2020_ns = 1_577_836_800_000_000_000u64;
            assert!(wall > jan_2020_ns);
            // Should be before year 2100
            let jan_2100_ns = 4_102_444_800_000_000_000u64;
            assert!(wall < jan_2100_ns);
        }

        #[test]
        fn wall_to_rtp_at_44100() {
            let clock = Clock::new(44100);
            let start_ns = clock.start_system
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos() as u64;
            // 1 second after start should be 44100 samples
            let wall_ns = start_ns + 1_000_000_000;
            let rtp = clock.wall_to_rtp(wall_ns);
            assert_eq!(rtp, 44100);
        }

        #[test]
        fn wall_to_rtp_at_48000() {
            let clock = Clock::new(48000);
            let start_ns = clock.start_system
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos() as u64;
            // 1 second after start should be 48000 samples
            let wall_ns = start_ns + 1_000_000_000;
            let rtp = clock.wall_to_rtp(wall_ns);
            assert_eq!(rtp, 48000);
        }

        #[test]
        fn rtp_to_wall_at_44100() {
            let clock = Clock::new(44100);
            let start_ns = clock.start_system
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos() as u64;
            // 44100 samples should be 1 second
            let wall_ns = clock.rtp_to_wall(44100);
            assert_eq!(wall_ns, start_ns + 1_000_000_000);
        }

        #[test]
        fn rtp_to_wall_at_48000() {
            let clock = Clock::new(48000);
            let start_ns = clock.start_system
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos() as u64;
            // 48000 samples should be 1 second
            let wall_ns = clock.rtp_to_wall(48000);
            assert_eq!(wall_ns, start_ns + 1_000_000_000);
        }

        #[test]
        fn wall_rtp_roundtrip() {
            let clock = Clock::new(44100);
            let start_ns = clock.start_system
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos() as u64;

            // Test several values
            for offset_ms in [0, 100, 500, 1000, 5000] {
                let original_wall = start_ns + (offset_ms * 1_000_000);
                let rtp = clock.wall_to_rtp(original_wall);
                let recovered_wall = clock.rtp_to_wall(rtp);
                // Allow small rounding error (less than 1ms)
                let diff = if recovered_wall > original_wall {
                    recovered_wall - original_wall
                } else {
                    original_wall - recovered_wall
                };
                assert!(diff < 1_000_000, "Roundtrip error {} ns for offset {}ms", diff, offset_ms);
            }
        }

        #[test]
        fn timestamp_pair_consistent() {
            let clock = Clock::new(44100);
            thread::sleep(Duration::from_millis(50));
            let pair = clock.timestamp_pair();

            // RTP should correspond to wall time
            let expected_rtp = clock.wall_to_rtp(pair.wall_ns);
            assert_eq!(pair.rtp, expected_rtp);
        }

        #[test]
        fn apply_offset_positive() {
            let clock = Clock::new(44100);
            let offset = ClockOffset {
                offset_ns: 1_000_000_000, // +1 second
                error_ns: 0,
                rtt_ns: 0,
            };
            let local = 5_000_000_000u64;
            let remote = clock.apply_offset(local, &offset);
            assert_eq!(remote, 6_000_000_000);
        }

        #[test]
        fn apply_offset_negative() {
            let clock = Clock::new(44100);
            let offset = ClockOffset {
                offset_ns: -1_000_000_000, // -1 second
                error_ns: 0,
                rtt_ns: 0,
            };
            let local = 5_000_000_000u64;
            let remote = clock.apply_offset(local, &offset);
            assert_eq!(remote, 4_000_000_000);
        }

        #[test]
        fn samples_to_ns_at_44100() {
            let clock = Clock::new(44100);
            // 44100 samples = 1 second = 1e9 ns
            assert_eq!(clock.samples_to_ns(44100), 1_000_000_000);
            // 352 samples (one ALAC frame) = 352/44100 seconds ≈ 7.98ms
            let ns = clock.samples_to_ns(352);
            assert!(ns > 7_900_000 && ns < 8_100_000);
        }

        #[test]
        fn ns_to_samples_at_44100() {
            let clock = Clock::new(44100);
            // 1 second = 44100 samples
            assert_eq!(clock.ns_to_samples(1_000_000_000), 44100);
            // 100ms = 4410 samples
            assert_eq!(clock.ns_to_samples(100_000_000), 4410);
        }

        #[test]
        fn samples_ns_roundtrip() {
            let clock = Clock::new(44100);
            // Only test exact divisors or values that don't have rounding errors
            // 44100 and 88200 are exact (1 second and 2 seconds)
            for samples in [0, 44100, 88200] {
                let ns = clock.samples_to_ns(samples);
                let recovered = clock.ns_to_samples(ns);
                assert_eq!(recovered, samples, "Roundtrip failed for {} samples", samples);
            }

            // For non-exact values, allow rounding error of 1 sample
            for samples in [352, 1024] {
                let ns = clock.samples_to_ns(samples);
                let recovered = clock.ns_to_samples(ns);
                let diff = (recovered as i64 - samples as i64).abs();
                assert!(diff <= 1, "Roundtrip error {} for {} samples", diff, samples);
            }
        }
    }

    mod ntp_conversion {
        use super::*;

        #[test]
        fn ntp_epoch_offset_correct() {
            // NTP epoch is Jan 1, 1900; Unix epoch is Jan 1, 1970
            // 70 years = 2208988800 seconds
            assert_eq!(NTP_EPOCH_OFFSET, 2_208_988_800);
        }

        #[test]
        fn unix_to_ntp_zero() {
            // Unix time 0 (Jan 1, 1970) = NTP time 2208988800
            let ntp = unix_to_ntp(0);
            let ntp_secs = ntp >> 32;
            assert_eq!(ntp_secs, NTP_EPOCH_OFFSET);
        }

        #[test]
        fn unix_to_ntp_one_second() {
            // 1 second after Unix epoch
            let ntp = unix_to_ntp(1_000_000_000);
            let ntp_secs = ntp >> 32;
            assert_eq!(ntp_secs, NTP_EPOCH_OFFSET + 1);
        }

        #[test]
        fn unix_to_ntp_fraction() {
            // 0.5 seconds (500ms)
            let ntp = unix_to_ntp(500_000_000);
            let ntp_secs = ntp >> 32;
            let ntp_frac = ntp & 0xFFFFFFFF;
            assert_eq!(ntp_secs, NTP_EPOCH_OFFSET);
            // 0.5 in NTP fraction = 2^31 = 2147483648
            assert!((ntp_frac as i64 - 0x80000000i64).abs() < 10);
        }

        #[test]
        fn ntp_to_unix_zero() {
            // NTP time at Unix epoch
            let ntp = (NTP_EPOCH_OFFSET as u64) << 32;
            let unix = ntp_to_unix(ntp);
            assert_eq!(unix, 0);
        }

        #[test]
        fn ntp_to_unix_one_second() {
            // 1 second after Unix epoch in NTP
            let ntp = ((NTP_EPOCH_OFFSET + 1) as u64) << 32;
            let unix = ntp_to_unix(ntp);
            assert_eq!(unix, 1_000_000_000);
        }

        #[test]
        fn ntp_to_unix_fraction() {
            // 0.5 seconds
            let ntp = ((NTP_EPOCH_OFFSET as u64) << 32) | 0x80000000u64;
            let unix = ntp_to_unix(ntp);
            // Should be approximately 500ms
            assert!(unix > 499_000_000 && unix < 501_000_000);
        }

        #[test]
        fn ntp_roundtrip() {
            for unix_ns in [0u64, 1_000_000_000, 500_000_000, 1_234_567_890_123_456_789] {
                let ntp = unix_to_ntp(unix_ns);
                let recovered = ntp_to_unix(ntp);
                // Allow small rounding error due to fraction conversion
                let diff = if recovered > unix_ns {
                    recovered - unix_ns
                } else {
                    unix_ns - recovered
                };
                assert!(diff < 2, "Roundtrip error {} for unix_ns {}", diff, unix_ns);
            }
        }

        #[test]
        fn ntp_before_unix_epoch() {
            // NTP time before Unix epoch should saturate to 0
            let ntp = (NTP_EPOCH_OFFSET - 1) << 32; // 1 second before Unix epoch
            let unix = ntp_to_unix(ntp);
            // This should underflow protection kick in
            assert_eq!(unix, 0);
        }
    }

    mod free_functions {
        use super::*;

        #[test]
        fn samples_to_ns_44100() {
            assert_eq!(samples_to_ns(44100, 44100), 1_000_000_000);
            assert_eq!(samples_to_ns(0, 44100), 0);
        }

        #[test]
        fn samples_to_ns_48000() {
            assert_eq!(samples_to_ns(48000, 48000), 1_000_000_000);
        }

        #[test]
        fn ns_to_samples_44100() {
            assert_eq!(ns_to_samples(1_000_000_000, 44100), 44100);
            assert_eq!(ns_to_samples(0, 44100), 0);
        }

        #[test]
        fn ns_to_samples_48000() {
            assert_eq!(ns_to_samples(1_000_000_000, 48000), 48000);
        }
    }
}
