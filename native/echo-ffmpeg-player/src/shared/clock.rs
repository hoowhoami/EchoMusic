use super::*;
use std::time::Duration;

impl SharedAudio {
    pub(super) fn notify_time_update_if_due(&self, current_samples: u64) {
        let interval = (self.mix_format.sample_rate as u64 / 5).max(1);
        let mut last = self.last_time_event_samples.load(Ordering::Acquire);
        loop {
            if current_samples.saturating_sub(last) < interval {
                return;
            }
            match self.last_time_event_samples.compare_exchange(
                last,
                current_samples,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    self.notify_signal(PlaybackSignal::TimeUpdate);
                    return;
                }
                Err(actual) => last = actual,
            }
        }
    }

    pub fn position_secs(&self) -> f64 {
        let raw = self.played_samples.load(Ordering::Acquire) as f64
            / self.mix_format.sample_rate.max(1) as f64;
        (raw - self.audible_clock_delay_secs()).max(0.0)
    }

    pub fn set_filter_latency_secs(&self, seconds: f64) {
        self.filter_latency_us.store(
            (seconds.max(0.0) * 1_000_000.0).round() as u64,
            Ordering::Release,
        );
    }

    pub fn set_position_secs(&self, position_secs: f64) {
        let raw_position_secs = position_secs.max(0.0) + self.audible_clock_delay_secs();
        let position_samples = (raw_position_secs * self.mix_format.sample_rate as f64) as u64;
        self.played_samples
            .store(position_samples, Ordering::Release);
        self.last_time_event_samples
            .store(position_samples, Ordering::Release);
    }

    pub fn update_live_output_delay_secs(&self, delay_secs: f64) {
        if !delay_secs.is_finite() {
            return;
        }
        let next = (delay_secs.clamp(0.0, 5.0) * 1_000_000.0).round() as u64;
        let previous = self.live_output_delay_us.load(Ordering::Acquire);
        let smoothed = if previous == 0 {
            next
        } else {
            ((previous as f64 * 0.8) + (next as f64 * 0.2)).round() as u64
        };
        self.live_output_delay_us
            .store(smoothed.max(1), Ordering::Release);
    }

    fn audible_clock_delay_secs(&self) -> f64 {
        let live_delay_us = self.live_output_delay_us.load(Ordering::Acquire);
        let delay_us = if live_delay_us > 0 {
            live_delay_us
        } else {
            self.output_delay_us.load(Ordering::Acquire)
        };
        let delay = delay_us as f64 / 1_000_000.0;
        let filter_latency = self.filter_latency_us.load(Ordering::Acquire) as f64 / 1_000_000.0;
        (delay + filter_latency) * f64::from(self.speed().max(0.001))
    }

    pub fn played_sample_count(&self) -> u64 {
        self.played_samples.load(Ordering::Acquire)
    }

    pub fn set_stall_timeout(&self, seconds: f64) {
        self.stall_timeout_ms
            .store(stall_timeout_millis(seconds), Ordering::Release);
    }

    pub fn set_speed(&self, speed: f32) {
        self.speed_bits.store(
            speed
                .clamp(crate::tempo::MIN_SPEED, crate::tempo::MAX_SPEED)
                .to_bits(),
            Ordering::Release,
        );
    }

    pub fn speed(&self) -> f32 {
        f32::from_bits(self.speed_bits.load(Ordering::Acquire))
            .clamp(crate::tempo::MIN_SPEED, crate::tempo::MAX_SPEED)
    }

    pub fn set_volume(&self, volume: f32) {
        self.volume_bits
            .store(volume.clamp(0.0, 1.5).to_bits(), Ordering::Release);
    }

    pub fn volume(&self) -> f32 {
        f32::from_bits(self.volume_bits.load(Ordering::Acquire)).clamp(0.0, 1.5)
    }

    pub fn normalization_gain(&self) -> f32 {
        let gain = f32::from_bits(self.normalization_gain_bits.load(Ordering::Acquire));
        if gain.is_finite() {
            gain.clamp(0.0, 16.0)
        } else {
            1.0
        }
    }

    pub fn stall_timeout(&self) -> Duration {
        Duration::from_millis(self.stall_timeout_ms.load(Ordering::Acquire))
    }

    pub fn should_watch_for_stall(&self) -> bool {
        self.output_started.load(Ordering::Acquire)
            && !self.paused.load(Ordering::Acquire)
            && !self.stop.load(Ordering::Acquire)
            && !self.eof.load(Ordering::Acquire)
            && !self.decode_failed.load(Ordering::Acquire)
            && !self.gapless_prepare_is_pending()
    }

    pub(super) fn source_frames_for_output(&self, output_samples: usize) -> u64 {
        let output_frames = output_samples / self.mix_format.channels.max(1);
        ((output_frames as f64) * self.speed() as f64).round() as u64
    }
}

pub(super) fn stall_timeout_millis(seconds: f64) -> u64 {
    if !seconds.is_finite() || seconds <= 0.0 {
        return 0;
    }
    (seconds.clamp(0.0, 60.0) * 1000.0).round() as u64
}
