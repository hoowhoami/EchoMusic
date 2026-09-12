//! Dual-deck overlap mixer – the `SSAutoMixInst` equivalent.
//!
//! The mixer owns two decks. Deck A is the outgoing track starting at its cut point
//! (`cue1`), deck B is the incoming track starting at its entry point (`cue2`). Both decks
//! are fed already-converted interleaved f32 audio in the engine mix format. The mixer
//! renders the overlap window sample-accurately:
//!
//! ```text
//! A ─► [tempo stretch?] ─► A effect chain (plan A, automation over 0..1) ─┐
//!                                                                          ├─► + ─► out
//! B ─────────────────────► B effect chain (plan B, automation over 0..1) ─┘
//! ```
//!
//! * The automation position is `frames_rendered / overlap_frames`; positions past 1.0
//!   hold their final values, exactly like QQ's `SetPos`.
//! * Deck A's stretch ratio comes from the cue decision (`speedType = 2`). Stretching is
//!   done with the vendored SoundTouch WSOLA engine; the engine's initial latency is
//!   discarded so the first output frame corresponds to the cut point.
//! * Edge micro-fades (`_nEdgeOverlapSamples`) remove the residual click when A is
//!   truncated at -20 dB and when B starts mid-waveform.
//! * After A runs out, its chain is drained for reverb/echo tails; B's chain is blended
//!   back to dry over `POST_MIX_RELEASE_SECS` so the incoming track never stays filtered.

use super::effects::{DeckEffectChain, AUTOMATION_BLOCK_FRAMES};
use super::plan::DjPlan;
use soundtouch_rs::{InterpolationAlgorithm, SoundTouch, SoundTouchPreset};
use std::collections::VecDeque;
use std::f32::consts::FRAC_PI_2;

/// Length of the fade applied to the last frames of deck A.
pub const A_TAIL_FADE_SECS: f32 = 0.02;
/// Length of the fade applied to the first frames of deck B.
pub const B_HEAD_FADE_SECS: f32 = 0.005;
/// Time over which B's effect chain releases to dry after the overlap ends.
pub const POST_MIX_RELEASE_SECS: f32 = 0.1;
/// Upper bound on how long deck A's tail (reverb / echo) may ring after its input ends.
pub const MAX_A_TAIL_SECS: f32 = 2.0;
const STRETCH_MIN_RATIO: f32 = 0.5;
const STRETCH_MAX_RATIO: f32 = 2.0;
const STRETCH_CHUNK_FRAMES: usize = 2_048;
/// How much the side (L−R) component of the receding deck is narrowed at the crossover
/// (0 = plain L/R sum). Kept subtle: 25 % narrowing of the *fading* deck only.
const MS_SIDE_NARROWING: f32 = 0.25;

/// How the overlap window is shaped.
#[derive(Clone, Debug)]
pub struct MixerConfig {
    pub sample_rate: u32,
    pub channels: usize,
    /// Overlap length in output frames. With `0` the window counts as complete from the
    /// first frame (both decks are summed immediately and B's chain is released at once);
    /// gapless butt splices are handled by the decoder without a mixer.
    pub overlap_frames: usize,
    /// Plan driving both effect chains. `None` = plain pass-through decks (the caller
    /// shapes gains through `a_gain` / `b_gain` or relies on the edge fades only).
    pub plan: Option<DjPlan>,
    /// Tempo ratio applied to deck A (`>1` = faster). `1.0` disables stretching.
    pub a_tempo_ratio: f32,
    /// Linear gain applied to each deck after its chain (loudness normalisation).
    pub a_gain: f32,
    pub b_gain: f32,
    /// Beat length of A/B in seconds (tunes echo delays); `None` keeps defaults.
    pub a_beat_secs: Option<f32>,
    pub b_beat_secs: Option<f32>,
}

/// Input audio for one deck.
pub enum DeckInput<'a> {
    /// Interleaved f32 frames in mix format.
    Samples(&'a [f32]),
    /// No more audio will arrive for this deck.
    End,
}

#[derive(Debug, Default, PartialEq)]
pub struct MixerOutput {
    /// Interleaved mixed frames produced by this call.
    pub samples: Vec<f32>,
    /// Frames of deck B consumed from the B input queue by this call. Callers use it to
    /// keep B's timeline aligned with the produced output.
    pub b_frames_consumed: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DeckState {
    Active,
    /// Input has ended; remaining queued/stretched audio and the chain tail still play.
    Draining,
    Finished,
}

struct Deck {
    chain: DeckEffectChain,
    queue: VecDeque<f32>,
    state: DeckState,
    gain: f32,
}

impl Deck {
    fn queued_frames(&self, channels: usize) -> usize {
        self.queue.len() / channels
    }

