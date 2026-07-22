use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};

pub(super) struct RealtimeAudioRing {
    samples: Vec<AtomicU32>,
    source_frames: Vec<AtomicU64>,
    capacity: usize,
    read: AtomicUsize,
    write: AtomicUsize,
}

impl RealtimeAudioRing {
    pub(super) fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            samples: (0..capacity)
                .map(|_| AtomicU32::new(0.0f32.to_bits()))
                .collect(),
            source_frames: (0..capacity).map(|_| AtomicU64::new(0)).collect(),
            capacity,
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

    pub(super) fn push(&self, samples: &[f32], source_frames: u64) -> (usize, u64) {
        if samples.is_empty() {
            return (0, 0);
        }
        let read = self.read.load(Ordering::Acquire);
        let write = self.write.load(Ordering::Relaxed);
        let available = self.capacity.saturating_sub(write.saturating_sub(read));
        let take = available.min(samples.len());
        if take == 0 {
            return (0, 0);
        }
        let credited_source_frames =
            source_frames_for_sample_span(source_frames, samples.len(), take);
        for (index, sample) in samples[..take].iter().enumerate() {
            let pos = (write + index) % self.capacity;
            self.samples[pos].store(sample.to_bits(), Ordering::Relaxed);
            self.source_frames[pos].store(
                source_credit_for_sample(credited_source_frames, take, index),
                Ordering::Relaxed,
            );
        }
        self.write.store(write + take, Ordering::Release);
        (take, credited_source_frames)
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
            let pos = (read + index) % self.capacity;
            *sample = f32::from_bits(self.samples[pos].load(Ordering::Relaxed));
            consumed_source_frames = consumed_source_frames
                .saturating_add(self.source_frames[pos].load(Ordering::Relaxed));
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

fn source_credit_for_sample(source_frames: u64, samples: usize, index: usize) -> u64 {
    let samples = samples.max(1) as u128;
    let start = index as u128;
    let end = start + 1;
    let total = source_frames as u128;
    ((total * end) / samples).saturating_sub((total * start) / samples) as u64
}
