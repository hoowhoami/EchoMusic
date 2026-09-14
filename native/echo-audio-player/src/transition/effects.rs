//! Per-deck effect chain driven by a DJ plan's automation.
//!
//! Supported effects and their processing parameters:
//!
//! | type | effect   | parameter          | implementation                                   |
//! |------|----------|--------------------|--------------------------------------------------|
//! | 1    | Gain     | dB                 | linear gain, smoothed                            |
//! | 0    | 3bandEQ  | low/mid/high dB    | low shelf 200 Hz, peak 1 kHz (Q 0.7), high shelf 4 kHz |
//! | 2    | LPF      | cutoff Hz          | 2nd-order Butterworth low-pass sweep             |
//! | 3    | HPF      | cutoff Hz          | 2nd-order Butterworth high-pass sweep            |
//! | 4    | Reverb   | wet mix 0..1       | Freeverb-style (4 comb + 2 all-pass) per channel |
//! | 5    | Echo     | wet mix 0..1       | one-beat feedback delay                          |
//!
//! Parameters are evaluated per processing block (≤ 256 frames) on the normalised
//! overlap timeline and then smoothed with a one-pole filter so `step` automation does not
//! zipper. Filters are recomputed only when their target moves.

use super::plan::{Automation, EffectChainSpec, EffectSlot, EffectTarget};
use std::f32::consts::PI;

pub const AUTOMATION_BLOCK_FRAMES: usize = 256;
const PARAM_SMOOTH_SECS: f32 = 0.03;
const EQ_LOW_SHELF_HZ: f32 = 200.0;
const EQ_MID_PEAK_HZ: f32 = 1_000.0;
const EQ_MID_Q: f32 = 0.7;
const EQ_HIGH_SHELF_HZ: f32 = 4_000.0;
const MAX_CUTOFF_RATIO: f32 = 0.45;
const MIN_CUTOFF_HZ: f32 = 10.0;
const COMB_TUNING_SECS: [f32; 4] = [0.0253, 0.0269, 0.0289, 0.0307];
const ALLPASS_TUNING_SECS: [f32; 2] = [0.0051, 0.0126];
const COMB_FEEDBACK: f32 = 0.84;
const COMB_DAMP: f32 = 0.2;
const ALLPASS_FEEDBACK: f32 = 0.5;
const ECHO_FEEDBACK: f32 = 0.5;
const ECHO_MAX_SECS: f32 = 1.5;

/// A single automated effect instance inside a chain.
struct EffectStage {
    target: EffectTarget,
    automation: Automation,
    smoother: ParamSmoother,
    /// Value the filter coefficients were last computed for.
    applied: f32,
    kind: StageKind,
}

enum StageKind {
    Gain,
    Eq(Vec<Biquad>),
    LowPass(Vec<Biquad>),
    HighPass(Vec<Biquad>),
    Reverb(Vec<Reverb>),
    Echo(Vec<Echo>),
}

/// One-pole smoother for automation values, time-based so block size does not matter.
struct ParamSmoother {
    tau_frames: f32,
    current: f32,
    initialised: bool,
}

impl ParamSmoother {
    fn new(sample_rate: u32) -> Self {
        Self {
            tau_frames: (PARAM_SMOOTH_SECS * sample_rate.max(1) as f32).max(1.0),
            current: 0.0,
            initialised: false,
        }
    }

    /// Advance by `frames` frames towards `target` and return the smoothed value.
    fn next(&mut self, target: f32, frames: usize) -> f32 {
        if !self.initialised {
            self.current = target;
            self.initialised = true;
            return target;
        }
        let coefficient = (-(frames.max(1) as f32) / self.tau_frames).exp();
        self.current = target + (self.current - target) * coefficient;
        if (self.current - target).abs() < 1.0e-4 {
            self.current = target;
        }
        self.current
    }

    fn snap(&mut self, value: f32) {
        self.current = value;
        self.initialised = true;
    }
}

