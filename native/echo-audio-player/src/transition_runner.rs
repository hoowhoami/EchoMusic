//! Runtime side of song transitions inside the decode worker.
//!
//! [`ArmedTransition`] is produced when the next source is prepared (its decoder is
//! already seeked to the incoming cue point and pre-decoded). The decode worker calls
//! [`TransitionRunner`] once the outgoing decoder reaches the cut point; the runner then
//! owns both decoders until the mix is over and hands the incoming decoder back.
//!
//! All mixing happens here, on the decode thread, in the engine mix format. The output
//! queue receives ordinary f32 chunks, so the filter thread and the output callback never
//! know that two tracks were involved – the only visible change is the continuous track
//! boundary (clock / sequence / loudness switch) marked when the first mixed sample is
//! queued.

use crate::audio_graph::SwrMixConverter;
use crate::decoder::{decoded_chunk_end_secs, DecoderData};
use crate::shared::{
    AudioSampleFormat, DecodedAudioChunk, DecodedAudioData, DecodedAudioFormat, MixFormat,
    SharedAudio, TrackSwitchInfo,
};
use crate::transition::decide::TransitionPlan;
use crate::transition::mixer::{DeckInput, MixerConfig, TransitionMixer};
use crate::transition::TransitionMode;

/// Frames rendered per mixer call.
const RENDER_BLOCK_FRAMES: usize = 2_048;
/// Frames of B decoded ahead of the mixer's demand.
const B_READAHEAD_FRAMES: usize = 8_192;
/// Upper bound on render iterations per `step` so command handling stays responsive.
const MAX_MIX_ITERATIONS_PER_STEP: usize = 1;

/// The next track, prepared for a transition: decoder positioned at `plan.b_start_secs`
/// with `predecoded` covering the first frames from there.
pub struct ArmedTransition {
    pub plan: TransitionPlan,
    pub decoder: Box<DecoderData>,
    pub predecoded: Vec<DecodedAudioChunk>,
    pub info: TrackSwitchInfo,
    pub preferred_output_sample_format: AudioSampleFormat,
    /// Linear loudness gains for the decks (outgoing / incoming), relative to the
    /// normalisation gain the output callback applies from the boundary on.
    pub a_gain: f32,
    pub b_gain: f32,
    /// Normalisation gain (dB) the callback should settle on once the overlap is over.
    pub post_overlap_normalization_gain_db: f32,
    /// Request id of the prepare call (for cancellation bookkeeping).
    pub request_id: u64,
    /// Track sequence of the outgoing track this transition was planned against.
    pub outgoing_seq: u64,
}

impl ArmedTransition {
    pub fn mode(&self) -> TransitionMode {
        self.plan.mode
    }

    /// Whether the outgoing decoder, having produced audio up to `decoded_secs`, should
    /// start the transition now.
    pub fn should_start(&self, decoded_secs: f64) -> bool {
        decoded_secs + 1.0e-6 >= self.plan.a_cut_secs
    }

    /// Start the transition right now (manual skip): the cut moves to `now_secs`, the
    /// overlap is capped to `max_overlap_secs` and the plan's own end/audible end.
    pub fn start_now(&mut self, now_secs: f64, max_overlap_secs: f64) {
        let plan = &mut self.plan;
        let audible_end = plan.a_end_secs.max(now_secs);
        plan.a_cut_secs = now_secs;
        if plan.overlap_secs <= 0.0 {
            plan.a_end_secs = now_secs;
            return;
        }
        let ratio = if plan.a_tempo_ratio > 0.0 {
            plan.a_tempo_ratio
        } else {
            1.0
        };
        let overlap = plan
            .overlap_secs
            .min(max_overlap_secs.max(0.0))
            .min((audible_end - now_secs) / ratio);
        plan.overlap_secs = if overlap <= 0.02 { 0.0 } else { overlap };
        plan.a_end_secs = now_secs + plan.overlap_secs * ratio;
    }

