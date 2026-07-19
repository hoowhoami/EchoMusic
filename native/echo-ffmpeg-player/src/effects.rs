use ffmpeg_audio::{AudioReader, ResampleOptions};
use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use std::collections::VecDeque;
use std::fs::File;
use std::sync::Arc;

const EQ_FREQUENCIES: [f32; 10] = [
    60.0, 170.0, 310.0, 600.0, 1_000.0, 3_000.0, 6_000.0, 12_000.0, 14_000.0, 16_000.0,
];
pub const EQ_BAND_COUNT: usize = EQ_FREQUENCIES.len();
pub const DEFAULT_SPATIAL_MIX: f32 = 0.15;
const EQ_Q: f32 = 1.414;
const CONVOLUTION_BLOCK_SIZE: usize = 1024;
const MAX_IR_SECONDS: f32 = 8.0;
const IR_TRIM_THRESHOLD: f32 = 0.00003;

#[derive(Clone, Debug)]
pub struct DspSettings {
    pub equalizer: [f32; 10],
    pub normalization_gain_db: f32,
    pub speed: f32,
    pub spatial: Option<PreparedSpatialEffect>,
}

impl Default for DspSettings {
    fn default() -> Self {
        Self {
            equalizer: [0.0; 10],
            normalization_gain_db: 0.0,
            speed: 1.0,
            spatial: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct PreparedSpatialEffect {
    pub file_path: String,
    pub mix: f32,
    sample_rate: u32,
    left: Arc<PreparedImpulseChannel>,
    right: Arc<PreparedImpulseChannel>,
}

#[derive(Debug)]
struct PreparedImpulseChannel {
    partitions: Vec<Vec<Complex32>>,
    block_size: usize,
    fft_size: usize,
}

pub struct DspChain {
    settings: DspSettings,
    gain_linear: f32,
    eq_headroom_linear: f32,
    eq: StereoEqualizer,
    spatial: Option<SpatialEffect>,
}

impl DspChain {
    pub fn new(sample_rate: u32, settings: &DspSettings) -> Self {
        Self {
            settings: settings.clone(),
            gain_linear: db_to_gain(settings.normalization_gain_db),
            eq_headroom_linear: eq_headroom_gain(&settings.equalizer),
            eq: StereoEqualizer::new(sample_rate, &settings.equalizer),
            spatial: settings
                .spatial
                .as_ref()
                .filter(|spatial| spatial.sample_rate == sample_rate)
                .map(SpatialEffect::new),
        }
    }

    pub fn update_settings(&mut self, settings: &DspSettings) {
        let sample_rate = self.eq.sample_rate;
        let eq_changed = self.settings.equalizer != settings.equalizer;
        let spatial_changed = spatial_resource_identity(&self.settings.spatial)
            != spatial_resource_identity(&settings.spatial);

        self.settings = settings.clone();
        self.gain_linear = db_to_gain(settings.normalization_gain_db);
        if eq_changed {
            self.eq_headroom_linear = eq_headroom_gain(&settings.equalizer);
            self.eq = StereoEqualizer::new(sample_rate, &settings.equalizer);
        }
        if spatial_changed {
            self.spatial = settings
                .spatial
                .as_ref()
                .filter(|spatial| spatial.sample_rate == sample_rate)
                .map(SpatialEffect::new);
        } else if let (Some(active), Some(next)) =
            (self.spatial.as_mut(), settings.spatial.as_ref())
        {
            active.set_mix(next.mix);
        }
    }

    pub fn process_interleaved(&mut self, samples: &mut [f32]) {
        self.eq.process_interleaved(samples);
        if (self.eq_headroom_linear - 1.0).abs() >= f32::EPSILON {
            for sample in samples.iter_mut() {
                *sample *= self.eq_headroom_linear;
            }
        }
        if let Some(spatial) = self.spatial.as_mut() {
            spatial.process_interleaved(samples);
        }
        for sample in samples {
            if (self.gain_linear - 1.0).abs() >= f32::EPSILON {
                *sample = (*sample * self.gain_linear).clamp(-1.0, 1.0);
            }
            *sample = sample.clamp(-1.0, 1.0);
        }
    }

    pub fn set_spatial_mix(&mut self, mix: f32) {
        let mix = clamp_spatial_mix(mix);
        if let Some(spatial) = self.settings.spatial.as_mut() {
            spatial.mix = mix;
        }
        if let Some(spatial) = self.spatial.as_mut() {
            spatial.set_mix(mix);
        }
    }
}

impl PreparedSpatialEffect {
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

pub fn prepare_spatial_effect(
    file_path: &str,
    mix: f32,
    sample_rate: u32,
) -> Result<PreparedSpatialEffect, String> {
    let mix = clamp_spatial_mix(mix);
    let file = File::open(file_path)
        .map_err(|err| format!("failed to open impulse response file: {err}"))?;
    let mut reader = AudioReader::new(file)
        .map_err(|err| format!("failed to decode impulse response file: {err}"))?;
    let mut resampler = reader
        .build_resampler(
            ResampleOptions::new()
                .sample_rate(sample_rate as i32)
                .channels(2)
                .format::<f32>(),
        )
        .map_err(|err| format!("failed to create impulse response resampler: {err}"))?;

    let max_samples = (sample_rate as f32 * MAX_IR_SECONDS) as usize * 2;
    let mut interleaved = Vec::<f32>::new();
    loop {
        let frame = reader
            .receive_frame()
            .map_err(|err| format!("failed to read impulse response frame: {err}"))?;
        let has_output = resampler
            .process::<f32>(frame.as_ref())
            .map_err(|err| format!("failed to resample impulse response frame: {err}"))?;
        if has_output {
            interleaved.extend_from_slice(resampler.output_as::<f32>());
            if interleaved.len() >= max_samples {
                interleaved.truncate(max_samples);
                break;
            }
        }
        if frame.is_none() {
            break;
        }
    }

    if interleaved.is_empty() {
        return Err("impulse response file did not contain audio samples".to_string());
    }

    trim_impulse_response(&mut interleaved);
    normalize_impulse_response(&mut interleaved);

    let (left, right) = split_stereo(&interleaved);
    Ok(PreparedSpatialEffect {
        file_path: file_path.to_string(),
        mix,
        sample_rate,
        left: Arc::new(PreparedImpulseChannel::new(&left)),
        right: Arc::new(PreparedImpulseChannel::new(&right)),
    })
}

pub fn clamp_spatial_mix(mix: f32) -> f32 {
    if !mix.is_finite() {
        return DEFAULT_SPATIAL_MIX;
    }
    mix.clamp(0.0, 1.0)
}

fn spatial_resource_identity(spatial: &Option<PreparedSpatialEffect>) -> Option<(&str, u32)> {
    spatial
        .as_ref()
        .map(|spatial| (spatial.file_path.as_str(), spatial.sample_rate))
}

fn trim_impulse_response(samples: &mut Vec<f32>) {
    let frames = samples.len() / 2;
    let mut last_active = 0usize;
    for frame in 0..frames {
        let left = samples[frame * 2].abs();
        let right = samples[frame * 2 + 1].abs();
        if left.max(right) >= IR_TRIM_THRESHOLD {
            last_active = frame;
        }
    }
    let keep_frames = (last_active + 1).max(1);
    samples.truncate(keep_frames * 2);
}

fn normalize_impulse_response(samples: &mut [f32]) {
    let (left_energy, right_energy) = samples
        .chunks_exact(2)
        .fold((0.0f32, 0.0f32), |(left, right), frame| {
            (left + frame[0] * frame[0], right + frame[1] * frame[1])
        });
    let energy = left_energy.sqrt().max(right_energy.sqrt());
    if energy <= f32::EPSILON {
        return;
    }
    let gain = (1.0 / energy).min(8.0);
    for sample in samples {
        *sample *= gain;
    }
}

fn split_stereo(samples: &[f32]) -> (Vec<f32>, Vec<f32>) {
    let mut left = Vec::with_capacity(samples.len() / 2);
    let mut right = Vec::with_capacity(samples.len() / 2);
    for frame in samples.chunks_exact(2) {
        left.push(frame[0]);
        right.push(frame[1]);
    }
    (left, right)
}

struct StereoEqualizer {
    sample_rate: u32,
    left: Vec<Biquad>,
    right: Vec<Biquad>,
}

impl StereoEqualizer {
    fn new(sample_rate: u32, gains: &[f32; 10]) -> Self {
        Self {
            sample_rate,
            left: make_eq_filters(sample_rate, gains),
            right: make_eq_filters(sample_rate, gains),
        }
    }

    fn process_interleaved(&mut self, samples: &mut [f32]) {
        for frame in samples.chunks_exact_mut(2) {
            let mut left = frame[0];
            let mut right = frame[1];
            for filter in &mut self.left {
                left = filter.process(left);
            }
            for filter in &mut self.right {
                right = filter.process(right);
            }
            frame[0] = left;
            frame[1] = right;
        }
    }
}

fn make_eq_filters(sample_rate: u32, gains: &[f32; 10]) -> Vec<Biquad> {
    EQ_FREQUENCIES
        .iter()
        .zip(gains.iter())
        .filter_map(|(frequency, gain)| {
            let nyquist = sample_rate as f32 * 0.5;
            if *frequency >= nyquist || gain.abs() < 0.05 {
                return None;
            }
            Some(Biquad::peaking(sample_rate as f32, *frequency, EQ_Q, *gain))
        })
        .collect()
}

#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn peaking(sample_rate: f32, frequency: f32, q: f32, gain_db: f32) -> Self {
        let a = 10.0f32.powf(gain_db / 40.0);
        let omega = 2.0 * std::f32::consts::PI * frequency / sample_rate;
        let sin = omega.sin();
        let cos = omega.cos();
        let alpha = sin / (2.0 * q);

        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cos;
        let a2 = 1.0 - alpha / a;

        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn process(&mut self, sample: f32) -> f32 {
        let out = self.b0 * sample + self.z1;
        self.z1 = self.b1 * sample - self.a1 * out + self.z2;
        self.z2 = self.b2 * sample - self.a2 * out;
        out.clamp(-4.0, 4.0)
    }
}

struct SpatialEffect {
    mix: f32,
    left: PartitionedConvolver,
    right: PartitionedConvolver,
}

impl SpatialEffect {
    fn new(prepared: &PreparedSpatialEffect) -> Self {
        Self {
            mix: prepared.mix,
            left: PartitionedConvolver::new(prepared.left.clone()),
            right: PartitionedConvolver::new(prepared.right.clone()),
        }
    }

    fn process_interleaved(&mut self, samples: &mut [f32]) {
        if self.mix <= 0.0 {
            return;
        }
        let wet = self.mix;
        let dry = 1.0 - wet;
        for frame in samples.chunks_exact_mut(2) {
            let left = frame[0];
            let right = frame[1];
            let wet_left = self.left.process_sample(left);
            let wet_right = self.right.process_sample(right);
            frame[0] = (left * dry + wet_left * wet).clamp(-1.0, 1.0);
            frame[1] = (right * dry + wet_right * wet).clamp(-1.0, 1.0);
        }
    }

    fn set_mix(&mut self, mix: f32) {
        self.mix = clamp_spatial_mix(mix);
    }
}

struct PartitionedConvolver {
    prepared: Arc<PreparedImpulseChannel>,
    forward: Arc<dyn Fft<f32>>,
    inverse: Arc<dyn Fft<f32>>,
    input_spectra: Vec<Vec<Complex32>>,
    input_fft: Vec<Complex32>,
    input_block: Vec<f32>,
    overlap: Vec<f32>,
    scratch: Vec<Complex32>,
    output: VecDeque<f32>,
    write_pos: usize,
}

impl PartitionedConvolver {
    fn new(prepared: Arc<PreparedImpulseChannel>) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let forward = planner.plan_fft_forward(prepared.fft_size);
        let inverse = planner.plan_fft_inverse(prepared.fft_size);
        let partitions = prepared.partitions.len().max(1);
        Self {
            input_spectra: vec![vec![Complex32::ZERO; prepared.fft_size]; partitions],
            input_fft: vec![Complex32::ZERO; prepared.fft_size],
            input_block: Vec::with_capacity(prepared.block_size),
            overlap: vec![0.0; prepared.block_size],
            scratch: vec![Complex32::ZERO; prepared.fft_size],
            output: VecDeque::with_capacity(prepared.block_size * 2),
            write_pos: 0,
            prepared,
            forward,
            inverse,
        }
    }

    fn process_sample(&mut self, sample: f32) -> f32 {
        self.input_block.push(sample);
        if self.input_block.len() == self.prepared.block_size {
            self.process_block();
            self.input_block.clear();
        }
        self.output.pop_front().unwrap_or(0.0)
    }

    fn process_block(&mut self) {
        if self.prepared.partitions.is_empty() {
            self.output.extend(self.input_block.iter().copied());
            return;
        }

        let fft_size = self.prepared.fft_size;
        let block_size = self.prepared.block_size;
        self.input_fft.fill(Complex32::ZERO);
        for (target, sample) in self
            .input_fft
            .iter_mut()
            .zip(self.input_block.iter().copied())
        {
            target.re = sample;
        }
        self.forward.process(&mut self.input_fft);
        std::mem::swap(&mut self.input_spectra[self.write_pos], &mut self.input_fft);

        self.scratch.fill(Complex32::ZERO);
        for (partition_index, partition) in self.prepared.partitions.iter().enumerate() {
            let input_index = (self.write_pos + self.input_spectra.len() - partition_index)
                % self.input_spectra.len();
            for ((acc, input), impulse) in self
                .scratch
                .iter_mut()
                .zip(self.input_spectra[input_index].iter())
                .zip(partition.iter())
            {
                *acc += *input * *impulse;
            }
        }

        self.inverse.process(&mut self.scratch);
        let scale = 1.0 / fft_size as f32;
        for index in 0..block_size {
            let value = self.scratch[index].re * scale + self.overlap[index];
            self.output.push_back(value);
        }
        for index in 0..block_size {
            self.overlap[index] = self.scratch[index + block_size].re * scale;
        }
        self.write_pos = (self.write_pos + 1) % self.input_spectra.len();
    }
}

impl PreparedImpulseChannel {
    fn new(samples: &[f32]) -> Self {
        let block_size = CONVOLUTION_BLOCK_SIZE;
        let fft_size = block_size * 2;
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(fft_size);
        let mut partitions = Vec::new();

        for chunk in samples.chunks(block_size) {
            let mut partition = vec![Complex32::ZERO; fft_size];
            for (target, sample) in partition.iter_mut().zip(chunk.iter().copied()) {
                target.re = sample;
            }
            fft.process(&mut partition);
            partitions.push(partition);
        }

        Self {
            partitions,
            block_size,
            fft_size,
        }
    }
}

fn db_to_gain(db: f32) -> f32 {
    10.0f32.powf(db / 20.0)
}

fn eq_headroom_gain(gains: &[f32; 10]) -> f32 {
    let max_boost = gains.iter().copied().fold(0.0f32, f32::max);
    db_to_gain(-max_boost.max(0.0))
}