/// Effect chain for one deck (interleaved f32, fixed channel count).
pub struct DeckEffectChain {
    sample_rate: u32,
    channels: usize,
    stages: Vec<EffectStage>,
    /// Extra gain applied after the chain (e.g. loudness normalisation for the deck).
    trim_gain: f32,
    bypass_blend: Option<BypassBlend>,
}

struct BypassBlend {
    remaining_frames: usize,
    total_frames: usize,
}

impl DeckEffectChain {
    pub fn new(spec: &EffectChainSpec, sample_rate: u32, channels: usize) -> Self {
        let channels = channels.max(1);
        let stages = spec
            .list
            .iter()
            .filter_map(|slot| EffectStage::new(slot, sample_rate, channels))
            .collect();
        Self {
            sample_rate: sample_rate.max(1),
            channels,
            stages,
            trim_gain: 1.0,
            bypass_blend: None,
        }
    }

    /// Chain that passes audio through untouched (used for gapless/plain crossfades).
    pub fn passthrough(sample_rate: u32, channels: usize) -> Self {
        Self {
            sample_rate: sample_rate.max(1),
            channels: channels.max(1),
            stages: Vec::new(),
            trim_gain: 1.0,
            bypass_blend: None,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.stages.is_empty()
    }

    /// Whether any stage keeps producing audio after its input stops (reverb/echo tails).
    pub fn has_tail(&self) -> bool {
        self.stages
            .iter()
            .any(|stage| matches!(stage.kind, StageKind::Reverb(_) | StageKind::Echo(_)))
    }

    /// Longest tail the chain can ring for, in frames.
    pub fn tail_frames(&self) -> usize {
        let secs = self
            .stages
            .iter()
            .map(|stage| match stage.kind {
                StageKind::Reverb(_) => 2.0,
                StageKind::Echo(_) => 3.0,
                _ => 0.0,
            })
            .fold(0.0f32, f32::max);
        (secs * self.sample_rate as f32) as usize
    }

    /// Process one block of interleaved frames in place. `pos` is the normalised overlap
    /// position at the start of the block (may exceed 1.0 once the overlap has ended).
    pub fn process_block(&mut self, samples: &mut [f32], pos: f32) {
        if samples.is_empty() {
            return;
        }
        let channels = self.channels;
        let frames = samples.len() / channels;
        if let Some(blend) = self.bypass_blend.as_mut() {
            // Fade the processed signal back to the dry input so that a chain that ends on
            // an aggressive setting (LPF at 8 kHz, gain at -20 dB) releases audibly.
            let mut dry = samples.to_vec();
            for stage in &mut self.stages {
                stage.process(samples, pos, channels);
            }
            let total = blend.total_frames.max(1) as f32;
            for (frame_index, frame) in samples.chunks_exact_mut(channels).enumerate() {
                let remaining = blend.remaining_frames.saturating_sub(frame_index);
                let wet = remaining as f32 / total;
                for (channel, sample) in frame.iter_mut().enumerate() {
                    let dry_sample = dry[frame_index * channels + channel];
                    *sample = dry_sample + (*sample - dry_sample) * wet;
                }
            }
            blend.remaining_frames = blend.remaining_frames.saturating_sub(frames);
            if blend.remaining_frames == 0 {
                self.bypass_blend = None;
                self.stages.clear();
            }
            dry.clear();
        } else {
            for stage in &mut self.stages {
                stage.process(samples, pos, channels);
            }
        }
        if (self.trim_gain - 1.0).abs() > f32::EPSILON {
            for sample in samples.iter_mut() {
                *sample *= self.trim_gain;
            }
        }
    }

    /// Begin releasing the chain to a dry pass-through over `frames` frames. After the blend
    /// completes the chain becomes an empty pass-through.
    pub fn begin_bypass(&mut self, frames: usize) {
        if self.stages.is_empty() || self.bypass_blend.is_some() {
            return;
        }
        let frames = frames.max(1);
        self.bypass_blend = Some(BypassBlend {
            remaining_frames: frames,
            total_frames: frames,
        });
    }

    /// Feed silence through the chain to drain reverb/echo tails. Returns the number of
    /// frames written (`output` is resized to hold them).
    pub fn drain_tail(&mut self, frames: usize, pos: f32, output: &mut Vec<f32>) {
        output.clear();
        if !self.has_tail() || frames == 0 {
            return;
        }
        output.resize(frames * self.channels, 0.0);
        let channels = self.channels;
        for stage in &mut self.stages {
            stage.process(output, pos, channels);
        }
        if (self.trim_gain - 1.0).abs() > f32::EPSILON {
            for sample in output.iter_mut() {
                *sample *= self.trim_gain;
            }
        }
    }
}

impl EffectStage {
    fn new(slot: &EffectSlot, sample_rate: u32, channels: usize) -> Option<Self> {
        let target = slot.target();
        let initial = slot.initial_value();
        let kind = match target {
            EffectTarget::GainDb => StageKind::Gain,
            EffectTarget::EqLowDb => StageKind::Eq(
                (0..channels)
                    .map(|_| Biquad::low_shelf(sample_rate, EQ_LOW_SHELF_HZ, initial))
                    .collect(),
            ),
            EffectTarget::EqMidDb => StageKind::Eq(
                (0..channels)
                    .map(|_| Biquad::peaking(sample_rate, EQ_MID_PEAK_HZ, EQ_MID_Q, initial))
                    .collect(),
            ),
            EffectTarget::EqHighDb => StageKind::Eq(
                (0..channels)
                    .map(|_| Biquad::high_shelf(sample_rate, EQ_HIGH_SHELF_HZ, initial))
                    .collect(),
            ),
            EffectTarget::LowPassHz => StageKind::LowPass(
                (0..channels)
                    .map(|_| Biquad::low_pass(sample_rate, initial))
                    .collect(),
            ),
            EffectTarget::HighPassHz => StageKind::HighPass(
                (0..channels)
                    .map(|_| Biquad::high_pass(sample_rate, initial))
                    .collect(),
            ),
            EffectTarget::ReverbMix => {
                StageKind::Reverb((0..channels).map(|_| Reverb::new(sample_rate)).collect())
            }
            EffectTarget::EchoMix => {
                StageKind::Echo((0..channels).map(|_| Echo::new(sample_rate)).collect())
            }
            EffectTarget::Unknown(_) => return None,
        };
        let mut smoother = ParamSmoother::new(sample_rate);
        smoother.snap(if target == EffectTarget::GainDb {
            slot.automation.evaluate_gain_linear(0.0)
        } else {
            initial
        });
        Some(Self {
            target,
            automation: slot.automation.clone(),
            smoother,
            applied: initial,
            kind,
        })
    }