    /// Recompute the cut for a plan whose cut point has already passed (late arm): start
    /// at `now_secs`, keep the same end and clamp the overlap.
    pub fn rebase_to(&mut self, now_secs: f64) {
        let plan = &mut self.plan;
        if now_secs <= plan.a_cut_secs {
            return;
        }
        let end = plan.a_end_secs.max(now_secs);
        plan.a_cut_secs = now_secs;
        plan.a_end_secs = end;
        if plan.overlap_secs <= 0.0 {
            // A butt splice stays a butt splice however late it starts.
            return;
        }
        let a_span = end - now_secs;
        plan.overlap_secs =
            if plan.a_tempo_ratio > 0.0 && (plan.a_tempo_ratio - 1.0).abs() > 1e-6 {
                a_span / plan.a_tempo_ratio
            } else {
                a_span
            }
            .min(plan.overlap_secs.max(0.0));
        if plan.overlap_secs <= 0.02 {
            plan.overlap_secs = 0.0;
        }
    }
}

/// Feeding state of one deck while the mix runs. Deck A's decoder stays in the decode
/// worker (`data`) and is borrowed per step; deck B owns the incoming decoder until the
/// hand-off.
struct Deck {
    decoder: Option<Box<DecoderData>>,
    converter: SwrMixConverter,
    /// Chunks decoded but not yet handed to the mixer (split tail of A, predecoded head of B).
    pending: Vec<DecodedAudioChunk>,
    ended: bool,
    /// Timeline position (seconds) of the next frame this deck will produce.
    position_secs: f64,
    /// Frames (mix rate) produced by this deck so far.
    produced_frames: u64,
}

impl Deck {
    fn new(decoder: Option<Box<DecoderData>>, position_secs: f64) -> Self {
        Self {
            decoder,
            converter: SwrMixConverter::default(),
            pending: Vec::new(),
            ended: false,
            position_secs,
            produced_frames: 0,
        }
    }
}

pub enum RunnerStep {
    /// The runner queued more mixed audio (or is waiting for the queue to drain).
    Continue,
    /// The mix has finished; the incoming decoder takes over the main loop.
    Finished(TransitionHandoff),
    /// Decoding failed on one deck; the runner cannot continue.
    Failed(String),
}

pub struct TransitionHandoff {
    pub decoder: DecoderData,
    /// Timeline position of the next frame the incoming decoder will produce.
    pub decoded_position_secs: f64,
    pub produced_frames: u64,
}

/// What an aborted runner hands back.
pub enum AbortedTransition {
    /// The incoming track has not reached the output yet (boundary not marked): deck B
    /// can be re-armed for a later attempt from the outgoing track.
    Rearm(Box<ArmedTransition>),
    /// The incoming track is already audible (boundary marked): it becomes the live
    /// decoder at the returned timeline position.
    Live(DecoderData, f64),
}

/// Drives one transition to completion.
pub struct TransitionRunner {
    mix_format: MixFormat,
    mixer: TransitionMixer,
    a: Deck,
    b: Deck,
    a_end_secs: f64,
    boundary_marked: bool,
    info: Option<TrackSwitchInfo>,
    generation: u64,
    scratch: Vec<f32>,
    mixed_frames: u64,
    /// Plan / gains / ids kept so the transition can be re-armed after an early abort.
    rearm: RearmInfo,
    rearm_incoming_seq: u64,
    /// Whether the post-overlap normalisation gain has been scheduled.
    post_gain_marked: bool,
}

struct RearmInfo {
    plan: TransitionPlan,
    preferred_output_sample_format: AudioSampleFormat,
    a_gain: f32,
    b_gain: f32,
    post_overlap_normalization_gain_db: f32,
    request_id: u64,
    outgoing_seq: u64,
    /// Original entry point of B; the decoder must be re-seeked there when re-armed.
    b_start_secs: f64,
}

