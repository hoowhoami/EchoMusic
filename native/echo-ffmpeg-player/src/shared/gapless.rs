use super::*;

pub(super) struct GaplessBoundary {
    pub(super) remaining_samples: usize,
    pub(super) info: TrackSwitchInfo,
}

#[derive(Default)]
pub(super) struct GaplessPrepareState {
    epoch: u64,
    pending: usize,
}

impl SharedAudio {
    pub fn begin_gapless_prepare(&self) -> u64 {
        let Ok(mut state) = self.gapless_prepare.lock() else {
            return 0;
        };
        state.epoch = state.epoch.wrapping_add(1).max(1);
        state.pending = 1;
        let epoch = state.epoch;
        self.gapless_prepare_changed.notify_all();
        epoch
    }

    pub fn finish_gapless_prepare(&self, epoch: u64) {
        if let Ok(mut state) = self.gapless_prepare.lock() {
            if state.epoch == epoch {
                state.pending = state.pending.saturating_sub(1);
            }
        }
        self.gapless_prepare_changed.notify_all();
    }

    pub fn gapless_prepare_is_pending(&self) -> bool {
        self.gapless_prepare
            .lock()
            .is_ok_and(|state| state.pending > 0)
    }

    pub fn pending_gapless_prepare_request(&self) -> Option<u64> {
        self.gapless_prepare
            .lock()
            .ok()
            .and_then(|state| (state.pending > 0 && state.epoch != 0).then_some(state.epoch))
    }

    pub fn gapless_prepare_request_is_current(&self, request_id: u64) -> bool {
        request_id != 0
            && self
                .gapless_prepare
                .lock()
                .is_ok_and(|state| state.epoch == request_id && state.pending > 0)
    }

    pub fn cancel_gapless_prepare(&self, request_id: u64) -> bool {
        let Ok(mut state) = self.gapless_prepare.lock() else {
            return false;
        };
        if request_id == 0 || state.epoch != request_id || state.pending == 0 {
            return false;
        }
        state.pending = 0;
        self.gapless_prepare_changed.notify_all();
        true
    }

    pub fn clear_gapless_prepares(&self) {
        if let Ok(mut state) = self.gapless_prepare.lock() {
            state.epoch = state.epoch.wrapping_add(1);
            state.pending = 0;
        }
        self.gapless_prepare_changed.notify_all();
    }

    pub fn wait_for_gapless_prepare_change(&self, request_id: u64) {
        let Ok(guard) = self.gapless_prepare.lock() else {
            return;
        };
        if guard.epoch != request_id || guard.pending == 0 {
            return;
        }
        let _guard = self.gapless_prepare_changed.wait(guard);
    }

    pub fn mark_gapless_boundary(&self, info: TrackSwitchInfo) {
        let output_samples = self.realtime_output.buffered_samples();
        let decoded_samples = self
            .decoded_queue
            .lock()
            .map(|mut queue| {
                let samples = (((queue.estimated_mix_frames * self.mix_format.channels.max(1))
                    as f64)
                    / self.speed().max(0.001) as f64)
                    .round() as usize;
                queue.push_boundary();
                samples
            })
            .unwrap_or_default();
        if let Ok(mut boundary) = self.gapless_boundary.lock() {
            *boundary = Some(GaplessBoundary {
                remaining_samples: output_samples.saturating_add(decoded_samples),
                info,
            });
        }
        self.eof.store(false, Ordering::Release);
        self.end_reported.store(false, Ordering::Release);
        self.ao_state.reset();
        self.output_queue_changed.notify_all();
        self.decoded_queue_changed.notify_all();
    }
}
