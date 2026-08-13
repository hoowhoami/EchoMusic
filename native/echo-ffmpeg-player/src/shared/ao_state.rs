use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

const AO_STATE_INACTIVE_BUCKET: u32 = u32::MAX;
const AO_STATE_UNDERRUN_OFFSET: u32 = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AoBufferingReason {
    Preroll,
    Underrun,
}

impl AoBufferingReason {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Preroll => "preroll",
            Self::Underrun => "underrun",
        }
    }
}

pub(super) struct AoBufferingState {
    underrun: AtomicBool,
    preroll: AtomicBool,
    state_bucket: AtomicU32,
}

pub(super) struct AoBufferingMetrics {
    pub(super) queued_samples: usize,
    pub(super) requested_samples: usize,
    pub(super) target_samples: usize,
    pub(super) channels: usize,
    pub(super) sample_rate: u32,
}

pub(super) struct AoBufferingDecision {
    pub(super) hold: bool,
    pub(super) state: Option<AoBufferState>,
}

pub(super) struct AoBufferState {
    pub(super) paused: bool,
    pub(super) reason: AoBufferingReason,
    pub(super) buffering_state: f64,
    pub(super) buffered_secs: f64,
    pub(super) target_secs: f64,
}

impl AoBufferingState {
    pub(super) fn new() -> Self {
        Self {
            underrun: AtomicBool::new(false),
            preroll: AtomicBool::new(false),
            state_bucket: AtomicU32::new(AO_STATE_INACTIVE_BUCKET),
        }
    }

    pub(super) fn reset(&self) {
        self.underrun.store(false, Ordering::Release);
        self.preroll.store(false, Ordering::Release);
        self.state_bucket
            .store(AO_STATE_INACTIVE_BUCKET, Ordering::Release);
    }

    pub(super) fn begin_preroll(&self) {
        self.underrun.store(false, Ordering::Release);
        self.preroll.store(true, Ordering::Release);
        self.state_bucket
            .store(AO_STATE_INACTIVE_BUCKET, Ordering::Release);
    }

    pub(super) fn is_buffering(&self) -> bool {
        self.preroll.load(Ordering::Acquire) || self.underrun.load(Ordering::Acquire)
    }

    pub(super) fn ao_underrun(&self) -> bool {
        self.underrun.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(super) fn set_ao_underrun(&self, value: bool) {
        self.preroll.store(false, Ordering::Release);
        self.underrun.store(value, Ordering::Release);
    }

    pub(super) fn enter_output_underrun(
        &self,
        buffered_samples: usize,
        metrics: &AoBufferingMetrics,
    ) -> Option<AoBufferState> {
        self.preroll.store(false, Ordering::Release);
        self.underrun.store(true, Ordering::Release);
        self.state(true, AoBufferingReason::Underrun, buffered_samples, metrics)
    }

    pub(super) fn should_hold_for_buffering(
        &self,
        metrics: AoBufferingMetrics,
    ) -> AoBufferingDecision {
        if metrics.requested_samples == 0 {
            self.reset();
            return AoBufferingDecision {
                hold: false,
                state: None,
            };
        }

        let reason = if self.preroll.load(Ordering::Acquire) {
            Some(AoBufferingReason::Preroll)
        } else if self.underrun.load(Ordering::Acquire) {
            Some(AoBufferingReason::Underrun)
        } else {
            None
        };
        let Some(reason) = reason else {
            return AoBufferingDecision {
                hold: false,
                state: None,
            };
        };

        let target_samples = metrics.target_samples.max(metrics.requested_samples).max(1);
        if metrics.queued_samples < target_samples {
            return AoBufferingDecision {
                hold: true,
                state: self.state(true, reason, metrics.queued_samples, &metrics),
            };
        }

        self.preroll.store(false, Ordering::Release);
        self.underrun.store(false, Ordering::Release);
        AoBufferingDecision {
            hold: false,
            state: self.state(false, reason, metrics.queued_samples, &metrics),
        }
    }

    pub(super) fn state(
        &self,
        paused: bool,
        reason: AoBufferingReason,
        buffered_samples: usize,
        metrics: &AoBufferingMetrics,
    ) -> Option<AoBufferState> {
        let channels = metrics.channels.max(1);
        let sample_rate = metrics.sample_rate.max(1) as f64;
        let target_samples = metrics.target_samples.max(metrics.requested_samples).max(1);
        let percent = ((buffered_samples as f64 / target_samples as f64) * 100.0).clamp(0.0, 100.0);
        let bucket = if paused {
            let progress_bucket = ((percent / 5.0).floor() as u32).min(20);
            match reason {
                AoBufferingReason::Preroll => progress_bucket,
                AoBufferingReason::Underrun => AO_STATE_UNDERRUN_OFFSET + progress_bucket,
            }
        } else {
            AO_STATE_INACTIVE_BUCKET
        };
        let previous = self.state_bucket.swap(bucket, Ordering::AcqRel);
        if previous == bucket {
            return None;
        }
        Some(AoBufferState {
            paused,
            reason,
            buffering_state: if paused { percent } else { 100.0 },
            buffered_secs: buffered_samples as f64 / channels as f64 / sample_rate,
            target_secs: target_samples as f64 / channels as f64 / sample_rate,
        })
    }
}
