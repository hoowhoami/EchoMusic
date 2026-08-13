use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

const CACHE_STATE_INACTIVE_BUCKET: u32 = u32::MAX;

pub(super) struct AoBufferingState {
    cache_pause_wait_secs: f64,
    cache_pause: bool,
    ao_underrun: AtomicBool,
    resume_when_buffered: AtomicBool,
    cache_state_bucket: AtomicU32,
}

pub(super) struct AoBufferingMetrics {
    pub(super) queued_samples: usize,
    pub(super) decoded_samples: usize,
    pub(super) requested_samples: usize,
    pub(super) output_queue_capacity: usize,
    pub(super) decoded_queue_capacity_frames: usize,
    pub(super) channels: usize,
    pub(super) sample_rate: u32,
    pub(super) speed: f32,
    pub(super) output_underruns: u64,
    pub(super) decode_throughput_ratio_milli: u64,
}

pub(super) struct AoBufferingDecision {
    pub(super) hold: bool,
    pub(super) cache_state: Option<AoCacheState>,
}

pub(super) struct AoCacheState {
    pub(super) paused: bool,
    pub(super) buffering_state: f64,
    pub(super) buffered_secs: f64,
    pub(super) target_secs: f64,
}

impl AoBufferingState {
    pub(super) fn new(cache_pause: bool, cache_pause_wait_secs: f64) -> Self {
        Self {
            cache_pause_wait_secs: cache_pause_wait_secs.clamp(0.0, 3_600_000.0),
            cache_pause,
            ao_underrun: AtomicBool::new(false),
            resume_when_buffered: AtomicBool::new(false),
            cache_state_bucket: AtomicU32::new(CACHE_STATE_INACTIVE_BUCKET),
        }
    }

    pub(super) fn cache_pause_enabled(&self) -> bool {
        self.cache_pause
    }

    pub(super) fn reset(&self) {
        self.ao_underrun.store(false, Ordering::Release);
        self.resume_when_buffered.store(false, Ordering::Release);
    }

    pub(super) fn begin_resume_when_buffered(&self, enabled: bool) {
        self.resume_when_buffered
            .store(enabled && self.cache_pause, Ordering::Release);
    }

    pub(super) fn begin_filter_resume(&self) {
        self.resume_when_buffered
            .store(self.cache_pause, Ordering::Release);
    }

    pub(super) fn resume_when_buffered(&self) -> bool {
        self.resume_when_buffered.load(Ordering::Acquire)
    }

