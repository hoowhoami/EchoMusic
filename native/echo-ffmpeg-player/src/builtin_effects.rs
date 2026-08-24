use std::collections::VecDeque;

const Q24_ONE: i32 = 1 << 24;
const PROCESS_BLOCK: usize = 1024;
const LIMITER_LOOKAHEAD: usize = 256;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BuiltinEffect {
    #[default]
    None,
    DynamicBass,
    ClearVoice,
    ThreeDBeauty,
}

impl BuiltinEffect {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Self::None),
            "dynamic-bass" => Some(Self::DynamicBass),
            "clear-voice" => Some(Self::ClearVoice),
            "3d-beauty" => Some(Self::ThreeDBeauty),
            _ => None,
        }
    }

    pub fn enabled(self) -> bool {
        self != Self::None
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::DynamicBass => "dynamic-bass",
            Self::ClearVoice => "clear-voice",
            Self::ThreeDBeauty => "3d-beauty",
        }
    }
}

pub struct BuiltinEffectProcessor {
    effect: BuiltinEffect,
    dynamic_bass: [FixedBiquad; 2],
    clear_voice: [[FixedBiquad; 5]; 2],
    limiters: [DbcvLimiter; 2],
    pending: VecDeque<[i32; 2]>,
    output: VecDeque<[i32; 2]>,
    haas_right: VecDeque<i32>,
    playback_gain: ThreeDPlaybackGain,
}

impl BuiltinEffectProcessor {
    pub fn new(sample_rate: u32, effect: BuiltinEffect) -> Self {
        let sample_rate = sample_rate.max(44_100) as f64;
        let dynamic_bass = FixedBiquad::low_pass(sample_rate, 66.0, 0.717);
        let clear_voice = [
            FixedBiquad::peaking_bandwidth(sample_rate, 300.0, 1.83, 6.0),
            FixedBiquad::peaking_bandwidth(sample_rate, 200.0, 4.17, -3.0),
            FixedBiquad::peaking_bandwidth(sample_rate, 2_600.0, 1.17, 5.0),
            FixedBiquad::peaking_bandwidth(sample_rate, 5_600.0, 0.83, -1.0),
            FixedBiquad::peaking_bandwidth(sample_rate, 12_000.0, 1.67, 4.0),
        ];
        Self {
            effect,
            dynamic_bass: [dynamic_bass; 2],
            clear_voice: [clear_voice; 2],
            limiters: std::array::from_fn(|_| DbcvLimiter::new()),
            pending: VecDeque::new(),
            // The App returns no frames until its first 1024-frame block is ready. The player
            // graph is length-preserving, so represent that contract as an equivalent delay.
            output: VecDeque::from(vec![
                [0, 0];
                if effect == BuiltinEffect::ThreeDBeauty {
                    0
                } else {
                    PROCESS_BLOCK
                }
            ]),
            haas_right: VecDeque::from(vec![0; 1152]),
            playback_gain: ThreeDPlaybackGain::new(sample_rate as u32),
        }
    }

    pub fn process_interleaved(&mut self, samples: &mut [f32]) {
        if self.effect == BuiltinEffect::ThreeDBeauty {
            self.process_three_d_beauty(samples);
            return;
        }
        self.pending.extend(
            samples
                .chunks_exact(2)
                .map(|frame| [float_to_q24(frame[0]), float_to_q24(frame[1])]),
        );

        while self.pending.len() >= PROCESS_BLOCK {
            for _ in 0..PROCESS_BLOCK {
                let mut frame = self.pending.pop_front().unwrap_or_default();
                self.process_frame(&mut frame);
                self.output.push_back(frame);
            }
        }

        for frame in samples.chunks_exact_mut(2) {
            let output = self.output.pop_front().unwrap_or_default();
            frame[0] = q24_to_float(output[0]);
            frame[1] = q24_to_float(output[1]);
        }
    }

    pub fn latency_frames(&self) -> usize {
        if self.effect == BuiltinEffect::ThreeDBeauty {
            1152 + LIMITER_LOOKAHEAD
        } else {
            PROCESS_BLOCK + LIMITER_LOOKAHEAD
        }
    }

