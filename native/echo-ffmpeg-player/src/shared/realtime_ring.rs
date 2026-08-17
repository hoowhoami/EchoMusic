use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

pub(super) struct RealtimeAudioRing {
    samples: Vec<AtomicU32>,
    /// Per-sample source-frame credit. Values are tiny (a handful of frames even at
    /// maximum playback speed), so u32 halves the metadata traffic on the audio
    /// callback path compared to the previous u64 slots.
    source_frames: Vec<AtomicU32>,
    /// Logical capacity requested by the caller; buffered_samples never exceeds it.
    capacity: usize,
    /// Physical slot-index mask. Slot count is the next power of two >= capacity so
    /// the hot push/pop loops use a mask instead of an integer modulo.
    index_mask: usize,
    read: AtomicUsize,
    write: AtomicUsize,
}

impl RealtimeAudioRing {
    pub(super) fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        let physical = capacity.next_power_of_two();
        Self {
            samples: (0..physical)
                .map(|_| AtomicU32::new(0.0f32.to_bits()))
                .collect(),
            source_frames: (0..physical).map(|_| AtomicU32::new(0)).collect(),
            capacity,
            index_mask: physical - 1,
            read: AtomicUsize::new(0),
            write: AtomicUsize::new(0),
        }
    }

    pub(super) fn clear(&self) {
        let write = self.write.load(Ordering::Acquire);
        self.read.store(write, Ordering::Release);
    }

    pub(super) fn buffered_samples(&self) -> usize {
        self.write
            .load(Ordering::Acquire)
            .saturating_sub(self.read.load(Ordering::Acquire))
            .min(self.capacity)
    }

    pub(super) fn is_empty(&self) -> bool {
        self.buffered_samples() == 0
    }

    pub(super) fn push_limited(
        &self,
        samples: &[f32],
        source_frames: u64,
        buffer_limit: usize,
    ) -> (usize, u64) {
        if samples.is_empty() {
            return (0, 0);
        }
        let read = self.read.load(Ordering::Acquire);
        let write = self.write.load(Ordering::Relaxed);
        let available = buffer_limit
            .min(self.capacity)
            .saturating_sub(write.saturating_sub(read));
        let take = available.min(samples.len());
        if take == 0 {
            return (0, 0);
        }
        let credited_source_frames =
            source_frames_for_sample_span(source_frames, samples.len(), take);
        // Return the sum of the credits actually stored (post-saturation), not the
        // ideal credited amount: producers decrement their remaining budget by this
        // value and consumers recover exactly the stored slots, so both sides stay
        // consistent even if a pathological credit ever saturates the u32 slot.
        let mut stored_source_frames = 0u64;
        for (index, sample) in samples[..take].iter().enumerate() {
            let pos = (write + index) & self.index_mask;
            self.samples[pos].store(sample.to_bits(), Ordering::Relaxed);
            let credit = source_credit_for_sample(credited_source_frames, take, index);
            self.source_frames[pos].store(credit, Ordering::Relaxed);
            stored_source_frames = stored_source_frames.saturating_add(u64::from(credit));
        }
        self.write.store(write + take, Ordering::Release);
        (take, stored_source_frames)
    }

    pub(super) fn pop_into(&self, output: &mut [f32]) -> (usize, u64) {
        let read = self.read.load(Ordering::Relaxed);
        let write = self.write.load(Ordering::Acquire);
        let take = write
            .saturating_sub(read)
            .min(self.capacity)
            .min(output.len());
        let mut consumed_source_frames = 0u64;
        for (index, sample) in output[..take].iter_mut().enumerate() {
            let pos = (read + index) & self.index_mask;
            *sample = f32::from_bits(self.samples[pos].load(Ordering::Relaxed));
            consumed_source_frames = consumed_source_frames
                .saturating_add(u64::from(self.source_frames[pos].load(Ordering::Relaxed)));
        }
        self.read.store(read + take, Ordering::Release);
        (take, consumed_source_frames)
    }
}

fn source_frames_for_sample_span(source_frames: u64, total_samples: usize, take: usize) -> u64 {
    if take >= total_samples {
        return source_frames;
    }
    ((source_frames as u128 * take as u128) / total_samples.max(1) as u128) as u64
}

fn source_credit_for_sample(source_frames: u64, samples: usize, index: usize) -> u32 {
    let samples = samples.max(1) as u128;
    let start = index as u128;
    let end = start + 1;
    let total = source_frames as u128;
    let credit = ((total * end) / samples).saturating_sub((total * start) / samples);
    // Per-sample credit is bounded by ceil(source_frames / samples) + 1; even at the
    // 5x maximum playback speed that is single digits, so saturation is unreachable
    // in practice. If it ever fires, push_limited reports the stored (saturated)
    // total so producer and consumer accounting still agree.
    debug_assert!(
        credit <= u128::from(u32::MAX),
        "per-sample source-frame credit {credit} exceeds u32 slot"
    );
    u32::try_from(credit).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_power_of_two_capacity_keeps_logical_limit_and_wraps_correctly() {
        let ring = RealtimeAudioRing::new(6);
        assert_eq!(ring.capacity, 6);
        assert_eq!(ring.index_mask + 1, 8);

        // Fill to logical capacity; the physical pow2 slack must not be usable.
        let (pushed, _) = ring.push_limited(&[1.0; 8], 4, usize::MAX);
        assert_eq!(pushed, 6);
        assert_eq!(ring.buffered_samples(), 6);

        // Drain and wrap across the physical boundary several times.
        let mut out = [0.0f32; 6];
        let (popped, _) = ring.pop_into(&mut out);
        assert_eq!(popped, 6);
        for round in 0..4 {
            let value = round as f32;
            let (pushed, _) = ring.push_limited(&[value; 6], 3, usize::MAX);
            assert_eq!(pushed, 6);
            let (popped, frames) = ring.pop_into(&mut out);
            assert_eq!(popped, 6);
            assert_eq!(frames, 3);
            assert!(out.iter().all(|sample| *sample == value));
        }
    }

    #[test]
    fn source_frame_credit_survives_partial_pops() {
        let ring = RealtimeAudioRing::new(8);
        let (pushed, credited) = ring.push_limited(&[0.5; 8], 4, usize::MAX);
        assert_eq!(pushed, 8);
        assert_eq!(credited, 4);

        let mut out = [0.0f32; 3];
        let (_, first) = ring.pop_into(&mut out);
        let (_, second) = ring.pop_into(&mut out);
        let mut rest = [0.0f32; 2];
        let (_, third) = ring.pop_into(&mut rest);
        assert_eq!(first + second + third, 4);
    }

    #[test]
    fn push_reports_exactly_what_consumers_can_recover() {
        // The value returned by push_limited must equal the sum of what pop_into
        // later recovers, otherwise the playback clock drifts permanently.
        let ring = RealtimeAudioRing::new(16);
        let mut total_pushed_frames = 0u64;
        for _ in 0..3 {
            let (pushed, credited) = ring.push_limited(&[0.25; 5], 7, usize::MAX);
            assert_eq!(pushed, 5);
            total_pushed_frames += credited;
        }
        let mut out = [0.0f32; 15];
        let (popped, recovered) = ring.pop_into(&mut out);
        assert_eq!(popped, 15);
        assert_eq!(recovered, total_pushed_frames);
    }
}