    pub(super) fn ao_underrun(&self) -> bool {
        self.ao_underrun.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(super) fn set_ao_underrun(&self, value: bool) {
        self.ao_underrun.store(value, Ordering::Release);
    }

    pub(super) fn enter_output_underrun(
        &self,
        buffered_samples: usize,
        requested_samples: usize,
        output_queue_capacity: usize,
        channels: usize,
        sample_rate: u32,
    ) -> Option<AoCacheState> {
        self.ao_underrun.store(true, Ordering::Release);
        self.cache_state(
            true,
            buffered_samples,
            self.output_underrun_resume_threshold(output_queue_capacity),
            requested_samples,
            channels,
            sample_rate,
        )
    }

    pub(super) fn should_hold_for_buffering(
        &self,
        metrics: AoBufferingMetrics,
    ) -> AoBufferingDecision {
        if metrics.requested_samples == 0 {
            self.reset();
            return AoBufferingDecision {
                hold: false,
                cache_state: None,
            };
        }

        if self.resume_when_buffered() {
            let resume_threshold = self.cache_pause_resume_threshold(&metrics);
            let total_buffered = metrics
                .queued_samples
                .saturating_add(metrics.decoded_samples);
            if total_buffered >= resume_threshold && self.output_queue_ready_for_resume(&metrics) {
                self.reset();
                return AoBufferingDecision {
                    hold: false,
                    cache_state: self.cache_state(
                        false,
                        total_buffered,
                        resume_threshold,
                        metrics.requested_samples,
                        metrics.channels,
                        metrics.sample_rate,
                    ),
                };
            }
            return AoBufferingDecision {
                hold: true,
                cache_state: self.cache_state(
                    true,
                    total_buffered,
                    resume_threshold,
                    metrics.requested_samples,
                    metrics.channels,
                    metrics.sample_rate,
                ),
            };
        }

        if self.ao_underrun() {
            let resume_threshold =
                self.output_underrun_resume_threshold(metrics.output_queue_capacity);
            if metrics.queued_samples < resume_threshold {
                return AoBufferingDecision {
                    hold: true,
                    cache_state: self.cache_state(
                        true,
                        metrics.queued_samples,
                        resume_threshold,
                        metrics.requested_samples,
                        metrics.channels,
                        metrics.sample_rate,
                    ),
                };
            }
            self.ao_underrun.store(false, Ordering::Release);
            return AoBufferingDecision {
                hold: false,
                cache_state: self.cache_state(
                    false,
                    metrics.queued_samples,
                    resume_threshold,
                    metrics.requested_samples,
                    metrics.channels,
                    metrics.sample_rate,
                ),
            };
        }

        // mpv-style AO underrun: the first short callback consumes what is
        // available and lets the caller output silence for the rest. Follow-up
        // callbacks are held until the realtime output queue is full again.
        AoBufferingDecision {
            hold: false,
            cache_state: None,
        }
    }

    pub(super) fn cache_pause_resume_threshold(&self, metrics: &AoBufferingMetrics) -> usize {
        let adaptive_wait_secs =
            self.cache_pause_wait_secs * self.adaptive_cache_pause_multiplier(metrics);
        let min_buffer_samples = ((metrics.sample_rate as f64 * adaptive_wait_secs) as usize)
            .saturating_mul(metrics.channels.max(1));
        let desired = min_buffer_samples
            .max(metrics.requested_samples)
            .max(metrics.output_queue_capacity);
        desired.min(self.max_buffering_resume_samples(metrics))
    }

    pub(super) fn output_underrun_resume_threshold(&self, output_queue_capacity: usize) -> usize {
        output_queue_capacity.max(1)
    }

    fn output_queue_ready_for_resume(&self, metrics: &AoBufferingMetrics) -> bool {
        let required_samples = metrics
            .requested_samples
            .min(metrics.output_queue_capacity)
            .max(1);
        metrics.queued_samples >= required_samples
    }

    fn max_buffering_resume_samples(&self, metrics: &AoBufferingMetrics) -> usize {
        let decoded_capacity_samples = (((metrics.decoded_queue_capacity_frames
            * metrics.channels.max(1)) as f64)
            / metrics.speed.max(0.001) as f64)
            .round() as usize;
        metrics
            .output_queue_capacity
            .saturating_add(decoded_capacity_samples)
            .max(metrics.requested_samples)
            .max(metrics.output_queue_capacity)
    }

    fn adaptive_cache_pause_multiplier(&self, metrics: &AoBufferingMetrics) -> f64 {
        let underrun_scale: f64 = if metrics.output_underruns >= 20 {
            3.0
        } else if metrics.output_underruns >= 5 {
            2.0
        } else {
            1.0
        };

        // Proactive throughput scaling: when decode throughput falls behind real
        // time (network-bound or slow source), buffer a little more before resume.
        let throughput_scale: f64 = if metrics.decode_throughput_ratio_milli == 0 {
            1.0
        } else if metrics.decode_throughput_ratio_milli < 500 {
            3.0
        } else if metrics.decode_throughput_ratio_milli < 900 {
            2.0
        } else {
            1.0
        };

        (underrun_scale.max(throughput_scale)).clamp(1.0, 5.0)
    }

    pub(super) fn cache_state(
        &self,
        paused: bool,
        buffered_samples: usize,
        target_samples: usize,
        requested_samples: usize,
        channels: usize,
        sample_rate: u32,
    ) -> Option<AoCacheState> {
        let channels = channels.max(1);
        let sample_rate = sample_rate.max(1) as f64;
        let target_samples = target_samples.max(requested_samples).max(1);
        let percent = ((buffered_samples as f64 / target_samples as f64) * 100.0).clamp(0.0, 100.0);
        let bucket = if paused {
            ((percent / 5.0).floor() as u32).min(20)
        } else {
            CACHE_STATE_INACTIVE_BUCKET
        };
        let previous = self.cache_state_bucket.swap(bucket, Ordering::AcqRel);
        if previous == bucket {
            return None;
        }
        Some(AoCacheState {
            paused,
            buffering_state: if paused { percent } else { 100.0 },
            buffered_secs: buffered_samples as f64 / channels as f64 / sample_rate,
            target_secs: target_samples as f64 / channels as f64 / sample_rate,
        })
    }
}
