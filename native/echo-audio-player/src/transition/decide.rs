//! Cue selection for silence trimming, timed fades and content-aware mixing.
//!
//! Each strategy produces a [`TransitionPlan`] with outgoing and incoming cue points,
//! overlap duration, effect template and optional tempo adjustment:
//!
//! * **Gapless** – zero-length overlap at the silence-trimmed boundary.
//! * **Fade** – linear-amplitude overlap of the configured length at the full track
//!   boundaries, without silence trimming.
//! * **Natural blend** – unchanged tempo, short bar-counted overlap and downbeat-aligned
//!   cues, with gain/bass exchange or filter/echo effects for differing tempos.
//! * **Rhythm blend** – keeps the outgoing tempo. Close tempos use bar-counted
//!   overlap and multi-band effects; residual outside ±1 % falls back to a
//!   filter mix so the first song never rushes or drags. Missing beat grids
//!   use the same filter mix.

use super::analysis::TrackAnalysis;
use super::plan::PlanTemplate;
use super::{TransitionMode, TransitionSettings, MIN_SUPPORTED_TRACK_SECS};
use serde::Serialize;

/// Upper bound for a manually triggered crossfade (user pressed "next").
pub const MANUAL_MAX_OVERLAP_SECS: f64 = 4.0;
/// Maximum overlap for natural blending.
const BASIC_MAX_OVERLAP_SECS: f64 = 16.0;
/// Maximum overlap for rhythm blending.
const PRO_MAX_OVERLAP_SECS: f64 = 25.0;
/// Fallback overlap when no beat grid is available.
const AUTOMIX_FALLBACK_SECS: f64 = 8.0;
const FILTER_FALLBACK_OVERLAP_SECS: f64 = 12.0;
/// Entry windows selected by the incoming/outgoing tempo ratio:
/// * close tempos: 4 bars;
/// * moderately different tempos: 8 bars;
/// * other ratios: 12 bars.
const CLOSE_TEMPO_RATIO_LOW: f64 = 19.0 / 20.0;
const CLOSE_TEMPO_RATIO_HIGH: f64 = 20.0 / 19.0;
const MODERATE_TEMPO_RATIO_LOW: f64 = 17.0 / 20.0;
const MODERATE_TEMPO_RATIO_HIGH: f64 = 20.0 / 17.0;
/// Inverse tempo-ratio bands that use a short, fixed four-beat blend.
const SHORT_BLEND_RATIO_BANDS: [(f64, f64); 2] = [(0.64, 0.85), (1.493, 1.8)];
/// Candidate tempo multiples used to account for half-time and double-time detection.
const TEMPO_MULTIPLIERS: [f64; 5] = [3.0, 2.0, 1.0, 0.5, 1.0 / 3.0];
/// Tempo ratio tolerance below which no stretch is applied.
const NO_STRETCH_TOLERANCE: f64 = 0.01;
/// Maximum tempo adjustment applied to the outgoing track when match-tempo is on: ±8 %.
const MAX_STRETCH_RATIO: f64 = 1.08;
const MIN_STRETCH_RATIO: f64 = 0.92;
/// Basic mode accepts tracks whose tempos differ by at most this much without stretching.
const BASIC_TEMPO_TOLERANCE: f64 = 0.04;
/// Beyond `BASIC_TEMPO_TOLERANCE` but within this, basic mode still blends with the filter
/// sweep; further apart it uses an echo tail.
const BASIC_FILTER_TEMPO_TOLERANCE: f64 = 0.12;
/// Minimum audible energy (RMS) for a cue region to count as "musical".
const MIN_CUE_ENERGY: f32 = 0.01;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransitionTrigger {
    /// Natural end of the outgoing track.
    EndOfTrack,
    /// The user skipped; the overlap must start at the current position.
    Manual,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpeedType {
    /// Keep the outgoing track's original tempo.
    None,
    /// Match the outgoing track's tempo to the incoming one.
    TempoMatch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DecisionStrategy {
    Gapless,
    Fade,
    /// Natural blending without tempo adjustment.
    Natural,
    /// Section-based entry selection or a fixed filter fallback.
    Section,
    /// Beat alignment with tempo adjustment.
    TempoMatched,
}

/// Everything the mixer needs to render one transition.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TransitionPlan {
    pub mode: TransitionMode,
    pub strategy: DecisionStrategy,
    pub trigger: TransitionTrigger,
    /// Timestamp on A where the overlap (and B) starts.
    pub a_cut_secs: f64,
    /// Timestamp on A after which A is no longer fed to the mixer.
    pub a_end_secs: f64,
    /// Timestamp on B where playback of B starts.
    pub b_start_secs: f64,
    /// Overlap window length in seconds (0 for gapless).
    pub overlap_secs: f64,
    /// Plan template (None = plain linear-amplitude fade when overlapping).
    pub template: Option<PlanTemplate>,
    /// Tempo ratio applied to A (1.0 when unstretched).
    pub a_tempo_ratio: f64,
    pub speed_type: SpeedType,
    pub bpm_a: Option<f32>,
    pub bpm_b: Option<f32>,
    pub bars: Option<u32>,
    pub a_beat_secs: Option<f64>,
    pub b_beat_secs: Option<f64>,
    /// Human-readable reason for the decision (logged for diagnostics).
    pub note: String,
}

impl TransitionPlan {
    pub fn is_gapless(&self) -> bool {
        self.overlap_secs <= 0.0
    }

    /// Plain fades use a sample-wise amplitude envelope, independent of DJ automation.
    pub fn uses_plain_fade(&self) -> bool {
        self.template.is_none() && self.overlap_secs > 0.0
    }
}

/// Inputs to the decision.
#[derive(Clone, Debug)]
pub struct TransitionRequest<'a> {
    pub settings: TransitionSettings,
    pub trigger: TransitionTrigger,
    /// Analysis of the outgoing track (tail window).
    pub a: &'a TrackAnalysis,
    /// Analysis of the incoming track (head window).
    pub b: &'a TrackAnalysis,
    /// Current playback position on A (only used for manual triggers).
    pub a_position_secs: f64,
}

