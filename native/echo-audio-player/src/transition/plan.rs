//! DJ plan templates and automation curves.
//!
//! The eight plan templates embedded here were extracted verbatim from the
//! `__TEXT,__cstring` section of the QQ Music 11.9.1 macOS binary (see
//! `.planning/crossfade-transitions/re/findings/`). The JSON schema is:
//!
//! ```text
//! { name, description,
//!   Achain: { description, list: [ { effect: {type, ...params}, automation: {...} } ] },
//!   Bchain: { ... } }
//! ```
//!
//! * effect `type`: 0 = 3-band EQ (`target_param` low/mid/high, dB), 1 = gain (dB),
//!   2 = low-pass (`freq` Hz), 3 = high-pass (`freq` Hz), 4 = reverb (`mix` 0..1),
//!   5 = echo (`value` 0..1).
//! * automation `type`: `piecewise` (m→n over start_pos..end_pos with `curve_type`),
//!   `step` (m until `step_pos`, then n), `custom` (`control_points` [[pos, value], …]).
//!
//! Positions are normalised over the overlap window (0 = mix start, 1 = mix end).
//! The binary's `SetPos` comment states that positions past the end simply hold the
//! final value, which `evaluate` mirrors by clamping.
//!
//! The exact `curve_type` maths is not recoverable from strings alone; the binary only
//! shows that curve 1 is used for every gain fade-in and curve 2 for every gain
//! fade-out. We reconstruct them as the equal-power pair `sin(u·π/2)` / `1-cos(u·π/2)`.
//! For gain targets the pair is applied to **linear amplitude** (that is the only domain
//! in which `gA² + gB² = 1` holds, i.e. the only reason the two curve types exist);
//! curve 0 and all non-gain parameters interpolate in the parameter's own unit.

use serde::{Deserialize, Serialize};
use std::f32::consts::FRAC_PI_2;

pub const SIMPLE_FILTER_JSON: &str = include_str!("plans/simple_filter.json");
pub const THREE_BAND_JSON: &str = include_str!("plans/three_band.json");
pub const SIMPLE_EXCHANGE_JSON: &str = include_str!("plans/simple_exchange.json");
pub const FILTER_EQ_JSON: &str = include_str!("plans/filter_eq.json");
pub const NO_PLAN_JSON: &str = include_str!("plans/no_plan.json");
pub const ECHO_DECLINE_JSON: &str = include_str!("plans/echo_decline.json");
pub const AM_FILTER_JSON: &str = include_str!("plans/am_filter.json");
pub const AM_FILTER_2_JSON: &str = include_str!("plans/am_filter_2.json");

/// Identifies one of the embedded plan templates. The names follow the symbol names in
/// the QQ Music binary (`kFilterPresetJson`, `k3bandPresetJson`, …).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlanTemplate {
    /// `kFilterPresetJson` – "SimpleFilterPreset": gain crossfade + HPF sweep on A, LPF
    /// sweep on B. Short, filter-driven DJ blend.
    SimpleFilter,
    /// `k3bandPresetJson` – "3bandEQPreset": gain + full 3-band swap + reverb tail. The
    /// richest template; used for long, beat-matched blends.
    ThreeBand,
    /// `simpleexchange` – "3bandEQPreset" (simple gain exchange): gain crossfade + bass
    /// swap at the midpoint.
    SimpleExchange,
    /// `filterEQPresetJson` – gain exchange + bass swap + HPF/LPF sweeps.
    FilterEq,
    /// `NoPlanJson` – "NoPlan": plain gain exchange + bass swap. The engine falls back to
    /// this when the BPM relationship is unusable.
    NoPlan,
    /// `EchoDeclineJson` – A ends in an echo tail while B fades in linearly.
    EchoDecline,
    /// `AMfilterPlanJson` – "AM": Apple-Music style, A ducks late and low-passes, B enters
    /// through an opening high-pass.
    AmFilter,
    /// `AMfilterPlanJson2` – denser control-point variant of [`PlanTemplate::AmFilter`].
    AmFilter2,
}

