use super::SharedAudio;
use std::sync::atomic::Ordering;

impl SharedAudio {
    /// Apply gain to the PCM frame where a marker lands, before device resampling.
    /// A reference-gain change must not amplify the outgoing frames in the same callback.
    pub(super) fn normalize_output(
        &self,
        output: &mut [f32],
        boundary: Option<(usize, f32)>,
        end: Option<(usize, f32)>,
    ) {
        let target = self.normalization_gain();
        let previous = f32::from_bits(self.applied_normalization_gain_bits.load(Ordering::Acquire));
        let start = if previous.is_finite() {
            previous
        } else {
            target
        };
        let mut events = [boundary, end];
        if events[0].is_none() || matches!((events[0], events[1]), (Some(a), Some(b)) if a.0 > b.0)
        {
            events.swap(0, 1);
        }
        let channels = self.mix_format.channels.max(1);
        let ramp_frames = events[0]
            .map_or(output.len(), |event| event.0)
            .min(output.len())
            / channels;
        let mut event_index = 0;
        let mut gain = target;
        for (index, frame) in output.chunks_mut(channels).enumerate() {
            while let Some((offset, db)) = events.get(event_index).copied().flatten() {
                if offset > index * channels {
                    break;
                }
                gain = crate::control::transition::normalization_gain_linear(db);
                event_index += 1;
            }
            let applied = if event_index == 0 && ramp_frames > 0 {
                start
                    + (target - start) * ((index + 1).min(ramp_frames) as f32 / ramp_frames as f32)
            } else {
                gain
            };
            for sample in frame {
                *sample *= applied;
            }
        }
        // A marker at the buffer's end belongs to the next frame, but its state is live now.
        for (offset, db) in events.into_iter().flatten() {
            if offset <= output.len() {
                gain = crate::control::transition::normalization_gain_linear(db);
            }
        }
        self.applied_normalization_gain_bits
            .store(gain.to_bits(), Ordering::Release);
    }
}