    fn process(&mut self, samples: &mut [f32], pos: f32, channels: usize) {
        let frames = samples.len() / channels.max(1);
        if let StageKind::Gain = self.kind {
            // Gain stages smooth the linear amplitude so equal-power ramps stay exact.
            let gain = self
                .smoother
                .next(self.automation.evaluate_gain_linear(pos), frames);
            if (gain - 1.0).abs() > f32::EPSILON {
                for sample in samples.iter_mut() {
                    *sample *= gain;
                }
            }
            return;
        }
        let target_value = self.automation.evaluate(pos);
        let value = self.smoother.next(target_value, frames);
        match &mut self.kind {
            StageKind::Gain => unreachable!("handled above"),
            StageKind::Eq(filters) => {
                if (value - self.applied).abs() > 1.0e-3 {
                    let sample_rate = filters.first().map(|f| f.sample_rate).unwrap_or(48_000);
                    for filter in filters.iter_mut() {
                        match self.target {
                            EffectTarget::EqLowDb => filter.retune(Biquad::low_shelf(
                                sample_rate,
                                EQ_LOW_SHELF_HZ,
                                value,
                            )),
                            EffectTarget::EqHighDb => filter.retune(Biquad::high_shelf(
                                sample_rate,
                                EQ_HIGH_SHELF_HZ,
                                value,
                            )),
                            _ => filter.retune(Biquad::peaking(
                                sample_rate,
                                EQ_MID_PEAK_HZ,
                                EQ_MID_Q,
                                value,
                            )),
                        }
                    }
                    self.applied = value;
                }
                if self.applied.abs() > 1.0e-3 {
                    run_biquads(filters, samples, channels);
                }
            }
            StageKind::LowPass(filters) => {
                if (value - self.applied).abs() > 0.5 {
                    let sample_rate = filters.first().map(|f| f.sample_rate).unwrap_or(48_000);
                    for filter in filters.iter_mut() {
                        filter.retune(Biquad::low_pass(sample_rate, value));
                    }
                    self.applied = value;
                }
                if filters.first().is_some_and(|f| !f.bypass) {
                    run_biquads(filters, samples, channels);
                }
            }
            StageKind::HighPass(filters) => {
                if (value - self.applied).abs() > 0.5 {
                    let sample_rate = filters.first().map(|f| f.sample_rate).unwrap_or(48_000);
                    for filter in filters.iter_mut() {
                        filter.retune(Biquad::high_pass(sample_rate, value));
                    }
                    self.applied = value;
                }
                if filters.first().is_some_and(|f| !f.bypass) {
                    run_biquads(filters, samples, channels);
                }
            }
            StageKind::Reverb(reverbs) => {
                let mix = value.clamp(0.0, 1.0);
                for (frame_index, frame) in samples.chunks_exact_mut(channels).enumerate() {
                    let _ = frame_index;
                    for (channel, sample) in frame.iter_mut().enumerate() {
                        let wet = reverbs[channel].process(*sample);
                        *sample = *sample * (1.0 - mix * 0.5) + wet * mix;
                    }
                }
            }
            StageKind::Echo(echoes) => {
                let mix = value.clamp(0.0, 1.0);
                for frame in samples.chunks_exact_mut(channels) {
                    for (channel, sample) in frame.iter_mut().enumerate() {
                        let wet = echoes[channel].process(*sample);
                        *sample += wet * mix;
                    }
                }
            }
        }
    }
}

fn run_biquads(filters: &mut [Biquad], samples: &mut [f32], channels: usize) {
    for frame in samples.chunks_exact_mut(channels) {
        for (channel, sample) in frame.iter_mut().enumerate() {
            if let Some(filter) = filters.get_mut(channel) {
                *sample = filter.process(*sample);
            }
        }
    }
}

/// Direct-form-I transposed biquad with RBJ cookbook designs.
#[derive(Clone, Copy, Debug)]
struct Biquad {
    sample_rate: u32,
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
    bypass: bool,
}

impl Biquad {
    fn identity(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1: 0.0,
            z2: 0.0,
            bypass: true,
        }
    }