    fn process_frame(&mut self, frame: &mut [i32; 2]) {
        match self.effect {
            BuiltinEffect::None => {}
            BuiltinEffect::DynamicBass => {
                for channel in 0..2 {
                    let low = self.dynamic_bass[channel].process(frame[channel]);
                    frame[channel] = saturating_i64(
                        i64::from(frame[channel]) + i64::from(q24_mul(low, q24(1.85))),
                    );
                }
            }
            BuiltinEffect::ClearVoice => {
                for channel in 0..2 {
                    for filter in &mut self.clear_voice[channel] {
                        frame[channel] = filter.process(frame[channel]);
                    }
                }
            }
            BuiltinEffect::ThreeDBeauty => unreachable!("3D beauty uses block processing"),
        }
        frame[0] = self.limiters[0].process(frame[0]);
        frame[1] = self.limiters[1].process(frame[1]);
    }

    fn process_three_d_beauty(&mut self, samples: &mut [f32]) {
        let mut block = samples
            .chunks_exact(2)
            .map(|frame| {
                self.haas_right.push_back(float_to_q24(frame[1]));
                [
                    float_to_q24(frame[0]),
                    self.haas_right.pop_front().unwrap_or_default(),
                ]
            })
            .collect::<Vec<_>>();
        self.playback_gain.process(&mut block, &mut self.limiters);
        for (target, source) in samples.chunks_exact_mut(2).zip(block) {
            target[0] = q24_to_float(source[0]);
            target[1] = q24_to_float(source[1]);
        }
    }
}

struct ThreeDPlaybackGain {
    sample_rate: u32,
    warmup_calls: u32,
    current_gain: [i32; 2],
    detectors: [FixedBiquad; 2],
}

impl ThreeDPlaybackGain {
    fn new(sample_rate: u32) -> Self {
        let sample_rate = sample_rate.max(44_100);
        let detector = FixedBiquad::band_pass(sample_rate as f64, 2_200.0, 0.33);
        Self {
            sample_rate,
            warmup_calls: 0,
            current_gain: [Q24_ONE; 2],
            detectors: [detector; 2],
        }
    }

    fn process(&mut self, block: &mut [[i32; 2]], limiters: &mut [DbcvLimiter; 2]) {
        if block.is_empty() {
            return;
        }
        let mut energy = [0.0f64; 2];
        for frame in block.iter() {
            for channel in 0..2 {
                let filtered = self.detectors[channel].process(frame[channel]);
                let normalized = f64::from(filtered) / f64::from(Q24_ONE);
                energy[channel] += normalized * normalized;
            }
        }
        let level_db = 10.0
            * (energy[0].max(energy[1]) / block.len() as f64)
                .max(1.0e-10)
                .log10();
        let base_db = -(2.0 / 3.0) * (level_db + 23.0);
        self.warmup_calls = self.warmup_calls.saturating_add(1).min(100);
        let amount = base_db * f64::from(self.warmup_calls) / 100.0;
        let target = q24(10.0f64.powf((amount - amount * amount / 200.0) / 20.0));
        let ramp_frames = block.len().min((self.sample_rate / 5) as usize).max(1) as i64;
        let mut steps = [0i32; 2];
        for channel in 0..2 {
            let current = self.current_gain[channel];
            let lower_target = q24_mul(target, q24(1.3));
            let destination = if target > current {
                target
            } else if lower_target < current {
                lower_target
            } else {
                current
            };
            let mut step = (i64::from(destination) - i64::from(current)) / ramp_frames;
            if step > 0 {
                step /= 16;
            }
            steps[channel] = saturating_i64(step);
        }
        for frame in block {
            for channel in 0..2 {
                frame[channel] = q24_mul(frame[channel], self.current_gain[channel]);
                self.current_gain[channel] = saturating_i64(
                    i64::from(self.current_gain[channel]) + i64::from(steps[channel]),
                )
                .clamp(-q24(8.0), q24(8.0));
                frame[channel] = limiters[channel].process(frame[channel]);
            }
        }
    }
}

#[derive(Clone, Copy, Default)]
struct FixedBiquad {
    b0: i32,
    b1: i32,
    b2: i32,
    feedback1: i32,
    feedback2: i32,
    x1: i32,
    x2: i32,
    y1: i32,
    y2: i32,
}

