//! Local music-information-retrieval (MIR) replacing QQ's server-side
//! `music.mir.MixPlanSvr` payload (`QMNewMirInfo`: `cue.cuts / cuts_2 / entrys / entrys_2`
//! + `beat.bpm`).
//!
//! Everything works on a mono, decimated envelope plus the vendored SoundTouch BPM
//! detector, so a 45 s head window and a 90 s tail window analyse in well under 100 ms.
//!
//! Outputs, in seconds on the track timeline:
//! * `leading_silence` / `trailing_silence` – gapless trim points
//!   (`gaplessPlayStartMuteMS` / `EndMuteMS` / `EndMutePercent` analogues).
//! * `bpm`, `beat_secs`, `beat_phase`, `downbeat_phase` – beat grid.
//! * `energy` – RMS envelope (100 ms hop) used by cue decisions.
//! * `sections` – structural boundaries (novelty peaks snapped to downbeats), which play
//!   the role of `cuts[0]` (outgoing track) and `entrys[]` (incoming track).

use soundtouch_rs::BpmDetect;
use std::f32::consts::PI;

/// RMS below this level counts as silence (dBFS).
pub const SILENCE_THRESHOLD_DB: f32 = -60.0;
/// Longest leading silence that will be skipped.
pub const MAX_LEADING_SILENCE_SECS: f64 = 5.0;
/// Longest trailing silence that will be skipped.
pub const MAX_TRAILING_SILENCE_SECS: f64 = 10.0;
/// Trailing silence is never allowed to exceed this fraction of the track.
pub const MAX_TRAILING_SILENCE_FRACTION: f64 = 0.2;
/// Silence detection block length.
pub const SILENCE_BLOCK_SECS: f64 = 0.01;
/// Energy envelope hop (`ENVELOPE_HOP_SECS` seconds per frame).
pub const ENVELOPE_HOP_SECS: f64 = 0.1;
const NOVELTY_WINDOW_SECS: f64 = 4.0;
const NOVELTY_MIN_SEPARATION_SECS: f64 = 6.0;
const ONSET_HOP_SECS: f64 = 0.01;
const MIN_BPM: f32 = 60.0;
const MAX_BPM: f32 = 180.0;
const BEATS_PER_BAR: usize = 4;
const MIN_ANALYSIS_SECS: f64 = 4.0;
const NOVELTY_PEAK_RATIO: f32 = 1.35;
/// Fine tempo search range around the coarse BPM estimate (fraction) and step count.
const TEMPO_REFINE_RANGE: f64 = 0.03;
const TEMPO_REFINE_STEPS: usize = 30;

/// Analysis of one window of a track, timestamps in seconds on the track timeline.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TrackAnalysis {
    /// Track duration as known to the decoder.
    pub duration_secs: f64,
    /// Start of the analysed window on the track timeline.
    pub window_start_secs: f64,
    /// End of the analysed window on the track timeline.
    pub window_end_secs: f64,
    /// First audible sample (only meaningful when the window starts at 0).
    pub leading_silence_secs: Option<f64>,
    /// Last audible sample (only meaningful when the window reaches the end).
    pub trailing_silence_start_secs: Option<f64>,
    pub bpm: Option<f32>,
    /// Beat length in seconds (60 / bpm).
    pub beat_secs: Option<f64>,
    /// Timestamp of a beat; the grid is `beat_phase + k·beat_secs`.
    pub beat_phase_secs: Option<f64>,
    /// Timestamp of a downbeat (bar start); bars are `downbeat_phase + k·4·beat_secs`.
    pub downbeat_phase_secs: Option<f64>,
    /// Confidence 0..1 that the grid is reliable (steady onsets, plausible bpm).
    pub beat_confidence: f32,
    /// RMS envelope, one value per [`ENVELOPE_HOP_SECS`] starting at `window_start_secs`.
    pub energy: Vec<f32>,
    /// Structural boundaries inside the window (seconds), ascending.
    pub sections: Vec<f64>,
}

impl TrackAnalysis {
    pub fn covers_start(&self) -> bool {
        self.window_start_secs <= 0.0
    }

    pub fn covers_end(&self) -> bool {
        self.duration_secs > 0.0 && self.window_end_secs + 0.05 >= self.duration_secs
    }