    fn from_coefficients(sample_rate: u32, b: [f32; 3], a: [f32; 3]) -> Self {
        let a0 = if a[0].abs() < 1.0e-9 { 1.0 } else { a[0] };
        Self {
            sample_rate,
            b0: b[0] / a0,
            b1: b[1] / a0,
            b2: b[2] / a0,
            a1: a[1] / a0,
            a2: a[2] / a0,
            z1: 0.0,
            z2: 0.0,
            bypass: false,
        }
    }

    fn omega(sample_rate: u32, frequency: f32) -> f32 {
        let nyquist_limited =
            frequency.clamp(MIN_CUTOFF_HZ, sample_rate.max(1) as f32 * MAX_CUTOFF_RATIO);
        2.0 * PI * nyquist_limited / sample_rate.max(1) as f32
    }

    fn peaking(sample_rate: u32, frequency: f32, q: f32, gain_db: f32) -> Self {
        if gain_db.abs() < 1.0e-3 {
            return Self::identity(sample_rate);
        }
        let a = 10.0f32.powf(gain_db / 40.0);
        let w = Self::omega(sample_rate, frequency);
        let (sin, cos) = w.sin_cos();
        let alpha = sin / (2.0 * q.max(0.1));
        Self::from_coefficients(
            sample_rate,
            [1.0 + alpha * a, -2.0 * cos, 1.0 - alpha * a],
            [1.0 + alpha / a, -2.0 * cos, 1.0 - alpha / a],
        )
    }