impl FixedBiquad {
    fn low_pass(sample_rate: f64, frequency: f64, q: f64) -> Self {
        let omega = 2.0 * std::f64::consts::PI * frequency / sample_rate;
        let sine = omega.sin();
        let cosine = omega.cos();
        let alpha = sine / (2.0 * q);
        Self::normalized(
            (1.0 - cosine) * 0.5,
            1.0 - cosine,
            (1.0 - cosine) * 0.5,
            1.0 + alpha,
            -2.0 * cosine,
            1.0 - alpha,
        )
    }

    fn peaking_bandwidth(sample_rate: f64, frequency: f64, bandwidth: f64, gain_db: f64) -> Self {
        let omega = 2.0 * std::f64::consts::PI * frequency / sample_rate;
        let sine = omega.sin();
        let cosine = omega.cos();
        let gain = 10.0f64.powf(gain_db / 40.0);
        let alpha =
            sine * (std::f64::consts::LN_2 * 0.5 * bandwidth * omega / sine.max(1.0e-12)).sinh();
        Self::normalized(
            1.0 + alpha * gain,
            -2.0 * cosine,
            1.0 - alpha * gain,
            1.0 + alpha / gain,
            -2.0 * cosine,
            1.0 - alpha / gain,
        )
    }

    fn band_pass(sample_rate: f64, frequency: f64, q: f64) -> Self {
        let omega = 2.0 * std::f64::consts::PI * frequency / sample_rate;
        let sine = omega.sin();
        let cosine = omega.cos();
        let alpha = sine / (2.0 * q);
        Self::normalized(
            sine * 0.5,
            0.0,
            -sine * 0.5,
            1.0 + alpha,
            -2.0 * cosine,
            1.0 - alpha,
        )
    }

    fn normalized(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Self {
        Self {
            b0: quantize_q24(b0 / a0),
            b1: quantize_q24(b1 / a0),
            b2: quantize_q24(b2 / a0),
            feedback1: quantize_q24(-(a1 / a0)),
            feedback2: quantize_q24(-(a2 / a0)),
            ..Self::default()
        }
    }

    fn process(&mut self, input: i32) -> i32 {
        let accumulator = i64::from(self.b0) * i64::from(input)
            + i64::from(self.b1) * i64::from(self.x1)
            + i64::from(self.b2) * i64::from(self.x2)
            + i64::from(self.feedback1) * i64::from(self.y1)
            + i64::from(self.feedback2) * i64::from(self.y2);
        let output = saturating_i64((accumulator + (1 << 23)) >> 24);
        self.x2 = self.x1;
        self.x1 = input;
        self.y2 = self.y1;
        self.y1 = output;
        output
    }
}

struct DbcvLimiter {
    delay: [i32; LIMITER_LOOKAHEAD],
    write_index: usize,
    envelope: i32,
    gain: i32,
}

impl DbcvLimiter {
    const GATE: i32 = 0x00ff_ffff;
    const ATTACK_A: i32 = 0x00e6_5fd9;
    const ATTACK_B: i32 = 0x0019_930c;
    const RELEASE_A: i32 = 0x00ff_f972;
    const RELEASE_STEP: i32 = 0x0000_068e;

    fn new() -> Self {
        Self {
            delay: [0; LIMITER_LOOKAHEAD],
            write_index: 0,
            envelope: Q24_ONE,
            gain: Q24_ONE,
        }
    }