    /// First audible time, or 0 when unknown.
    pub fn audible_start_secs(&self) -> f64 {
        self.leading_silence_secs.unwrap_or(0.0)
    }

    /// Last audible time, or the duration when unknown.
    pub fn audible_end_secs(&self) -> f64 {
        self.trailing_silence_start_secs
            .unwrap_or(self.duration_secs)
            .max(0.0)
    }

    pub fn has_beat_grid(&self) -> bool {
        self.beat_secs.is_some_and(|beat| beat > 0.0)
            && self.downbeat_phase_secs.is_some()
            && self.beat_confidence >= 0.35
    }

    pub fn bar_secs(&self) -> Option<f64> {
        self.beat_secs.map(|beat| beat * BEATS_PER_BAR as f64)
    }

    /// Nearest downbeat to `time`.
    pub fn nearest_downbeat(&self, time: f64) -> Option<f64> {
        let bar = self.bar_secs()?;
        let phase = self.downbeat_phase_secs?;
        Some(phase + ((time - phase) / bar).round() * bar)
    }

    /// Latest downbeat at or before `time`.
    pub fn downbeat_at_or_before(&self, time: f64) -> Option<f64> {
        let bar = self.bar_secs()?;
        let phase = self.downbeat_phase_secs?;
        Some(phase + ((time - phase) / bar).floor() * bar)
    }

    /// Earliest downbeat at or after `time`.
    pub fn downbeat_at_or_after(&self, time: f64) -> Option<f64> {
        let bar = self.bar_secs()?;
        let phase = self.downbeat_phase_secs?;
        Some(phase + ((time - phase) / bar).ceil() * bar)
    }

    /// Mean RMS energy between two timestamps (0 when outside the window).
    pub fn mean_energy(&self, from: f64, to: f64) -> f32 {
        if self.energy.is_empty() || to <= from {
            return 0.0;
        }
        let hop = ENVELOPE_HOP_SECS;
        let start = (((from - self.window_start_secs) / hop).floor().max(0.0)) as usize;
        let end = (((to - self.window_start_secs) / hop).ceil().max(0.0)) as usize;
        let end = end.min(self.energy.len());
        if start >= end {
            return 0.0;
        }
        self.energy[start..end].iter().sum::<f32>() / (end - start) as f32
    }
}

/// Incrementally accumulates mono samples for one analysis window.
pub struct TrackAnalyzer {
    sample_rate: u32,
    channels: usize,
    duration_secs: f64,
    window_start_secs: f64,
    mono: Vec<f32>,
}

impl TrackAnalyzer {
    pub fn new(
        sample_rate: u32,
        channels: usize,
        duration_secs: f64,
        window_start_secs: f64,
    ) -> Self {
        Self {
            sample_rate: sample_rate.max(1),
            channels: channels.max(1),
            duration_secs: duration_secs.max(0.0),
            window_start_secs: window_start_secs.max(0.0),
            mono: Vec::new(),
        }
    }

    /// Seconds of audio accumulated so far.
    pub fn collected_secs(&self) -> f64 {
        self.mono.len() as f64 / f64::from(self.sample_rate)
    }

    /// Push interleaved samples (any channel count matching the analyzer).
    pub fn push_interleaved(&mut self, samples: &[f32]) {
        let channels = self.channels;
        self.mono.reserve(samples.len() / channels);
        for frame in samples.chunks_exact(channels) {
            let sum: f32 = frame.iter().copied().sum();
            self.mono.push(sum / channels as f32);
        }
    }

    pub fn push_mono(&mut self, samples: &[f32]) {
        self.mono.extend_from_slice(samples);
    }

    /// Whether the window has reached the end of the track.
    fn reaches_end(&self) -> bool {
        self.duration_secs > 0.0
            && self.window_start_secs + self.collected_secs() + 0.05 >= self.duration_secs
    }