impl PlanTemplate {
    pub fn json(self) -> &'static str {
        match self {
            Self::SimpleFilter => SIMPLE_FILTER_JSON,
            Self::ThreeBand => THREE_BAND_JSON,
            Self::SimpleExchange => SIMPLE_EXCHANGE_JSON,
            Self::FilterEq => FILTER_EQ_JSON,
            Self::NoPlan => NO_PLAN_JSON,
            Self::EchoDecline => ECHO_DECLINE_JSON,
            Self::AmFilter => AM_FILTER_JSON,
            Self::AmFilter2 => AM_FILTER_2_JSON,
        }
    }

    pub fn symbol_name(self) -> &'static str {
        match self {
            Self::SimpleFilter => "kFilterPresetJson",
            Self::ThreeBand => "k3bandPresetJson",
            Self::SimpleExchange => "simpleexchange",
            Self::FilterEq => "filterEQPresetJson",
            Self::NoPlan => "NoPlanJson",
            Self::EchoDecline => "EchoDeclineJson",
            Self::AmFilter => "AMfilterPlanJson",
            Self::AmFilter2 => "AMfilterPlanJson2",
        }
    }

    pub fn load(self) -> DjPlan {
        DjPlan::parse(self.json()).unwrap_or_else(|err| {
            // The templates are compile-time constants validated by unit tests, so this
            // cannot fail at runtime; keep the panic message informative regardless.
            panic!("embedded DJ plan {} is invalid: {err}", self.symbol_name())
        })
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct DjPlan {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "Achain")]
    pub a_chain: EffectChainSpec,
    #[serde(rename = "Bchain")]
    pub b_chain: EffectChainSpec,
}