    fn process(&mut self, input: i32) -> i32 {
        let delayed = self.delay[self.write_index];
        self.delay[self.write_index] = input;
        self.write_index = (self.write_index + 1) & (LIMITER_LOOKAHEAD - 1);
        let peak = self
            .delay
            .iter()
            .copied()
            .map(i32::unsigned_abs)
            .max()
            .unwrap_or_default();
        let desired = if peak > Self::GATE as u32 {
            (((Self::GATE as i64) << 24) / i64::from(peak)).clamp(0, i64::from(Q24_ONE)) as i32
        } else {
            Q24_ONE
        };
        self.envelope = saturating_i64(
            i64::from(q24_mul(Self::ATTACK_A, self.envelope))
                + i64::from(q24_mul(Self::ATTACK_B, desired)),
        );
        let release = saturating_i64(
            i64::from(q24_mul(Self::RELEASE_A, self.gain)) + i64::from(Self::RELEASE_STEP),
        );
        self.gain = self.envelope.min(release).min(Q24_ONE);
        let mut output = q24_mul(delayed, self.gain);
        if output.unsigned_abs() > Self::GATE as u32 && delayed != 0 {
            output = q24_mul(
                delayed,
                (((Self::GATE as i64) << 24) / i64::from(delayed.unsigned_abs())) as i32,
            );
        }
        output
    }
}

fn quantize_q24(value: f64) -> i32 {
    saturating_i64((value * f64::from(Q24_ONE) + 0.5).trunc() as i64)
}

fn q24(value: f64) -> i32 {
    quantize_q24(value)
}

fn q24_mul(left: i32, right: i32) -> i32 {
    saturating_i64((i64::from(left) * i64::from(right) + (1 << 23)) >> 24)
}

fn float_to_q24(value: f32) -> i32 {
    q24(f64::from(value.clamp(-128.0, 127.999_99)))
}

fn q24_to_float(value: i32) -> f32 {
    value as f32 / Q24_ONE as f32
}

fn saturating_i64(value: i64) -> i32 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(sample_rate: u32, frequency: f32, frames: usize) -> Vec<f32> {
        (0..frames)
            .flat_map(|frame| {
                let value = (2.0 * std::f32::consts::PI * frequency * frame as f32
                    / sample_rate as f32)
                    .sin()
                    * 0.1;
                [value, value]
            })
            .collect()
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn dynamic_bass_boosts_66_hz_after_app_buffer_latency() {
        let mut samples = sine(48_000, 66.0, 8192);
        let before = rms(&samples);
        let mut processor = BuiltinEffectProcessor::new(48_000, BuiltinEffect::DynamicBass);
        let latency = processor.latency_frames();
        processor.process_interleaved(&mut samples);
        let after = rms(&samples[latency * 2..]);
        assert!(after > before * 1.5);
        assert!(samples[..latency * 2]
            .iter()
            .all(|sample| sample.abs() <= f32::EPSILON));
    }

    #[test]
    fn clear_voice_changes_presence_band_after_app_buffer_latency() {
        let mut samples = sine(48_000, 2_600.0, 8192);
        let before = rms(&samples);
        let mut processor = BuiltinEffectProcessor::new(48_000, BuiltinEffect::ClearVoice);
        let latency = processor.latency_frames();
        processor.process_interleaved(&mut samples);
        let after = rms(&samples[latency * 2..]);
        assert!(after > before * 1.2);
    }

    #[test]
    fn builtin_processing_is_independent_of_host_callback_size() {
        let source = sine(48_000, 300.0, 8192);
        let mut large_blocks = source.clone();
        let mut small_blocks = source;
        let mut large = BuiltinEffectProcessor::new(48_000, BuiltinEffect::ClearVoice);
        let mut small = BuiltinEffectProcessor::new(48_000, BuiltinEffect::ClearVoice);
        for block in large_blocks.chunks_mut(2048) {
            large.process_interleaved(block);
        }
        for block in small_blocks.chunks_mut(256) {
            small.process_interleaved(block);
        }
        assert_eq!(large_blocks, small_blocks);
    }

    #[test]
    fn three_d_beauty_delays_right_channel() {
        let mut samples = vec![0.0f32; 1800 * 2];
        samples[0] = 0.5;
        samples[1] = 0.25;
        let mut processor = BuiltinEffectProcessor::new(48_000, BuiltinEffect::ThreeDBeauty);

        processor.process_interleaved(&mut samples);

        let left_frame = LIMITER_LOOKAHEAD;
        let right_frame = 1152 + LIMITER_LOOKAHEAD;
        assert!(samples[left_frame * 2].abs() > 0.1);
        assert!(samples[..right_frame * 2 + 1]
            .chunks_exact(2)
            .all(|frame| frame[1].abs() < 0.00001));
        assert!(samples[right_frame * 2 + 1].abs() > 0.05);
        assert!(samples.iter().all(|sample| sample.abs() <= 1.0));
    }
}
