#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
pub trait ToF32Sample: Copy + Send + 'static {
    fn to_f32_sample(self) -> f32;
}

const MAX_BUFFER_SAMPLES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct CapturedSamples {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: usize,
}

/// Bounded interleaved-f32 ring shared by every platform backend.
/// It retains the newest samples when full so continuous analyzers can poll it.
pub struct SampleRing {
    buffer: Vec<f32>,
    write_index: usize,
    written: usize,
    sample_rate: u32,
    channels: usize,
    max_duration_ms: u32,
}

impl SampleRing {
    pub fn new(max_duration_ms: u32) -> Self {
        Self {
            buffer: Vec::new(),
            write_index: 0,
            written: 0,
            sample_rate: 0,
            channels: 0,
            max_duration_ms,
        }
    }

    pub fn configure(&mut self, sample_rate: u32, channels: usize) -> Result<(), String> {
        if sample_rate == 0 || channels == 0 {
            return Err("capture backend returned an invalid audio format".to_string());
        }
        let requested = sample_rate as u64 * channels as u64 * self.max_duration_ms as u64 / 1_000;
        if requested > MAX_BUFFER_SAMPLES as u64 {
            return Err(format!(
                "requested capture buffer requires {requested} samples; maximum is {MAX_BUFFER_SAMPLES}"
            ));
        }
        let capacity = requested.max(channels as u64) as usize / channels * channels;
        self.buffer = vec![0.0; capacity];
        self.write_index = 0;
        self.written = 0;
        self.sample_rate = sample_rate;
        self.channels = channels;
        Ok(())
    }

    pub fn push(&mut self, sample: f32) {
        if self.buffer.is_empty() {
            return;
        }
        self.buffer[self.write_index] = sample.clamp(-1.0, 1.0);
        self.write_index = (self.write_index + 1) % self.buffer.len();
        self.written = self.written.saturating_add(1);
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    pub fn push_interleaved<T: ToF32Sample>(&mut self, input: &[T], channels: usize) {
        if channels == 0 || channels != self.channels {
            return;
        }
        for sample in input {
            self.push(sample.to_f32_sample());
        }
    }

    pub fn captured_frames(&self) -> usize {
        self.written
            .min(self.buffer.len())
            .checked_div(self.channels)
            .unwrap_or(0)
    }

    pub fn snapshot(&self, duration_ms: Option<u32>) -> CapturedSamples {
        if self.buffer.is_empty() || self.channels == 0 {
            return CapturedSamples {
                samples: Vec::new(),
                sample_rate: self.sample_rate,
                channels: self.channels,
            };
        }

        let available = self.written.min(self.buffer.len());
        let requested = duration_ms
            .map(|duration| {
                (self.sample_rate as u64 * self.channels as u64 * duration as u64 / 1_000)
                    .min(usize::MAX as u64) as usize
            })
            .unwrap_or(available);
        let count = available.min(requested);
        let aligned_count = count / self.channels * self.channels;
        let start = (self.write_index + self.buffer.len() - aligned_count) % self.buffer.len();
        let mut samples = Vec::with_capacity(aligned_count);
        for offset in 0..aligned_count {
            samples.push(self.buffer[(start + offset) % self.buffer.len()]);
        }
        CapturedSamples {
            samples,
            sample_rate: self.sample_rate,
            channels: self.channels,
        }
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
macro_rules! impl_signed_sample {
    ($type:ty) => {
        impl ToF32Sample for $type {
            fn to_f32_sample(self) -> f32 {
                (self as f64 / <$type>::MAX as f64).clamp(-1.0, 1.0) as f32
            }
        }
    };
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
macro_rules! impl_unsigned_sample {
    ($type:ty) => {
        impl ToF32Sample for $type {
            fn to_f32_sample(self) -> f32 {
                let midpoint = (<$type>::MAX as f64 + 1.0) * 0.5;
                ((self as f64 - midpoint) / midpoint).clamp(-1.0, 1.0) as f32
            }
        }
    };
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
impl ToF32Sample for f32 {
    fn to_f32_sample(self) -> f32 {
        self.clamp(-1.0, 1.0)
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
impl ToF32Sample for f64 {
    fn to_f32_sample(self) -> f32 {
        self.clamp(-1.0, 1.0) as f32
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
impl_signed_sample!(i8);
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
impl_signed_sample!(i16);
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
impl_signed_sample!(i32);
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
impl_signed_sample!(i64);
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
impl_unsigned_sample!(u8);
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
impl_unsigned_sample!(u16);
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
impl_unsigned_sample!(u32);
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
impl_unsigned_sample!(u64);

#[cfg(test)]
mod tests {
    use super::SampleRing;

    #[test]
    fn ring_retains_latest_complete_frames() {
        let mut ring = SampleRing::new(1);
        ring.configure(2_000, 2).unwrap();
        for value in [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] {
            ring.push(value);
        }
        let snapshot = ring.snapshot(Some(1));
        assert_eq!(snapshot.samples, vec![0.3, 0.4, 0.5, 0.6]);
        assert_eq!(snapshot.channels, 2);
        assert_eq!(snapshot.sample_rate, 2_000);
    }

    #[test]
    fn ring_clamps_samples() {
        let mut ring = SampleRing::new(1_000);
        ring.configure(1, 1).unwrap();
        ring.push(2.0);
        assert_eq!(ring.snapshot(None).samples, vec![1.0]);
    }

    #[test]
    fn oversized_buffers_are_rejected_instead_of_silently_truncated() {
        let mut ring = SampleRing::new(300_000);
        assert!(ring.configure(384_000, 8).is_err());
    }
}