/// Decide how to move from track A to track B. Returns `None` when no transition should
/// be attempted (mode off, tracks too short) – the caller then falls back to a hard cut.
pub fn decide_transition(request: &TransitionRequest<'_>) -> Option<TransitionPlan> {
    let settings = request.settings.sanitized();
    let a = request.a;
    let b = request.b;
    if a.duration_secs <= 0.0 {
        return None;
    }
    match settings.mode {
        TransitionMode::None => None,
        TransitionMode::Gapless => Some(gapless_plan(request)),
        TransitionMode::Fade => {
            if settings.fade_secs <= 0.05 {
                return None;
            }
            // Very short tracks are never overlapped.
            if a.duration_secs < MIN_SUPPORTED_TRACK_SECS
                || (b.duration_secs > 0.0 && b.duration_secs < MIN_SUPPORTED_TRACK_SECS)
            {
                return None;
            }
            Some(fade_plan(request, f64::from(settings.fade_secs)))
        }
        TransitionMode::AutomixBasic | TransitionMode::AutomixPro => {
            if a.duration_secs < MIN_SUPPORTED_TRACK_SECS
                || (b.duration_secs > 0.0 && b.duration_secs < MIN_SUPPORTED_TRACK_SECS)
            {
                // Too short for a musical blend: behave like a gentle crossfade.
                return Some(fade_plan(request, 4.0));
            }
            if request.trigger == TransitionTrigger::Manual {
                return Some(manual_automix_plan(request));
            }
            Some(if settings.mode == TransitionMode::AutomixPro {
                pro_plan(request)
            } else {
                basic_plan(request)
            })
        }
    }
}

fn audible_end(a: &TrackAnalysis) -> f64 {
    a.audible_end_secs().min(a.duration_secs).max(0.0)
}

fn audible_start(b: &TrackAnalysis) -> f64 {
    b.audible_start_secs().max(0.0)
}

fn gapless_plan(request: &TransitionRequest<'_>) -> TransitionPlan {
    let a = request.a;
    let b = request.b;
    let a_end = if request.trigger == TransitionTrigger::Manual {
        request.a_position_secs.clamp(0.0, a.duration_secs)
    } else {
        audible_end(a)
    };
    // A butt splice: the decoder hands over directly at `a_end` (bit-exact, no mixer). The
    // trim points sit at ≤ −60 dBFS, so no edge fade is needed and continuous albums stay
    // sample-exact.
    TransitionPlan {
        mode: TransitionMode::Gapless,
        strategy: DecisionStrategy::Gapless,
        trigger: request.trigger,
        a_cut_secs: a_end,
        a_end_secs: a_end,
        b_start_secs: audible_start(b),
        overlap_secs: 0.0,
        template: None,
        a_tempo_ratio: 1.0,
        speed_type: SpeedType::None,
        bpm_a: a.bpm,
        bpm_b: b.bpm,
        bars: None,
        a_beat_secs: a.beat_secs,
        b_beat_secs: b.beat_secs,
        note: format!(
            "gapless: trim A tail {:.2}s, skip B head {:.2}s",
            a.duration_secs - a_end,
            audible_start(b)
        ),
    }
}