    fn drain_frames(&mut self, frames: usize, channels: usize, into: &mut Vec<f32>) {
        let samples = frames.saturating_mul(channels).min(self.queue.len());
        into.extend(self.queue.drain(..samples));
    }
}

/// WSOLA time-stretch wrapper for deck A with an output side-buffer.
///
/// Where an input frame lands in SoundTouch's output depends on the WSOLA overlap
/// search (content-dependent, ±one seek window) *and* on the engine's start-up
/// behaviour, so neither `initial_latency()` nor a fixed formula gives the cut point
/// reliably. What *is* deterministic is the number of output frames the engine has emitted
/// after any given amount of input. The stretcher therefore calibrates with a twin engine:
/// the caller pre-rolls audio from before the cut ([`Stretcher::preroll`]); a twin engine
/// with identical settings is fed the same amount of silence followed by an impulse at the
/// cut and the impulse's output position is measured. That position is the discard count.
struct Stretcher {
    engine: SoundTouch,
    ratio: f32,
    sample_rate: u32,
    input_planar: Vec<Vec<f32>>,
    output_planar: Vec<Vec<f32>>,
    /// Stretched frames already pulled from the engine but not yet consumed.
    ready: VecDeque<f32>,
    /// Frames still to be discarded from the engine output.
    discard_frames: usize,
    /// Input frames fed as pre-roll (before the cut point).
    preroll_frames: usize,
    aligned: bool,
    flushed: bool,
}

impl Stretcher {
    fn new(ratio: f32, sample_rate: u32, channels: usize) -> Result<Self, String> {
        let engine = Self::build_engine(ratio, sample_rate, channels)?;
        Ok(Self {
            engine,
            ratio,
            sample_rate,
            input_planar: vec![Vec::new(); channels],
            output_planar: vec![vec![0.0; STRETCH_CHUNK_FRAMES]; channels],
            ready: VecDeque::new(),
            discard_frames: 0,
            preroll_frames: 0,
            aligned: false,
            flushed: false,
        })
    }

    fn build_engine(ratio: f32, sample_rate: u32, channels: usize) -> Result<SoundTouch, String> {
        SoundTouch::builder(channels, sample_rate as usize)
            .tempo(f64::from(ratio))
            .pitch(1.0)
            .rate(1.0)
            .preset(SoundTouchPreset::Music)
            .interpolation_algo(InterpolationAlgorithm::Shannon)
            .build()
            .map_err(|err| format!("failed to create transition stretcher: {err}"))
    }

    /// Input frames the caller should supply from before the cut so the engine is settled
    /// (≥ its latency in input frames, plus one seek window of slack).
    fn wanted_preroll_frames(&self) -> usize {
        let settle = (self.engine.initial_latency() as f32 * self.ratio.max(0.01)).ceil() as usize;
        settle + 4_096
    }

    /// Feed audio that precedes the cut point (settles the engine; not rendered).
    fn preroll(&mut self, interleaved: &[f32]) {
        let channels = self.channels();
        self.preroll_frames += interleaved.len() / channels;
        self.feed_engine(interleaved);
    }

    fn feed_engine(&mut self, interleaved: &[f32]) {
        let channels = self.channels();
        for channel in &mut self.input_planar {
            channel.clear();
        }
        for frame in interleaved.chunks_exact(channels) {
            for (channel, sample) in frame.iter().enumerate() {
                self.input_planar[channel].push(*sample);
            }
        }
        let _ = self.engine.put_samples(&self.input_planar);
    }

    /// Determine how many output frames precede the cut point by running a twin engine
    /// over `preroll_frames` of silence followed by an impulse. Output-frame counts are
    /// content-independent, so the twin's impulse position equals the real cut position
    /// up to WSOLA's within-window jitter.
    fn calibrate_discard(&mut self) {
        if self.aligned {
            return;
        }
        self.aligned = true;
        let Ok(mut twin) = Self::build_engine(self.ratio, self.sample_rate, 1) else {
            self.discard_frames = self.engine.initial_latency();
            return;
        };
        let tail = (self.engine.initial_latency() * 2).max(8_192);
        let total = self.preroll_frames + tail;
        let mut probe = vec![0.0f32; total];
        // A short raised-cosine burst rather than a single-sample impulse: WSOLA's
        // overlap-add smears an impulse into two copies, a burst keeps one centroid.
        let burst = (self.sample_rate as usize / 1_000).max(16);
        for i in 0..burst.min(tail) {
            let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / burst as f32).cos();
            probe[self.preroll_frames + i] = w;
        }
        let mut output = Vec::with_capacity(total * 2);
        let mut planar = vec![vec![0.0f32; STRETCH_CHUNK_FRAMES]];
        for chunk in probe.chunks(STRETCH_CHUNK_FRAMES) {
            if twin.put_samples(&[chunk]).is_err() {
                break;
            }
            loop {
                let received = twin.receive_samples(&mut planar).unwrap_or(0);
                if received == 0 {
                    break;
                }
                output.extend_from_slice(&planar[0][..received]);
            }
        }
        let _ = twin.flush();
        loop {
            let received = twin.receive_samples(&mut planar).unwrap_or(0);
            if received == 0 {
                break;
            }
            output.extend_from_slice(&planar[0][..received]);
        }
        // Energy centroid of the burst in the output → onset ≈ centroid − burst/2.
        let mut weight = 0.0f64;
        let mut moment = 0.0f64;
        for (index, sample) in output.iter().enumerate() {
            let energy = f64::from(*sample) * f64::from(*sample);
            weight += energy;
            moment += energy * index as f64;
        }
        self.discard_frames = if weight > 1.0e-9 {
            ((moment / weight) - burst as f64 / (2.0 * f64::from(self.ratio.max(0.01))))
                .round()
                .max(0.0) as usize
        } else {
            (self.preroll_frames as f32 / self.ratio.max(0.01)).round() as usize
        };
    }

