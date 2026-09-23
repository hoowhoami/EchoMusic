//! Spatial audio mixer for AirPlay 2 multi-speaker groups.
//!
//! Takes stereo input and produces per-speaker mono feeds with:
//! - Angle-based stereo pan blending (StereoPan mode)
//! - STFT 5.1 frequency-domain upmix blending (Stft51 mode)
//! - Distance-based delay and gain compensation
//! - Smooth parameter interpolation for dynamic listener movement

pub mod stft_upmix;

use std::f64::consts::PI;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU8, Ordering};
use std::sync::Arc;

use self::stft_upmix::{Channels51, StftUpmixConfig, StftUpmixer};

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/// 2D position in meters.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

impl Position {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn distance_to(&self, other: &Position) -> f64 {
        ((self.x - other.x).powi(2) + (self.y - other.y).powi(2)).sqrt()
    }

    /// Angle in radians from self to other, measured clockwise from +Y (forward).
    pub fn angle_to(&self, other: &Position) -> f64 {
        (other.x - self.x).atan2(other.y - self.y)
    }
}

/// Spatial processing mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpatialMode {
    /// Simple angle-based stereo pan: each speaker gets a blend of L/R
    /// based on its angle from the listener.
    StereoPan,
    /// STFT 5.1 frequency-domain upmix: stereo is upmixed to 6 channels,
    /// then each speaker blends the 6 channels based on angular proximity
    /// to standard 5.1 positions.
    Stft51,
}

impl From<u8> for SpatialMode {
    fn from(v: u8) -> Self {
        match v {
            1 => SpatialMode::Stft51,
            _ => SpatialMode::StereoPan,
        }
    }
}

/// Static configuration for one speaker.
#[derive(Debug, Clone)]
pub struct SpeakerConfig {
    pub device_id: String,
    pub position: Position,
}

/// Runtime parameters derived for one speaker.
#[derive(Debug, Clone, Copy)]
pub struct SpeakerParams {
    /// Gain multiplier (inverse-distance).
    pub gain: f64,
    /// Delay in fractional samples to align wavefronts.
    pub delay_samples: f64,
    /// Left channel blend weight (constant-power).
    pub l_weight: f64,
    /// Right channel blend weight (constant-power).
    pub r_weight: f64,
    /// Relative angle from listener to speaker (radians, -PI..PI).
    pub angle: f64,
}

impl Default for SpeakerParams {
    fn default() -> Self {
        Self {
            gain: 1.0,
            delay_samples: 0.0,
            l_weight: 0.707,
            r_weight: 0.707,
            angle: 0.0,
        }
    }
}

// ---------------------------------------------------------------------------
// Core DSP helpers
// ---------------------------------------------------------------------------

const SPEED_OF_SOUND: f64 = 343.0; // m/s at ~20C

/// Constant-power panning: for a ratio 0..1, returns (left_gain, right_gain).
/// ratio=0 → full left, ratio=0.5 → equal, ratio=1 → full right.
pub fn constant_power_pan(angle_ratio: f64) -> (f64, f64) {
    let clamped = angle_ratio.clamp(0.0, 1.0);
    let theta = clamped * PI / 2.0;
    (theta.cos(), theta.sin())
}

/// Simple exponential smoothing.
pub fn smooth(current: f64, target: f64, alpha: f64) -> f64 {
    current + alpha * (target - current)
}

/// Wrap angle to [-PI, PI].
fn wrap_angle(mut a: f64) -> f64 {
    while a > PI {
        a -= 2.0 * PI;
    }
    while a < -PI {
        a += 2.0 * PI;
    }
    a
}

/// Standard 5.1 channel angles (radians from front center, clockwise positive).
const CHANNEL_ANGLES_51: [f64; 5] = [
    -PI / 6.0,      // Front Left (-30°)
    0.0,             // Front Center (0°)
    PI / 6.0,        // Front Right (+30°)
    -110.0 * PI / 180.0, // Rear Left (-110°)
    110.0 * PI / 180.0,  // Rear Right (+110°)
];

/// Compute 5.1 channel weights for a speaker at the given angle.
/// Uses cosine falloff from each channel's standard position.
fn channel_weights_for_angle(speaker_angle: f64) -> [f64; 6] {
    let mut weights = [0.0f64; 6]; // FL, FC, FR, RL, RR, LFE

    for (i, &ch_angle) in CHANNEL_ANGLES_51.iter().enumerate() {
        let diff = wrap_angle(speaker_angle - ch_angle).abs();
        // Cosine falloff: full weight at 0° diff, zero at 90°+
        let w = if diff < PI / 2.0 {
            // cos(diff) is 1.0 at diff=0, 0.0 at diff=PI/2
            diff.cos().powi(2)
        } else {
            0.0
        };
        weights[i] = w;
    }

    // LFE is omnidirectional (small contribution everywhere)
    weights[5] = 0.3;

    // Normalize so weights sum to ~1.0 (excluding LFE)
    let sum: f64 = weights[..5].iter().sum();
    if sum > 1e-10 {
        for w in &mut weights[..5] {
            *w /= sum;
        }
    }

    weights
}