fn fade_plan(request: &TransitionRequest<'_>, fade_secs: f64) -> TransitionPlan {
    let a = request.a;
    let b = request.b;
    let b_start = 0.0;
    let (a_cut, a_end, overlap) = match request.trigger {
        TransitionTrigger::EndOfTrack => {
            let a_end = a.duration_secs;
            let overlap = fade_secs.min(a_end).max(0.0);
            (a_end - overlap, a_end, overlap)
        }
        TransitionTrigger::Manual => {
            let a_cut = request.a_position_secs.clamp(0.0, a.duration_secs);
            let remaining = (a.duration_secs - a_cut).max(0.0);
            let overlap = fade_secs.min(MANUAL_MAX_OVERLAP_SECS).min(remaining);
            (a_cut, a_cut + overlap, overlap)
        }
    };
    TransitionPlan {
        mode: TransitionMode::Fade,
        strategy: DecisionStrategy::Fade,
        trigger: request.trigger,
        a_cut_secs: a_cut,
        a_end_secs: a_end,
        b_start_secs: b_start,
        overlap_secs: overlap,
        template: None,
        a_tempo_ratio: 1.0,
        speed_type: SpeedType::None,
        bpm_a: a.bpm,
        bpm_b: b.bpm,
        bars: None,
        a_beat_secs: a.beat_secs,
        b_beat_secs: b.beat_secs,
        note: format!("fade: {overlap:.2}s linear amplitude, full track boundaries"),
    }
}

/// Manual skip in an automix mode: start now, keep it short, but still use a musical
/// template and snap B's entry to a downbeat.
fn manual_automix_plan(request: &TransitionRequest<'_>) -> TransitionPlan {
    let a = request.a;
    let b = request.b;
    let a_cut = request.a_position_secs.clamp(0.0, a.duration_secs);
    let remaining = (audible_end(a) - a_cut).max(0.0);
    let overlap = MANUAL_MAX_OVERLAP_SECS.min(remaining);
    if overlap <= 0.05 {
        return gapless_plan(request);
    }
    let b_start = first_musical_downbeat(b).unwrap_or_else(|| audible_start(b));
    let template = if request.settings.mode == TransitionMode::AutomixPro {
        PlanTemplate::SimpleFilter
    } else {
        PlanTemplate::FallbackExchange
    };
    TransitionPlan {
        mode: request.settings.mode,
        strategy: DecisionStrategy::Natural,
        trigger: TransitionTrigger::Manual,
        a_cut_secs: a_cut,
        a_end_secs: a_cut + overlap,
        b_start_secs: b_start,
        overlap_secs: overlap,
        template: Some(template),
        a_tempo_ratio: 1.0,
        speed_type: SpeedType::None,
        bpm_a: a.bpm,
        bpm_b: b.bpm,
        bars: None,
        a_beat_secs: a.beat_secs,
        b_beat_secs: b.beat_secs,
        note: format!("manual automix: {overlap:.2}s {template:?}"),
    }
}

/// First downbeat of B that sits inside audible, reasonably energetic material.
fn first_musical_downbeat(b: &TrackAnalysis) -> Option<f64> {
    let start = audible_start(b);
    let mut candidate = b.downbeat_at_or_after(start)?;
    let bar = b.bar_secs()?;
    for _ in 0..8 {
        if b.mean_energy(candidate, candidate + bar) >= MIN_CUE_ENERGY {
            return Some(candidate);
        }
        candidate += bar;
    }
    Some(candidate)
}

/// Choose the tempo multiple closest to B and return `(bpm_b / candidate, mode)`.
/// The ratio is what deck A must be stretched by so that its (possibly half/double-time)
/// beat grid lands on B's.
fn tempo_ratio_and_mode(bpm_a: f32, bpm_b: f32) -> (f64, usize) {
    let bpm_a = f64::from(bpm_a);
    let bpm_b = f64::from(bpm_b);
    let mut best = (f64::MAX, 1.0, 2usize);
    for (mode, multiplier) in TEMPO_MULTIPLIERS.iter().enumerate() {
        let candidate = bpm_a * multiplier;
        let ratio = bpm_b / candidate;
        let difference = (ratio - 1.0).abs();
        if difference < best.0 {
            best = (difference, ratio, mode);
        }
    }
    (best.1, best.2)
}

/// Incoming/outgoing tempo ratio after half/double-time folding.
fn tempo_ratio(bpm_a: f32, bpm_b: f32) -> f64 {
    tempo_ratio_and_mode(bpm_a, bpm_b).0
}

/// Select an entry window of 4, 8 or 12 bars from the tempo ratio.
fn entry_bars_for_ratio(ratio: f64) -> u32 {
    if ratio > CLOSE_TEMPO_RATIO_LOW && ratio < CLOSE_TEMPO_RATIO_HIGH {
        4
    } else if ratio > MODERATE_TEMPO_RATIO_LOW && ratio < MODERATE_TEMPO_RATIO_HIGH {
        8
    } else {
        12
    }
}

/// Check whether the inverse tempo ratio calls for a short four-beat blend.
fn uses_short_blend(ratio: f64) -> bool {
    let inverse = 1.0 / ratio;
    SHORT_BLEND_RATIO_BANDS
        .iter()
        .any(|(low, high)| inverse > *low && inverse < *high)
}

