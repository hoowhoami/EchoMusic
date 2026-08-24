use super::*;

impl SharedAudio {
    pub fn bind_signal_senders(
        &self,
        control_sender: Sender<PlaybackSignal>,
        telemetry_sender: SyncSender<PlaybackSignal>,
    ) -> Result<(), &'static str> {
        self.control_signal_tx
            .set(control_sender)
            .map_err(|_| "playback signal sender is already bound")?;
        self.telemetry_signal_tx
            .set(telemetry_sender)
            .map_err(|_| "playback signal sender is already bound")
    }

    pub fn notify_signal(&self, signal: PlaybackSignal) {
        if signal.is_control() {
            if let Some(sender) = self.control_signal_tx.get() {
                let _ = sender.send(signal);
            }
        } else if let Some(sender) = self.telemetry_signal_tx.get() {
            let _ = sender.try_send(signal);
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

    pub fn refresh_output_stats(&self) {
        let Ok(mut current) = self.output_stats.try_lock() else {
            return;
        };
        let Some(stats) = current.as_mut() else {
            return;
        };
        let target_secs = self.output_buffer_target_secs();
        let ao_request_frames = self.max_output_request_frames() as f64;
        if stats.ao_buffer_target_secs == target_secs
            && stats.ao_request_frames == ao_request_frames
        {
            return;
        }
        stats.ao_buffer_target_secs = target_secs;
        stats.ao_request_frames = ao_request_frames;
        stats.software_buffer_secs = (target_secs - stats.device_buffer_secs).max(0.0);
        stats.delay_secs = target_secs.max(stats.device_buffer_secs);
        self.output_delay_us.store(
            (stats.delay_secs * 1_000_000.0).round() as u64,
            Ordering::Release,
        );
        self.notify_signal(PlaybackSignal::OutputStats(stats.clone()));
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

    pub(super) fn reset_output_buffering_state(&self) {
        self.reset_adaptive_output_buffer_target();
        self.output_underruns.store(0, Ordering::Release);
        self.ao_state.reset();
        let target_secs = self.output_buffer_target_secs();
        if let Ok(mut current) = self.output_stats.try_lock() {
            if let Some(stats) = current.as_mut() {
                stats.underruns = 0.0;
                stats.ao_buffer_target_secs = target_secs;
                stats.ao_request_frames = 0.0;
                stats.software_buffer_secs = (target_secs - stats.device_buffer_secs).max(0.0);
                stats.delay_secs = target_secs.max(stats.device_buffer_secs);
                self.output_delay_us.store(
                    (stats.delay_secs * 1_000_000.0).round() as u64,
                    Ordering::Release,
                );
                self.notify_signal(PlaybackSignal::OutputStats(stats.clone()));
            }
        }
    }
}