    fn channels(&self) -> usize {
        self.input_planar.len().max(1)
    }

    fn put(&mut self, interleaved: &[f32]) {
        self.calibrate_discard();
        self.feed_engine(interleaved);
        self.pull_engine();
    }

    fn flush(&mut self) {
        if !self.flushed {
            self.flushed = true;
            self.calibrate_discard();
            let _ = self.engine.flush();
            self.pull_engine();
        }
    }

    /// Move everything the engine has produced into `ready`, dropping the frames that
    /// precede the cut point (`discard_frames`, settled by `finish_preroll`).
    fn pull_engine(&mut self) {
        let channels = self.channels();
        loop {
            let received = self
                .engine
                .receive_samples(&mut self.output_planar)
                .unwrap_or(0);
            if received == 0 {
                break;
            }
            let skip = self.discard_frames.min(received);
            self.discard_frames -= skip;
            for index in skip..received {
                for channel in 0..channels {
                    self.ready.push_back(self.output_planar[channel][index]);
                }
            }
        }
    }

    fn ready_frames(&self) -> usize {
        self.ready.len() / self.channels()
    }

    fn take(&mut self, frames: usize, into: &mut Vec<f32>) -> usize {
        let channels = self.channels();
        let frames = frames.min(self.ready_frames());
        into.extend(self.ready.drain(..frames * channels));
        frames
    }
}

pub struct TransitionMixer {
    sample_rate: u32,
    channels: usize,
    overlap_frames: usize,
    rendered_frames: usize,
    a: Deck,
    b: Deck,
    stretcher: Option<Stretcher>,
    a_tail_fade_frames: usize,
    b_head_fade_frames: usize,
    b_started: bool,
    a_drained_frames: usize,
    max_a_tail_frames: usize,
    b_release_started: bool,
    finished: bool,
    scratch_a: Vec<f32>,
    scratch_b: Vec<f32>,
}

impl TransitionMixer {
    pub fn new(config: MixerConfig) -> Result<Self, String> {
        let sample_rate = config.sample_rate.max(1);
        let channels = config.channels.max(1);
        let (mut a_chain, mut b_chain) = match config.plan.as_ref() {
            Some(plan) => (
                DeckEffectChain::new(&plan.a_chain, sample_rate, channels),
                DeckEffectChain::new(&plan.b_chain, sample_rate, channels),
            ),
            None => (
                DeckEffectChain::passthrough(sample_rate, channels),
                DeckEffectChain::passthrough(sample_rate, channels),
            ),
        };
        if let Some(beat) = config.a_beat_secs {
            a_chain.set_echo_beat_secs(beat);
        }
        if let Some(beat) = config.b_beat_secs {
            b_chain.set_echo_beat_secs(beat);
        }
        let ratio = if config.a_tempo_ratio.is_finite() {
            config
                .a_tempo_ratio
                .clamp(STRETCH_MIN_RATIO, STRETCH_MAX_RATIO)
        } else {
            1.0
        };
        let stretcher = if (ratio - 1.0).abs() > 1.0e-3 {
            Some(Stretcher::new(ratio, sample_rate, channels)?)
        } else {
            None
        };
        let max_a_tail_frames = if a_chain.has_tail() {
            ((MAX_A_TAIL_SECS * sample_rate as f32) as usize).min(a_chain.tail_frames())
        } else {
            0
        };
        Ok(Self {
            sample_rate,
            channels,
            overlap_frames: config.overlap_frames,
            rendered_frames: 0,
            a: Deck {
                chain: a_chain,
                queue: VecDeque::new(),
                state: DeckState::Active,
                gain: sanitize_gain(config.a_gain),
            },
            b: Deck {
                chain: b_chain,
                queue: VecDeque::new(),
                state: DeckState::Active,
                gain: sanitize_gain(config.b_gain),
            },
            stretcher,
            a_tail_fade_frames: (A_TAIL_FADE_SECS * sample_rate as f32) as usize,
            b_head_fade_frames: (B_HEAD_FADE_SECS * sample_rate as f32) as usize,
            b_started: false,
            a_drained_frames: 0,
            max_a_tail_frames,
            b_release_started: false,
            finished: false,
            scratch_a: Vec::new(),
            scratch_b: Vec::new(),
        })
    }

    /// Normalised overlap position for the next frame to be rendered.
    pub fn position(&self) -> f32 {
        if self.overlap_frames == 0 {
            return 1.0;
        }
        self.rendered_frames as f32 / self.overlap_frames as f32
    }

    /// Everything the mixer had to render is done; the caller continues with deck B's
    /// remaining audio directly (see [`TransitionMixer::take_b_remainder`]).
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    pub fn a_finished(&self) -> bool {
        self.a.state == DeckState::Finished
    }