/// Natural blending with unchanged tempo and conservative overlap lengths.
fn basic_plan(request: &TransitionRequest<'_>) -> TransitionPlan {
    let a = request.a;
    let b = request.b;
    let a_end_audible = audible_end(a);
    let (bpm_a, bpm_b) = (a.bpm, b.bpm);
    let grids_ok = a.has_beat_grid() && b.has_beat_grid();
    let ratio = match (bpm_a, bpm_b) {
        (Some(x), Some(y)) if grids_ok => Some(tempo_ratio(x, y)),
        _ => None,
    };
    let tempo_compatible = ratio.is_some_and(|r| (r - 1.0).abs() <= BASIC_TEMPO_TOLERANCE);
    // Similar tempos use gain/bass exchange; increasing mismatch selects filters,
    // then an echo tail that does not require beat alignment.
    let moderately_compatible =
        ratio.is_some_and(|r| (r - 1.0).abs() <= BASIC_FILTER_TEMPO_TOLERANCE);
    let (bars, template) = if tempo_compatible {
        (4u32, PlanTemplate::SimpleExchange)
    } else if moderately_compatible {
        (2u32, PlanTemplate::SimpleFilter)
    } else {
        (2u32, PlanTemplate::EchoTail)
    };
    let Some(bar_secs) = a.bar_secs().filter(|_| grids_ok) else {
        // No usable grid: energy-anchored crossfade with the basic template.
        let overlap = AUTOMIX_FALLBACK_SECS.min(a_end_audible);
        return TransitionPlan {
            mode: TransitionMode::AutomixBasic,
            strategy: DecisionStrategy::Natural,
            trigger: request.trigger,
            a_cut_secs: a_end_audible - overlap,
            a_end_secs: a_end_audible,
            b_start_secs: audible_start(b),
            overlap_secs: overlap,
            template: Some(PlanTemplate::FallbackExchange),
            a_tempo_ratio: 1.0,
            speed_type: SpeedType::None,
            bpm_a,
            bpm_b,
            bars: None,
            a_beat_secs: a.beat_secs,
            b_beat_secs: b.beat_secs,
            note: "basic: no beat grid, energy-anchored FallbackExchange".to_string(),
        };
    };
    let mut bars = bars;
    let mut overlap = bar_secs * f64::from(bars);
    while overlap > BASIC_MAX_OVERLAP_SECS && bars > 1 {
        // Shorten the overlap until it fits the duration limit.
        bars -= 1;
        overlap = bar_secs * f64::from(bars);
    }
    // Exit cue: the downbeat `bars` bars before the last downbeat of A, preferring a section
    // boundary within ±1 bar of it.
    let a_last_downbeat = a
        .downbeat_at_or_before(a_end_audible)
        .unwrap_or(a_end_audible);
    let mut a_cut = a_last_downbeat - overlap;
    if let Some(section) = nearest_section(a, a_cut, bar_secs) {
        a_cut = section;
    }
    a_cut = a_cut.max(0.0);
    let a_end = (a_cut + overlap).min(a_end_audible);
    let overlap = a_end - a_cut;
    let b_start = first_musical_downbeat(b).unwrap_or_else(|| audible_start(b));
    TransitionPlan {
        mode: TransitionMode::AutomixBasic,
        strategy: DecisionStrategy::Natural,
        trigger: request.trigger,
        a_cut_secs: a_cut,
        a_end_secs: a_end,
        b_start_secs: b_start,
        overlap_secs: overlap,
        template: Some(template),
        a_tempo_ratio: 1.0,
        speed_type: SpeedType::None,
        bpm_a,
        bpm_b,
        bars: Some(bars),
        a_beat_secs: a.beat_secs,
        b_beat_secs: b.beat_secs,
        note: format!(
            "natural blend: {bars} bars ({overlap:.2}s) {template:?}, ratio {:?}",
            ratio.map(|r| format!("{r:.3}"))
        ),
    }
}

/// Section boundary of `a` within one bar of `target`, if any.
fn nearest_section(a: &TrackAnalysis, target: f64, bar_secs: f64) -> Option<f64> {
    a.sections
        .iter()
        .copied()
        .filter(|section| (section - target).abs() <= bar_secs)
        .min_by(|x, y| (x - target).abs().partial_cmp(&(y - target).abs()).unwrap())
}