impl TransitionRunner {
    /// Start the transition. `a_tail` is the part of the current decoded chunk that lies
    /// at/after the cut point (already split by the caller); `a_position_secs` is its
    /// timeline start. The outgoing decoder itself stays with the caller and is passed to
    /// every [`TransitionRunner::step`].
    pub fn start(
        shared: &SharedAudio,
        armed: ArmedTransition,
        a_tail: Option<DecodedAudioChunk>,
        a_preroll: Vec<DecodedAudioChunk>,
        a_position_secs: f64,
        generation: u64,
    ) -> Result<Self, (String, Box<ArmedTransition>)> {
        let mix_format = shared.mix_format;
        let sample_rate = mix_format.sample_rate.max(1);
        let plan = armed.plan.clone();
        let overlap_frames = (plan.overlap_secs.max(0.0) * f64::from(sample_rate)).round() as usize;
        let plan_for_mixer = match plan.template {
            Some(template) => Some(template.load()),
            None if plan.uses_equal_power_fade() => Some(equal_power_fade_plan()),
            None => None,
        };
        let mut mixer = match TransitionMixer::new(MixerConfig {
            sample_rate,
            channels: mix_format.channels,
            overlap_frames,
            plan: plan_for_mixer,
            a_tempo_ratio: plan.a_tempo_ratio as f32,
            a_gain: armed.a_gain,
            b_gain: armed.b_gain,
            a_beat_secs: plan.a_beat_secs.map(|secs| secs as f32),
            b_beat_secs: plan.b_beat_secs.map(|secs| secs as f32),
        }) {
            Ok(mixer) => mixer,
            Err(err) => return Err((err, Box::new(armed))),
        };
        let mut a = Deck::new(None, a_position_secs);
        if let Some(tail) = a_tail {
            a.pending.push(tail);
        }
        // Settle the tempo stretcher with audio from before the cut so its first kept
        // frame is the cut point itself (see `Stretcher` docs).
        let wanted = mixer.a_preroll_frames_wanted();
        if wanted > 0 && !a_preroll.is_empty() {
            let mut preroll_converter = SwrMixConverter::default();
            let mut converted = Vec::new();
            for chunk in &a_preroll {
                let mut scratch = Vec::new();
                if preroll_converter
                    .process(chunk, mix_format, &mut scratch)
                    .is_err()
                {
                    converted.clear();
                    break;
                }
                converted.extend_from_slice(&scratch);
            }
            let mut tail_scratch = Vec::new();
            if preroll_converter.finish(&mut tail_scratch).is_ok() {
                converted.extend_from_slice(&tail_scratch);
            }
            let channels = mix_format.channels.max(1);
            let frames = converted.len() / channels;
            let keep = frames.min(wanted);
            if keep > 0 {
                mixer.preroll_a(&converted[(frames - keep) * channels..]);
            }
        }
        let mut b = Deck::new(Some(armed.decoder), plan.b_start_secs);
        b.pending = armed.predecoded;
        let mut info = armed.info;
        info.start_position_secs = plan.b_start_secs;
        let rearm_incoming_seq = info.seq;
        let rearm = RearmInfo {
            plan: plan.clone(),
            preferred_output_sample_format: armed.preferred_output_sample_format,
            a_gain: armed.a_gain,
            b_gain: armed.b_gain,
            post_overlap_normalization_gain_db: armed.post_overlap_normalization_gain_db,
            request_id: armed.request_id,
            outgoing_seq: armed.outgoing_seq,
            b_start_secs: plan.b_start_secs,
        };
        Ok(Self {
            mix_format,
            mixer,
            a,
            b,
            a_end_secs: plan.a_end_secs,
            boundary_marked: false,
            info: Some(info),
            generation,
            scratch: Vec::new(),
            mixed_frames: 0,
            rearm,
            rearm_incoming_seq,
            post_gain_marked: false,
        })
    }

    pub fn incoming_seq(&self) -> u64 {
        self.rearm_incoming_seq
    }

    pub fn matches_request(&self, request_id: Option<u64>) -> bool {
        request_id.is_none_or(|id| self.rearm.request_id == id)
    }