    fn low_shelf(sample_rate: u32, frequency: f32, gain_db: f32) -> Self {
        if gain_db.abs() < 1.0e-3 {
            return Self::identity(sample_rate);
        }
        let a = 10.0f32.powf(gain_db / 40.0);
        let w = Self::omega(sample_rate, frequency);
        let (sin, cos) = w.sin_cos();
        let alpha = sin / 2.0 * (2.0f32).sqrt(); // S = 1
        let sqrt_a2alpha = 2.0 * a.sqrt() * alpha;
        Self::from_coefficients(
            sample_rate,
            [
                a * ((a + 1.0) - (a - 1.0) * cos + sqrt_a2alpha),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                a * ((a + 1.0) - (a - 1.0) * cos - sqrt_a2alpha),
            ],
            [
                (a + 1.0) + (a - 1.0) * cos + sqrt_a2alpha,
                -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                (a + 1.0) + (a - 1.0) * cos - sqrt_a2alpha,
            ],
        )
    }

    fn high_shelf(sample_rate: u32, frequency: f32, gain_db: f32) -> Self {
        if gain_db.abs() < 1.0e-3 {
            return Self::identity(sample_rate);
        }
        let a = 10.0f32.powf(gain_db / 40.0);
        let w = Self::omega(sample_rate, frequency);
        let (sin, cos) = w.sin_cos();
        let alpha = sin / 2.0 * (2.0f32).sqrt();
        let sqrt_a2alpha = 2.0 * a.sqrt() * alpha;
        Self::from_coefficients(
            sample_rate,
            [
                a * ((a + 1.0) + (a - 1.0) * cos + sqrt_a2alpha),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                a * ((a + 1.0) + (a - 1.0) * cos - sqrt_a2alpha),
            ],
            [
                (a + 1.0) - (a - 1.0) * cos + sqrt_a2alpha,
                2.0 * ((a - 1.0) - (a + 1.0) * cos),
                (a + 1.0) - (a - 1.0) * cos - sqrt_a2alpha,
            ],
        )
    }