/// Rhythm blending: evaluate tempo adjustment, choose an entry window, align cue
/// points to downbeats and sections, then select effects for the overlap length.
/// Incompatible tempos fall back to a fixed filter blend.
fn pro_plan(request: &TransitionRequest<'_>) -> TransitionPlan {
    let a = request.a;
    let b = request.b;
    let a_end_audible = audible_end(a);
    let grids_ok = a.has_beat_grid() && b.has_beat_grid();
    let (Some(bpm_a), Some(bpm_b), true) = (a.bpm, b.bpm, grids_ok) else {
        return filter_fallback_plan(request, "pro: no beat grid → layered filter fallback");
    };
    // Stretching A is opt-in (`match_tempo`): speeding a song the listener already
    // knows is heard as a rush. Default is a filter mix whenever the residual is
    // outside the no-stretch band.
    let raw_ratio = f64::from(bpm_b) / f64::from(bpm_a);
    let (ratio, speed_mode) = tempo_ratio_and_mode(bpm_a, bpm_b);
    let (speed_type, a_tempo_ratio) = if (ratio - 1.0).abs() <= NO_STRETCH_TOLERANCE {
        (SpeedType::None, 1.0)
    } else if request.settings.match_tempo && (MIN_STRETCH_RATIO..=MAX_STRETCH_RATIO).contains(&ratio)
    {
        (SpeedType::TempoMatch, ratio)
    } else {
        return filter_fallback_plan(
            request,
            &format!(
                "pro: residual tempo ratio {ratio:.3} (mode {speed_mode}) {} → layered filter fallback",
                if request.settings.match_tempo {
                    "outside stretch range"
                } else {
                    "match-tempo off"
                }
            ),
        );
    };
    // Select the entry window from the raw tempo ratio before half/double-time folding.
    let special = uses_short_blend(raw_ratio);
    let b_beat = b.beat_secs.unwrap_or(0.5);
    let b_bar = b.bar_secs().unwrap_or(b_beat * 4.0);
    let a_bar = a.bar_secs().unwrap_or(b_bar);
    // `bars` counts A's bars before its last downbeat; the special condition is a fixed
    // four-beat blend spanning one bar of the incoming track.
    let mut bars: u32 = if special {
        1
    } else {
        entry_bars_for_ratio(raw_ratio)
    };
    let effective_overlap = |bars: u32| {
        let a_span = a_bar * f64::from(bars);
        if speed_type == SpeedType::TempoMatch {
            a_span / a_tempo_ratio
        } else {
            a_span
        }
    };
    while effective_overlap(bars) > PRO_MAX_OVERLAP_SECS && bars > 1 {
        // Prefer shorter musical windows when the current overlap exceeds the limit.
        bars = match bars {
            12 => 8,
            8 => 4,
            4 => 2,
            _ => 1,
        };
    }
    // Place the outgoing cue on a downbeat, preferring a nearby section boundary.
    let a_last_downbeat = a
        .downbeat_at_or_before(a_end_audible)
        .unwrap_or(a_end_audible);
    let a_span = a_bar * f64::from(bars);
    let mut a_cut = a_last_downbeat - a_span;
    if !special {
        if let Some(section) = nearest_section(a, a_cut, a_bar) {
            a_cut = section;
        }
    }
    if a_cut < 0.0 {
        return filter_fallback_plan(request, "pro: negative exit cue → layered filter fallback");
    }
    let a_end = (a_cut + a_span).min(a_end_audible);
    let overlap = if speed_type == SpeedType::TempoMatch {
        (a_end - a_cut) / a_tempo_ratio
    } else {
        a_end - a_cut
    };
    // Prefer a downbeat such that B's first section boundary lands at the end of the
    // overlap (the drop arrives exactly when A is gone); otherwise the first musical downbeat.
    let b_first = first_musical_downbeat(b).unwrap_or_else(|| audible_start(b));
    let b_start = b
        .sections
        .iter()
        .copied()
        .filter(|section| *section > b_first + overlap)
        .map(|section| section - overlap)
        .filter_map(|candidate| b.nearest_downbeat(candidate))
        .find(|candidate| {
            *candidate >= b_first && b.mean_energy(*candidate, *candidate + b_bar) >= MIN_CUE_ENERGY
        })
        .unwrap_or(b_first);
    // Long beat-matched blends get the full 3-band/reverb treatment, medium ones the
    // filter+EQ exchange, short ones the plain HPF/LPF sweep; the special
    // 4-beat blend uses the echo tail so A's last bar rings out under B.
    let template = if special {
        PlanTemplate::EchoTail
    } else {
        match bars {
            b if b >= 8 => PlanTemplate::ThreeBand,
            4 => PlanTemplate::FilterEq,
            _ => PlanTemplate::SimpleFilter,
        }
    };
    TransitionPlan {
        mode: TransitionMode::AutomixPro,
        strategy: if speed_type == SpeedType::TempoMatch {
            DecisionStrategy::TempoMatched
        } else {
            DecisionStrategy::Section
        },
        trigger: request.trigger,
        a_cut_secs: a_cut,
        a_end_secs: a_end,
        b_start_secs: b_start,
        overlap_secs: overlap,
        template: Some(template),
        a_tempo_ratio,
        speed_type,
        bpm_a: Some(bpm_a),
        bpm_b: Some(bpm_b),
        bars: Some(bars),
        a_beat_secs: a.beat_secs,
        b_beat_secs: b.beat_secs,
        note: format!(
            "pro: bpm {bpm_a:.1}→{bpm_b:.1} raw {raw_ratio:.3} residual {ratio:.3} mode {speed_mode} {speed_type:?} special={special} {bars} bars {overlap:.2}s {template:?}"
        ),
    }
}