    /// Advance the transition by one step: feed the decks, render one block, queue it.
    /// `a_decoder` is the outgoing track's decoder (owned by the decode worker). Each
    /// step pushes at most one block so decode commands are serviced between blocks.
    pub fn step(&mut self, shared: &SharedAudio, a_decoder: &mut DecoderData) -> RunnerStep {
        for _ in 0..MAX_MIX_ITERATIONS_PER_STEP {
            if shared.should_stop_decoding()
                || !shared.is_decode_generation_current(self.generation)
            {
                return RunnerStep::Continue;
            }
            // Feed A up to the end of its window. Decode errors on the outgoing track are
            // treated like the main loop treats them: interrupt / stop / stale generation
            // simply yield, a broken tail ends the deck early instead of failing the mix.
            if !self.a.ended && self.mixer.a_queued_frames() < B_READAHEAD_FRAMES {
                if let Err(err) = self.feed_a(a_decoder, RENDER_BLOCK_FRAMES * 2) {
                    if a_decoder
                        .interrupt_handle()
                        .load(std::sync::atomic::Ordering::Acquire)
                        || shared.should_stop_decoding()
                        || !shared.is_decode_generation_current(self.generation)
                    {
                        return RunnerStep::Continue;
                    }
                    crate::decoder::emit_decode_warning(format!(
                        "outgoing track decode error during transition; ending deck A early: {err}"
                    ));
                    self.end_a();
                }
            }
            // Feed B until the mixer has a comfortable read-ahead.
            if !self.b.ended && self.mixer.b_queued_frames() < B_READAHEAD_FRAMES {
                if let Err(err) = self.feed_b(B_READAHEAD_FRAMES) {
                    let interrupted = self.b.decoder.as_ref().is_some_and(|decoder| {
                        decoder
                            .interrupt_handle()
                            .load(std::sync::atomic::Ordering::Acquire)
                    });
                    if interrupted
                        || shared.should_stop_decoding()
                        || !shared.is_decode_generation_current(self.generation)
                    {
                        return RunnerStep::Continue;
                    }
                    return RunnerStep::Failed(err);
                }
            }
            let output = self.mixer.render(RENDER_BLOCK_FRAMES);
            let produced = !output.samples.is_empty();
            if produced {
                let frames = output.samples.len() / self.mix_format.channels.max(1);
                self.b.position_secs +=
                    output.b_frames_consumed as f64 / f64::from(self.mix_format.sample_rate.max(1));
                self.b.produced_frames += output.b_frames_consumed as u64;
                self.mixed_frames += frames as u64;
                if !self.push_mixed(shared, output.samples) {
                    return RunnerStep::Continue;
                }
                self.mark_post_overlap_gain(shared);
            }
            if self.mixer.is_finished() || (!produced && self.a.ended && self.b.ended) {
                return self.finish(shared);
            }
            // One block per step keeps command latency at one block; starvation returns
            // as well so the caller can service commands / wait for input.
            return RunnerStep::Continue;
        }
        RunnerStep::Continue
    }

    fn end_a(&mut self) {
        if self.a.ended {
            return;
        }
        self.a.ended = true;
        self.scratch.clear();
        if self.a.converter.finish(&mut self.scratch).is_ok() && !self.scratch.is_empty() {
            self.mixer.push_a(DeckInput::Samples(&self.scratch));
        }
        self.mixer.push_a(DeckInput::End);
    }

    /// Once the overlap window is complete only deck B (plus A's effect tail) remains, so
    /// the callback's normalisation gain can settle on B's own value.
    fn mark_post_overlap_gain(&mut self, shared: &SharedAudio) {
        if self.post_gain_marked || self.mixer.position() < 1.0 {
            return;
        }
        self.post_gain_marked = true;
        shared.mark_gain_marker(self.rearm.post_overlap_normalization_gain_db);
    }

    fn push_mixed(&mut self, shared: &SharedAudio, samples: Vec<f32>) -> bool {
        if !self.boundary_marked {
            if let Some(info) = self.info.take() {
                shared.mark_track_boundary_continuous(info);
            }
            self.boundary_marked = true;
        }
        let frames = samples.len() / self.mix_format.channels.max(1);
        let chunk = DecodedAudioChunk::new(
            DecodedAudioFormat {
                sample_rate: self.mix_format.sample_rate,
                sample_format: AudioSampleFormat::F32,
                channels: self.mix_format.channels,
            },
            frames,
            None,
            DecodedAudioData::F32(samples),
        );
        shared.push_decoded_chunk_for_generation(chunk, self.generation)
    }

    fn feed_a(&mut self, a_decoder: &mut DecoderData, want_frames: usize) -> Result<(), String> {
        let mut fed = 0usize;
        while fed < want_frames && !self.a.ended {
            let chunk = if !self.a.pending.is_empty() {
                Some(self.a.pending.remove(0))
            } else {
                a_decoder.decode_next_chunk()?
            };
            let Some(mut chunk) = chunk else {
                self.a.ended = true;
                self.mixer.push_a(DeckInput::End);
                break;
            };
            // Trim A at its end point.
            let chunk_secs = chunk.frames as f64 / f64::from(chunk.format.sample_rate.max(1));
            let chunk_end = self.a.position_secs + chunk_secs;
            if chunk_end > self.a_end_secs {
                let keep_secs = (self.a_end_secs - self.a.position_secs).max(0.0);
                let keep_frames =
                    (keep_secs * f64::from(chunk.format.sample_rate.max(1))).round() as usize;
                let drop_frames = chunk.frames.saturating_sub(keep_frames);
                if drop_frames > 0 {
                    truncate_chunk(&mut chunk, keep_frames);
                }
                self.a.ended = true;
            }
            self.a.position_secs = decoded_chunk_end_secs(&chunk, self.a.position_secs);
            self.scratch.clear();
            if chunk.frames > 0 {
                self.a
                    .converter
                    .process(&chunk, self.mix_format, &mut self.scratch)?;
            }
            if self.a.ended {
                self.a.converter.finish(&mut self.scratch)?;
            }
            if !self.scratch.is_empty() {
                fed += self.scratch.len() / self.mix_format.channels.max(1);
                self.mixer.push_a(DeckInput::Samples(&self.scratch));
            }
            if self.a.ended {
                self.mixer.push_a(DeckInput::End);
            }
        }
        Ok(())
    }

