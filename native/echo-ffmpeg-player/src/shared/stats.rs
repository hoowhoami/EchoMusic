use super::*;

impl SharedAudio {
    pub fn bind_signal_senders(
        &self,
        control_sender: SyncSender<()>,
        telemetry_sender: SyncSender<PlaybackSignal>,
    ) -> Result<(), &'static str> {
        self.control_signal_tx
            .set(control_sender)
            .map_err(|_| "playback signal sender is already bound")?;
        self.telemetry_signal_tx
            .set(telemetry_sender)
            .map_err(|_| "playback signal sender is already bound")
    }

    pub fn notify_playback_restart(&self, position_secs: f64) {
        self.pending_playback_restart_bits
            .store(position_secs.to_bits(), Ordering::Release);
        self.wake_control_signal();
    }

    pub fn notify_ao_state(
        &self,
        paused: bool,
        reason: &'static str,
        buffering_state: f64,
        buffered_secs: f64,
        target_secs: f64,
    ) {
        // The filter producer and output callback can both publish. Claim the
        // stable even sequence before touching the snapshot; a competing writer
        // drops its coalescible update instead of exposing an even sequence while
        // either publisher is still replacing fields.
        let sequence = self.pending_ao_state_sequence.load(Ordering::Acquire);
        if sequence & 1 != 0
            || self
                .pending_ao_state_sequence
                .compare_exchange(
                    sequence,
                    sequence.wrapping_add(1),
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_err()
        {
            return;
        }
        self.pending_ao_state_paused
            .store(paused, Ordering::Relaxed);
        self.pending_ao_state_reason_is_underrun
            .store(reason == "underrun", Ordering::Relaxed);
        self.pending_ao_state_buffering_state_bits
            .store(buffering_state.to_bits(), Ordering::Relaxed);
        self.pending_ao_state_buffered_secs_bits
            .store(buffered_secs.to_bits(), Ordering::Relaxed);
        self.pending_ao_state_target_secs_bits
            .store(target_secs.to_bits(), Ordering::Relaxed);
        self.pending_ao_state_sequence
            .store(sequence.wrapping_add(2), Ordering::Release);
        self.wake_control_signal();
    }

    pub fn notify_playback_end(&self) {
        self.pending_playback_end.store(true, Ordering::Release);
        self.wake_control_signal();
    }

    pub(super) fn wake_control_signal(&self) {
        if let Some(sender) = self.control_signal_tx.get() {
            // A full wake channel means the consumer is already scheduled. All semantic
            // state lives in pending fields, so coalescing this token cannot lose an event.
            let _ = sender.try_send(());
        }
    }

    pub fn take_pending_control_signal(&self) -> Option<PlaybackSignal> {
        if self.stop.load(Ordering::Acquire) {
            return Some(PlaybackSignal::Stop);
        }

        let mut pending_track_switch = match self.pending_track_switch.lock() {
            Ok(pending) => pending,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(info) = pending_track_switch.take() {
            return Some(PlaybackSignal::TrackSwitch(info));
        }
        drop(pending_track_switch);

        let position_bits = self
            .pending_playback_restart_bits
            .swap(f64::NAN.to_bits(), Ordering::AcqRel);
        let position = f64::from_bits(position_bits);
        if position.is_finite() {
            return Some(PlaybackSignal::PlaybackRestart(position));
        }

        if let Some(signal) = self.take_pending_ao_state() {
            return Some(signal);
        }

        self.pending_playback_end
            .swap(false, Ordering::AcqRel)
            .then_some(PlaybackSignal::PlaybackEnd)
    }

    fn take_pending_ao_state(&self) -> Option<PlaybackSignal> {
        let sequence = self.pending_ao_state_sequence.load(Ordering::Acquire);
        if sequence & 1 != 0 || sequence == self.consumed_ao_state_sequence.load(Ordering::Acquire)
        {
            return None;
        }
        let paused = self.pending_ao_state_paused.load(Ordering::Relaxed);
        let reason = if self
            .pending_ao_state_reason_is_underrun
            .load(Ordering::Relaxed)
        {
            "underrun"
        } else {
            "preroll"
        };
        let buffering_state = f64::from_bits(
            self.pending_ao_state_buffering_state_bits
                .load(Ordering::Relaxed),
        );
        let buffered_secs = f64::from_bits(
            self.pending_ao_state_buffered_secs_bits
                .load(Ordering::Relaxed),
        );
        let target_secs = f64::from_bits(
            self.pending_ao_state_target_secs_bits
                .load(Ordering::Relaxed),
        );
        if self.pending_ao_state_sequence.load(Ordering::Acquire) != sequence {
            return None;
        }
        self.consumed_ao_state_sequence
            .store(sequence, Ordering::Release);
        Some(PlaybackSignal::AoState {
            paused,
            reason,
            buffering_state,
            buffered_secs,
            target_secs,
        })
    }

    fn notify_telemetry(&self, signal: PlaybackSignal) {
        if let Some(sender) = self.telemetry_signal_tx.get() {
            let _ = sender.try_send(signal);
        }
    }

    pub fn update_packet_cache_stats(&self, stats: PacketCacheStats) {
        if let Ok(mut current) = self.packet_cache_stats.lock() {
            let changed = current.as_ref() != Some(&stats);
            *current = Some(stats.clone());
            if changed {
                self.notify_telemetry(PlaybackSignal::PacketCacheStats(stats));
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
                self.notify_telemetry(PlaybackSignal::OutputStats(stats));
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
            .map(|mut stats| {
                stats.underruns = self.output_underruns.load(Ordering::Acquire) as f64;
                stats
            })
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
        let underruns = self.output_underruns.load(Ordering::Acquire) as f64;
        if stats.ao_buffer_target_secs == target_secs
            && stats.ao_request_frames == ao_request_frames
            && stats.underruns == underruns
        {
            return;
        }
        stats.underruns = underruns;
        stats.ao_buffer_target_secs = target_secs;
        stats.ao_request_frames = ao_request_frames;
        stats.software_buffer_secs = (target_secs - stats.device_buffer_secs).max(0.0);
        stats.delay_secs = target_secs.max(stats.device_buffer_secs);
        self.output_delay_us.store(
            (stats.delay_secs * 1_000_000.0).round() as u64,
            Ordering::Release,
        );
        self.notify_telemetry(PlaybackSignal::OutputStats(stats.clone()));
    }

    #[cfg(test)]
    pub fn output_underrun_count(&self) -> u64 {
        self.output_underruns.load(Ordering::Acquire)
    }

    pub(super) fn record_output_underrun(&self) {
        self.output_underruns.fetch_add(1, Ordering::AcqRel);
        self.notify_telemetry(PlaybackSignal::OutputStatsChanged);
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
            }
        }
        self.notify_telemetry(PlaybackSignal::OutputStatsChanged);
    }
}