impl DjPlan {
    pub fn parse(json: &str) -> Result<Self, String> {
        serde_json::from_str::<Self>(json).map_err(|err| format!("invalid DJ plan JSON: {err}"))
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct EffectChainSpec {
    #[serde(default)]
    pub description: String,
    pub list: Vec<EffectSlot>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct EffectSlot {
    pub effect: EffectSpec,
    pub automation: Automation,
}

impl EffectSlot {
    /// The parameter targeted by this slot's automation.
    pub fn target(&self) -> EffectTarget {
        match self.effect.kind {
            0 => match self.effect.target_param.as_deref() {
                Some("mid") => EffectTarget::EqMidDb,
                Some("high") => EffectTarget::EqHighDb,
                _ => EffectTarget::EqLowDb,
            },
            1 => EffectTarget::GainDb,
            2 => EffectTarget::LowPassHz,
            3 => EffectTarget::HighPassHz,
            4 => EffectTarget::ReverbMix,
            5 => EffectTarget::EchoMix,
            other => EffectTarget::Unknown(other),
        }
    }

    /// Value the effect starts with before automation kicks in. Falls back to the static
    /// effect parameter when the automation has no explicit start.
    pub fn initial_value(&self) -> f32 {
        let target = self.target();
        let from_effect = match target {
            EffectTarget::GainDb | EffectTarget::EchoMix => self.effect.value,
            EffectTarget::EqLowDb => self.effect.low,
            EffectTarget::EqMidDb => self.effect.mid,
            EffectTarget::EqHighDb => self.effect.high,
            EffectTarget::LowPassHz | EffectTarget::HighPassHz => self.effect.freq,
            EffectTarget::ReverbMix => self.effect.mix,
            EffectTarget::Unknown(_) => None,
        };
        from_effect.unwrap_or_else(|| self.automation.evaluate(0.0))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectTarget {
    GainDb,
    EqLowDb,
    EqMidDb,
    EqHighDb,
    LowPassHz,
    HighPassHz,
    ReverbMix,
    EchoMix,
    Unknown(u32),
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct EffectSpec {
    #[serde(rename = "type")]
    pub kind: u32,
    #[serde(default)]
    pub target_param: Option<String>,
    #[serde(default)]
    pub value: Option<f32>,
    #[serde(default)]
    pub low: Option<f32>,
    #[serde(default)]
    pub mid: Option<f32>,
    #[serde(default)]
    pub high: Option<f32>,
    #[serde(default)]
    pub freq: Option<f32>,
    #[serde(default)]
    pub mix: Option<f32>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum Automation {
    #[serde(rename = "piecewise")]
    Piecewise {
        m: f32,
        n: f32,
        #[serde(default)]
        start_pos: f32,
        #[serde(default = "one")]
        end_pos: f32,
        #[serde(default)]
        curve_type: u32,
    },
    #[serde(rename = "step")]
    Step { m: f32, n: f32, step_pos: f32 },
    #[serde(rename = "custom")]
    Custom { control_points: Vec<[f32; 2]> },
}

fn one() -> f32 {
    1.0
}

/// Shape of a piecewise ramp. `curve_type` 0 is linear; 1 and 2 are the fade-in and
/// fade-out halves of an equal-power crossfade (see module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CurveShape {
    Linear,
    EqualPowerIn,
    EqualPowerOut,
}

impl CurveShape {
    pub fn from_type(curve_type: u32) -> Self {
        match curve_type {
            1 => Self::EqualPowerIn,
            2 => Self::EqualPowerOut,
            _ => Self::Linear,
        }
    }

    /// Maps normalised progress `u ∈ [0, 1]` to the interpolation weight.
    pub fn weight(self, u: f32) -> f32 {
        let u = u.clamp(0.0, 1.0);
        match self {
            Self::Linear => u,
            Self::EqualPowerIn => (u * FRAC_PI_2).sin(),
            Self::EqualPowerOut => 1.0 - (u * FRAC_PI_2).cos(),
        }
    }
}

impl Automation {
    /// Evaluate the automated value at normalised overlap position `pos`. Positions
    /// outside `0..=1` hold the boundary values (QQ: "always in the last time").
    pub fn evaluate(&self, pos: f32) -> f32 {
        let pos = if pos.is_finite() { pos } else { 0.0 };
        match self {
            Self::Piecewise {
                m,
                n,
                start_pos,
                end_pos,
                curve_type,
            } => {
                let (start, end) = if end_pos > start_pos {
                    (*start_pos, *end_pos)
                } else {
                    (*start_pos, *start_pos)
                };
                if pos <= start {
                    return *m;
                }
                if pos >= end || end <= start {
                    return *n;
                }
                let u = (pos - start) / (end - start);
                let w = CurveShape::from_type(*curve_type).weight(u);
                m + (n - m) * w
            }
            Self::Step { m, n, step_pos } => {
                if pos < *step_pos {
                    *m
                } else {
                    *n
                }
            }
            Self::Custom { control_points } => evaluate_control_points(control_points, pos),
        }
    }

    /// Final value once the overlap has completed.
    pub fn end_value(&self) -> f32 {
        self.evaluate(f32::INFINITY.min(1.0e9))
    }

    /// Evaluate a gain automation (values in dB) as a linear amplitude. Piecewise ramps
    /// with the equal-power curve types interpolate between the linear end-points so the
    /// mirrored A/B pair conserves power; everything else converts the dB value.
    pub fn evaluate_gain_linear(&self, pos: f32) -> f32 {
        if let Self::Piecewise {
            m,
            n,
            start_pos,
            end_pos,
            curve_type,
        } = self
        {
            let shape = CurveShape::from_type(*curve_type);
            if shape != CurveShape::Linear && end_pos > start_pos {
                let pos = if pos.is_finite() { pos } else { 0.0 };
                let from = db_to_linear(*m);
                let to = db_to_linear(*n);
                if pos <= *start_pos {
                    return from;
                }
                if pos >= *end_pos {
                    return to;
                }
                let u = (pos - start_pos) / (end_pos - start_pos);
                return from + (to - from) * shape.weight(u);
            }
        }
        db_to_linear(self.evaluate(pos))
    }
}

pub(crate) fn db_to_linear(db: f32) -> f32 {
    if !db.is_finite() {
        return 1.0;
    }
    10.0f32.powf(db.clamp(-120.0, 24.0) / 20.0)
}

fn evaluate_control_points(points: &[[f32; 2]], pos: f32) -> f32 {
    let Some(first) = points.first() else {
        return 0.0;
    };
    if pos <= first[0] {
        return first[1];
    }
    for pair in points.windows(2) {
        let [x0, y0] = pair[0];
        let [x1, y1] = pair[1];
        if pos >= x0 && pos <= x1 {
            if x1 <= x0 {
                return y1;
            }
            let u = (pos - x0) / (x1 - x0);
            return y0 + (y1 - y0) * u;
        }
    }
    points.last().map(|point| point[1]).unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_embedded_templates_parse_and_match_binary_structure() {
        let expected = [
            (PlanTemplate::SimpleFilter, "SimpleFilterPreset", 2, 2),
            (PlanTemplate::ThreeBand, "3bandEQPreset", 5, 5),
            (PlanTemplate::SimpleExchange, "3bandEQPreset", 2, 2),
            (PlanTemplate::FilterEq, "3bandEQPreset", 3, 3),
            (PlanTemplate::NoPlan, "NoPlan", 2, 2),
            (PlanTemplate::EchoDecline, "NoPlan", 1, 1),
            (PlanTemplate::AmFilter, "AM", 3, 3),
            (PlanTemplate::AmFilter2, "AM", 3, 3),
        ];
        for (template, name, a_len, b_len) in expected {
            let plan = template.load();
            assert_eq!(plan.name, name, "{}", template.symbol_name());
            assert_eq!(plan.a_chain.list.len(), a_len, "{}", template.symbol_name());
            assert_eq!(plan.b_chain.list.len(), b_len, "{}", template.symbol_name());
            for slot in plan.a_chain.list.iter().chain(plan.b_chain.list.iter()) {
                assert!(
                    !matches!(slot.target(), EffectTarget::Unknown(_)),
                    "{} has an unknown effect type",
                    template.symbol_name()
                );
            }
        }
    }

    #[test]
    fn three_band_plan_gain_curves_are_mirrored_equal_power_pair() {
        let plan = PlanTemplate::ThreeBand.load();
        let a_gain = &plan.a_chain.list[0];
        let b_gain = &plan.b_chain.list[0];
        assert_eq!(a_gain.target(), EffectTarget::GainDb);
        assert_eq!(b_gain.target(), EffectTarget::GainDb);
        assert_eq!(a_gain.automation.evaluate(0.0), 0.0);
        assert_eq!(a_gain.automation.evaluate(1.0), -20.0);
        assert_eq!(b_gain.automation.evaluate(0.0), -20.0);
        assert_eq!(b_gain.automation.evaluate(1.0), 0.0);
        // As linear amplitudes the mirrored pair conserves power across the window
        // (within the 0.1 floor the templates keep for the outgoing deck).
        for step in 0..=10 {
            let pos = step as f32 / 10.0;
            let a = a_gain.automation.evaluate_gain_linear(pos);
            let b = b_gain.automation.evaluate_gain_linear(pos);
            let power = a * a + b * b;
            assert!(
                power > 0.95 && power < 1.25,
                "pos {pos}: a {a} b {b} power {power}"
            );
        }
        assert!((a_gain.automation.evaluate_gain_linear(0.0) - 1.0).abs() < 1e-6);
        assert!((b_gain.automation.evaluate_gain_linear(1.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn piecewise_holds_boundary_values_outside_window() {
        let automation = Automation::Piecewise {
            m: 10.0,
            n: 4000.0,
            start_pos: 0.0,
            end_pos: 0.6,
            curve_type: 0,
        };
        assert_eq!(automation.evaluate(-1.0), 10.0);
        assert_eq!(automation.evaluate(0.0), 10.0);
        assert!((automation.evaluate(0.3) - 2005.0).abs() < 1e-3);
        assert_eq!(automation.evaluate(0.6), 4000.0);
        assert_eq!(automation.evaluate(0.9), 4000.0);
        assert_eq!(automation.evaluate(2.5), 4000.0);
        assert_eq!(automation.end_value(), 4000.0);
    }

    #[test]
    fn step_switches_exactly_at_step_pos() {
        let automation = Automation::Step {
            m: 0.0,
            n: -28.0,
            step_pos: 0.5,
        };
        assert_eq!(automation.evaluate(0.499), 0.0);
        assert_eq!(automation.evaluate(0.5), -28.0);
        assert_eq!(automation.evaluate(1.2), -28.0);
    }

    #[test]
    fn custom_control_points_interpolate_and_hold_ends() {
        let plan = PlanTemplate::AmFilter.load();
        let b_gain = &plan.b_chain.list[0];
        // control points: [0.25,-30],[0.45,-10],[0.55,-5],[0.9,0]
        assert_eq!(b_gain.automation.evaluate(0.0), -30.0);
        assert_eq!(b_gain.automation.evaluate(0.25), -30.0);
        assert!((b_gain.automation.evaluate(0.35) - (-20.0)).abs() < 1e-4);
        assert!((b_gain.automation.evaluate(0.5) - (-7.5)).abs() < 1e-4);
        assert_eq!(b_gain.automation.evaluate(0.95), 0.0);
        assert_eq!(b_gain.initial_value(), -30.0);
    }

    #[test]
    fn effect_initial_values_come_from_the_effect_block() {
        let plan = PlanTemplate::SimpleFilter.load();
        let a_hpf = &plan.a_chain.list[1];
        assert_eq!(a_hpf.target(), EffectTarget::HighPassHz);
        assert_eq!(a_hpf.initial_value(), 10.0);
        let b_lpf = &plan.b_chain.list[1];
        assert_eq!(b_lpf.target(), EffectTarget::LowPassHz);
        assert_eq!(b_lpf.initial_value(), 20.0);
        let plan = PlanTemplate::EchoDecline.load();
        assert_eq!(plan.a_chain.list[0].target(), EffectTarget::EchoMix);
        assert_eq!(plan.a_chain.list[0].automation.evaluate(0.6), 1.0);
    }

    #[test]
    fn curve_shapes_form_an_equal_power_pair() {
        for step in 0..=20 {
            let u = step as f32 / 20.0;
            let a = 1.0 - CurveShape::EqualPowerOut.weight(u); // cos(uπ/2)
            let b = CurveShape::EqualPowerIn.weight(u); // sin(uπ/2)
            assert!((a * a + b * b - 1.0).abs() < 1e-5, "u={u}");
        }
        assert_eq!(CurveShape::Linear.weight(0.25), 0.25);
        assert_eq!(CurveShape::Linear.weight(3.0), 1.0);
    }
}