    fn low_pass(sample_rate: u32, cutoff: f32) -> Self {
        // Above ~0.45·fs the filter is audibly transparent; skip it entirely.
        if cutoff >= sample_rate.max(1) as f32 * MAX_CUTOFF_RATIO {
            return Self::identity(sample_rate);
        }
        let w = Self::omega(sample_rate, cutoff);
        let (sin, cos) = w.sin_cos();
        let alpha = sin / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
        Self::from_coefficients(
            sample_rate,
            [(1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0],
            [1.0 + alpha, -2.0 * cos, 1.0 - alpha],
        )
    }

    fn high_pass(sample_rate: u32, cutoff: f32) -> Self {
        if cutoff <= MIN_CUTOFF_HZ + 0.5 {
            return Self::identity(sample_rate);
        }
        let w = Self::omega(sample_rate, cutoff);
        let (sin, cos) = w.sin_cos();
        let alpha = sin / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
        Self::from_coefficients(
            sample_rate,
            [(1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0],
            [1.0 + alpha, -2.0 * cos, 1.0 - alpha],
        )
    }

    /// Replace coefficients while keeping the filter state (click-free retuning).
    fn retune(&mut self, next: Biquad) {
        self.b0 = next.b0;
        self.b1 = next.b1;
        self.b2 = next.b2;
        self.a1 = next.a1;
        self.a2 = next.a2;
        self.bypass = next.bypass;
        if next.bypass {
            self.z1 = 0.0;
            self.z2 = 0.0;
        }
    }

    fn process(&mut self, sample: f32) -> f32 {
        if self.bypass {
            return sample;
        }
        let sample = if sample.is_finite() { sample } else { 0.0 };
        let out = self.b0 * sample + self.z1;
        self.z1 = self.b1 * sample - self.a1 * out + self.z2;
        self.z2 = self.b2 * sample - self.a2 * out;
        if !out.is_finite() || !self.z1.is_finite() || !self.z2.is_finite() {
            self.z1 = 0.0;
            self.z2 = 0.0;
            return 0.0;
        }
        out
    }
}

/// Minimal Freeverb: four damped feedback combs in parallel followed by two all-passes.
struct Reverb {
    combs: Vec<Comb>,
    allpasses: Vec<Allpass>,
}

impl Reverb {
    fn new(sample_rate: u32) -> Self {
        let sample_rate = sample_rate.max(1) as f32;
        Self {
            combs: COMB_TUNING_SECS
                .iter()
                .map(|secs| Comb::new(((secs * sample_rate) as usize).max(1)))
                .collect(),
            allpasses: ALLPASS_TUNING_SECS
                .iter()
                .map(|secs| Allpass::new(((secs * sample_rate) as usize).max(1)))
                .collect(),
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        let mut out = 0.0;
        for comb in &mut self.combs {
            out += comb.process(input);
        }
        out *= 0.25;
        for allpass in &mut self.allpasses {
            out = allpass.process(out);
        }
        out
    }
}

struct Comb {
    buffer: Vec<f32>,
    index: usize,
    filter_store: f32,
}

impl Comb {
    fn new(len: usize) -> Self {
        Self {
            buffer: vec![0.0; len],
            index: 0,
            filter_store: 0.0,
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        let output = self.buffer[self.index];
        self.filter_store = output * (1.0 - COMB_DAMP) + self.filter_store * COMB_DAMP;
        let next = input + self.filter_store * COMB_FEEDBACK;
        self.buffer[self.index] = if next.is_finite() { next } else { 0.0 };
        self.index = (self.index + 1) % self.buffer.len();
        output
    }
}

struct Allpass {
    buffer: Vec<f32>,
    index: usize,
}

impl Allpass {
    fn new(len: usize) -> Self {
        Self {
            buffer: vec![0.0; len],
            index: 0,
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        let buffered = self.buffer[self.index];
        let output = -input + buffered;
        let next = input + buffered * ALLPASS_FEEDBACK;
        self.buffer[self.index] = if next.is_finite() { next } else { 0.0 };
        self.index = (self.index + 1) % self.buffer.len();
        output
    }
}

/// Feedback echo. The delay defaults to 500 ms (one beat at 120 BPM) and can be re-tuned
/// to the track tempo via [`DeckEffectChain::set_echo_beat_secs`].
struct Echo {
    buffer: Vec<f32>,
    index: usize,
    delay: usize,
}

impl Echo {
    fn new(sample_rate: u32) -> Self {
        let max_len = ((ECHO_MAX_SECS * sample_rate.max(1) as f32) as usize).max(1);
        Self {
            buffer: vec![0.0; max_len],
            index: 0,
            delay: ((0.5 * sample_rate.max(1) as f32) as usize).clamp(1, max_len),
        }
    }

    fn set_delay_frames(&mut self, frames: usize) {
        self.delay = frames.clamp(1, self.buffer.len());
    }

    fn process(&mut self, input: f32) -> f32 {
        let read_index = (self.index + self.buffer.len() - self.delay) % self.buffer.len();
        let delayed = self.buffer[read_index];
        let next = input + delayed * ECHO_FEEDBACK;
        self.buffer[self.index] = if next.is_finite() { next } else { 0.0 };
        self.index = (self.index + 1) % self.buffer.len();
        delayed
    }
}

impl DeckEffectChain {
    /// Tune echo stages to the deck's beat length so the repeats fall on the grid.
    pub fn set_echo_beat_secs(&mut self, beat_secs: f32) {
        if !beat_secs.is_finite() || beat_secs <= 0.0 {
            return;
        }
        let frames = (beat_secs * self.sample_rate as f32) as usize;
        for stage in &mut self.stages {
            if let StageKind::Echo(echoes) = &mut stage.kind {
                for echo in echoes {
                    echo.set_delay_frames(frames);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transition::plan::PlanTemplate;

    const SR: u32 = 48_000;

    fn sine(frequency: f32, frames: usize, channels: usize) -> Vec<f32> {
        (0..frames)
            .flat_map(|frame| {
                let value = (2.0 * PI * frequency * frame as f32 / SR as f32).sin() * 0.5;
                std::iter::repeat_n(value, channels)
            })
            .collect()
    }

    fn rms(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    fn run_chain_over_window(
        chain: &mut DeckEffectChain,
        input: &[f32],
        channels: usize,
    ) -> Vec<f32> {
        let mut output = input.to_vec();
        let total_frames = input.len() / channels;
        for (block_index, block) in output
            .chunks_mut(AUTOMATION_BLOCK_FRAMES * channels)
            .enumerate()
        {
            let pos = (block_index * AUTOMATION_BLOCK_FRAMES) as f32 / total_frames as f32;
            chain.process_block(block, pos);
        }
        output
    }

    #[test]
    fn gain_stage_follows_automation_from_unity_to_minus_twenty() {
        let plan = PlanTemplate::FallbackExchange.load();
        let mut chain = DeckEffectChain::new(&plan.a_chain, SR, 2);
        let input = sine(440.0, SR as usize, 2);
        let output = run_chain_over_window(&mut chain, &input, 2);
        let head = rms(&output[..4_800]);
        let tail = rms(&output[output.len() - 4_800..]);
        let head_in = rms(&input[..4_800]);
        assert!((head / head_in) > 0.9, "head ratio {}", head / head_in);
        // -20 dB gain, plus the low-shelf step at 0.5 removes 20 dB below 200 Hz (440 Hz is
        // only partly affected). Expect the tail to sit well below -15 dB.
        assert!(
            20.0 * (tail / head_in).log10() < -15.0,
            "tail dB {}",
            20.0 * (tail / head_in).log10()
        );
    }

    #[test]
    fn low_pass_sweep_attenuates_high_frequencies_only_when_closed() {
        let plan = PlanTemplate::SimpleFilter.load();
        // B chain: LPF 20 Hz → 8 kHz over the window.
        let mut chain = DeckEffectChain::new(&plan.b_chain, SR, 1);
        let input = sine(6_000.0, SR as usize * 2, 1);
        let output = run_chain_over_window(&mut chain, &input, 1);
        let early = rms(&output[SR as usize / 10..SR as usize / 5]);
        let late = rms(&output[output.len() - SR as usize / 10..]);
        let reference = rms(&input[..SR as usize / 10]);
        assert!(
            early < reference * 0.05,
            "early {early} reference {reference}"
        );
        // At the end the gain has recovered to 0 dB and the LPF sits at 8 kHz (> 6 kHz).
        assert!(late > reference * 0.5, "late {late} reference {reference}");
    }

    #[test]
    fn high_pass_sweep_removes_bass_from_deck_a() {
        let plan = PlanTemplate::SimpleFilter.load();
        let mut chain = DeckEffectChain::new(&plan.a_chain, SR, 1);
        let input = sine(80.0, SR as usize * 2, 1);
        let output = run_chain_over_window(&mut chain, &input, 1);
        let start = rms(&output[..SR as usize / 20]);
        let mid = rms(&output[SR as usize..SR as usize + SR as usize / 10]);
        let reference = rms(&input[..SR as usize / 20]);
        assert!(
            start > reference * 0.9,
            "start {start} reference {reference}"
        );
        assert!(mid < reference * 0.05, "mid {mid} reference {reference}");
    }

    #[test]
    fn shelving_eq_boost_and_cut_change_band_energy_in_the_right_direction() {
        let sample_rate = SR;
        let mut cut = Biquad::low_shelf(sample_rate, 200.0, -20.0);
        let mut boost = Biquad::high_shelf(sample_rate, 4_000.0, 6.0);
        let bass = sine(60.0, SR as usize, 1);
        let treble = sine(10_000.0, SR as usize, 1);
        let cut_out: Vec<f32> = bass.iter().map(|s| cut.process(*s)).collect();
        let boost_out: Vec<f32> = treble.iter().map(|s| boost.process(*s)).collect();
        let cut_db = 20.0 * (rms(&cut_out[24_000..]) / rms(&bass[24_000..])).log10();
        let boost_db = 20.0 * (rms(&boost_out[24_000..]) / rms(&treble[24_000..])).log10();
        assert!(cut_db < -17.0, "cut {cut_db}");
        assert!(boost_db > 4.5 && boost_db < 7.0, "boost {boost_db}");
    }

    #[test]
    fn reverb_and_echo_stages_produce_a_tail_after_input_stops() {
        let plan = PlanTemplate::ThreeBand.load();
        let mut chain = DeckEffectChain::new(&plan.a_chain, SR, 2);
        assert!(chain.has_tail());
        let input = sine(440.0, SR as usize, 2);
        let _ = run_chain_over_window(&mut chain, &input, 2);
        let mut tail = Vec::new();
        chain.drain_tail(4_800, 1.0, &mut tail);
        assert_eq!(tail.len(), 9_600);
        assert!(
            rms(&tail) > 1.0e-4,
            "reverb tail should ring: {}",
            rms(&tail)
        );

        let plan = PlanTemplate::EchoTail.load();
        let mut echo_chain = DeckEffectChain::new(&plan.a_chain, SR, 1);
        echo_chain.set_echo_beat_secs(0.1);
        // Let the step automation settle (mix 0 → 1 at pos 0.55, smoothed over ~30 ms).
        let mut warmup = vec![0.0f32; 9_600];
        echo_chain.process_block(&mut warmup, 0.9);
        let mut burst = vec![0.0f32; 4_800];
        burst[0] = 1.0;
        echo_chain.process_block(&mut burst, 0.9);
        assert!(burst[0].abs() > 0.99);
        assert!(burst[4_800 - 1].abs() < 1.0e-6);
        let mut tail = Vec::new();
        echo_chain.drain_tail(4_800, 1.0, &mut tail);
        // First repeat lands 0.1 s (4800 frames) after the impulse: at index 0 of the tail.
        assert!(tail[0].abs() > 0.9, "echo repeat missing: {}", tail[0]);
        assert!(tail[1..].iter().all(|s| s.abs() < 1.0e-3));
    }

    #[test]
    fn bypass_blend_releases_to_dry_signal() {
        let plan = PlanTemplate::SimpleFilter.load();
        let mut chain = DeckEffectChain::new(&plan.b_chain, SR, 1);
        let input = sine(6_000.0, 4_800, 1);
        let mut first = input.clone();
        chain.process_block(&mut first, 0.0);
        assert!(rms(&first) < rms(&input) * 0.1);
        chain.begin_bypass(480);
        let mut second = input.clone();
        chain.process_block(&mut second, 0.0);
        assert!(
            chain.is_empty(),
            "chain should be empty after the blend completes"
        );
        assert!((rms(&second[1_000..]) - rms(&input[1_000..])).abs() < 1.0e-4);
        let mut third = input.clone();
        chain.process_block(&mut third, 0.0);
        assert_eq!(third, input);
    }

    #[test]
    fn param_smoother_is_time_based_and_snaps_initial_value() {
        let mut smoother = ParamSmoother::new(SR);
        assert_eq!(smoother.next(-20.0, 256), -20.0);
        // 30 ms time constant: after 150 ms (5τ) the value is within 1 % of the target.
        let value = smoother.next(0.0, 7_200);
        assert!(value.abs() < 0.2, "value {value}");
        let mut blocks = ParamSmoother::new(SR);
        blocks.snap(-20.0);
        let mut value = -20.0;
        for _ in 0..(7_200 / 256) {
            value = blocks.next(0.0, 256);
        }
        // Many small blocks converge the same way as one large block.
        assert!(value.abs() < 0.3, "value {value}");
    }
}