    fn feed_b(&mut self, want_frames: usize) -> Result<(), String> {
        let mut fed = 0usize;
        while fed < want_frames && !self.b.ended {
            let chunk = if !self.b.pending.is_empty() {
                Some(self.b.pending.remove(0))
            } else {
                match self.b.decoder.as_mut() {
                    Some(decoder) => decoder.decode_next_chunk()?,
                    None => None,
                }
            };
            let Some(chunk) = chunk else {
                self.b.ended = true;
                self.scratch.clear();
                self.b.converter.finish(&mut self.scratch)?;
                if !self.scratch.is_empty() {
                    self.mixer.push_b(DeckInput::Samples(&self.scratch));
                }
                self.mixer.push_b(DeckInput::End);
                break;
            };
            self.scratch.clear();
            self.b
                .converter
                .process(&chunk, self.mix_format, &mut self.scratch)?;
            if !self.scratch.is_empty() {
                fed += self.scratch.len() / self.mix_format.channels.max(1);
                self.mixer.push_b(DeckInput::Samples(&self.scratch));
            }
        }
        Ok(())
    }

    fn finish(&mut self, shared: &SharedAudio) -> RunnerStep {
        if !self.post_gain_marked {
            // Overlap 0 / aborted early: the callback gain switches at the boundary and
            // settles on B's value immediately after.
            self.post_gain_marked = true;
            shared.mark_gain_marker(self.rearm.post_overlap_normalization_gain_db);
        }
        // Whatever B audio the mixer did not consume continues as plain mix-format audio.
        let remainder = self.mixer.take_b_remainder();
        if !remainder.is_empty() {
            let frames = remainder.len() / self.mix_format.channels.max(1);
            self.b.position_secs += frames as f64 / f64::from(self.mix_format.sample_rate.max(1));
            self.b.produced_frames += frames as u64;
            if !self.push_mixed(shared, remainder) {
                return RunnerStep::Continue;
            }
        }
        // The B converter may still hold resampler residue for the *next* chunk; the
        // filter thread's own converter takes over from here, so flush it now.
        self.scratch.clear();
        if self.b.converter.finish(&mut self.scratch).is_ok() && !self.scratch.is_empty() {
            let samples = std::mem::take(&mut self.scratch);
            let frames = samples.len() / self.mix_format.channels.max(1);
            self.b.position_secs += frames as f64 / f64::from(self.mix_format.sample_rate.max(1));
            self.b.produced_frames += frames as u64;
            if !self.push_mixed(shared, samples) {
                return RunnerStep::Continue;
            }
        }
        let Some(decoder) = self.b.decoder.take() else {
            return RunnerStep::Failed("incoming decoder missing at hand-off".to_string());
        };
        if !self.boundary_marked {
            if let Some(info) = self.info.take() {
                shared.mark_track_boundary_continuous(info);
            }
            self.boundary_marked = true;
        }
        // Any B chunks decoded ahead but not fed (should be none) are re-queued by the caller.
        let leftover = std::mem::take(&mut self.b.pending);
        for chunk in leftover {
            self.b.position_secs = decoded_chunk_end_secs(&chunk, self.b.position_secs);
            self.b.produced_frames += chunk.frames as u64;
            if !shared.push_decoded_chunk_for_generation(chunk, self.generation) {
                break;
            }
        }
        RunnerStep::Finished(TransitionHandoff {
            decoder: *decoder,
            decoded_position_secs: self.b.position_secs,
            produced_frames: self.b.produced_frames,
        })
    }