    pub fn finish(self) -> TrackAnalysis {
        let sample_rate = self.sample_rate;
        let sr = f64::from(sample_rate);
        let window_end_secs = self.window_start_secs + self.mono.len() as f64 / sr;
        let mut analysis = TrackAnalysis {
            duration_secs: if self.duration_secs > 0.0 {
                self.duration_secs
            } else {
                window_end_secs
            },
            window_start_secs: self.window_start_secs,
            window_end_secs,
            ..TrackAnalysis::default()
        };
        if self.mono.is_empty() {
            return analysis;
        }
        let reaches_end = self.reaches_end() || self.duration_secs <= 0.0;
        if self.window_start_secs <= 0.0 {
            analysis.leading_silence_secs = Some(leading_silence_secs(&self.mono, sample_rate));
        }
        if reaches_end {
            let trailing =
                trailing_silence_start_secs(&self.mono, sample_rate, analysis.duration_secs);
            analysis.trailing_silence_start_secs = Some(self.window_start_secs + trailing);
        }
        analysis.energy = energy_envelope(&self.mono, sample_rate);
        if self.collected_secs() >= MIN_ANALYSIS_SECS {
            let onsets = onset_envelope(&self.mono, sample_rate);
            let grid = beat_grid(&self.mono, &onsets, sample_rate);
            if let Some(grid) = grid {
                analysis.bpm = Some(grid.bpm);
                analysis.beat_secs = Some(grid.beat_secs);
                analysis.beat_phase_secs = Some(self.window_start_secs + grid.beat_phase);
                analysis.downbeat_phase_secs = Some(self.window_start_secs + grid.downbeat_phase);
                analysis.beat_confidence = grid.confidence;
            }
            analysis.sections = section_boundaries(&analysis.energy, &self.mono, sample_rate)
                .into_iter()
                .map(|secs| self.window_start_secs + secs)
                .map(|secs| analysis.nearest_downbeat(secs).unwrap_or(secs))
                .filter(|secs| {
                    *secs > self.window_start_secs + 0.5 && *secs < window_end_secs - 0.5
                })
                .collect();
            analysis.sections.dedup_by(|a, b| (*a - *b).abs() < 0.5);
        }
        analysis
    }
}

// ---------------------------------------------------------------------------------------
// Silence
// ---------------------------------------------------------------------------------------

fn silence_threshold_linear() -> f32 {
    10.0f32.powf(SILENCE_THRESHOLD_DB / 20.0)
}

fn block_rms(block: &[f32]) -> f32 {
    if block.is_empty() {
        return 0.0;
    }
    (block.iter().map(|s| s * s).sum::<f32>() / block.len() as f32).sqrt()
}

/// Seconds of leading silence (capped).
pub fn leading_silence_secs(mono: &[f32], sample_rate: u32) -> f64 {
    let block = ((SILENCE_BLOCK_SECS * f64::from(sample_rate)) as usize).max(1);
    let threshold = silence_threshold_linear();
    let max_blocks = (MAX_LEADING_SILENCE_SECS / SILENCE_BLOCK_SECS) as usize;
    let mut silent_blocks = 0usize;
    for chunk in mono.chunks(block) {
        if block_rms(chunk) >= threshold || silent_blocks >= max_blocks {
            break;
        }
        silent_blocks += 1;
    }
    (silent_blocks * block) as f64 / f64::from(sample_rate)
}

/// Timestamp (relative to `mono[0]`) where trailing silence begins, capped so that at most
/// `MAX_TRAILING_SILENCE_SECS` / 20 % of the track is trimmed.
pub fn trailing_silence_start_secs(mono: &[f32], sample_rate: u32, duration_secs: f64) -> f64 {
    let sr = f64::from(sample_rate);
    let total_secs = mono.len() as f64 / sr;
    let block = ((SILENCE_BLOCK_SECS * sr) as usize).max(1);
    let threshold = silence_threshold_linear();
    let cap_secs = MAX_TRAILING_SILENCE_SECS.min(if duration_secs > 0.0 {
        duration_secs * MAX_TRAILING_SILENCE_FRACTION
    } else {
        MAX_TRAILING_SILENCE_SECS
    });
    let max_blocks = (cap_secs / SILENCE_BLOCK_SECS) as usize;
    let mut silent_blocks = 0usize;
    for chunk in mono.rchunks(block) {
        if block_rms(chunk) >= threshold || silent_blocks >= max_blocks {
            break;
        }
        silent_blocks += 1;
    }
    (total_secs - (silent_blocks * block) as f64 / sr).max(0.0)
}

// ---------------------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------------------