    pub fn push_a(&mut self, input: DeckInput<'_>) {
        match input {
            DeckInput::Samples(samples) => {
                if self.a.state == DeckState::Active {
                    match self.stretcher.as_mut() {
                        Some(stretcher) => stretcher.put(samples),
                        None => self.a.queue.extend(samples.iter().copied()),
                    }
                }
            }
            DeckInput::End => {
                if self.a.state == DeckState::Active {
                    self.a.state = DeckState::Draining;
                    if let Some(stretcher) = self.stretcher.as_mut() {
                        stretcher.flush();
                    }
                }
            }
        }
    }

    pub fn push_b(&mut self, input: DeckInput<'_>) {
        match input {
            DeckInput::Samples(samples) => {
                if self.b.state == DeckState::Active {
                    self.b.queue.extend(samples.iter().copied());
                }
            }
            DeckInput::End => {
                if self.b.state == DeckState::Active {
                    self.b.state = DeckState::Draining;
                }
            }
        }
    }

    /// Input frames of deck A from *before* the cut point that [`TransitionMixer::preroll_a`]
    /// can use to settle the tempo stretcher (0 when A is not stretched).
    pub fn a_preroll_frames_wanted(&self) -> usize {
        self.stretcher
            .as_ref()
            .map(|stretcher| stretcher.wanted_preroll_frames())
            .unwrap_or(0)
    }

    /// Feed deck-A audio that precedes the cut point. Must be called before any
    /// [`TransitionMixer::push_a`]; the audio is not rendered, only used to settle the
    /// stretcher. Ignored when A is not stretched.
    pub fn preroll_a(&mut self, samples: &[f32]) {
        if let Some(stretcher) = self.stretcher.as_mut() {
            stretcher.preroll(samples);
        }
    }

    /// Frames of B that have been pushed but not consumed yet.
    pub fn b_queued_frames(&self) -> usize {
        self.b.queued_frames(self.channels)
    }

    /// Frames of A (post-stretch) that have been pushed but not consumed yet.
    pub fn a_queued_frames(&self) -> usize {
        self.a_ready_frames()
    }

    /// Hand back un-mixed B audio after the mixer has finished.
    pub fn take_b_remainder(&mut self) -> Vec<f32> {
        self.b.queue.drain(..).collect()
    }

    /// Frames of A audio (post-stretch) currently available to render.
    fn a_ready_frames(&self) -> usize {
        match self.stretcher.as_ref() {
            Some(stretcher) => stretcher.ready_frames(),
            None => self.a.queued_frames(self.channels),
        }
    }

    /// Render up to `max_frames` frames. Returns fewer frames when a deck is waiting for
    /// input; zero frames with `is_finished() == true` marks the end of the mix.
    pub fn render(&mut self, max_frames: usize) -> MixerOutput {
        let mut output = MixerOutput::default();
        if self.finished || max_frames == 0 {
            return output;
        }
        let channels = self.channels;
        let mut produced = 0usize;

        while produced < max_frames {
            self.refresh_state();
            if self.finished {
                break;
            }
            let want = AUTOMATION_BLOCK_FRAMES.min(max_frames - produced);
            let frames = match self.frames_available(want) {
                Some(frames) => frames,
                None => break,
            };
            if frames == 0 {
                break;
            }
            self.pull_a(frames);
            self.pull_b(frames);
            let pos = self.position();

            if !self.scratch_a.is_empty() {
                self.a.chain.process_block(&mut self.scratch_a, pos);
            }
            if !self.scratch_b.is_empty() {
                if !self.b_started {
                    apply_head_fade(&mut self.scratch_b, self.b_head_fade_frames, channels);
                    self.b_started = true;
                }
                self.b.chain.process_block(&mut self.scratch_b, pos);
            }
            output.b_frames_consumed += self.scratch_b.len() / channels;

            let start = output.samples.len();
            output.samples.resize(start + frames * channels, 0.0);
            let block = &mut output.samples[start..];
            let a_gain = self.a.gain;
            let b_gain = self.b.gain;
            if channels == 2 {
                // Mid/side summing (`AutoMix: MS (Mid-Side) processing enabled`): the two
                // decks are combined in the M/S domain with the side component of the
                // *quieter* deck slightly narrowed towards the crossover, so two wide mixes
                // do not smear into a phasey stereo image while both are audible.
                let pos = self.position().clamp(0.0, 1.0);
                let a_side = 1.0 - MS_SIDE_NARROWING * (pos * FRAC_PI_2).sin();
                let b_side = 1.0 - MS_SIDE_NARROWING * (pos * FRAC_PI_2).cos();
                for (frame_index, frame) in block.chunks_exact_mut(2).enumerate() {
                    let ai = frame_index * 2;
                    let al = self.scratch_a.get(ai).copied().unwrap_or(0.0) * a_gain;
                    let ar = self.scratch_a.get(ai + 1).copied().unwrap_or(0.0) * a_gain;
                    let bl = self.scratch_b.get(ai).copied().unwrap_or(0.0) * b_gain;
                    let br = self.scratch_b.get(ai + 1).copied().unwrap_or(0.0) * b_gain;
                    let mid = 0.5 * (al + ar) + 0.5 * (bl + br);
                    let side = 0.5 * (al - ar) * a_side + 0.5 * (bl - br) * b_side;
                    frame[0] = mid + side;
                    frame[1] = mid - side;
                }
            } else {
                for (index, sample) in block.iter_mut().enumerate() {
                    let a = self.scratch_a.get(index).copied().unwrap_or(0.0) * a_gain;
                    let b = self.scratch_b.get(index).copied().unwrap_or(0.0) * b_gain;
                    *sample = a + b;
                }
            }
            produced += frames;
            self.rendered_frames += frames;
        }
        self.refresh_state();
        output
    }