    /// Abandon the mix. `incoming_is_audible` tells whether the output callback already
    /// crossed the boundary (i.e. the listener has heard the incoming track): then the
    /// incoming decoder becomes the live decoder at its current position. Otherwise every
    /// queued mixed sample was discarded by the caller's reset, so the deck is handed back
    /// as a re-armable transition and the outgoing track stays live.
    pub fn abort(mut self, incoming_is_audible: bool) -> Option<AbortedTransition> {
        self.mixer.abort_a();
        let decoder = self.b.decoder.take()?;
        if incoming_is_audible {
            return Some(AbortedTransition::Live(*decoder, self.b.position_secs));
        }
        let mut decoder = *decoder;
        // B may have been decoded ahead; return it to its entry point for the retry.
        let b_start = self.rearm.b_start_secs;
        if decoder.prepare_seamless_seek(b_start).is_err() {
            return Some(AbortedTransition::Live(decoder, self.b.position_secs));
        }
        decoder.set_discard_before_secs(if b_start > 0.0 { Some(b_start) } else { None });
        let mut info = self.info.take().unwrap_or_else(|| {
            TrackSwitchInfo::new(String::new(), None, self.rearm_incoming_seq, 0.0)
        });
        info.start_position_secs = b_start;
        Some(AbortedTransition::Rearm(Box::new(ArmedTransition {
            plan: self.rearm.plan.clone(),
            decoder: Box::new(decoder),
            predecoded: Vec::new(),
            info,
            preferred_output_sample_format: self.rearm.preferred_output_sample_format,
            a_gain: self.rearm.a_gain,
            b_gain: self.rearm.b_gain,
            post_overlap_normalization_gain_db: self.rearm.post_overlap_normalization_gain_db,
            request_id: self.rearm.request_id,
            outgoing_seq: self.rearm.outgoing_seq,
        })))
    }
}

/// The plain 淡入淡出 plan: mirrored equal-power gain curves that take the outgoing deck
/// all the way to silence (unlike the DJ templates, which stop at -20 dB because the
/// track ends anyway).
fn equal_power_fade_plan() -> crate::transition::plan::DjPlan {
    crate::transition::plan::DjPlan::parse(
        r#"{"name":"Fade","description":"equal-power crossfade",
            "Achain":{"list":[{"effect":{"type":1,"value":0.0},
              "automation":{"type":"piecewise","m":0.0,"n":-90.0,"start_pos":0.0,"end_pos":1.0,"curve_type":2}}]},
            "Bchain":{"list":[{"effect":{"type":1,"value":-90.0},
              "automation":{"type":"piecewise","m":-90.0,"n":0.0,"start_pos":0.0,"end_pos":1.0,"curve_type":1}}]}}"#,
    )
    .expect("built-in fade plan is valid")
}

fn truncate_chunk(chunk: &mut DecodedAudioChunk, frames: usize) {
    let frames = frames.min(chunk.frames);
    let samples = frames.saturating_mul(chunk.format.channels.max(1));
    match &mut chunk.data {
        DecodedAudioData::U8(data) => data.truncate(samples),
        DecodedAudioData::I16(data) => data.truncate(samples),
        DecodedAudioData::I32(data) => data.truncate(samples),
        DecodedAudioData::F32(data) => data.truncate(samples),
        DecodedAudioData::F64(data) => data.truncate(samples),
    }
    chunk.frames = frames;
}