fn energy_envelope(mono: &[f32], sample_rate: u32) -> Vec<f32> {
    let hop = ((ENVELOPE_HOP_SECS * f64::from(sample_rate)) as usize).max(1);
    mono.chunks(hop).map(block_rms).collect()
}

/// Onset strength envelope: half-wave rectified difference of a band-limited log energy,
/// 10 ms hop. Good enough for phase/downbeat estimation of pop/electronic material.
fn onset_envelope(mono: &[f32], sample_rate: u32) -> Vec<f32> {
    let hop = ((ONSET_HOP_SECS * f64::from(sample_rate)) as usize).max(1);
    // One-pole low-pass (≈ 200 Hz) emphasises kick/bass onsets, a high-pass difference
    // emphasises snares/hats; combine both energies.
    let lp_coeff = (-2.0 * PI * 200.0 / sample_rate.max(1) as f32).exp();
    let mut lp = 0.0f32;
    let mut prev = 0.0f32;
    let mut energies = Vec::with_capacity(mono.len() / hop + 1);
    for chunk in mono.chunks(hop) {
        let mut low = 0.0f32;
        let mut high = 0.0f32;
        for &sample in chunk {
            lp = sample + (lp - sample) * lp_coeff;
            let hp = sample - prev;
            prev = sample;
            low += lp * lp;
            high += hp * hp;
        }
        let n = chunk.len().max(1) as f32;
        energies.push(((low / n).sqrt() * 1.5 + (high / n).sqrt()).ln_1p());
    }
    let mut onsets = vec![0.0f32; energies.len()];
    for index in 1..energies.len() {
        onsets[index] = (energies[index] - energies[index - 1]).max(0.0);
    }
    // Light smoothing.
    let mut smoothed = onsets.clone();
    for index in 1..onsets.len().saturating_sub(1) {
        smoothed[index] = (onsets[index - 1] + 2.0 * onsets[index] + onsets[index + 1]) / 4.0;
    }
    smoothed
}

// ---------------------------------------------------------------------------------------
// Beat grid
// ---------------------------------------------------------------------------------------

struct BeatGrid {
    bpm: f32,
    beat_secs: f64,
    beat_phase: f64,
    downbeat_phase: f64,
    confidence: f32,
}

fn beat_grid(mono: &[f32], onsets: &[f32], sample_rate: u32) -> Option<BeatGrid> {
    let coarse_bpm = detect_bpm(mono, sample_rate).or_else(|| autocorrelation_bpm(onsets))?;
    let coarse_bpm = fold_bpm(coarse_bpm);
    let hop = ONSET_HOP_SECS;
    let coarse_hops = 60.0 / f64::from(coarse_bpm) / hop;
    if coarse_hops < 2.0 || onsets.len() < (coarse_hops * 4.0) as usize {
        return None;
    }
    // Fine tempo/phase refinement: a coarse estimate that is 0.5 % off drifts by a third
    // of a beat over 40 s, which would ruin downbeat alignment. Comb-search the period in
    // ±TEMPO_REFINE_RANGE around the coarse value and keep the (period, phase) pair that
    // best explains the onsets.
    let mut best = (coarse_hops, 0usize, f32::MIN);
    let steps = TEMPO_REFINE_STEPS as i32;
    for step in -steps..=steps {
        let period = coarse_hops * (1.0 + TEMPO_REFINE_RANGE * f64::from(step) / f64::from(steps));
        let phase_steps = period.floor().max(1.0) as usize;
        for phase in 0..phase_steps {
            let score = grid_score(onsets, phase as f64, period);
            if score > best.2 {
                best = (period, phase, score);
            }
        }
    }
    let (beat_hops, best_phase, best_score) = best;
    let beat_secs = beat_hops * hop;
    let bpm = (60.0 / beat_secs) as f32;
    // Confidence: how much the best grid stands out against the average phase.
    let phase_steps = beat_hops.floor().max(1.0) as usize;
    let mean_score = (0..phase_steps)
        .map(|phase| grid_score(onsets, phase as f64, beat_hops))
        .sum::<f32>()
        / phase_steps as f32;
    let confidence = if mean_score <= 1.0e-6 || !best_score.is_finite() {
        0.0
    } else {
        ((best_score / mean_score - 1.0) / 1.5).clamp(0.0, 1.0)
    };
    // Downbeat: among the four beat offsets, the one with the strongest accumulated onset
    // (the envelope already emphasises bass, so kicks on "one" win).
    let mut best_beat = 0usize;
    let mut best_beat_score = f32::MIN;
    for beat in 0..BEATS_PER_BAR {
        let phase = best_phase as f64 + beat as f64 * beat_hops;
        let score = grid_score(onsets, phase, beat_hops * BEATS_PER_BAR as f64);
        if score > best_beat_score {
            best_beat_score = score;
            best_beat = beat;
        }
    }
    let beat_phase = best_phase as f64 * hop;
    let downbeat_phase = beat_phase + best_beat as f64 * beat_secs;
    Some(BeatGrid {
        bpm,
        beat_secs,
        beat_phase,
        downbeat_phase,
        confidence,
    })
}