    /// Number of frames both decks can supply for the next block, or `None` when a deck
    /// that is still active cannot supply anything yet. Deck states are settled by
    /// [`TransitionMixer::refresh_state`] before this is called.
    fn frames_available(&self, want: usize) -> Option<usize> {
        let a_ready = self.a_ready_frames();
        let b_ready = self.b.queued_frames(self.channels);
        // An active deck with nothing queued stalls the mix (its audio must not be
        // skipped); a draining deck supplies what it has, then its tail budget.
        let a_supply = match self.a.state {
            DeckState::Active => {
                if a_ready == 0 {
                    return None;
                }
                a_ready.min(want)
            }
            DeckState::Draining => {
                if a_ready > 0 {
                    a_ready.min(want)
                } else {
                    (self.max_a_tail_frames - self.a_drained_frames).min(want)
                }
            }
            DeckState::Finished => 0,
        };
        let b_supply = match self.b.state {
            DeckState::Active => {
                if b_ready == 0 {
                    return None;
                }
                b_ready.min(want)
            }
            DeckState::Draining => b_ready.min(want),
            DeckState::Finished => 0,
        };
        Some(match (self.a.state, self.b.state) {
            (DeckState::Finished, DeckState::Finished) => 0,
            (DeckState::Finished, _) => b_supply,
            (_, DeckState::Finished) => a_supply,
            _ => a_supply.min(b_supply),
        })
    }

    /// Settle lazy deck-state transitions and the overall completion flag.
    fn refresh_state(&mut self) {
        let overlap_done = self.rendered_frames >= self.overlap_frames;
        if overlap_done && !self.b_release_started {
            self.b_release_started = true;
            let release = (POST_MIX_RELEASE_SECS * self.sample_rate as f32) as usize;
            self.b.chain.begin_bypass(release.max(1));
        }
        if self.a.state == DeckState::Draining
            && self.a_ready_frames() == 0
            && !(self.a.chain.has_tail() && self.a_drained_frames < self.max_a_tail_frames)
        {
            self.a.state = DeckState::Finished;
        }
        if self.b.state == DeckState::Draining && self.b.queued_frames(self.channels) == 0 {
            self.b.state = DeckState::Finished;
        }
        if self.a.state == DeckState::Finished
            && ((overlap_done && self.b.chain.is_empty()) || self.b.state == DeckState::Finished)
        {
            self.finished = true;
        }
    }

    fn pull_a(&mut self, frames: usize) {
        let channels = self.channels;
        self.scratch_a.clear();
        if frames == 0 || self.a.state == DeckState::Finished {
            return;
        }
        let taken = match self.stretcher.as_mut() {
            Some(stretcher) => stretcher.take(frames, &mut self.scratch_a),
            None => {
                let available = self.a.queued_frames(channels).min(frames);
                self.a
                    .drain_frames(available, channels, &mut self.scratch_a);
                available
            }
        };
        if self.a.state == DeckState::Draining {
            if taken > 0 {
                let remaining_after = self.a_ready_frames();
                apply_tail_fade(
                    &mut self.scratch_a,
                    remaining_after,
                    self.a_tail_fade_frames,
                    channels,
                );
            }
            if taken < frames {
                // Input is exhausted: zero-pad the block so the chain rings its reverb /
                // echo tail, and account the padded frames against the tail budget.
                let padded = frames - taken;
                self.scratch_a.resize(frames * channels, 0.0);
                self.a_drained_frames += padded;
                if self.a_drained_frames >= self.max_a_tail_frames {
                    self.a.state = DeckState::Finished;
                }
            }
        }
    }

    fn pull_b(&mut self, frames: usize) {
        let channels = self.channels;
        self.scratch_b.clear();
        if frames == 0 || self.b.state == DeckState::Finished {
            return;
        }
        let available = self.b.queued_frames(channels).min(frames);
        self.b
            .drain_frames(available, channels, &mut self.scratch_b);
    }

    /// Force the mix to end now (seek / stop during the overlap). Deck A is dropped and
    /// B's chain is released immediately.
    pub fn abort_a(&mut self) {
        self.a.queue.clear();
        self.a.state = DeckState::Finished;
        self.stretcher = None;
        self.b_release_started = true;
        self.b.chain.begin_bypass(1);
        let mut silence = vec![0.0f32; self.channels];
        self.b.chain.process_block(&mut silence, 1.0);
        self.finished = true;
    }
}