/// Split `chunk` at `cut_secs` (timeline seconds; `chunk_start_secs` is the chunk's own
/// start). Returns `(head, tail)` where `head` ends exactly at the cut and `tail` starts
/// there. Either may be `None` when empty.
pub fn split_chunk_at(
    chunk: DecodedAudioChunk,
    chunk_start_secs: f64,
    cut_secs: f64,
) -> (Option<DecodedAudioChunk>, Option<DecodedAudioChunk>) {
    let sample_rate = f64::from(chunk.format.sample_rate.max(1));
    let cut_frames = ((cut_secs - chunk_start_secs) * sample_rate).round();
    if cut_frames <= 0.0 {
        return (None, Some(chunk));
    }
    let cut_frames = cut_frames as usize;
    if cut_frames >= chunk.frames {
        return (Some(chunk), None);
    }
    let mut head = chunk.clone();
    truncate_chunk(&mut head, cut_frames);
    let mut tail = chunk;
    tail.trim_start_frames(cut_frames);
    (Some(head), Some(tail))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(frames: usize, start: f64) -> DecodedAudioChunk {
        let data: Vec<i16> = (0..frames * 2).map(|i| i as i16).collect();
        DecodedAudioChunk::new(
            DecodedAudioFormat {
                sample_rate: 100,
                sample_format: AudioSampleFormat::S16,
                channels: 2,
            },
            frames,
            Some(start),
            DecodedAudioData::I16(data),
        )
    }

    #[test]
    fn split_chunk_at_cuts_on_the_exact_frame() {
        let (head, tail) = split_chunk_at(chunk(10, 1.0), 1.0, 1.04);
        let head = head.expect("head");
        let tail = tail.expect("tail");
        assert_eq!(head.frames, 4);
        assert_eq!(tail.frames, 6);
        assert_eq!(tail.pts_secs, Some(1.04));
        match (&head.data, &tail.data) {
            (DecodedAudioData::I16(h), DecodedAudioData::I16(t)) => {
                assert_eq!(h.len(), 8);
                assert_eq!(t[0], 8);
            }
            _ => panic!("format"),
        }
        let (head, tail) = split_chunk_at(chunk(10, 1.0), 1.0, 0.5);
        assert!(head.is_none());
        assert_eq!(tail.unwrap().frames, 10);
        let (head, tail) = split_chunk_at(chunk(10, 1.0), 1.0, 5.0);
        assert_eq!(head.unwrap().frames, 10);
        assert!(tail.is_none());
    }

    #[test]
    fn rebase_moves_cut_to_now_and_shrinks_overlap() {
        let plan = TransitionPlan {
            mode: TransitionMode::Fade,
            version: crate::transition::decide::DecisionVersion::Fade,
            trigger: crate::transition::decide::TransitionTrigger::EndOfTrack,
            a_cut_secs: 100.0,
            a_end_secs: 110.0,
            b_start_secs: 0.5,
            overlap_secs: 10.0,
            template: None,
            a_tempo_ratio: 1.0,
            speed_type: crate::transition::decide::SpeedType::None,
            bpm_a: None,
            bpm_b: None,
            bars: None,
            a_beat_secs: None,
            b_beat_secs: None,
            note: String::new(),
        };
        let mut armed = ArmedTransition {
            plan,
            decoder: Box::new(dummy_decoder()),
            predecoded: Vec::new(),
            info: TrackSwitchInfo::new("b".to_string(), None, 2, 200.0),
            preferred_output_sample_format: AudioSampleFormat::S16,
            a_gain: 1.0,
            b_gain: 1.0,
            post_overlap_normalization_gain_db: 0.0,
            request_id: 1,
            outgoing_seq: 1,
        };
        assert!(!armed.should_start(99.0));
        assert!(armed.should_start(100.0));
        armed.rebase_to(104.0);
        assert_eq!(armed.plan.a_cut_secs, 104.0);
        assert_eq!(armed.plan.a_end_secs, 110.0);
        assert!((armed.plan.overlap_secs - 6.0).abs() < 1e-9);
        armed.rebase_to(109.995);
        assert_eq!(armed.plan.overlap_secs, 0.0);
        // Manual start well before the planned cut: the blend starts now with the cap.
        armed.plan.a_cut_secs = 100.0;
        armed.plan.a_end_secs = 110.0;
        armed.plan.overlap_secs = 10.0;
        armed.start_now(20.0, 4.0);
        assert_eq!(armed.plan.a_cut_secs, 20.0);
        assert!((armed.plan.overlap_secs - 4.0).abs() < 1e-9);
        assert!((armed.plan.a_end_secs - 24.0).abs() < 1e-9);
        // Near the end the cap is the remaining audible span.
        armed.plan.a_end_secs = 110.0;
        armed.plan.overlap_secs = 10.0;
        armed.start_now(108.0, 4.0);
        assert!((armed.plan.overlap_secs - 2.0).abs() < 1e-9);
        assert!((armed.plan.a_end_secs - 110.0).abs() < 1e-9);
    }

    fn dummy_decoder() -> DecoderData {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("vendor/ffmpeg-audio/crates/ffmpeg_audio/tests/assets/seek_test.aac");
        DecoderData::open(
            path.to_string_lossy().into_owned(),
            None,
            None,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            ffmpeg_audio::PacketCacheOptions::default(),
            &crate::stream::StreamOptions::default(),
        )
        .expect("test asset decoder")
    }
}
