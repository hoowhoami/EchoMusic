const DEFAULT_CEILING: f32 = 0.98;
const RELEASE_SECONDS: f32 = 0.1;

/// A frame-linked lookahead peak limiter.
///
/// All channels share one gain envelope so overload protection cannot move the stereo image.
/// Allocation is confined to construction and drain; steady-state processing is in-place.
pub(crate) struct LinkedLimiter {
    channels: usize,
    write_index: usize,
    ceiling: f32,
    release_coefficient: f32,
    gain_envelope: f32,
    delay: Vec<f32>,
    peak_tree: [f32; Self::LOOKAHEAD * 2],
}

impl LinkedLimiter {
    pub(crate) const LOOKAHEAD: usize = 256;

    pub(crate) fn new(sample_rate: u32, channels: usize) -> Self {
        let channels = channels.max(1);
        let release_samples = sample_rate.max(1) as f32 * RELEASE_SECONDS;
        let release_coefficient = 1.0 - (-1.0 / release_samples).exp();
        Self {
            channels,
            write_index: 0,
            ceiling: DEFAULT_CEILING,
            release_coefficient,
            gain_envelope: 1.0,
            delay: vec![0.0; Self::LOOKAHEAD * channels],
            peak_tree: [0.0; Self::LOOKAHEAD * 2],
        }
    }

    pub(crate) fn process_interleaved(&mut self, samples: &mut [f32]) {
        let mut frames = samples.chunks_exact_mut(self.channels);
        for frame in frames.by_ref() {
            self.process_frame(frame);
        }
        for sample in frames.into_remainder() {
            *sample = 0.0;
        }
    }

    /// Emits the delayed frames still owned by the limiter and leaves it ready for reuse.
    pub(crate) fn drain_interleaved(&mut self, output: &mut Vec<f32>) {
        let mut frame = vec![0.0; self.channels];
        output.reserve(Self::LOOKAHEAD * self.channels);
        for _ in 0..Self::LOOKAHEAD {
            frame.fill(0.0);
            self.process_frame(&mut frame);
            output.extend_from_slice(&frame);
        }
        self.reset();
    }

    pub(crate) fn reset(&mut self) {
        self.write_index = 0;
        self.gain_envelope = 1.0;
        self.delay.fill(0.0);
        self.peak_tree.fill(0.0);
    }

    fn process_frame(&mut self, frame: &mut [f32]) {
        let window_peak = self.peak_tree[1];
        let target_gain = if window_peak > self.ceiling {
            self.ceiling / window_peak
        } else {
            1.0
        };
        let released =
            self.gain_envelope + self.release_coefficient * (1.0 - self.gain_envelope) + 1.0e-25;
        let gain = target_gain.min(released).min(1.0);
        self.gain_envelope = gain;

        let delay_offset = self.write_index * self.channels;
        let mut input_peak = 0.0f32;
        for (channel, sample) in frame.iter_mut().enumerate() {
            let input = if sample.is_finite() { *sample } else { 0.0 };
            input_peak = input_peak.max(input.abs());
            let delayed = self.delay[delay_offset + channel];
            self.delay[delay_offset + channel] = input;
            *sample = delayed * gain;
        }
        self.update_peak(input_peak);
        self.write_index = (self.write_index + 1) & (Self::LOOKAHEAD - 1);
    }

    fn update_peak(&mut self, peak: f32) {
        let mut node = Self::LOOKAHEAD + self.write_index;
        self.peak_tree[node] = peak;
        while node > 1 {
            let parent = node >> 1;
            let sibling = node ^ 1;
            self.peak_tree[parent] = self.peak_tree[node].max(self.peak_tree[sibling]);
            node = parent;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linked_limiter_preserves_stereo_balance_during_overload() {
        let mut limiter = LinkedLimiter::new(48_000, 2);
        let output_frame = LinkedLimiter::LOOKAHEAD;
        let mut samples = vec![0.0; (output_frame + 1) * 2];
        samples[0] = 2.0;
        samples[1] = 1.0;

        limiter.process_interleaved(&mut samples);

        let left = samples[output_frame * 2];
        let right = samples[output_frame * 2 + 1];
        assert!(left <= DEFAULT_CEILING + 0.00001);
        assert!((left / right - 2.0).abs() < 0.00001);
    }

    #[test]
    fn drain_emits_delayed_samples_and_resets_state() {
        let mut limiter = LinkedLimiter::new(48_000, 2);
        let mut input = vec![0.25, -0.5];
        limiter.process_interleaved(&mut input);
        assert_eq!(input, vec![0.0, 0.0]);

        let mut tail = Vec::new();
        limiter.drain_interleaved(&mut tail);

        assert_eq!(tail.len(), LinkedLimiter::LOOKAHEAD * 2);
        assert_eq!(tail[(LinkedLimiter::LOOKAHEAD - 1) * 2], 0.25);
        assert_eq!(tail[(LinkedLimiter::LOOKAHEAD - 1) * 2 + 1], -0.5);

        let mut reused = vec![0.1, 0.1];
        limiter.process_interleaved(&mut reused);
        assert_eq!(reused, vec![0.0, 0.0]);
    }
}