fn grid_score(onsets: &[f32], phase_hops: f64, period_hops: f64) -> f32 {
    let mut score = 0.0f32;
    let mut count = 0usize;
    let mut position = phase_hops;
    while (position as usize) < onsets.len() {
        let index = position.round() as usize;
        if index < onsets.len() {
            // Small tolerance window around the grid point.
            let lo = index.saturating_sub(1);
            let hi = (index + 1).min(onsets.len() - 1);
            score += onsets[lo..=hi].iter().copied().fold(0.0, f32::max);
            count += 1;
        }
        position += period_hops;
    }
    if count == 0 {
        0.0
    } else {
        score / count as f32
    }
}

fn detect_bpm(mono: &[f32], sample_rate: u32) -> Option<f32> {
    let mut detector = BpmDetect::new(1, sample_rate as usize).ok()?;
    for chunk in mono.chunks(8_192) {
        detector.put_samples(&[chunk]).ok()?;
    }
    detector.get_bpm()
}

/// Fallback tempo estimate from the onset envelope's autocorrelation.
fn autocorrelation_bpm(onsets: &[f32]) -> Option<f32> {
    let hop = ONSET_HOP_SECS;
    let min_lag = (60.0 / f64::from(MAX_BPM) / hop) as usize;
    let max_lag = (60.0 / f64::from(MIN_BPM) / hop) as usize;
    if onsets.len() < max_lag * 2 {
        return None;
    }
    let mean = onsets.iter().sum::<f32>() / onsets.len() as f32;
    let centred: Vec<f32> = onsets.iter().map(|v| v - mean).collect();
    let mut best_lag = 0usize;
    let mut best = f32::MIN;
    for lag in min_lag..=max_lag {
        let mut sum = 0.0f32;
        for index in lag..centred.len() {
            sum += centred[index] * centred[index - lag];
        }
        // Slight preference for shorter lags to avoid octave-down errors.
        let weighted = sum / (centred.len() - lag) as f32
            * (1.0 + 0.1 * (max_lag - lag) as f32 / max_lag as f32);
        if weighted > best {
            best = weighted;
            best_lag = lag;
        }
    }
    if best_lag == 0 || best <= 0.0 {
        return None;
    }
    Some((60.0 / (best_lag as f64 * hop)) as f32)
}

/// Fold the tempo into the DJ-friendly 70–150 range (octave errors are common).
fn fold_bpm(bpm: f32) -> f32 {
    let mut bpm = bpm;
    while bpm > 150.0 {
        bpm /= 2.0;
    }
    while bpm < 70.0 {
        bpm *= 2.0;
    }
    bpm
}

// ---------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------