fn sanitize_gain(gain: f32) -> f32 {
    if gain.is_finite() {
        gain.clamp(0.0, 16.0)
    } else {
        1.0
    }
}

fn apply_head_fade(samples: &mut [f32], fade_frames: usize, channels: usize) {
    if fade_frames == 0 {
        return;
    }
    for (frame_index, frame) in samples.chunks_exact_mut(channels).enumerate() {
        if frame_index >= fade_frames {
            break;
        }
        let gain = ((frame_index + 1) as f32 / (fade_frames + 1) as f32 * FRAC_PI_2).sin();
        for sample in frame {
            *sample *= gain;
        }
    }
}

/// Fade the end of deck A. `remaining_after` is how many A frames will still follow this
/// block, so the fade lands on the true last frames of the deck.
fn apply_tail_fade(
    samples: &mut [f32],
    remaining_after: usize,
    fade_frames: usize,
    channels: usize,
) {
    if fade_frames == 0 {
        return;
    }
    let frames = samples.len() / channels;
    for (frame_index, frame) in samples.chunks_exact_mut(channels).enumerate() {
        let distance_to_end = remaining_after + (frames - frame_index); // ≥ 1
        if distance_to_end > fade_frames {
            continue;
        }
        let gain = (distance_to_end as f32 / (fade_frames + 1) as f32 * FRAC_PI_2).sin();
        for sample in frame {
            *sample *= gain;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transition::plan::PlanTemplate;

    const SR: u32 = 48_000;

    fn tone(frequency: f32, amplitude: f32, frames: usize, channels: usize) -> Vec<f32> {
        (0..frames)
            .flat_map(|frame| {
                let v = (2.0 * std::f32::consts::PI * frequency * frame as f32 / SR as f32).sin()
                    * amplitude;
                std::iter::repeat_n(v, channels)
            })
            .collect()
    }

    fn rms(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    fn config(overlap_frames: usize, plan: Option<DjPlan>) -> MixerConfig {
        MixerConfig {
            sample_rate: SR,
            channels: 2,
            overlap_frames,
            plan,
            a_tempo_ratio: 1.0,
            a_gain: 1.0,
            b_gain: 1.0,
            a_beat_secs: None,
            b_beat_secs: None,
        }
    }

    /// Feed all of A and B, then render until the mixer reports completion.
    fn run_to_completion(mixer: &mut TransitionMixer, a: &[f32], b: &[f32]) -> Vec<f32> {
        mixer.push_a(DeckInput::Samples(a));
        mixer.push_a(DeckInput::End);
        mixer.push_b(DeckInput::Samples(b));
        let mut out = Vec::new();
        for _ in 0..100_000 {
            let rendered = mixer.render(1_024);
            out.extend_from_slice(&rendered.samples);
            if mixer.is_finished() {
                break;
            }
            if rendered.samples.is_empty() {
                // B starved: declare its end so the mixer can wind down.
                mixer.push_b(DeckInput::End);
            }
        }
        assert!(mixer.is_finished(), "mixer never finished");
        out
    }

    #[test]
    fn butt_splice_keeps_a_sample_exact_and_hands_b_back() {
        let mut mixer = TransitionMixer::new(config(0, None)).expect("mixer");
        let a = tone(440.0, 0.5, 4_800, 2);
        let b = tone(220.0, 0.5, 4_800, 2);
        mixer.push_a(DeckInput::Samples(&a));
        mixer.push_a(DeckInput::End);
        mixer.push_b(DeckInput::Samples(&b));
        let mut out = Vec::new();
        let mut consumed = 0;
        while !mixer.is_finished() {
            let rendered = mixer.render(512);
            if rendered.samples.is_empty() {
                assert!(mixer.is_finished(), "empty render must mean finished");
                break;
            }
            consumed += rendered.b_frames_consumed;
            out.extend_from_slice(&rendered.samples);
        }
        // Overlap 0: both decks are summed from the first frame (A tail-faded over the
        // last 20 ms, B head-faded over 5 ms); after A ends, the remaining B is handed
        // back untouched so the caller continues sample-exactly.
        let probe = 1_000 * 2;
        assert!((out[probe] - (a[probe] + b[probe])).abs() < 1.0e-5);
        let last_a = (4_800 - 1) * 2;
        assert!(out[last_a].abs() <= b[last_a].abs() + 0.05);
        assert_eq!(out.len(), a.len());
        assert_eq!(consumed, 4_800);
        assert!(mixer.take_b_remainder().is_empty());
    }

    #[test]
    fn plain_crossfade_conserves_energy_with_equal_power_plan() {
        let plan = PlanTemplate::NoPlan.load();
        let overlap = SR as usize * 2;
        let mut mixer = TransitionMixer::new(config(overlap, Some(plan))).expect("mixer");
        let a = tone(1_000.0, 0.4, overlap, 2);
        let b = tone(1_300.0, 0.4, overlap + SR as usize, 2);
        let out = run_to_completion(&mut mixer, &a, &b);
        assert!(out.len() >= overlap * 2, "out {}", out.len());
        let head = rms(&out[..9_600]);
        let mid = rms(&out[overlap - 4_800..overlap + 4_800]);
        let tail = rms(&out[overlap * 2 - 9_600..overlap * 2]);
        // Head ≈ A alone, tail ≈ B alone (0.4 / √2 ≈ 0.283 each, A slightly dimmed by
        // the fade-in of B); the midpoint must neither dip nor overshoot much.
        assert!((head - 0.283).abs() < 0.06, "head {head}");
        assert!((tail - 0.283).abs() < 0.06, "tail {tail}");
        assert!(mid > 0.18 && mid < 0.36, "mid {mid}");
        assert!(out.iter().all(|s| s.abs() <= 1.0));
    }

    #[test]
    fn mixer_consumes_b_exactly_as_many_frames_as_it_renders() {
        let plan = PlanTemplate::SimpleExchange.load();
        let overlap = 24_000;
        let mut mixer = TransitionMixer::new(config(overlap, Some(plan))).expect("mixer");
        mixer.push_a(DeckInput::Samples(&tone(500.0, 0.3, overlap, 2)));
        mixer.push_a(DeckInput::End);
        mixer.push_b(DeckInput::Samples(&tone(700.0, 0.3, 30_000, 2)));
        let mut total_frames = 0;
        let mut consumed = 0;
        loop {
            let rendered = mixer.render(1_000);
            total_frames += rendered.samples.len() / 2;
            consumed += rendered.b_frames_consumed;
            if mixer.is_finished() || rendered.samples.is_empty() {
                break;
            }
        }
        assert_eq!(consumed, total_frames);
        assert_eq!(consumed + mixer.b_queued_frames(), 30_000);
        assert!(mixer.is_finished());
        assert_eq!(mixer.take_b_remainder().len(), (30_000 - consumed) * 2);
    }

    #[test]
    fn starved_deck_returns_partial_output_and_resumes() {
        let mut mixer = TransitionMixer::new(config(4_800, None)).expect("mixer");
        mixer.push_a(DeckInput::Samples(&tone(440.0, 0.5, 4_800, 2)));
        mixer.push_a(DeckInput::End);
        mixer.push_b(DeckInput::Samples(&tone(220.0, 0.5, 1_024, 2)));
        let first = mixer.render(4_096);
        assert_eq!(first.samples.len() / 2, 1_024);
        assert_eq!(first.b_frames_consumed, 1_024);
        assert!(!mixer.is_finished());
        let starved = mixer.render(4_096);
        assert!(starved.samples.is_empty());
        mixer.push_b(DeckInput::Samples(&tone(220.0, 0.5, 8_000, 2)));
        let second = mixer.render(4_096);
        // 3 776 frames of A remain (4 800 − 1 024); the mixer stops exactly when A ends
        // because the overlap window is complete and B's chain has nothing to release.
        assert_eq!(second.samples.len() / 2, 3_776);
        assert!(mixer.is_finished());
        assert_eq!(mixer.take_b_remainder().len() / 2, 1_024 + 8_000 - 4_800);
    }

    #[test]
    fn stretched_deck_a_renders_shorter_when_sped_up() {
        let mut cfg = config(SR as usize, None);
        cfg.a_tempo_ratio = 1.25;
        let mut mixer = TransitionMixer::new(cfg).expect("mixer");
        let a = tone(440.0, 0.5, SR as usize * 2, 2);
        let b = tone(220.0, 0.5, SR as usize * 3, 2);
        mixer.push_a(DeckInput::Samples(&a));
        mixer.push_a(DeckInput::End);
        mixer.push_b(DeckInput::Samples(&b));
        let mut rendered_until_a_done = 0usize;
        for _ in 0..1_000 {
            let out = mixer.render(2_048);
            rendered_until_a_done += out.samples.len() / 2;
            if mixer.a_finished() || out.samples.is_empty() {
                break;
            }
        }
        // 2 s of A at 1.25× ≈ 1.6 s of output (± one WSOLA sequence).
        let expected = (SR as f32 * 2.0 / 1.25) as usize;
        assert!(
            (rendered_until_a_done as i64 - expected as i64).unsigned_abs() < 6_000,
            "rendered {rendered_until_a_done}, expected ≈ {expected}"
        );
    }

    #[test]
    fn a_reverb_tail_rings_after_input_ends_then_mixer_finishes() {
        let plan = PlanTemplate::ThreeBand.load();
        let overlap = 24_000;
        let mut mixer = TransitionMixer::new(config(overlap, Some(plan))).expect("mixer");
        let a = tone(440.0, 0.5, overlap, 2);
        let b = tone(220.0, 0.5, overlap * 4, 2);
        let out = run_to_completion(&mut mixer, &a, &b);
        // The mixer keeps rendering (A tail + B) for up to MAX_A_TAIL_SECS after A ends.
        assert!(
            out.len() / 2 > overlap,
            "tail should extend past the overlap"
        );
        assert!(out.len() / 2 <= overlap + (MAX_A_TAIL_SECS * SR as f32) as usize + 1_024);
    }

    #[test]
    fn abort_a_finishes_mix_immediately() {
        let plan = PlanTemplate::ThreeBand.load();
        let mut mixer = TransitionMixer::new(config(SR as usize * 4, Some(plan))).expect("mixer");
        mixer.push_a(DeckInput::Samples(&tone(440.0, 0.5, SR as usize, 2)));
        mixer.push_b(DeckInput::Samples(&tone(220.0, 0.5, SR as usize, 2)));
        let _ = mixer.render(2_048);
        mixer.abort_a();
        assert!(mixer.is_finished());
        assert!(!mixer.take_b_remainder().is_empty());
    }

    #[test]
    fn mid_side_sum_keeps_mono_content_exact_and_only_narrows_the_fading_side() {
        // Mono-in-stereo A + mono-in-stereo B: M/S summing must equal the plain sum.
        let mut mixer = TransitionMixer::new(config(4_800, None)).expect("mixer");
        let a = tone(440.0, 0.4, 4_800, 2);
        let b = tone(660.0, 0.4, 4_800, 2);
        mixer.push_a(DeckInput::Samples(&a));
        mixer.push_a(DeckInput::End);
        mixer.push_b(DeckInput::Samples(&b));
        let out = mixer.render(4_800).samples;
        // Skip B's 5 ms head fade and A's 20 ms tail fade, both applied per deck.
        for i in (2 * 300..out.len() - 2 * 1_000).step_by(97) {
            let expected = a[i] + b[i];
            assert!(
                (out[i] - expected).abs() < 1.0e-5,
                "index {i}: {} vs {expected}",
                out[i]
            );
        }
        // Pure side content on A (L = −R) at the *end* of the window is narrowed by 25 %.
        let mut mixer = TransitionMixer::new(config(4_800, None)).expect("mixer");
        let side: Vec<f32> = (0..4_800).flat_map(|_| [0.5f32, -0.5f32]).collect();
        mixer.push_a(DeckInput::Samples(&side));
        mixer.push_a(DeckInput::End);
        mixer.push_b(DeckInput::Samples(&vec![0.0f32; 9_600]));
        let out = mixer.render(4_800).samples;
        assert!(
            (out[0] - 0.5).abs() < 1.0e-5,
            "start of window untouched: {}",
            out[0]
        );
        let last = out.len() - 2;
        // 20 ms tail fade also applies to the very last frames; probe just before it.
        let probe = last - 2 * 1_200;
        assert!(
            (out[probe] - 0.5 * (1.0 - 0.25 * (0.75f32 * std::f32::consts::FRAC_PI_2).sin())).abs()
                < 0.02,
            "{}",
            out[probe]
        );
    }

    #[test]
    fn head_and_tail_fades_are_monotonic_and_bounded() {
        let mut samples = vec![1.0f32; 10 * 2];
        apply_head_fade(&mut samples, 4, 2);
        assert!(samples[0] < samples[2] && samples[2] < samples[4] && samples[6] < 1.0);
        assert_eq!(samples[8], 1.0);
        let mut tail = vec![1.0f32; 10 * 2];
        apply_tail_fade(&mut tail, 0, 4, 2);
        assert_eq!(tail[0], 1.0);
        assert!(tail[12] > tail[14] && tail[14] > tail[16] && tail[16] > tail[18]);
        // With frames still to come after this block, the fade has not started yet.
        let mut later = vec![1.0f32; 10 * 2];
        apply_tail_fade(&mut later, 10, 4, 2);
        assert!(later.iter().all(|s| *s == 1.0));
    }
}

#[cfg(test)]
mod stretch_alignment_tests {
    use super::*;

    /// A 3 ms marker burst placed exactly at the cut must appear at (or within a few ms of)
    /// the first kept output frame, for both slow-down and speed-up ratios.
    #[test]
    fn preroll_alignment_puts_the_cut_at_the_first_kept_frame() {
        let sr = 48_000u32;
        for ratio in [1.05f32, 0.95, 1.3, 0.75] {
            let frames = 2 * sr as usize;
            let cut = sr as usize;
            let mut signal: Vec<f32> = (0..frames)
                .map(|i| {
                    let t = i as f32 / sr as f32;
                    0.3 * (2.0 * std::f32::consts::PI * (5.0 * t + 40.0 * t * t)).sin()
                })
                .collect();
            let burst = 144usize;
            for i in 0..burst {
                let w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / burst as f32).cos();
                signal[cut + i] += w;
            }
            let mut stretcher = Stretcher::new(ratio, sr, 1).expect("stretcher");
            let preroll = stretcher.wanted_preroll_frames();
            stretcher.preroll(&signal[cut - preroll..cut]);
            for chunk in signal[cut..].chunks(2_048) {
                stretcher.put(chunk);
            }
            stretcher.flush();
            let mut out = Vec::new();
            stretcher.take(20_000, &mut out);
            let mut best = (0usize, 0.0f32);
            for i in 0..out.len().saturating_sub(burst) {
                let energy: f32 = out[i..i + burst].iter().map(|v| v * v).sum();
                if energy > best.1 {
                    best = (i, energy);
                }
            }
            let error_ms = best.0 as f32 / sr as f32 * 1_000.0;
            assert!(
                error_ms < 8.0,
                "ratio {ratio}: cut marker lands {error_ms:.1} ms into the kept output"
            );
        }
    }
}
