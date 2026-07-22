use soundtouch_rs::{InterpolationAlgorithm, SoundTouch, SoundTouchPreset};

#[cfg(test)]
const TEST_CHANNELS: usize = 2;
const OUTPUT_CHUNK_FRAMES: usize = 2048;
pub const MIN_SPEED: f32 = 0.1;
pub const MAX_SPEED: f32 = 5.0;

pub fn normalize_speed(value: f64) -> f32 {
    value.clamp(MIN_SPEED as f64, MAX_SPEED as f64) as f32
}

pub struct TempoProcessor {
    speed: f32,
    channels: usize,
    engine: SoundTouch,
    input_planar: Vec<Vec<f32>>,
    output_planar: Vec<Vec<f32>>,
}

impl TempoProcessor {
    pub fn new(speed: f32, sample_rate: u32, channels: usize) -> Result<Self, String> {
        let speed = speed.clamp(MIN_SPEED, MAX_SPEED);
        let channels = channels.max(1);
        let mut engine = SoundTouch::builder(channels, sample_rate.max(1) as usize)
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
        Ok(Self {
            speed,
            channels,
            engine,
            input_planar: vec![Vec::new(); channels],
            output_planar: vec![vec![0.0; OUTPUT_CHUNK_FRAMES]; channels],
        })
    }

    pub fn set_speed(&mut self, speed: f32) -> Result<(), String> {
        let next = speed.clamp(MIN_SPEED, MAX_SPEED);
        if (self.speed - next).abs() < f32::EPSILON {
            return Ok(());
        }
        self.speed = next;
        self.engine.set_tempo(next as f64);
        self.engine.set_pitch(1.0);
        self.engine.set_rate(1.0);
        self.engine
            .clear()
            .map_err(|err| format!("failed to clear tempo processor: {err}"))
    }

    pub fn speed(&self) -> f32 {
        self.speed
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
            return Ok(());
        }

        self.push_interleaved(samples)?;
        self.pull_available(output)
    }

    pub fn finish_into(&mut self, output: &mut Vec<f32>) -> Result<(), String> {
        output.clear();
        if (self.speed - 1.0).abs() < 0.001 {
            return Ok(());
        }
        self.engine
            .flush()
            .map_err(|err| format!("failed to flush tempo processor: {err}"))?;
        let result = self.pull_available(output);
        let _ = self.engine.clear();
        result
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
        self.engine
            .put_samples(&self.input_planar)
            .map_err(|err| format!("failed to process tempo input: {err}"))
    }

    fn pull_available(&mut self, output: &mut Vec<f32>) -> Result<(), String> {
        loop {
            let frames = self
                .engine
                .receive_samples(&mut self.output_planar)
                .map_err(|err| format!("failed to read tempo output: {err}"))?;
            if frames == 0 {
                return Ok(());
            }
            output.reserve(frames * self.channels);
            for index in 0..frames {
                for channel in 0..self.channels {
                    output.push(self.output_planar[channel][index]);
                }
            }
        }
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
}
