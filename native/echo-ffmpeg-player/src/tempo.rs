use soundtouch_rs::{
    InterpolationAlgorithm, SoundTouch, SoundTouchPreset, SpectralPreset, SpectralStretch,
};

#[cfg(test)]
const TEST_CHANNELS: usize = 2;
const OUTPUT_CHUNK_FRAMES: usize = 2048;
const ENGINE_SWITCH_CROSSFADE_SECS: f64 = 0.02;
/// Bound the audible delay introduced by draining an old, very-slow engine.
const MAX_ENGINE_SWITCH_TAIL_SECS: f64 = 0.2;
pub const MIN_SPEED: f32 = 0.1;
pub const MAX_SPEED: f32 = 5.0;

/// Below this speed the spectral (phase vocoder) engine is always used.
const SPECTRAL_LOWER_BOUND: f32 = 0.5;
/// Above this speed the spectral (phase vocoder) engine is always used.
const SPECTRAL_UPPER_BOUND: f32 = 2.0;
/// Back inside this range the cheaper WSOLA engine is restored (hysteresis).
const WSOLA_LOWER_BOUND: f32 = 0.7;
const WSOLA_UPPER_BOUND: f32 = 1.5;

pub fn normalize_speed(value: f64) -> f32 {
    value.clamp(MIN_SPEED as f64, MAX_SPEED as f64) as f32
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StretchKind {
    Wsola,
    Spectral,
}

fn desired_stretch(speed: f32, current: StretchKind) -> StretchKind {
    if speed <= SPECTRAL_LOWER_BOUND || speed >= SPECTRAL_UPPER_BOUND {
        StretchKind::Spectral
    } else if (WSOLA_LOWER_BOUND..=WSOLA_UPPER_BOUND).contains(&speed) {
        StretchKind::Wsola
    } else {
        current
    }
}

fn initial_stretch(speed: f32) -> StretchKind {
    if (WSOLA_LOWER_BOUND..=WSOLA_UPPER_BOUND).contains(&speed) {
        StretchKind::Wsola
    } else {
        StretchKind::Spectral
    }
}

enum StretchEngine {
    Wsola(SoundTouch),
    Spectral(SpectralStretch),
}

impl StretchEngine {
    fn build(
        kind: StretchKind,
        speed: f32,
        sample_rate: usize,
        channels: usize,
    ) -> Result<Self, String> {
        match kind {
            StretchKind::Wsola => {
                let mut engine = SoundTouch::builder(channels, sample_rate)
                    .tempo(speed as f64)
                    .pitch(1.0)
                    .rate(1.0)
                    .preset(SoundTouchPreset::Music)
                    .interpolation_algo(InterpolationAlgorithm::Shannon)
                    .build()
                    .map_err(|err| format!("failed to create tempo processor: {err}"))?;
                if (speed - 1.0).abs() < 0.001 {
                    engine
                        .clear()
                        .map_err(|err| format!("failed to clear tempo processor: {err}"))?;
                }
                Ok(Self::Wsola(engine))
            }
            StretchKind::Spectral => {
                let engine = SpectralStretch::builder(channels, sample_rate)
                    .preset(SpectralPreset::Default)
                    .tempo(speed as f64)
                    .pitch(1.0)
                    .build()
                    .map_err(|err| format!("failed to create spectral tempo processor: {err}"))?;
                Ok(Self::Spectral(engine))
            }
        }
    }

    fn kind(&self) -> StretchKind {
        match self {
            Self::Wsola(_) => StretchKind::Wsola,
            Self::Spectral(_) => StretchKind::Spectral,
        }
    }

    fn set_tempo(&mut self, tempo: f64) {
        match self {
            Self::Wsola(engine) => {
                engine.set_tempo(tempo);
            }
            Self::Spectral(engine) => engine.set_tempo(tempo),
        }
    }

    fn clear(&mut self) -> Result<(), String> {
        match self {
            Self::Wsola(engine) => engine
                .clear()
                .map_err(|err| format!("failed to clear tempo processor: {err}")),
            Self::Spectral(engine) => engine
                .clear()
                .map_err(|err| format!("failed to clear tempo processor: {err}")),
        }
    }

    fn flush(&mut self) -> Result<(), String> {
        match self {
            Self::Wsola(engine) => engine
                .flush()
                .map_err(|err| format!("failed to flush tempo processor: {err}")),
            Self::Spectral(engine) => engine
                .flush()
                .map_err(|err| format!("failed to flush tempo processor: {err}")),
        }
    }

    fn put_samples(&mut self, samples: &[Vec<f32>]) -> Result<(), String> {
        match self {
            Self::Wsola(engine) => engine
                .put_samples(samples)
                .map_err(|err| format!("failed to process tempo input: {err}")),
            Self::Spectral(engine) => engine
                .put_samples(samples)
                .map_err(|err| format!("failed to process tempo input: {err}")),
        }
    }

    fn receive_samples(&mut self, output: &mut [Vec<f32>]) -> Result<usize, String> {
        match self {
            Self::Wsola(engine) => engine
                .receive_samples(output)
                .map_err(|err| format!("failed to read tempo output: {err}")),
            Self::Spectral(engine) => engine
                .receive_samples(output)
                .map_err(|err| format!("failed to read tempo output: {err}")),
        }
    }

    /// Pipeline latency in frames, reported by the active engine.
    fn initial_latency(&self) -> usize {
        match self {
            Self::Wsola(engine) => engine.initial_latency(),
            Self::Spectral(engine) => engine.initial_latency(),
        }
    }
}

pub struct TempoProcessor {
    speed: f32,
    channels: usize,
    sample_rate: usize,
    engine: StretchEngine,
    /// Built on the first engine switch, then retained for subsequent switches.
    standby_engine: Option<StretchEngine>,
    engine_has_input: bool,
    transition_tail: Vec<f32>,
    input_planar: Vec<Vec<f32>>,
    output_planar: Vec<Vec<f32>>,
}

impl TempoProcessor {
    pub fn new(speed: f32, sample_rate: u32, channels: usize) -> Result<Self, String> {
        let speed = speed.clamp(MIN_SPEED, MAX_SPEED);
        let channels = channels.max(1);
        let sample_rate = sample_rate.max(1) as usize;
        let active_kind = initial_stretch(speed);
        let engine = StretchEngine::build(active_kind, speed, sample_rate, channels)?;
        Ok(Self {
            speed,
            channels,
            sample_rate,
            engine,
            standby_engine: None,
            engine_has_input: false,
            transition_tail: Vec::new(),
            input_planar: vec![Vec::new(); channels],
            output_planar: vec![vec![0.0; OUTPUT_CHUNK_FRAMES]; channels],
        })
    }

    pub fn set_speed(&mut self, speed: f32) -> Result<(), String> {
        let next = speed.clamp(MIN_SPEED, MAX_SPEED);
        if (self.speed - next).abs() < f32::EPSILON {
            return Ok(());
        }
        let desired = desired_stretch(next, self.engine.kind());
        let mut transition_tail = Vec::new();

        if desired != self.engine.kind() {
            let mut next_engine = match self.standby_engine.take() {
                Some(engine) if engine.kind() == desired => engine,
                Some(engine) => {
                    self.standby_engine = Some(engine);
                    StretchEngine::build(desired, next, self.sample_rate, self.channels)?
                }
                None => StretchEngine::build(desired, next, self.sample_rate, self.channels)?,
            };
            if let Err(error) = next_engine.clear() {
                self.standby_engine = Some(next_engine);
                return Err(error);
            }
            next_engine.set_tempo(next as f64);

            if self.engine_has_input {
                if let Err(error) = self.engine.flush() {
                    self.standby_engine = Some(next_engine);
                    return Err(error);
                }
                if let Err(error) = Self::pull_engine_available(
                    &mut self.engine,
                    &mut self.output_planar,
                    self.channels,
                    &mut transition_tail,
                ) {
                    self.standby_engine = Some(next_engine);
                    return Err(error);
                }
            }
            let old_engine = std::mem::replace(&mut self.engine, next_engine);
            self.standby_engine = Some(old_engine);
        } else {
            if self.engine_has_input {
                self.engine.flush()?;
                Self::pull_engine_available(
                    &mut self.engine,
                    &mut self.output_planar,
                    self.channels,
                    &mut transition_tail,
                )?;
            }
            self.engine.clear()?;
            self.engine.set_tempo(next as f64);
        }

        self.append_transition_tail(transition_tail);
        self.engine_has_input = false;
        self.speed = next;
        Ok(())
    }

    pub fn speed(&self) -> f32 {
        self.speed
    }

    #[cfg(test)]
    fn stretch_kind(&self) -> StretchKind {
        self.engine.kind()
    }

    pub fn latency_secs(&self, sample_rate: u32) -> f64 {
        if (self.speed - 1.0).abs() < 0.001 {
            0.0
        } else {
            self.engine.initial_latency() as f64 / f64::from(sample_rate.max(1))
        }
    }

    pub fn process_into(&mut self, samples: &[f32], output: &mut Vec<f32>) -> Result<(), String> {
        output.clear();
        if (self.speed - 1.0).abs() < 0.001 {
            output.extend_from_slice(samples);
            self.merge_transition(output, false);
            return Ok(());
        }

        self.push_interleaved(samples)?;
        self.engine_has_input |= !samples.is_empty();
        self.pull_available(output)?;
        self.merge_transition(output, false);
        Ok(())
    }

    pub fn finish_into(&mut self, output: &mut Vec<f32>) -> Result<(), String> {
        output.clear();
        if (self.speed - 1.0).abs() < 0.001 {
            self.merge_transition(output, true);
            return Ok(());
        }
        self.engine.flush()?;
        self.pull_available(output)?;
        self.merge_transition(output, true);
        self.engine.clear()?;
        self.engine_has_input = false;
        Ok(())
    }

    fn push_interleaved(&mut self, samples: &[f32]) -> Result<(), String> {
        let frames = samples.len() / self.channels;
        for channel in &mut self.input_planar {
            channel.clear();
            channel.reserve(frames);
        }
        for frame in samples.chunks_exact(self.channels) {
            for (channel, sample) in frame.iter().copied().enumerate() {
                self.input_planar[channel].push(sample);
            }
        }
        self.engine.put_samples(&self.input_planar)
    }

    fn pull_available(&mut self, output: &mut Vec<f32>) -> Result<(), String> {
        Self::pull_engine_available(
            &mut self.engine,
            &mut self.output_planar,
            self.channels,
            output,
        )
    }

    fn pull_engine_available(
        engine: &mut StretchEngine,
        output_planar: &mut [Vec<f32>],
        channels: usize,
        output: &mut Vec<f32>,
    ) -> Result<(), String> {
        loop {
            let frames = engine.receive_samples(output_planar)?;
            if frames == 0 {
                return Ok(());
            }
            output.reserve(frames * channels);
            for index in 0..frames {
                for channel in output_planar.iter().take(channels) {
                    output.push(channel[index]);
                }
            }
        }
    }

    fn append_transition_tail(&mut self, tail: Vec<f32>) {
        let max_frames = (self.sample_rate as f64 * MAX_ENGINE_SWITCH_TAIL_SECS).round() as usize;
        let max_samples = max_frames.saturating_mul(self.channels);
        let remaining = max_samples.saturating_sub(self.transition_tail.len());

        // A long slow-tempo drain is valid audio, but delaying the new speed by seconds is worse
        // for interactive playback. Keep the earliest 200 ms and intentionally truncate the rest.
        self.transition_tail
            .extend(tail.into_iter().take(remaining));
    }

    fn merge_transition(&mut self, output: &mut Vec<f32>, force: bool) {
        if self.transition_tail.is_empty() {
            return;
        }
        if output.is_empty() {
            if force {
                output.append(&mut self.transition_tail);
            }
            return;
        }

        let tail_frames = self.transition_tail.len() / self.channels;
        let output_frames = output.len() / self.channels;
        let requested_fade_frames =
            (self.sample_rate as f64 * ENGINE_SWITCH_CROSSFADE_SECS).round() as usize;
        let fade_frames = requested_fade_frames.min(tail_frames).min(output_frames);
        let fade_samples = fade_frames * self.channels;
        let tail_fade_start = self.transition_tail.len() - fade_samples;

        // At tiny synthetic sample rates the rounded fade may be zero; concatenation is intended.
        for frame in 0..fade_frames {
            let mix = (frame + 1) as f32 / (fade_frames + 1) as f32;
            for channel in 0..self.channels {
                let tail_index = tail_fade_start + frame * self.channels + channel;
                let output_index = frame * self.channels + channel;
                self.transition_tail[tail_index] =
                    self.transition_tail[tail_index].mul_add(1.0 - mix, output[output_index] * mix);
            }
        }

        let mut merged = std::mem::take(&mut self.transition_tail);
        merged.extend_from_slice(&output[fade_samples..]);
        *output = merged;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stereo_tone(frames: usize) -> Vec<f32> {
        let mut samples = Vec::with_capacity(frames * TEST_CHANNELS);
        for frame in 0..frames {
            let sample = (frame as f32 * 0.01).sin();
            samples.push(sample);
            samples.push(sample);
        }
        samples
    }

    #[test]
    fn speed_range_matches_legacy_player_ui() {
        assert_eq!(normalize_speed(0.01), MIN_SPEED);
        assert_eq!(normalize_speed(0.1), MIN_SPEED);
        assert_eq!(normalize_speed(5.0), MAX_SPEED);
        assert_eq!(normalize_speed(8.0), MAX_SPEED);

        let low = TempoProcessor::new(0.01, 48_000, TEST_CHANNELS).expect("tempo processor");
        assert!((low.speed() - MIN_SPEED).abs() < f32::EPSILON);
        let high = TempoProcessor::new(8.0, 48_000, TEST_CHANNELS).expect("tempo processor");
        assert!((high.speed() - MAX_SPEED).abs() < f32::EPSILON);
    }

    #[test]
    fn faster_speed_outputs_fewer_frames_after_flush() {
        let mut tempo = TempoProcessor::new(2.0, 48_000, TEST_CHANNELS).expect("tempo processor");
        let mut output = Vec::new();
        tempo
            .process_into(&stereo_tone(48_000), &mut output)
            .expect("process");
        let mut tail = Vec::new();
        tempo.finish_into(&mut tail).expect("finish");
        output.extend(tail);

        assert!(output.len() < 48_000 * TEST_CHANNELS);
        assert_eq!(output.len() % TEST_CHANNELS, 0);
    }

    #[test]
    fn slower_speed_outputs_more_frames_after_flush() {
        let mut tempo = TempoProcessor::new(0.5, 48_000, TEST_CHANNELS).expect("tempo processor");
        let mut output = Vec::new();
        tempo
            .process_into(&stereo_tone(48_000), &mut output)
            .expect("process");
        let mut tail = Vec::new();
        tempo.finish_into(&mut tail).expect("finish");
        output.extend(tail);

        assert!(output.len() > 48_000 * TEST_CHANNELS);
        assert_eq!(output.len() % TEST_CHANNELS, 0);
    }

    #[test]
    fn normal_speed_bypasses_without_latency() {
        let input = stereo_tone(128);
        let mut tempo = TempoProcessor::new(1.0, 48_000, TEST_CHANNELS).expect("tempo processor");
        let mut output = Vec::new();
        tempo.process_into(&input, &mut output).expect("process");

        assert_eq!(output, input);
        assert_eq!(tempo.latency_secs(48_000), 0.0);
    }

    #[test]
    fn tempo_latency_comes_from_soundtouch_pipeline() {
        let tempo = TempoProcessor::new(1.5, 48_000, TEST_CHANNELS).expect("tempo processor");

        assert_eq!(
            tempo.latency_secs(48_000),
            tempo.engine.initial_latency() as f64 / 48_000.0
        );
    }

    #[test]
    fn spectral_latency_comes_from_engine_configuration() {
        let tempo = TempoProcessor::new(2.0, 48_000, TEST_CHANNELS).expect("tempo processor");

        assert_eq!(tempo.stretch_kind(), StretchKind::Spectral);
        assert_eq!(tempo.latency_secs(48_000), 0.15);
    }

    #[test]
    fn spectral_engine_used_at_extreme_speeds() {
        for speed in [MIN_SPEED, 0.4, 2.1, MAX_SPEED] {
            let mut tempo =
                TempoProcessor::new(speed, 48_000, TEST_CHANNELS).expect("tempo processor");
            assert_eq!(
                tempo.stretch_kind(),
                StretchKind::Spectral,
                "speed {speed} should select the spectral engine"
            );
            let mut output = Vec::new();
            tempo
                .process_into(&stereo_tone(48_000), &mut output)
                .expect("process");
            let mut tail = Vec::new();
            tempo.finish_into(&mut tail).expect("finish");
            output.extend(tail);

            assert!(!output.is_empty());
            assert!(output.iter().all(|sample| sample.is_finite()));
            assert_eq!(output.len() % TEST_CHANNELS, 0);
            let output_frames = output.len() / TEST_CHANNELS;
            let expected_frames = (48_000.0 / speed).round() as usize;
            let latency_frames = tempo.engine.initial_latency();
            assert!(
                output_frames >= expected_frames,
                "speed {speed} truncated output: {output_frames} < {expected_frames}"
            );
            assert!(
                output_frames <= expected_frames + latency_frames,
                "speed {speed} added excessive tail: {output_frames}"
            );
        }
    }

    #[test]
    fn wsola_engine_used_near_normal_speed() {
        let tempo = TempoProcessor::new(1.2, 48_000, TEST_CHANNELS).expect("tempo processor");
        assert_eq!(tempo.stretch_kind(), StretchKind::Wsola);
    }

    #[test]
    fn auto_switch_switches_engine_by_speed() {
        let mut tempo = TempoProcessor::new(1.0, 48_000, TEST_CHANNELS).expect("tempo processor");
        assert_eq!(tempo.stretch_kind(), StretchKind::Wsola);
        assert!(tempo.standby_engine.is_none());

        tempo.set_speed(3.0).expect("switch to spectral");
        assert_eq!(tempo.stretch_kind(), StretchKind::Spectral);
        assert_eq!(
            tempo.standby_engine.as_ref().map(StretchEngine::kind),
            Some(StretchKind::Wsola)
        );

        tempo.set_speed(1.0).expect("switch back to wsola");
        assert_eq!(tempo.stretch_kind(), StretchKind::Wsola);
        assert_eq!(
            tempo.standby_engine.as_ref().map(StretchEngine::kind),
            Some(StretchKind::Spectral)
        );
    }

    #[test]
    fn auto_switch_has_hysteresis_band() {
        let mut tempo = TempoProcessor::new(2.2, 48_000, TEST_CHANNELS).expect("tempo processor");
        assert_eq!(tempo.stretch_kind(), StretchKind::Spectral);

        // 1.6 sits between the WSOLA restore bound (1.5) and the spectral bound (2.0):
        // the engine must not flap back to WSOLA.
        tempo.set_speed(1.6).expect("stay in hysteresis band");
        assert_eq!(tempo.stretch_kind(), StretchKind::Spectral);

        tempo.set_speed(1.5).expect("restore wsola");
        assert_eq!(tempo.stretch_kind(), StretchKind::Wsola);
    }

    #[test]
    fn initial_selection_prefers_spectral_in_hysteresis_band() {
        for speed in [0.5, 0.6, 1.6, 2.0] {
            let tempo = TempoProcessor::new(speed, 48_000, TEST_CHANNELS).expect("tempo processor");
            assert_eq!(
                tempo.stretch_kind(),
                StretchKind::Spectral,
                "speed {speed} should start on the spectral engine"
            );
        }
    }

    #[test]
    fn engine_switch_drains_and_crossfades_old_pipeline() {
        let mut tempo = TempoProcessor::new(1.2, 48_000, TEST_CHANNELS).expect("tempo processor");
        let mut first_output = Vec::new();
        tempo
            .process_into(&stereo_tone(24_000), &mut first_output)
            .expect("prime wsola");

        tempo.set_speed(3.0).expect("switch to spectral");
        assert_eq!(tempo.stretch_kind(), StretchKind::Spectral);
        assert!(!tempo.transition_tail.is_empty());

        let mut switched_output = Vec::new();
        tempo
            .process_into(&stereo_tone(48_000), &mut switched_output)
            .expect("process spectral");
        assert!(!switched_output.is_empty());
        assert!(switched_output.iter().all(|sample| sample.is_finite()));
        assert!(tempo.transition_tail.is_empty());
    }

    #[test]
    fn extreme_slow_engine_switch_caps_transition_tail() {
        let mut tempo =
            TempoProcessor::new(MIN_SPEED, 48_000, TEST_CHANNELS).expect("tempo processor");
        let mut output = Vec::new();
        tempo
            .process_into(&stereo_tone(7_200), &mut output)
            .expect("prime spectral engine");

        tempo.set_speed(1.0).expect("switch to wsola");

        let max_tail_frames = (48_000.0 * MAX_ENGINE_SWITCH_TAIL_SECS).round() as usize;
        assert!(!tempo.transition_tail.is_empty());
        assert!(tempo.transition_tail.len() / TEST_CHANNELS <= max_tail_frames);
    }
}
