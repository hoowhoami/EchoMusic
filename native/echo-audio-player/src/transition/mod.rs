//! Song transitions: silence-trimmed handoffs, timed fades and content-aware mixing.
//!
//! * [`plan`] – effect templates and automation curves.
//! * [`effects`] – per-deck effect chains executing a plan.
//! * [`analysis`] – local tempo, beat-grid, silence and section analysis.
//! * [`decide`] – cue selection producing a [`TransitionPlan`].
//! * [`mixer`] – the dual-deck overlap mixer that renders a plan sample-accurately.

pub mod analysis;
pub mod decide;
pub mod effects;
pub mod mixer;
pub mod plan;

#[allow(unused_imports)]
pub use analysis::{TrackAnalysis, TrackAnalyzer};
#[allow(unused_imports)]
pub use decide::{decide_transition, TransitionPlan, TransitionRequest, TransitionTrigger};
#[allow(unused_imports)]
pub use mixer::{DeckInput, MixerOutput, TransitionMixer};
#[allow(unused_imports)]
pub use plan::{DjPlan, PlanTemplate};

use serde::{Deserialize, Serialize};

/// The four user-facing transition modes (`歌曲过渡设置`) plus "off".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransitionMode {
    /// Hard cut at end of track (legacy behaviour when gapless is disabled).
    #[default]
    None,
    /// 无缝播放: skip leading/trailing silence, butt-splice sample-continuously.
    Gapless,
    /// 淡入淡出播放 0–15 s: linear-amplitude overlap without silence trimming.
    Fade,
    /// Content-aware cue points with unchanged tempo and gain/bass exchange.
    AutomixBasic,
    /// Beat-matched cue points with multi-band filtering and optional tempo adjustment.
    AutomixPro,
}

impl TransitionMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "none" | "off" => Some(Self::None),
            "gapless" => Some(Self::Gapless),
            "fade" | "crossfade" => Some(Self::Fade),
            "automix-basic" | "automix_basic" | "basic" => Some(Self::AutomixBasic),
            "automix-pro" | "automix_pro" | "pro" => Some(Self::AutomixPro),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Gapless => "gapless",
            Self::Fade => "fade",
            Self::AutomixBasic => "automix-basic",
            Self::AutomixPro => "automix-pro",
        }
    }

    pub fn is_automix(self) -> bool {
        matches!(self, Self::AutomixBasic | Self::AutomixPro)
    }

    /// Whether the mode produces an overlap that needs the next track prepared well ahead
    /// of the end of the current one.
    pub fn overlaps(self) -> bool {
        matches!(self, Self::Fade | Self::AutomixBasic | Self::AutomixPro)
    }
}

/// User-selected transition mode and timed-fade duration.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct TransitionSettings {
    pub mode: TransitionMode,
    /// Crossfade length for [`TransitionMode::Fade`], from 0 to 15 seconds.
    pub fade_secs: f32,
}

pub const MAX_FADE_SECS: f32 = 15.0;
pub const DEFAULT_FADE_SECS: f32 = 15.0;
/// Songs shorter than this are never overlapped.
pub const MIN_SUPPORTED_TRACK_SECS: f64 = 30.0;

impl Default for TransitionSettings {
    fn default() -> Self {
        Self {
            mode: TransitionMode::AutomixPro,
            fade_secs: DEFAULT_FADE_SECS,
        }
    }
}

impl TransitionSettings {
    pub fn sanitized(self) -> Self {
        let fade_secs = if self.fade_secs.is_finite() {
            self.fade_secs.clamp(0.0, MAX_FADE_SECS)
        } else {
            DEFAULT_FADE_SECS
        };
        Self {
            mode: self.mode,
            fade_secs,
        }
    }

    /// How far ahead of the end of the current track the next one should be prepared so
    /// analysis and cue decisions are ready before the overlap starts.
    pub fn prefetch_lead_secs(&self) -> f64 {
        match self.mode {
            TransitionMode::None => 0.0,
            TransitionMode::Gapless => 30.0,
            TransitionMode::Fade => 30.0 + f64::from(self.fade_secs),
            TransitionMode::AutomixBasic | TransitionMode::AutomixPro => 75.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_round_trips_through_strings() {
        for mode in [
            TransitionMode::None,
            TransitionMode::Gapless,
            TransitionMode::Fade,
            TransitionMode::AutomixBasic,
            TransitionMode::AutomixPro,
        ] {
            assert_eq!(TransitionMode::parse(mode.as_str()), Some(mode));
        }
        assert_eq!(
            TransitionMode::parse("Crossfade"),
            Some(TransitionMode::Fade)
        );
        assert_eq!(TransitionMode::parse("bogus"), None);
    }

    #[test]
    fn settings_clamp_fade_to_supported_range() {
        let settings = TransitionSettings {
            mode: TransitionMode::Fade,
            fade_secs: 40.0,
        }
        .sanitized();
        assert_eq!(settings.fade_secs, MAX_FADE_SECS);
        let nan = TransitionSettings {
            mode: TransitionMode::Fade,
            fade_secs: f32::NAN,
        }
        .sanitized();
        assert_eq!(nan.fade_secs, DEFAULT_FADE_SECS);
        assert!(TransitionMode::AutomixPro.overlaps());
        assert!(!TransitionMode::Gapless.overlaps());
        assert!(settings.prefetch_lead_secs() > 30.0);
    }
}
