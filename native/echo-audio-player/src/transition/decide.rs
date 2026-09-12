//! Cue-point decision: the `DesideCue` V1 / V2 / V3 reconstruction.
//!
//! QQ's `transformInfo` tries `DesideCueV3 → V2 → V1` and every version emits the same
//! record: `cue1` (cut start on the outgoing track A), `cue2` (entry point on the incoming
//! track B), selected bars, duration, `bpm_in / bpm_out`, `szMixMode` (plan template) and
//! `speedType` (0 = no stretch, 2 = tempo match). This module produces the equivalent
//! [`TransitionPlan`] for all four user modes:
//!
//! * **Gapless** – zero-length overlap at the silence-trimmed boundary.
//! * **Fade** – equal-power overlap of the configured length anchored on the audible end
//!   of A and the audible start of B.
//! * **AutoMix basic** (V1 analogue) – no tempo change; short bar-counted overlap using the
//!   `simpleexchange` / `NoPlan` templates, cut points snapped to downbeats.
//! * **AutoMix pro** (V3/V2 analogue) – evaluates "no speed change" vs "speed change"
//!   (`Best speed mode`), picks the bar count from the BPM ratio (4/8 bars, 2 bars for the
//!   special ratio condition), prefers section boundaries for `cue1`, enforces the
//!   duration upper limit with entry fallback, and selects a multi-band template.
//!
//! Numeric thresholds that the binary does not expose as strings (`reviseMixMode`
//! mapping, the special-ratio bound, the duration limits) are our own choices and are
//! called out as such in comments.

use super::analysis::TrackAnalysis;
use super::plan::PlanTemplate;
use super::{TransitionMode, TransitionSettings, MIN_SUPPORTED_TRACK_SECS};
use serde::Serialize;

/// Upper bound for a manually triggered crossfade (user pressed "next").
pub const MANUAL_MAX_OVERLAP_SECS: f64 = 4.0;
/// Duration upper limit for basic automix (`duration_thresh` analogue; our choice).
const BASIC_MAX_OVERLAP_SECS: f64 = 16.0;
/// Duration upper limit for pro automix. Disassembly-confirmed constant
/// (`double 0x4039000000000000` = 25.0, "Duration %f exceeds upper limit %f").
const PRO_MAX_OVERLAP_SECS: f64 = 25.0;
/// Fallback overlap when no beat grid is available.
const AUTOMIX_FALLBACK_SECS: f64 = 8.0;
const AM_FILTER_OVERLAP_SECS: f64 = 12.0;
/// V2 entry selection thresholds on `ratio = bpm_out / bpm_in` (disassembly-confirmed
/// rational constants 19/20, 20/19, 17/20, 20/17):
/// * small  – ratio ∈ (19/20, 20/19) → `fcue_entry_1` (4 bars)
/// * large  – ratio ∈ (17/20, 20/17) but not small → `fcue_entry_2` (8 bars)
/// * medium – otherwise → `fcue_entry_3` (12 bars)
const V2_SMALL_LOW: f64 = 19.0 / 20.0;
const V2_SMALL_HIGH: f64 = 20.0 / 19.0;
const V2_LARGE_LOW: f64 = 17.0 / 20.0;
const V2_LARGE_HIGH: f64 = 20.0 / 17.0;
/// Special 2-bar condition on `1/ratio = bpm_in / bpm_out` (disassembly-confirmed
/// constants 0.64 / 0.85 / 1.493 / 1.8): a fixed 4-beat blend.
const V2_SPECIAL_BANDS: [(f64, f64); 2] = [(0.64, 0.85), (1.493, 1.8)];
/// V3 speed modes: `bpm_out = bpm_in × {3, 2, 1, 0.5, 1/3}` (mode 0..4).
const V3_SPEED_MULTIPLIERS: [f64; 5] = [3.0, 2.0, 1.0, 0.5, 1.0 / 3.0];
/// Tempo ratio tolerance below which no stretch is applied (`Type=0`; our choice).
const NO_STRETCH_TOLERANCE: f64 = 0.01;
/// Largest stretch we are willing to apply to the outgoing track (our choice: ±8 %).
const MAX_STRETCH_RATIO: f64 = 1.08;
const MIN_STRETCH_RATIO: f64 = 0.92;
/// Basic mode accepts tracks whose tempos differ by at most this much without stretching.
const BASIC_TEMPO_TOLERANCE: f64 = 0.04;
/// Beyond `BASIC_TEMPO_TOLERANCE` but within this, basic mode still blends with the filter
/// sweep (`filter2`); further apart it uses the echo tail (`echo`).
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
    /// `Type=0 (no speed change)`
    None,
    /// `Type=2 (speed change)` – outgoing track tempo-matched to the incoming one.
    TempoMatch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DecisionVersion {
    Gapless,
    Fade,
    /// `DesideCue` (V1)
    V1,
    /// `DesideCueV2` (entry-index based fallback path)
    V2,
    /// `DesideCueV3` (speed-mode evaluation)
    V3,
}

