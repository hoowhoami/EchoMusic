use super::*;

impl SharedAudio {
    pub fn bind_signal_sender(&self, sender: SyncSender<PlaybackSignal>) {
        if let Ok(mut guard) = self.signal_tx.lock() {
            *guard = Some(sender);
        }
    }

    pub fn notify_signal(&self, signal: PlaybackSignal) {
        if let Ok(guard) = self.signal_tx.lock() {
            if let Some(sender) = guard.as_ref() {
                let _ = sender.try_send(signal);
            }
        }
    }

    pub fn update_packet_cache_stats(&self, stats: PacketCacheStats) {
        if let Ok(mut current) = self.packet_cache_stats.lock() {
            let changed = current.as_ref() != Some(&stats);
            *current = Some(stats.clone());
            if changed {
                self.notify_signal(PlaybackSignal::PacketCacheStats(stats));
            }
        }
    }

    pub fn packet_cache_stats(&self) -> Option<PacketCacheStats> {
        self.packet_cache_stats
            .try_lock()
            .ok()
            .and_then(|stats| stats.clone())
    }

    pub fn update_output_stats(&self, stats: AudioOutputStats) {
        if let Ok(mut current) = self.output_stats.lock() {
            let mut stats = stats;
            stats.underruns = self.output_underruns.load(Ordering::Acquire) as f64;
            self.output_delay_us.store(
                (stats.delay_secs.max(0.0) * 1_000_000.0).round() as u64,
                Ordering::Release,
            );
            self.live_output_delay_us.store(0, Ordering::Release);
            let changed = current.as_ref() != Some(&stats);
            *current = Some(stats.clone());
            if changed {
                self.notify_signal(PlaybackSignal::OutputStats(stats));
            }
        }
    }

    pub fn requested_output_buffer_secs(&self) -> f64 {
        self.requested_output_buffer_secs
    }

    pub fn output_stats(&self) -> Option<AudioOutputStats> {
        self.output_stats
            .try_lock()
            .ok()
            .and_then(|stats| stats.clone())
    }

    #[cfg(test)]
    pub fn output_underrun_count(&self) -> u64 {
        self.output_underruns.load(Ordering::Acquire)
    }

    pub(super) fn record_output_underrun(&self) {
        let underruns = self.output_underruns.fetch_add(1, Ordering::AcqRel) + 1;
        if let Ok(mut current) = self.output_stats.try_lock() {
            if let Some(stats) = current.as_mut() {
                stats.underruns = underruns as f64;
                self.notify_signal(PlaybackSignal::OutputStats(stats.clone()));
            }
        }
    }

    pub(super) fn reset_adaptive_buffering(&self) {
        self.output_underruns.store(0, Ordering::Release);
        self.ao_state.reset();
        self.decode_throughput_ratio_milli
            .store(0, Ordering::Release);
        if let Ok(mut current) = self.output_stats.try_lock() {
            if let Some(stats) = current.as_mut() {
                stats.underruns = 0.0;
                self.notify_signal(PlaybackSignal::OutputStats(stats.clone()));
            }
        }
    }
}