// ---------------------------------------------------------------------------
// Atomic shared state for UI ↔ audio thread
// ---------------------------------------------------------------------------

/// Snapshot of spatial parameters (plain struct, no atomics).
#[derive(Debug, Clone)]
pub struct SpatialSnapshot {
    pub enabled: bool,
    pub mode: SpatialMode,
    pub listener_x: f64,
    pub listener_y: f64,
    pub listener_facing: f64,
    pub speaker_positions: Vec<(f64, f64)>,
}

/// Shared spatial parameters updated atomically from the UI thread.
///
/// Positions are stored as millimeters (i32) for atomic access.
pub struct SpatialParams {
    enabled: AtomicBool,
    mode: AtomicU8, // 0=StereoPan, 1=Stft51
    listener_x_mm: AtomicI32,
    listener_y_mm: AtomicI32,
    listener_facing_mrad: AtomicI32,
    speaker_positions: Vec<(AtomicI32, AtomicI32)>,
    num_speakers: usize,
}

impl std::fmt::Debug for SpatialParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpatialParams")
            .field("enabled", &self.is_enabled())
            .field("mode", &self.mode())
            .field("num_speakers", &self.num_speakers)
            .finish()
    }
}

impl SpatialParams {
    /// Create new spatial params for the given number of speakers.
    pub fn new(num_speakers: usize) -> Self {
        let speaker_positions = (0..num_speakers)
            .map(|_| (AtomicI32::new(0), AtomicI32::new(0)))
            .collect();
        Self {
            enabled: AtomicBool::new(false),
            mode: AtomicU8::new(0),
            listener_x_mm: AtomicI32::new(0),
            listener_y_mm: AtomicI32::new(0),
            listener_facing_mrad: AtomicI32::new(0),
            speaker_positions,
            num_speakers,
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn toggle_enabled(&self) {
        let current = self.enabled.load(Ordering::Relaxed);
        self.enabled.store(!current, Ordering::Relaxed);
    }

    pub fn mode(&self) -> SpatialMode {
        SpatialMode::from(self.mode.load(Ordering::Relaxed))
    }

    pub fn set_mode(&self, mode: SpatialMode) {
        self.mode.store(mode as u8, Ordering::Relaxed);
    }

    pub fn cycle_mode(&self) {
        let current = self.mode.load(Ordering::Relaxed);
        self.mode.store(if current == 0 { 1 } else { 0 }, Ordering::Relaxed);
    }

    /// Set listener position in meters.
    pub fn set_listener(&self, x: f64, y: f64, facing: f64) {
        self.listener_x_mm.store((x * 1000.0) as i32, Ordering::Relaxed);
        self.listener_y_mm.store((y * 1000.0) as i32, Ordering::Relaxed);
        self.listener_facing_mrad.store((facing * 1000.0) as i32, Ordering::Relaxed);
    }

    /// Set speaker position in meters.
    pub fn set_speaker_position(&self, index: usize, x: f64, y: f64) {
        if index < self.num_speakers {
            self.speaker_positions[index].0.store((x * 1000.0) as i32, Ordering::Relaxed);
            self.speaker_positions[index].1.store((y * 1000.0) as i32, Ordering::Relaxed);
        }
    }

    /// Get listener position in meters.
    pub fn listener_pos(&self) -> (f64, f64) {
        let x = self.listener_x_mm.load(Ordering::Relaxed) as f64 / 1000.0;
        let y = self.listener_y_mm.load(Ordering::Relaxed) as f64 / 1000.0;
        (x, y)
    }

    /// Get listener facing in radians.
    pub fn listener_facing(&self) -> f64 {
        self.listener_facing_mrad.load(Ordering::Relaxed) as f64 / 1000.0
    }

    /// Get speaker position in meters.
    pub fn speaker_position(&self, index: usize) -> Option<(f64, f64)> {
        if index < self.num_speakers {
            let x = self.speaker_positions[index].0.load(Ordering::Relaxed) as f64 / 1000.0;
            let y = self.speaker_positions[index].1.load(Ordering::Relaxed) as f64 / 1000.0;
            Some((x, y))
        } else {
            None
        }
    }

    pub fn num_speakers(&self) -> usize {
        self.num_speakers
    }

    /// Take a snapshot of all current values for the audio thread.
    pub fn snapshot(&self) -> SpatialSnapshot {
        let speaker_positions = (0..self.num_speakers)
            .map(|i| {
                let x = self.speaker_positions[i].0.load(Ordering::Relaxed) as f64 / 1000.0;
                let y = self.speaker_positions[i].1.load(Ordering::Relaxed) as f64 / 1000.0;
                (x, y)
            })
            .collect();

        SpatialSnapshot {
            enabled: self.enabled.load(Ordering::Relaxed),
            mode: SpatialMode::from(self.mode.load(Ordering::Relaxed)),
            listener_x: self.listener_x_mm.load(Ordering::Relaxed) as f64 / 1000.0,
            listener_y: self.listener_y_mm.load(Ordering::Relaxed) as f64 / 1000.0,
            listener_facing: self.listener_facing_mrad.load(Ordering::Relaxed) as f64 / 1000.0,
            speaker_positions,
        }
    }
}

// ---------------------------------------------------------------------------
// SpatialMixer
// ---------------------------------------------------------------------------

/// The main spatial mixer. Holds speaker configuration, listener state,
/// and smoothed runtime parameters.
pub struct SpatialMixer {
    pub speakers: Vec<SpeakerConfig>,
    pub sample_rate: f64,
    /// Smoothing factor for parameter interpolation.
    pub smoothing_alpha: f64,

    // Runtime state
    listener_pos: Position,
    listener_facing: f64,
    current_params: Vec<SpeakerParams>,
    target_params: Vec<SpeakerParams>,

    // Per-speaker delay lines (ring buffers)
    delay_lines: Vec<Vec<f64>>,
    delay_write_pos: Vec<usize>,

    // STFT upmixer (lazy-initialized when Stft51 mode is used)
    stft_upmixer: Option<StftUpmixer>,
}

impl SpatialMixer {
    /// Maximum delay line length in samples.
    const MAX_DELAY_SAMPLES: usize = 2048;

    pub fn new(speakers: Vec<SpeakerConfig>, sample_rate: f64) -> Self {
        let n = speakers.len();
        let default_params: Vec<SpeakerParams> = vec![SpeakerParams::default(); n];
        let delay_lines = vec![vec![0.0; Self::MAX_DELAY_SAMPLES]; n];
        let delay_write_pos = vec![0; n];

        let mut mixer = Self {
            speakers,
            sample_rate,
            smoothing_alpha: 0.05,
            listener_pos: Position::new(0.0, 0.0),
            listener_facing: 0.0,
            current_params: default_params.clone(),
            target_params: default_params,
            delay_lines,
            delay_write_pos,
            stft_upmixer: None,
        };
        mixer.recompute_targets();
        mixer.snap_to_targets();
        mixer
    }

    /// Update listener position and facing direction.
    pub fn set_listener(&mut self, pos: Position, facing: f64) {
        self.listener_pos = pos;
        self.listener_facing = facing;
        self.recompute_targets();
    }

    /// Update a speaker position.
    pub fn set_speaker_position(&mut self, index: usize, pos: Position) {
        if index < self.speakers.len() {
            self.speakers[index].position = pos;
            self.recompute_targets();
        }
    }

    pub fn listener_pos(&self) -> Position {
        self.listener_pos
    }

    /// Recompute target parameters from current geometry.
    fn recompute_targets(&mut self) {
        let distances: Vec<f64> = self
            .speakers
            .iter()
            .map(|s| self.listener_pos.distance_to(&s.position).max(0.1))
            .collect();

        let min_dist = distances.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_dist = distances.iter().cloned().fold(0.0_f64, f64::max);

        for (i, _speaker) in self.speakers.iter().enumerate() {
            let dist = distances[i];

            // Inverse-distance gain (referenced to closest speaker)
            let gain = min_dist / dist;

            // Delay: closer speakers need more delay so all arrive simultaneously
            let delay_seconds = (max_dist - dist) / SPEED_OF_SOUND;
            let delay_samples = delay_seconds * self.sample_rate;

            // Compute relative angle from listener perspective
            let raw_angle = self.listener_pos.angle_to(&self.speakers[i].position);
            let angle = wrap_angle(raw_angle - self.listener_facing);

            // Angle-based stereo blend:
            // angle=-PI/2 (full left) → ratio=0 → l_weight=1, r_weight=0
            // angle=0 (center) → ratio=0.5 → equal
            // angle=+PI/2 (full right) → ratio=1 → l_weight=0, r_weight=1
            let ratio = (angle / PI + 1.0) / 2.0;
            let (l_weight, r_weight) = constant_power_pan(ratio);

            self.target_params[i] = SpeakerParams {
                gain,
                delay_samples,
                l_weight,
                r_weight,
                angle,
            };
        }
    }

    /// Instantly set current params to targets (no smoothing).
    fn snap_to_targets(&mut self) {
        self.current_params = self.target_params.clone();
    }

    /// Advance smoothing one step.
    pub fn update_smoothing(&mut self) {
        let alpha = self.smoothing_alpha;
        for i in 0..self.current_params.len() {
            self.current_params[i].gain =
                smooth(self.current_params[i].gain, self.target_params[i].gain, alpha);
            self.current_params[i].delay_samples = smooth(
                self.current_params[i].delay_samples,
                self.target_params[i].delay_samples,
                alpha,
            );
            self.current_params[i].l_weight = smooth(
                self.current_params[i].l_weight,
                self.target_params[i].l_weight,
                alpha,
            );
            self.current_params[i].r_weight = smooth(
                self.current_params[i].r_weight,
                self.target_params[i].r_weight,
                alpha,
            );
            self.current_params[i].angle = smooth(
                self.current_params[i].angle,
                self.target_params[i].angle,
                alpha,
            );
        }
    }

    /// Get current (smoothed) parameters for inspection/testing.
    pub fn current_params(&self) -> &[SpeakerParams] {
        &self.current_params
    }

    /// Get target parameters for inspection/testing.
    pub fn target_params(&self) -> &[SpeakerParams] {
        &self.target_params
    }

    /// Apply delay line and gain to a mono sample for one speaker.
    fn apply_delay_and_gain(&mut self, speaker_idx: usize, sample: f64) -> f64 {
        let wp = self.delay_write_pos[speaker_idx];
        self.delay_lines[speaker_idx][wp] = sample;
        self.delay_write_pos[speaker_idx] = (wp + 1) % Self::MAX_DELAY_SAMPLES;

        let delay = self.current_params[speaker_idx].delay_samples;
        let read_pos = (wp as f64) - delay;
        let read_pos_wrapped = if read_pos < 0.0 {
            read_pos + Self::MAX_DELAY_SAMPLES as f64
        } else {
            read_pos
        };

        let idx0 = read_pos_wrapped.floor() as usize % Self::MAX_DELAY_SAMPLES;
        let idx1 = (idx0 + 1) % Self::MAX_DELAY_SAMPLES;
        let frac = read_pos_wrapped.fract();
        let delayed = self.delay_lines[speaker_idx][idx0] * (1.0 - frac)
            + self.delay_lines[speaker_idx][idx1] * frac;

        delayed * self.current_params[speaker_idx].gain
    }

    /// Process one stereo sample in StereoPan mode.
    fn process_sample_stereo_pan(&mut self, left_in: f64, right_in: f64) -> Vec<f64> {
        let mut outputs = Vec::with_capacity(self.speakers.len());

        for i in 0..self.speakers.len() {
            let blended = left_in * self.current_params[i].l_weight
                + right_in * self.current_params[i].r_weight;
            let out = self.apply_delay_and_gain(i, blended);
            outputs.push(out);
        }

        outputs
    }

    /// Process a buffer in StereoPan mode.
    pub fn process_buffer_stereo_pan(&mut self, stereo_interleaved: &[f64]) -> Vec<Vec<f64>> {
        let num_frames = stereo_interleaved.len() / 2;
        let mut speaker_buffers: Vec<Vec<f64>> = (0..self.speakers.len())
            .map(|_| Vec::with_capacity(num_frames))
            .collect();

        for frame in 0..num_frames {
            let l = stereo_interleaved[frame * 2];
            let r = stereo_interleaved[frame * 2 + 1];

            let outputs = self.process_sample_stereo_pan(l, r);

            for (spk, sample) in outputs.into_iter().enumerate() {
                speaker_buffers[spk].push(sample);
            }

            self.update_smoothing();
        }

        speaker_buffers
    }

    /// Process a buffer in Stft51 mode.
    ///
    /// Runs STFT upmixer to get 6 channels, then for each speaker, blends the
    /// 6 channels based on angular proximity to standard 5.1 positions.
    pub fn process_buffer_stft51(&mut self, stereo_interleaved: &[f64]) -> Vec<Vec<f64>> {
        let num_frames = stereo_interleaved.len() / 2;

        // Deinterleave to separate L/R buffers
        let mut left = Vec::with_capacity(num_frames);
        let mut right = Vec::with_capacity(num_frames);
        for frame in 0..num_frames {
            left.push(stereo_interleaved[frame * 2]);
            right.push(stereo_interleaved[frame * 2 + 1]);
        }

        // Lazy-init STFT upmixer
        if self.stft_upmixer.is_none() {
            let config = StftUpmixConfig {
                sample_rate: self.sample_rate,
                rear_delay_samples: (self.sample_rate * 0.015) as usize,
                ..Default::default()
            };
            self.stft_upmixer = Some(StftUpmixer::new(config));
        }

        let channels = self.stft_upmixer.as_mut().unwrap().process(&left, &right);

        // For each speaker, compute 5.1 channel weights based on angle,
        // then blend all 6 channels and apply delay/gain
        let mut speaker_buffers: Vec<Vec<f64>> = (0..self.speakers.len())
            .map(|_| Vec::with_capacity(num_frames))
            .collect();

        for i in 0..self.speakers.len() {
            let weights = channel_weights_for_angle(self.current_params[i].angle);

            for frame in 0..num_frames {
                let blended = channels.front_left[frame] * weights[0]
                    + channels.front_center[frame] * weights[1]
                    + channels.front_right[frame] * weights[2]
                    + channels.rear_left[frame] * weights[3]
                    + channels.rear_right[frame] * weights[4]
                    + channels.lfe[frame] * weights[5];

                let out = self.apply_delay_and_gain(i, blended);
                speaker_buffers[i].push(out);
            }
        }

        // Update smoothing once per buffer in Stft51 mode
        self.update_smoothing();

        speaker_buffers
    }

    /// Process a buffer of interleaved stereo samples.
    /// Returns a Vec of per-speaker mono buffers.
    pub fn process_buffer(
        &mut self,
        stereo_interleaved: &[f64],
        mode: SpatialMode,
    ) -> Vec<Vec<f64>> {
        match mode {
            SpatialMode::StereoPan => self.process_buffer_stereo_pan(stereo_interleaved),
            SpatialMode::Stft51 => self.process_buffer_stft51(stereo_interleaved),
        }
    }

    /// Update mixer state from a SpatialSnapshot (called once per buffer).
    pub fn update_from_snapshot(&mut self, snap: &SpatialSnapshot) {
        let new_listener = Position::new(snap.listener_x, snap.listener_y);
        let listener_changed = new_listener != self.listener_pos
            || (snap.listener_facing - self.listener_facing).abs() > 0.001;

        let mut speakers_changed = false;
        for (i, &(x, y)) in snap.speaker_positions.iter().enumerate() {
            if i < self.speakers.len() {
                let new_pos = Position::new(x, y);
                if new_pos != self.speakers[i].position {
                    self.speakers[i].position = new_pos;
                    speakers_changed = true;
                }
            }
        }

        if listener_changed || speakers_changed {
            self.listener_pos = new_listener;
            self.listener_facing = snap.listener_facing;
            self.recompute_targets();
        }
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn default_speakers() -> Vec<SpeakerConfig> {
        vec![
            SpeakerConfig {
                device_id: "AA:BB:CC:DD:EE:01".into(),
                position: Position::new(-1.5, 2.0),
            },
            SpeakerConfig {
                device_id: "AA:BB:CC:DD:EE:02".into(),
                position: Position::new(0.0, 2.0),
            },
            SpeakerConfig {
                device_id: "AA:BB:CC:DD:EE:03".into(),
                position: Position::new(1.5, 2.0),
            },
        ]
    }

    fn approx_eq(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() < tol
    }

    // --- Position tests ---

    #[test]
    fn test_position_distance() {
        let a = Position::new(0.0, 0.0);
        let b = Position::new(3.0, 4.0);
        assert!(approx_eq(a.distance_to(&b), 5.0, 1e-10));
    }

    #[test]
    fn test_position_distance_symmetric() {
        let a = Position::new(1.0, 2.0);
        let b = Position::new(4.0, 6.0);
        assert!(approx_eq(a.distance_to(&b), b.distance_to(&a), 1e-10));
    }

    #[test]
    fn test_position_angle_straight_ahead() {
        let listener = Position::new(0.0, 0.0);
        let ahead = Position::new(0.0, 5.0);
        assert!(approx_eq(listener.angle_to(&ahead), 0.0, 1e-10));
    }

    #[test]
    fn test_position_angle_right() {
        let listener = Position::new(0.0, 0.0);
        let right = Position::new(5.0, 0.0);
        assert!(approx_eq(listener.angle_to(&right), PI / 2.0, 1e-10));
    }

    #[test]
    fn test_position_angle_left() {
        let listener = Position::new(0.0, 0.0);
        let left = Position::new(-5.0, 0.0);
        assert!(approx_eq(listener.angle_to(&left), -PI / 2.0, 1e-10));
    }

    // --- Constant power panning ---

    #[test]
    fn test_pan_center() {
        let (l, r) = constant_power_pan(0.5);
        assert!(approx_eq(l, r, 1e-10));
        assert!(approx_eq(l * l + r * r, 1.0, 1e-10));
    }

    #[test]
    fn test_pan_hard_left() {
        let (l, r) = constant_power_pan(0.0);
        assert!(approx_eq(l, 1.0, 1e-10));
        assert!(approx_eq(r, 0.0, 1e-10));
    }

    #[test]
    fn test_pan_hard_right() {
        let (l, r) = constant_power_pan(1.0);
        assert!(approx_eq(l, 0.0, 1e-10));
        assert!(approx_eq(r, 1.0, 1e-10));
    }

    #[test]
    fn test_pan_constant_power_invariant() {
        for i in 0..=100 {
            let ratio = i as f64 / 100.0;
            let (l, r) = constant_power_pan(ratio);
            let power = l * l + r * r;
            assert!(approx_eq(power, 1.0, 1e-10), "power={power} at ratio={ratio}");
        }
    }

    // --- Smoothing ---

    #[test]
    fn test_smooth_converges() {
        let mut val = 0.0;
        for _ in 0..200 {
            val = smooth(val, 1.0, 0.05);
        }
        assert!(approx_eq(val, 1.0, 1e-4));
    }

    // --- SpatialMixer: angle-based blending ---

    #[test]
    fn test_mixer_symmetric_gains() {
        let speakers = default_speakers();
        let mixer = SpatialMixer::new(speakers, 44100.0);
        let params = mixer.target_params();

        // L at x=-1.5, R at x=1.5 → same distance from origin
        assert!(approx_eq(params[0].gain, params[2].gain, 1e-10));

        // Center at x=0 is closest → gain=1.0
        assert!(approx_eq(params[1].gain, 1.0, 1e-10));
    }

    #[test]
    fn test_mixer_symmetric_delays() {
        let speakers = default_speakers();
        let mixer = SpatialMixer::new(speakers, 44100.0);
        let params = mixer.target_params();

        // Center is closest, should have MOST delay
        assert!(params[1].delay_samples > params[0].delay_samples);
        assert!(approx_eq(params[0].delay_samples, params[2].delay_samples, 1e-10));
    }

    #[test]
    fn test_mixer_angle_based_lr_weights() {
        let speakers = default_speakers();
        let mixer = SpatialMixer::new(speakers, 44100.0);
        let params = mixer.target_params();

        // Left speaker (x=-1.5) should get more left channel
        assert!(params[0].l_weight > params[0].r_weight,
            "left speaker should favor left: l={}, r={}", params[0].l_weight, params[0].r_weight);

        // Right speaker (x=1.5) should get more right channel
        assert!(params[2].r_weight > params[2].l_weight,
            "right speaker should favor right: l={}, r={}", params[2].l_weight, params[2].r_weight);

        // Center speaker should have roughly equal L/R
        assert!(approx_eq(params[1].l_weight, params[1].r_weight, 0.1),
            "center should be balanced: l={}, r={}", params[1].l_weight, params[1].r_weight);
    }

    #[test]
    fn test_mixer_listener_moves_left() {
        let speakers = default_speakers();
        let mut mixer = SpatialMixer::new(speakers, 44100.0);
        mixer.set_listener(Position::new(-1.0, 0.0), 0.0);
        let params = mixer.target_params();

        // Left speaker should be closer → higher gain
        assert!(params[0].gain > params[2].gain);
    }

    #[test]
    fn test_process_buffer_length() {
        let speakers = default_speakers();
        let mut mixer = SpatialMixer::new(speakers, 44100.0);

        let input: Vec<f64> = (0..20).map(|i| (i as f64) * 0.01).collect();
        let buffers = mixer.process_buffer(&input, SpatialMode::StereoPan);

        assert_eq!(buffers.len(), 3);
        for buf in &buffers {
            assert_eq!(buf.len(), 10);
        }
    }

    #[test]
    fn test_process_silence() {
        let speakers = default_speakers();
        let mut mixer = SpatialMixer::new(speakers, 44100.0);

        let out = mixer.process_sample_stereo_pan(0.0, 0.0);
        assert_eq!(out.len(), 3);
        for s in &out {
            assert!(approx_eq(*s, 0.0, 1e-10));
        }
    }

    #[test]
    fn test_energy_does_not_explode() {
        let speakers = default_speakers();
        let mut mixer = SpatialMixer::new(speakers, 44100.0);

        let mut max_output = 0.0_f64;
        for _ in 0..1000 {
            let out = mixer.process_sample_stereo_pan(1.0, 1.0);
            for s in &out {
                max_output = max_output.max(s.abs());
            }
        }
        assert!(max_output < 2.0, "output exploded: max={max_output}");
    }

    #[test]
    fn test_smoothing_gradual_transition() {
        let speakers = default_speakers();
        let mut mixer = SpatialMixer::new(speakers, 44100.0);
        mixer.smoothing_alpha = 0.1;

        let initial_gain = mixer.current_params()[0].gain;
        mixer.set_listener(Position::new(3.0, 0.0), 0.0);

        mixer.update_smoothing();
        let after_one = mixer.current_params()[0].gain;
        let target = mixer.target_params()[0].gain;

        assert!((after_one - initial_gain).abs() > 0.0);
        assert!((after_one - target).abs() > 0.001);

        for _ in 0..500 {
            mixer.update_smoothing();
        }
        let converged = mixer.current_params()[0].gain;
        assert!(approx_eq(converged, target, 1e-4));
    }

    #[test]
    fn test_facing_affects_lr_weights() {
        let speakers = default_speakers();

        // Listener facing forward
        let mixer_fwd = SpatialMixer::new(speakers.clone(), 44100.0);

        // Listener facing right (PI/2)
        let mut mixer_right = SpatialMixer::new(speakers, 44100.0);
        mixer_right.set_listener(Position::new(0.0, 0.0), PI / 2.0);

        // When facing right, the left speaker (-1.5, 2) is more "behind-left",
        // so its L/R balance should shift compared to facing forward
        let fwd_params = mixer_fwd.target_params();
        let right_params = mixer_right.target_params();

        // The angles should be different
        assert!(
            (fwd_params[0].angle - right_params[0].angle).abs() > 0.1,
            "facing direction should change speaker angles"
        );
    }

    // --- SpatialParams atomic tests ---

    #[test]
    fn test_spatial_params_snapshot() {
        let params = SpatialParams::new(3);
        params.set_enabled(true);
        params.set_mode(SpatialMode::Stft51);
        params.set_listener(1.5, 2.0, 0.5);
        params.set_speaker_position(0, -1.0, 3.0);
        params.set_speaker_position(1, 0.0, 3.0);
        params.set_speaker_position(2, 1.0, 3.0);

        let snap = params.snapshot();
        assert!(snap.enabled);
        assert_eq!(snap.mode, SpatialMode::Stft51);
        assert!(approx_eq(snap.listener_x, 1.5, 0.01));
        assert!(approx_eq(snap.listener_y, 2.0, 0.01));
        assert!(approx_eq(snap.listener_facing, 0.5, 0.01));
        assert_eq!(snap.speaker_positions.len(), 3);
        assert!(approx_eq(snap.speaker_positions[0].0, -1.0, 0.01));
    }

    #[test]
    fn test_spatial_params_toggle() {
        let params = SpatialParams::new(2);
        assert!(!params.is_enabled());
        params.toggle_enabled();
        assert!(params.is_enabled());
        params.toggle_enabled();
        assert!(!params.is_enabled());
    }

    #[test]
    fn test_spatial_params_cycle_mode() {
        let params = SpatialParams::new(2);
        assert_eq!(params.mode(), SpatialMode::StereoPan);
        params.cycle_mode();
        assert_eq!(params.mode(), SpatialMode::Stft51);
        params.cycle_mode();
        assert_eq!(params.mode(), SpatialMode::StereoPan);
    }

    // --- Stereo pan: signal routing ---

    #[test]
    fn test_stereo_pan_left_signal_goes_left() {
        let speakers = default_speakers(); // L at -1.5, C at 0, R at +1.5
        let mut mixer = SpatialMixer::new(speakers, 44100.0);

        // Feed a left-only signal through several frames so smoothing settles
        let mut left_energy = 0.0_f64;
        let mut right_energy = 0.0_f64;
        for _ in 0..500 {
            let out = mixer.process_sample_stereo_pan(1.0, 0.0);
            left_energy += out[0] * out[0];  // left speaker
            right_energy += out[2] * out[2]; // right speaker
            mixer.update_smoothing();
        }
        assert!(
            left_energy > right_energy * 1.5,
            "left speaker should be louder for left-only input: L_e={left_energy:.4}, R_e={right_energy:.4}"
        );
    }

    #[test]
    fn test_stereo_pan_right_signal_goes_right() {
        let speakers = default_speakers();
        let mut mixer = SpatialMixer::new(speakers, 44100.0);

        let mut left_energy = 0.0_f64;
        let mut right_energy = 0.0_f64;
        for _ in 0..500 {
            let out = mixer.process_sample_stereo_pan(0.0, 1.0);
            left_energy += out[0] * out[0];
            right_energy += out[2] * out[2];
            mixer.update_smoothing();
        }
        assert!(
            right_energy > left_energy * 1.5,
            "right speaker should be louder for right-only input: L_e={left_energy:.4}, R_e={right_energy:.4}"
        );
    }

    #[test]
    fn test_stereo_pan_symmetric_speakers_equal_for_mono() {
        let speakers = default_speakers(); // symmetric about x=0
        let mut mixer = SpatialMixer::new(speakers, 44100.0);

        // Mono input (equal L/R)
        let mut energies = [0.0_f64; 3];
        for _ in 0..500 {
            let out = mixer.process_sample_stereo_pan(0.5, 0.5);
            for (i, s) in out.iter().enumerate() {
                energies[i] += s * s;
            }
            mixer.update_smoothing();
        }
        // Left and right speakers should have equal energy
        assert!(
            approx_eq(energies[0], energies[2], energies[0] * 0.01),
            "symmetric speakers should match for mono: L={:.4}, R={:.4}",
            energies[0], energies[2]
        );
    }

    #[test]
    fn test_stereo_pan_delay_values_correct_for_geometry() {
        // Two speakers: one at 1m, one at 3m from listener
        let speakers = vec![
            SpeakerConfig {
                device_id: "close".into(),
                position: Position::new(0.0, 1.0),
            },
            SpeakerConfig {
                device_id: "far".into(),
                position: Position::new(0.0, 3.0),
            },
        ];
        let mixer = SpatialMixer::new(speakers, 44100.0);
        let params = mixer.target_params();

        // Close speaker should have MORE delay (to align with far speaker)
        assert!(params[0].delay_samples > params[1].delay_samples);

        // Far speaker should have zero delay (it's the reference)
        assert!(
            approx_eq(params[1].delay_samples, 0.0, 0.01),
            "far speaker delay should be ~0: {}",
            params[1].delay_samples
        );

        // Close speaker delay = (3-1) / 343 * 44100 ≈ 257 samples
        let expected_delay = (3.0 - 1.0) / SPEED_OF_SOUND * 44100.0;
        assert!(
            approx_eq(params[0].delay_samples, expected_delay, 1.0),
            "close speaker delay should be ~{expected_delay:.1}: {:.1}",
            params[0].delay_samples
        );
    }

    #[test]
    fn test_stereo_pan_total_gain_bounded() {
        // With several speakers, the total gain across all speakers
        // should not exceed the number of speakers (each ≤ 1.0)
        let speakers = default_speakers();
        let mixer = SpatialMixer::new(speakers, 44100.0);
        let params = mixer.target_params();

        let total_gain: f64 = params.iter().map(|p| p.gain).sum();
        assert!(
            total_gain <= 3.0 + 1e-10,
            "total gain should not exceed speaker count: {total_gain}"
        );
        // The closest speaker should always have gain = 1.0
        let max_gain = params.iter().map(|p| p.gain).fold(0.0_f64, f64::max);
        assert!(
            approx_eq(max_gain, 1.0, 1e-10),
            "max gain should be 1.0: {max_gain}"
        );
    }

    #[test]
    fn test_stereo_pan_buffer_matches_sample_by_sample() {
        let speakers = default_speakers();
        let mut mixer_buf = SpatialMixer::new(speakers.clone(), 44100.0);
        let mut mixer_samp = SpatialMixer::new(speakers, 44100.0);

        // Generate test input
        let input: Vec<f64> = (0..20)
            .map(|i| (i as f64 * 0.1).sin())
            .collect();

        // Process as buffer
        let buf_result = mixer_buf.process_buffer_stereo_pan(&input);

        // Process sample-by-sample
        let num_frames = input.len() / 2;
        let mut samp_result: Vec<Vec<f64>> = vec![Vec::new(); 3];
        for frame in 0..num_frames {
            let l = input[frame * 2];
            let r = input[frame * 2 + 1];
            let out = mixer_samp.process_sample_stereo_pan(l, r);
            for (i, s) in out.iter().enumerate() {
                samp_result[i].push(*s);
            }
            mixer_samp.update_smoothing();
        }

        // Results should be identical
        for spk in 0..3 {
            for frame in 0..num_frames {
                assert!(
                    approx_eq(buf_result[spk][frame], samp_result[spk][frame], 1e-10),
                    "mismatch at speaker {spk}, frame {frame}: buf={}, samp={}",
                    buf_result[spk][frame], samp_result[spk][frame]
                );
            }
        }
    }

    // --- Channel weights for 5.1 ---

    #[test]
    fn test_channel_weights_center() {
        let weights = channel_weights_for_angle(0.0);
        // At 0° (front center), FC should be dominant
        assert!(weights[1] > weights[0], "FC should be > FL at center");
        assert!(weights[1] > weights[2], "FC should be > FR at center");
    }

    #[test]
    fn test_channel_weights_left() {
        let weights = channel_weights_for_angle(-PI / 6.0);
        // At -30° (front left), FL should be dominant
        assert!(weights[0] > weights[2], "FL should be > FR at -30°");
    }

    #[test]
    fn test_channel_weights_normalized() {
        for deg in (-180..=180).step_by(15) {
            let angle = deg as f64 * PI / 180.0;
            let weights = channel_weights_for_angle(angle);
            let sum: f64 = weights[..5].iter().sum();
            assert!(
                approx_eq(sum, 1.0, 0.01),
                "weights should sum to ~1.0 at {}°, got {sum}",
                deg
            );
        }
    }
}