/// Novelty-based section boundaries: large changes in the mean of the energy envelope and
/// of the spectral centroid proxy (high/low band ratio) between adjacent windows.
fn section_boundaries(energy: &[f32], mono: &[f32], sample_rate: u32) -> Vec<f64> {
    let hop = ENVELOPE_HOP_SECS;
    let window = (NOVELTY_WINDOW_SECS / hop) as usize;
    if energy.len() < window * 2 + 2 {
        return Vec::new();
    }
    let brightness = brightness_envelope(mono, sample_rate);
    let mut novelty = vec![0.0f32; energy.len()];
    for index in window..energy.len() - window {
        let before_e = energy[index - window..index].iter().sum::<f32>() / window as f32;
        let after_e = energy[index..index + window].iter().sum::<f32>() / window as f32;
        let before_b = brightness[index - window..index].iter().sum::<f32>() / window as f32;
        let after_b = brightness[index..index + window].iter().sum::<f32>() / window as f32;
        let energy_change = (after_e - before_e).abs() / (before_e.max(after_e) + 1.0e-4);
        let brightness_change = (after_b - before_b).abs();
        novelty[index] = energy_change + brightness_change;
    }
    let mean = novelty.iter().sum::<f32>() / novelty.len() as f32;
    let threshold = mean * NOVELTY_PEAK_RATIO + 0.05;
    let min_sep = (NOVELTY_MIN_SEPARATION_SECS / hop) as usize;
    let mut peaks = Vec::new();
    let mut index = window;
    while index < novelty.len() - window {
        let value = novelty[index];
        if value > threshold
            && value >= novelty[index - 1]
            && value >= novelty[index + 1]
            && peaks
                .last()
                .is_none_or(|last: &(usize, f32)| index - last.0 >= min_sep || value > last.1)
        {
            if let Some(last) = peaks.last() {
                if index - last.0 < min_sep {
                    peaks.pop();
                }
            }
            peaks.push((index, value));
        }
        index += 1;
    }
    peaks
        .into_iter()
        .map(|(index, _)| index as f64 * hop)
        .collect()
}