/// Everything the mixer needs to render one transition.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TransitionPlan {
    pub mode: TransitionMode,
    pub version: DecisionVersion,
    pub trigger: TransitionTrigger,
    /// `cue1`: timestamp on A where the overlap (and B) starts.
    pub a_cut_secs: f64,
    /// Timestamp on A after which A is no longer fed to the mixer.
    pub a_end_secs: f64,
    /// `cue2`: timestamp on B where playback of B starts.
    pub b_start_secs: f64,
    /// Overlap window length in seconds (0 for gapless).
    pub overlap_secs: f64,
    /// Plan template (None = pass-through decks with equal-power gains from the mixer).
    pub template: Option<PlanTemplate>,
    /// Tempo ratio applied to A (`bpm_out / bpm_in` semantics; 1.0 when unstretched).
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

    /// The template's equal-power gains are expressed in dB inside the plan; a plain fade
    /// (no template) gets equal-power gains from the mixer's own curves. Both are
    /// represented by `template == None` + this flag.
    pub fn uses_equal_power_fade(&self) -> bool {
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
                return Some(gapless_plan(request));
            }
            // `fadePlaySupportSongMinDuration`: very short tracks are never overlapped.
            if a.duration_secs < MIN_SUPPORTED_TRACK_SECS
                || (b.duration_secs > 0.0 && b.duration_secs < MIN_SUPPORTED_TRACK_SECS)
            {
                return Some(gapless_plan(request));
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
        version: DecisionVersion::Gapless,
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
    let b_start = audible_start(b);
    let (a_cut, a_end, overlap) = match request.trigger {
        TransitionTrigger::EndOfTrack => {
            let a_end = audible_end(a);
            let overlap = fade_secs.min(a_end).max(0.0);
            (a_end - overlap, a_end, overlap)
        }
        TransitionTrigger::Manual => {
            let a_cut = request.a_position_secs.clamp(0.0, a.duration_secs);
            let remaining = (audible_end(a) - a_cut).max(0.0);
            let overlap = fade_secs.min(MANUAL_MAX_OVERLAP_SECS).min(remaining);
            (a_cut, a_cut + overlap, overlap)
        }
    };
    if overlap <= 0.05 {
        let mut plan = gapless_plan(request);
        plan.mode = TransitionMode::Fade;
        plan.version = DecisionVersion::Fade;
        return plan;
    }
    TransitionPlan {
        mode: TransitionMode::Fade,
        version: DecisionVersion::Fade,
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
        note: format!("fade: {overlap:.2}s equal-power, B from {b_start:.2}s"),
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
        PlanTemplate::NoPlan
    };
    TransitionPlan {
        mode: request.settings.mode,
        version: DecisionVersion::V1,
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

/// V3 `Best speed mode`: among `bpm_a × {3, 2, 1, 0.5, 1/3}` pick the candidate closest to
/// `bpm_b` and return `(ratio = candidate / bpm_b … expressed as bpm_b / candidate, mode)`.
/// The ratio is what deck A must be stretched by so that its (possibly half/double-time)
/// beat grid lands on B's.
fn tempo_ratio_and_mode(bpm_a: f32, bpm_b: f32) -> (f64, usize) {
    let bpm_a = f64::from(bpm_a);
    let bpm_b = f64::from(bpm_b);
    let mut best = (f64::MAX, 1.0, 2usize);
    for (mode, multiplier) in V3_SPEED_MULTIPLIERS.iter().enumerate() {
        let candidate = bpm_a * multiplier;
        let ratio = bpm_b / candidate;
        let difference = (ratio - 1.0).abs();
        if difference < best.0 {
            best = (difference, ratio, mode);
        }
    }
    (best.1, best.2)
}

/// Relative tempo ratio (`bpm_out / bpm_in` semantics) after half/double-time folding.
fn tempo_ratio(bpm_a: f32, bpm_b: f32) -> f64 {
    tempo_ratio_and_mode(bpm_a, bpm_b).0
}

/// V2 entry choice from the BPM ratio: 4 / 8 / 12 bars (`fcue_entry_1/2/3`).
fn v2_bars_for_ratio(ratio: f64) -> u32 {
    if ratio > V2_SMALL_LOW && ratio < V2_SMALL_HIGH {
        4
    } else if ratio > V2_LARGE_LOW && ratio < V2_LARGE_HIGH {
        8
    } else {
        12
    }
}

/// V2 special condition: `1/ratio` inside one of the two bands → fixed 4-beat blend.
fn v2_special_two_bar(ratio: f64) -> bool {
    let inverse = 1.0 / ratio;
    V2_SPECIAL_BANDS
        .iter()
        .any(|(low, high)| inverse > *low && inverse < *high)
}

/// `DesideCue` V1 analogue: no tempo change, conservative bar counts.
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
    // V1 `Selected mode`: `simpleexchange` for compatible tempos, `filter2` (HPF/LPF
    // sweep, robust to a moderate tempo mismatch) for moderately different ones, `echo`
    // (A rings out under a linear B fade-in) when the tempos are unrelated.
    let moderately_compatible =
        ratio.is_some_and(|r| (r - 1.0).abs() <= BASIC_FILTER_TEMPO_TOLERANCE);
    let (bars, template) = if tempo_compatible {
        (4u32, PlanTemplate::SimpleExchange)
    } else if moderately_compatible {
        (2u32, PlanTemplate::SimpleFilter)
    } else {
        (2u32, PlanTemplate::EchoDecline)
    };
    let Some(bar_secs) = a.bar_secs().filter(|_| grids_ok) else {
        // No usable grid: energy-anchored crossfade with the basic template.
        let overlap = AUTOMIX_FALLBACK_SECS.min(a_end_audible);
        return TransitionPlan {
            mode: TransitionMode::AutomixBasic,
            version: DecisionVersion::V1,
            trigger: request.trigger,
            a_cut_secs: a_end_audible - overlap,
            a_end_secs: a_end_audible,
            b_start_secs: audible_start(b),
            overlap_secs: overlap,
            template: Some(PlanTemplate::NoPlan),
            a_tempo_ratio: 1.0,
            speed_type: SpeedType::None,
            bpm_a,
            bpm_b,
            bars: None,
            a_beat_secs: a.beat_secs,
            b_beat_secs: b.beat_secs,
            note: "basic: no beat grid, energy-anchored NoPlan".to_string(),
        };
    };
    let mut bars = bars;
    let mut overlap = bar_secs * f64::from(bars);
    while overlap > BASIC_MAX_OVERLAP_SECS && bars > 1 {
        // `Try %d failed - duration exceeds duration_thresh` → shorter combination.
        bars -= 1;
        overlap = bar_secs * f64::from(bars);
    }
    // cue1: the downbeat `bars` bars before the last downbeat of A, preferring a section
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
        version: DecisionVersion::V1,
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
            "basic V1: {bars} bars ({overlap:.2}s) {template:?}, ratio {:?}",
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

/// `DesideCueV3` / `V2` analogue.
///
/// 1. V3: evaluate Type 0 (no speed change) against Type 2 (`bpm_out = bpm_in × mode
///    multiplier`) and keep the smaller tempo difference. The *residual* ratio after
///    folding decides whether stretching deck A is feasible.
/// 2. V2: the *raw* `bpm_out / bpm_in` ratio (before folding, as in the binary) picks the
///    entry — 4 / 8 / 12 bars before the cut — and the special 2-bar condition (fixed
///    4-beat blend); the duration is then capped at 25 s by falling back to shorter entries.
/// 3. Snap `cue1` to A's downbeat grid (preferring a section boundary) and `cue2` to B's.
/// 4. `reviseMixMode`: the template follows the bar count; an unusable tempo relation
///    degrades the plan to the filter (`EQfilter`) family, and a mix that cannot be
///    beat-matched at all ends up on the AM filter blend.
fn pro_plan(request: &TransitionRequest<'_>) -> TransitionPlan {
    let a = request.a;
    let b = request.b;
    let a_end_audible = audible_end(a);
    let grids_ok = a.has_beat_grid() && b.has_beat_grid();
    let (Some(bpm_a), Some(bpm_b), true) = (a.bpm, b.bpm, grids_ok) else {
        return am_filter_plan(request, "pro: no beat grid → AM filter plan");
    };
    // --- V3: Type 0 vs Type 2 -----------------------------------------------------------
    let raw_ratio = f64::from(bpm_b) / f64::from(bpm_a);
    let (ratio, speed_mode) = tempo_ratio_and_mode(bpm_a, bpm_b);
    let (speed_type, a_tempo_ratio) = if (ratio - 1.0).abs() <= NO_STRETCH_TOLERANCE {
        (SpeedType::None, 1.0)
    } else if (MIN_STRETCH_RATIO..=MAX_STRETCH_RATIO).contains(&ratio) {
        // Stretch A (the outgoing deck) so its beats land on B's grid.
        (SpeedType::TempoMatch, ratio)
    } else {
        // `correctBpmOut: bpm of the two songs are not suitable for automix`
        return am_filter_plan(
            request,
            &format!("pro: residual tempo ratio {ratio:.3} (mode {speed_mode}) outside stretch range → AM filter plan"),
        );
    };
    // --- V2: entry / bar count from the raw ratio -----------------------------------------
    let special = v2_special_two_bar(raw_ratio);
    let b_beat = b.beat_secs.unwrap_or(0.5);
    let b_bar = b.bar_secs().unwrap_or(b_beat * 4.0);
    let a_bar = a.bar_secs().unwrap_or(b_bar);
    // `bars` counts A's bars before its last downbeat; the special condition is a fixed
    // 4-beat blend (`duration = (60/bpm_in) × 4`, one bar of the incoming track).
    let mut bars: u32 = if special {
        1
    } else {
        v2_bars_for_ratio(raw_ratio)
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
        // `Duration %f exceeds upper limit %f, attempting to fallback from entry_%d`
        bars = match bars {
            12 => 8,
            8 => 4,
            4 => 2,
            _ => 1,
        };
    }
    if effective_overlap(bars) > PRO_MAX_OVERLAP_SECS {
        // `Warning: Final duration %f still exceeds upper limit %f` — keep the plan.
    }
    // --- cue1 on A --------------------------------------------------------------------
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
        // `Fallback would result in negative cue1`
        return am_filter_plan(request, "pro: negative cue1 → AM filter plan");
    }
    let a_end = (a_cut + a_span).min(a_end_audible);
    let overlap = if speed_type == SpeedType::TempoMatch {
        (a_end - a_cut) / a_tempo_ratio
    } else {
        a_end - a_cut
    };
    // --- cue2 on B ---------------------------------------------------------------------
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
    // --- reviseMixMode --------------------------------------------------------------------
    // Long beat-matched blends get the full 3-band/reverb treatment, medium ones the
    // filter+EQ exchange (`EQfilter`), short ones the plain HPF/LPF sweep; the special
    // 4-beat blend uses the echo tail so A's last bar rings out under B.
    let template = if special {
        PlanTemplate::EchoDecline
    } else {
        match bars {
            b if b >= 8 => PlanTemplate::ThreeBand,
            4 => PlanTemplate::FilterEq,
            _ => PlanTemplate::SimpleFilter,
        }
    };
    TransitionPlan {
        mode: TransitionMode::AutomixPro,
        version: if speed_type == SpeedType::TempoMatch {
            DecisionVersion::V3
        } else {
            DecisionVersion::V2
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

/// Apple-Music style filter blend used when tempos cannot be matched.
fn am_filter_plan(request: &TransitionRequest<'_>, note: &str) -> TransitionPlan {
    let a = request.a;
    let b = request.b;
    let a_end = audible_end(a);
    let overlap = AM_FILTER_OVERLAP_SECS.min(a_end);
    let a_cut = (a_end - overlap).max(0.0);
    let a_cut = a
        .nearest_downbeat(a_cut)
        .filter(|t| *t >= 0.0 && *t < a_end)
        .unwrap_or(a_cut);
    let overlap = a_end - a_cut;
    let b_start = first_musical_downbeat(b).unwrap_or_else(|| audible_start(b));
    TransitionPlan {
        mode: TransitionMode::AutomixPro,
        version: DecisionVersion::V2,
        trigger: request.trigger,
        a_cut_secs: a_cut,
        a_end_secs: a_end,
        b_start_secs: b_start,
        overlap_secs: overlap,
        template: Some(PlanTemplate::AmFilter2),
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
        TransitionSettings { mode, fade_secs }
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
    fn fade_anchors_on_audible_end_and_start() {
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
        assert_eq!(plan.a_cut_secs, 184.0);
        assert_eq!(plan.a_end_secs, 199.0);
        assert_eq!(plan.b_start_secs, 0.4);
        assert!(plan.uses_equal_power_fade());
        // Fade 0 → gapless.
        let zero = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::Fade, 0.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        assert!(zero.is_gapless());
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
        assert_eq!(plan.version, DecisionVersion::V1);
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
        assert_eq!(plan.template, Some(PlanTemplate::EchoDecline));
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
    fn pro_mode_tempo_matches_and_uses_four_bars_for_small_ratio() {
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
        assert_eq!(plan.version, DecisionVersion::V3);
        assert_eq!(plan.speed_type, SpeedType::TempoMatch);
        assert!((plan.a_tempo_ratio - 128.0 / 124.0).abs() < 1e-6);
        // ratio 1.032 is inside (19/20, 20/19) → "small" → entry_1 → 4 bars.
        assert_eq!(plan.bars, Some(4));
        assert_eq!(plan.template, Some(PlanTemplate::FilterEq));
        // Overlap is measured in B time: 4 bars at 128 bpm = 7.5 s.
        assert!(
            (plan.overlap_secs - 7.5).abs() < 1e-3,
            "{}",
            plan.overlap_secs
        );
        // A span in A time = 4 bars at 124 bpm ≈ 7.74 s.
        assert!((plan.a_end_secs - plan.a_cut_secs - 240.0 / 124.0 * 4.0).abs() < 1e-3);
    }

    #[test]
    fn pro_mode_prefers_section_boundaries_and_falls_back_from_twelve_bars_to_eight() {
        // ratio 1.004 → "small" → 4 bars per the V2 table; to exercise the section snap
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
    fn v2_entry_table_and_special_band_follow_disassembled_constants() {
        assert_eq!(v2_bars_for_ratio(1.0), 4);
        assert_eq!(v2_bars_for_ratio(1.05), 4);
        assert_eq!(v2_bars_for_ratio(1.06), 8);
        assert_eq!(v2_bars_for_ratio(0.9), 8);
        assert_eq!(v2_bars_for_ratio(0.84), 12);
        assert_eq!(v2_bars_for_ratio(1.2), 12);
        // 1/ratio ∈ (0.64, 0.85) ∪ (1.493, 1.8)
        assert!(v2_special_two_bar(1.0 / 0.7));
        assert!(v2_special_two_bar(1.0 / 1.6));
        assert!(!v2_special_two_bar(1.0));
        assert!(!v2_special_two_bar(1.0 / 0.9));
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
    fn pro_mode_uses_am_filter_when_tempos_are_incompatible_or_grid_missing() {
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
        assert_eq!(plan.template, Some(PlanTemplate::AmFilter2));
        assert_eq!(plan.speed_type, SpeedType::None);
        assert!(plan.overlap_secs > 10.0 && plan.overlap_secs <= 12.0);

        // 120 vs 63 bpm: mode 3 (×0.5) folds the residual to 1.05 (stretchable) while the
        // raw ratio 0.525 misses the special band (1/ratio ≈ 1.905) and selects the
        // "medium" entry: 12 bars of A (24 s) stretched by 1.05 → 22.9 s, under the 25 s cap.
        let b = analysis(200.0, 63.0, 0.0, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::AutomixPro, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        assert_eq!(plan.speed_type, SpeedType::TempoMatch);
        assert!(
            (plan.a_tempo_ratio - 1.05).abs() < 1e-9,
            "{}",
            plan.a_tempo_ratio
        );
        assert_eq!(plan.bars, Some(12));
        assert_eq!(plan.template, Some(PlanTemplate::ThreeBand));
        assert!(
            (plan.overlap_secs - 24.0 / 1.05).abs() < 1e-6,
            "{}",
            plan.overlap_secs
        );
        assert!(plan.overlap_secs <= PRO_MAX_OVERLAP_SECS);

        // Slow A (60 bpm, 4 s bars) vs 63 bpm: 12 bars = 48 s → 8 → 4 bars (16 s / 1.05).
        let slow_a = analysis(240.0, 60.0, 0.0, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::AutomixPro, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &slow_a,
            b: &b,
            a_position_secs: 0.0,
        })
        .unwrap();
        assert_eq!(plan.bars, Some(4));
        assert!(plan.overlap_secs <= PRO_MAX_OVERLAP_SECS);

        // 120 vs 150 bpm: raw 1.25 → 1/ratio = 0.8 ∈ (0.64, 0.85): special 4-beat blend,
        // but the residual (mode 2, 1.25) is not stretchable → AM plan.
        let b150 = analysis(200.0, 150.0, 0.0, vec![]);
        let plan = decide_transition(&TransitionRequest {
            settings: settings(TransitionMode::AutomixPro, 5.0),
            trigger: TransitionTrigger::EndOfTrack,
            a: &a,
            b: &b150,
            a_position_secs: 0.0,
        })
        .unwrap();
        assert_eq!(plan.template, Some(PlanTemplate::AmFilter2));

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
        // Residual after ×0.5 folding: 78/60 = 1.3 → not stretchable → AM plan instead.
        assert_eq!(plan.template, Some(PlanTemplate::AmFilter2));

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
        assert_eq!(plan.template, Some(PlanTemplate::AmFilter2));
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
        assert_eq!(plan.version, DecisionVersion::Fade);
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