/// Layered filter blend used when tempos cannot be matched.
fn filter_fallback_plan(request: &TransitionRequest<'_>, note: &str) -> TransitionPlan {
    let a = request.a;
    let b = request.b;
    let a_end = audible_end(a);
    let overlap = FILTER_FALLBACK_OVERLAP_SECS.min(a_end);
    let a_cut = (a_end - overlap).max(0.0);
    let a_cut = a
        .nearest_downbeat(a_cut)
        .filter(|t| *t >= 0.0 && *t < a_end)
        .unwrap_or(a_cut);
    let overlap = a_end - a_cut;
    let b_start = first_musical_downbeat(b).unwrap_or_else(|| audible_start(b));
    TransitionPlan {
        mode: TransitionMode::AutomixPro,
        strategy: DecisionStrategy::Section,
        trigger: request.trigger,
        a_cut_secs: a_cut,
        a_end_secs: a_end,
        b_start_secs: b_start,
        overlap_secs: overlap,
        template: Some(PlanTemplate::LayeredFilter),
        a_tempo_ratio: 1.0,
        speed_type: SpeedType::None,
        bpm_a: a.bpm,
        bpm_b: b.bpm,
        bars: None,
        a_beat_secs: a.beat_secs,
        b_beat_secs: b.beat_secs,
        note: note.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn analysis(duration: f64, bpm: f32, downbeat: f64, sections: Vec<f64>) -> TrackAnalysis {
        let beat = 60.0 / f64::from(bpm);
        let hops = (duration / super::super::analysis::ENVELOPE_HOP_SECS) as usize;
        TrackAnalysis {
            duration_secs: duration,
            window_start_secs: 0.0,
            window_end_secs: duration,
            leading_silence_secs: Some(0.4),
            trailing_silence_start_secs: Some(duration - 1.0),
            bpm: Some(bpm),
            beat_secs: Some(beat),
            beat_phase_secs: Some(downbeat),
            downbeat_phase_secs: Some(downbeat),
            beat_confidence: 0.9,
            energy: vec![0.2; hops],
            sections,
        }
    }

    fn settings(mode: TransitionMode, fade_secs: f32) -> TransitionSettings {
        TransitionSettings {
            mode,
            fade_secs,
            match_tempo: false,
        }
    }

    fn settings_match_tempo(mode: TransitionMode, fade_secs: f32) -> TransitionSettings {
        TransitionSettings {
            mode,
            fade_secs,
            match_tempo: true,
        }
    }

    #[test]
    fn gapless_uses_silence_trimmed_boundary() {
        let a = analysis(200.0, 120.0, 0.1, vec![]);
        let b = analysis(180.0, 100.0, 0.0, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::Gapless, 0.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        assert!(plan.is_gapless());
        assert_eq!(plan.a_end_secs, 199.0);
        assert_eq!(plan.a_cut_secs, 199.0);
        assert_eq!(plan.b_start_secs, 0.4);
    }

    #[test]
    fn fade_preserves_silent_head_and_tail() {
        let a = analysis(200.0, 120.0, 0.1, vec![]);
        let b = analysis(180.0, 100.0, 0.0, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::Fade, 15.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        assert_eq!(plan.overlap_secs, 15.0);
        assert_eq!(plan.a_cut_secs, 185.0);
        assert_eq!(plan.a_end_secs, 200.0);
        assert_eq!(plan.b_start_secs, 0.0);
        assert!(plan.uses_plain_fade());
        // Zero fade must not enable silence trimming.
        let zero = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::Fade, 0.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        });
        assert!(zero.is_none());
    }

    #[test]
    fn short_fade_tracks_fall_back_without_enabling_silence_trimming() {
        for (a_duration, b_duration) in [(20.0, 180.0), (200.0, 20.0)] {
            let a = analysis(a_duration, 120.0, 0.0, vec![]);
            let b = analysis(b_duration, 120.0, 0.0, vec![]);
            assert!(decide_transition(&TransitionRequest {
                settings: settings(TransitionMode::Fade, 15.0),
                trigger: TransitionTrigger::EndOfTrack,
                a: &a,
                b: &b,
                a_position_secs: 0.0,
            })
            .is_none());
        }
    }

    #[test]
    fn manual_fade_starts_now_and_is_capped() {
        let a = analysis(200.0, 120.0, 0.1, vec![]);
        let b = analysis(180.0, 100.0, 0.0, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::Fade, 15.0),
            trigger: TransitionTrigger::Manual,
            a: &a,
            b: &b,
            a_position_secs: 42.0,
        })
        .unwrap();
        assert_eq!(plan.a_cut_secs, 42.0);
        assert_eq!(plan.overlap_secs, MANUAL_MAX_OVERLAP_SECS);
        assert_eq!(plan.a_end_secs, 46.0);
    }

    #[test]
    fn basic_mode_picks_four_bars_and_simple_exchange_for_compatible_tempos() {
        let a = analysis(200.0, 120.0, 0.1, vec![]);
        let b = analysis(180.0, 122.0, 0.3, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::AutomixBasic, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        assert_eq!(plan.strategy, DecisionStrategy::Natural);
        assert_eq!(plan.bars, Some(4));
        assert_eq!(plan.template, Some(PlanTemplate::SimpleExchange));
        assert_eq!(plan.speed_type, SpeedType::None);
        // 4 bars at 120 bpm = 8 s, ending on the last downbeat before the audible end.
        assert!(
            (plan.overlap_secs - 8.0).abs() < 1e-6,
            "{}",
            plan.overlap_secs
        );
        let bar = 2.0;
        let frac = ((plan.a_cut_secs - 0.1) / bar).fract();
        assert!(
            frac.abs() < 1e-6 || (1.0 - frac).abs() < 1e-6,
            "cut not on downbeat: {}",
            plan.a_cut_secs
        );
        // B starts on its first downbeat after the audible start (0.3 + k·bar ≥ 0.4).
        assert!((plan.b_start_secs - (0.3 + 60.0 / 122.0 * 4.0)).abs() < 1e-6);
    }

    #[test]
    fn basic_mode_picks_filter_or_echo_when_tempos_differ() {
        let a = analysis(200.0, 120.0, 0.1, vec![]);
        let b = analysis(180.0, 95.0, 0.0, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::AutomixBasic, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        // 120 vs 95 bpm: 21 % apart → echo tail blend over 2 bars.
        assert_eq!(plan.template, Some(PlanTemplate::EchoTail));
        assert_eq!(plan.bars, Some(2));
        assert!((plan.overlap_secs - 4.0).abs() < 1e-6);
        let b = analysis(180.0, 110.0, 0.0, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::AutomixBasic, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        // 120 vs 110 bpm: 8 % apart → filter sweep.
        assert_eq!(plan.template, Some(PlanTemplate::SimpleFilter));
    }

    #[test]
    fn pro_mode_keeps_original_tempo_for_close_ratios_and_does_not_stretch() {
        let a = analysis(240.0, 120.0, 0.5, vec![]);
        let b = analysis(200.0, 120.5, 0.2, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::AutomixPro, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        assert_eq!(plan.strategy, DecisionStrategy::Section);
        assert_eq!(plan.speed_type, SpeedType::None);
        assert!((plan.a_tempo_ratio - 1.0).abs() < 1e-9);
        // Ratio ≈ 1.004 falls in the close-tempo band and selects four bars.
        assert_eq!(plan.bars, Some(4));
        assert_eq!(plan.template, Some(PlanTemplate::FilterEq));
        // 4 bars at 120 bpm = 8 s, unstretched.
        assert!((plan.overlap_secs - 8.0).abs() < 1e-3, "{}", plan.overlap_secs);

        // 124 vs 128 is ±3 %: previously TempoMatch (audible rush). Now filter fallback.
        let a = analysis(240.0, 124.0, 0.5, vec![]);
        let b = analysis(200.0, 128.0, 0.2, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::AutomixPro, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        assert_eq!(plan.speed_type, SpeedType::None);
        assert!((plan.a_tempo_ratio - 1.0).abs() < 1e-9);
        assert_eq!(plan.template, Some(PlanTemplate::LayeredFilter));
    }

    #[test]
    fn pro_mode_match_tempo_stretches_outgoing_within_eight_percent() {
        let a = analysis(240.0, 124.0, 0.5, vec![]);
        let b = analysis(200.0, 128.0, 0.2, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings_match_tempo(TransitionMode::AutomixPro, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        assert_eq!(plan.strategy, DecisionStrategy::TempoMatched);
        assert_eq!(plan.speed_type, SpeedType::TempoMatch);
        assert!((plan.a_tempo_ratio - 128.0 / 124.0).abs() < 1e-6);
        assert_eq!(plan.bars, Some(4));
        assert_eq!(plan.template, Some(PlanTemplate::FilterEq));
        assert!(
            (plan.overlap_secs - 7.5).abs() < 1e-3,
            "{}",
            plan.overlap_secs
        );
        assert!((plan.a_end_secs - plan.a_cut_secs - 240.0 / 124.0 * 4.0).abs() < 1e-3);
    }

    #[test]
    fn pro_mode_prefers_section_boundaries_and_falls_back_from_twelve_bars_to_eight() {
        // Ratio 1.004 selects four bars; to exercise the section snap
        // and the 25 s upper-limit fallback we use a slow track: 12 bars at 60 bpm = 48 s
        // > 25 s → 8 bars = 32 s > 25 s → 4 bars = 16 s.
        let a_bar = 4.0; // 60 bpm
        let a_last_downbeat = 196.0; // downbeats at 0 + k·4 ≤ 199
        let section = a_last_downbeat - 4.0 * a_bar - a_bar; // one bar earlier than the pure count
        let a = analysis(200.0, 60.0, 0.0, vec![section]);
        let b = analysis(200.0, 60.25, 0.0, vec![30.0]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::AutomixPro, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        assert_eq!(plan.speed_type, SpeedType::None);
        assert_eq!(plan.bars, Some(4));
        assert_eq!(plan.template, Some(PlanTemplate::FilterEq));
        assert_eq!(plan.a_cut_secs, section);
        assert!(plan.overlap_secs <= PRO_MAX_OVERLAP_SECS);
        // B's section at 30 s should land at the end of the overlap: b_start ≈ 30 - overlap.
        let expected_b = 30.0 - plan.overlap_secs;
        assert!((plan.b_start_secs - expected_b).abs() < 60.0 / 60.25 * 4.0 + 1e-6);
        assert!(plan.b_start_secs >= 0.4);
    }

    #[test]
    fn entry_windows_and_short_blend_bands_respect_thresholds() {
        assert_eq!(entry_bars_for_ratio(1.0), 4);
        assert_eq!(entry_bars_for_ratio(1.05), 4);
        assert_eq!(entry_bars_for_ratio(1.06), 8);
        assert_eq!(entry_bars_for_ratio(0.9), 8);
        assert_eq!(entry_bars_for_ratio(0.84), 12);
        assert_eq!(entry_bars_for_ratio(1.2), 12);
        // 1/ratio ∈ (0.64, 0.85) ∪ (1.493, 1.8)
        assert!(uses_short_blend(1.0 / 0.7));
        assert!(uses_short_blend(1.0 / 1.6));
        assert!(!uses_short_blend(1.0));
        assert!(!uses_short_blend(1.0 / 0.9));
        // Mode table: 60 vs 120 bpm → mode 1 (×2) with ratio 1.
        let (ratio, mode) = tempo_ratio_and_mode(60.0, 120.0);
        assert!((ratio - 1.0).abs() < 1e-9);
        assert_eq!(mode, 1);
        let (ratio, mode) = tempo_ratio_and_mode(120.0, 61.0);
        assert!((ratio - 61.0 / 60.0).abs() < 1e-9);
        assert_eq!(mode, 3);
        assert_eq!(tempo_ratio_and_mode(100.0, 104.0).1, 2);
    }

    #[test]
    fn pro_mode_uses_filter_fallback_when_tempos_are_incompatible_or_grid_missing() {
        let a = analysis(200.0, 120.0, 0.0, vec![]);
        let b = analysis(200.0, 150.0, 0.0, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::AutomixPro, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        assert_eq!(plan.template, Some(PlanTemplate::LayeredFilter));
        assert_eq!(plan.speed_type, SpeedType::None);
        assert!(plan.overlap_secs > 10.0 && plan.overlap_secs <= 12.0);

        // 120 vs 63 bpm: residual 1.05 used to TempoMatch (audible 5 % rush). Now filter.
        let b = analysis(200.0, 63.0, 0.0, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::AutomixPro, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        assert_eq!(plan.speed_type, SpeedType::None);
        assert!((plan.a_tempo_ratio - 1.0).abs() < 1e-9);
        assert_eq!(plan.template, Some(PlanTemplate::LayeredFilter));

        // 120 vs 150 bpm: raw 1.25 → 1/ratio = 0.8 ∈ (0.64, 0.85): special 4-beat blend,
        // but the residual (mode 2, 1.25) requires the layered filter fallback.
        let b150 = analysis(200.0, 150.0, 0.0, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::AutomixPro, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b150,
            a_position_secs: 0.0,
        })
        .unwrap();
        assert_eq!(plan.template, Some(PlanTemplate::LayeredFilter));

        // 120 vs 84 bpm: raw ratio 0.7 → 1/ratio = 1.43 is outside the special band, but
        // 120 vs 78 bpm: raw 0.65 → 1/ratio ≈ 1.54 ∈ (1.493, 1.8): special 4-beat blend.
        let b = analysis(200.0, 78.0, 0.0, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::AutomixPro, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        // Residual after ×0.5 folding: 78/60 = 1.3 requires the layered filter fallback.
        assert_eq!(plan.template, Some(PlanTemplate::LayeredFilter));

        let mut no_grid = analysis(200.0, 120.0, 0.0, vec![]);
        no_grid.beat_confidence = 0.1;
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::AutomixPro, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &no_grid,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        assert_eq!(plan.template, Some(PlanTemplate::LayeredFilter));
    }

    #[test]
    fn short_tracks_never_get_a_long_musical_blend() {
        let a = analysis(20.0, 120.0, 0.0, vec![]);
        let b = analysis(200.0, 120.0, 0.0, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::AutomixPro, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        assert_eq!(plan.strategy, DecisionStrategy::Fade);
        assert!(plan.overlap_secs <= 4.0);
        assert!(decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::None, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        })
        .is_none());
    }

    #[test]
    fn tempo_ratio_considers_half_and_double_time() {
        assert!((tempo_ratio(120.0, 240.0) - 1.0).abs() < 1e-9);
        assert!((tempo_ratio(120.0, 61.0) - 61.0 * 2.0 / 120.0).abs() < 1e-9);
        assert!((tempo_ratio(100.0, 104.0) - 1.04).abs() < 1e-9);
    }
}