/// Ratio of high-band to total energy per envelope hop (0..1).
fn brightness_envelope(mono: &[f32], sample_rate: u32) -> Vec<f32> {
    let hop = ((ENVELOPE_HOP_SECS * f64::from(sample_rate)) as usize).max(1);
    let coeff = (-2.0 * PI * 1_500.0 / sample_rate.max(1) as f32).exp();
    let mut lp = 0.0f32;
    mono.chunks(hop)
        .map(|chunk| {
            let mut total = 0.0f32;
            let mut high = 0.0f32;
            for &sample in chunk {
                lp = sample + (lp - sample) * coeff;
                let hp = sample - lp;
                total += sample * sample;
                high += hp * hp;
            }
            if total <= 1.0e-9 {
                0.0
            } else {
                (high / total).clamp(0.0, 1.0)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 44_100;

    /// Synthetic drum-machine track: kick on every beat, accent on beat 1, a bass tone and a
    /// section change (extra hi-hat energy) at `section_at` seconds.
    fn click_track(bpm: f32, secs: f64, offset_secs: f64, section_at: Option<f64>) -> Vec<f32> {
        let sr = f64::from(SR);
        let frames = (secs * sr) as usize;
        let beat = 60.0 / f64::from(bpm);
        let mut out = vec![0.0f32; frames];
        let mut beat_index = 0usize;
        let mut t = offset_secs;
        while t < secs {
            let start = (t * sr) as usize;
            let accent = if beat_index % 4 == 0 { 1.0 } else { 0.5 };
            for i in 0..(0.05 * sr) as usize {
                let idx = start + i;
                if idx >= frames {
                    break;
                }
                let env = (-(i as f32) / (0.01 * sr as f32)).exp();
                out[idx] += accent * env * (2.0 * PI * 60.0 * i as f32 / SR as f32).sin();
            }
            beat_index += 1;
            t += beat;
        }
        for (idx, sample) in out.iter_mut().enumerate() {
            let time = idx as f64 / sr;
            *sample += 0.1 * (2.0 * PI as f64 * 110.0 * time).sin() as f32;
            if section_at.is_some_and(|s| time >= s) {
                // Pseudo-noise hats after the section change.
                let noise = ((idx as u64).wrapping_mul(6_364_136_223_846_793_005) >> 33) as f32
                    / (1u64 << 31) as f32
                    - 0.5;
                *sample += 0.15 * noise;
            }
        }
        out
    }

    #[test]
    fn leading_and_trailing_silence_are_detected_and_capped() {
        let sr = f64::from(SR);
        let mut mono = vec![0.0f32; (1.5 * sr) as usize];
        mono.extend(click_track(120.0, 30.0, 0.0, None));
        mono.extend(vec![0.0f32; (3.0 * sr) as usize]);
        let leading = leading_silence_secs(&mono, SR);
        assert!((leading - 1.5).abs() < 0.03, "leading {leading}");
        let total = mono.len() as f64 / sr;
        let trailing = trailing_silence_start_secs(&mono, SR, total);
        assert!(
            (trailing - (total - 3.0)).abs() < 0.08,
            "trailing {trailing} total {total}"
        );
        // Cap: never trim more than 20 % of a short track …
        let short_total = 14.5;
        let short = vec![0.0f32; (short_total * sr) as usize];
        let short_trim = trailing_silence_start_secs(&short, SR, short_total);
        assert!(
            (short_trim - (short_total - short_total * MAX_TRAILING_SILENCE_FRACTION)).abs() < 0.05
        );
        // … and a 200 s track with 30 s of trailing silence only trims 10 s.
        let long = vec![0.0f32; (30.0 * sr) as usize];
        let capped = trailing_silence_start_secs(&long, SR, 200.0);
        assert!((capped - 20.0).abs() < 0.05, "capped {capped}");
        let head = vec![0.0f32; (12.0 * sr) as usize];
        assert!((leading_silence_secs(&head, SR) - MAX_LEADING_SILENCE_SECS).abs() < 0.02);
    }

    #[test]
    fn beat_grid_recovers_tempo_phase_and_downbeat_of_a_click_track() {
        let mut analyzer = TrackAnalyzer::new(SR, 1, 40.0, 0.0);
        analyzer.push_mono(&click_track(128.0, 40.0, 0.25, None));
        let analysis = analyzer.finish();
        let bpm = analysis.bpm.expect("bpm");
        assert!((bpm - 128.0).abs() < 2.0, "bpm {bpm}");
        assert!(
            analysis.has_beat_grid(),
            "confidence {}",
            analysis.beat_confidence
        );
        let beat = analysis.beat_secs.unwrap();
        let phase = analysis.beat_phase_secs.unwrap();
        // Phase should sit on the 0.25 s grid (modulo one beat).
        let offset = ((phase - 0.25) / beat).fract().abs();
        let offset = offset.min(1.0 - offset);
        assert!(offset < 0.08, "phase offset {offset} beats");
        let downbeat = analysis.downbeat_phase_secs.unwrap();
        let bar = beat * 4.0;
        let bar_offset = ((downbeat - 0.25) / bar).fract().abs();
        let bar_offset = bar_offset.min(1.0 - bar_offset);
        assert!(bar_offset < 0.05, "downbeat offset {bar_offset} bars");
        assert!(analysis.leading_silence_secs.unwrap() < 0.3);
    }

    #[test]
    fn section_boundary_lands_near_the_texture_change() {
        let mut analyzer = TrackAnalyzer::new(SR, 1, 40.0, 0.0);
        analyzer.push_mono(&click_track(120.0, 40.0, 0.0, Some(20.0)));
        let analysis = analyzer.finish();
        assert!(!analysis.sections.is_empty(), "no sections found");
        let nearest = analysis
            .sections
            .iter()
            .map(|s| (s - 20.0).abs())
            .fold(f64::MAX, f64::min);
        assert!(
            nearest < 2.5,
            "nearest boundary {nearest}s away: {:?}",
            analysis.sections
        );
    }

    #[test]
    fn window_offsets_are_applied_to_timestamps() {
        let mut analyzer = TrackAnalyzer::new(SR, 2, 300.0, 250.0);
        let mono = click_track(100.0, 50.0, 0.0, None);
        let stereo: Vec<f32> = mono.iter().flat_map(|s| [*s, *s]).collect();
        analyzer.push_interleaved(&stereo);
        let analysis = analyzer.finish();
        assert!(analysis.covers_end());
        assert!(!analysis.covers_start());
        assert!(analysis.leading_silence_secs.is_none());
        let end = analysis.trailing_silence_start_secs.unwrap();
        assert!(end > 299.0 && end <= 300.0, "end {end}");
        let phase = analysis.beat_phase_secs.unwrap();
        assert!(phase >= 250.0 && phase < 251.0, "phase {phase}");
        let db = analysis.downbeat_at_or_before(299.0).unwrap();
        assert!(db <= 299.0 && db > 296.0);
        assert!(analysis.mean_energy(260.0, 270.0) > 0.05);
    }

    #[test]
    fn fold_bpm_moves_octave_errors_into_range() {
        assert_eq!(fold_bpm(256.0), 128.0);
        assert_eq!(fold_bpm(64.0), 128.0);
        assert_eq!(fold_bpm(100.0), 100.0);
    }
}
