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

impl DspSettings {
    pub fn requires_stereo_graph(&self) -> bool {
        self.spatial.is_some()
    }
}

#[derive(Clone, Debug)]
pub struct PreparedSpatialEffect {
    pub file_path: String,
    pub mix: f32,
    sample_rate: u32,
    channels: usize,
    responses: Vec<Arc<PreparedImpulseChannel>>,
}

#[derive(Debug)]
struct PreparedImpulseChannel {
    partitions: Vec<Vec<Complex32>>,
    block_size: usize,
    fft_size: usize,
}

pub struct DspChain {
    settings: DspSettings,
    channels: usize,
    gain_linear: f32,
    eq_headroom_linear: f32,
    eq: MultichannelEqualizer,
    spatial: Option<SpatialEffect>,
}

impl DspChain {
    pub fn new(sample_rate: u32, channels: usize, settings: &DspSettings) -> Self {
        let channels = channels.max(1);
        Self {
            settings: settings.clone(),
            channels,
            gain_linear: db_to_gain(settings.normalization_gain_db),
            eq_headroom_linear: eq_headroom_gain(&settings.equalizer),
            eq: MultichannelEqualizer::new(sample_rate, channels, &settings.equalizer),
            spatial: settings
                .spatial
                .as_ref()
                .filter(|spatial| channels == 2 && spatial.sample_rate == sample_rate)
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
            self.eq = MultichannelEqualizer::new(sample_rate, self.channels, &settings.equalizer);
        }
        if spatial_changed {
            self.spatial = settings
                .spatial
                .as_ref()
                .filter(|spatial| self.channels == 2 && spatial.sample_rate == sample_rate)
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
        if self.channels == 2 {
            if let Some(spatial) = self.spatial.as_mut() {
                spatial.process_interleaved(samples);
            }
        }
        for sample in samples {
            if (self.gain_linear - 1.0).abs() >= f32::EPSILON {
                *sample *= self.gain_linear;
            }
        }
    }

    pub fn latency_secs(&self) -> f64 {
        self.spatial
            .as_ref()
            .map(|spatial| spatial.latency_frames() as f64 / f64::from(self.eq.sample_rate.max(1)))
            .unwrap_or_default()
    }
}

impl PreparedSpatialEffect {
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    pub fn mode(&self) -> &'static str {
        if self.channels >= 4 {
            "true-stereo"
        } else {
            "stereo"
        }
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
    let source_channels = usize::try_from(reader.source_info().channels)
        .ok()
        .filter(|channels| *channels > 0)
        .unwrap_or(2);
    let ir_channels = if source_channels >= 4 { 4 } else { 2 };
    let mut resampler = reader
        .build_resampler(
            ResampleOptions::new()
                .sample_rate(sample_rate as i32)
                .channels(ir_channels as i32)
                .format::<f32>(),
        )
        .map_err(|err| format!("failed to create impulse response resampler: {err}"))?;

    let max_samples = (sample_rate as f32 * MAX_IR_SECONDS) as usize * ir_channels;
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

    trim_impulse_response(&mut interleaved, ir_channels);
    normalize_impulse_response(&mut interleaved, ir_channels);

    let responses = split_impulse_channels(&interleaved, ir_channels)
        .into_iter()
        .map(|channel| Arc::new(PreparedImpulseChannel::new(&channel)))
        .collect();
    Ok(PreparedSpatialEffect {
        file_path: file_path.to_string(),
        mix,
        sample_rate,
        channels: ir_channels,
        responses,
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

fn trim_impulse_response(samples: &mut Vec<f32>, channels: usize) {
    let channels = channels.max(1);
    let frames = samples.len() / channels;
    let mut last_active = 0usize;
    for frame in 0..frames {
        let frame_start = frame * channels;
        let peak = samples
            .get(frame_start..frame_start + channels)
            .unwrap_or(&[])
            .iter()
            .copied()
            .map(f32::abs)
            .fold(0.0, f32::max);
        if peak >= IR_TRIM_THRESHOLD {
            last_active = frame;
        }
    }
    let keep_frames = (last_active + 1).max(1);
    samples.truncate(keep_frames * channels);
}

fn normalize_impulse_response(samples: &mut [f32], channels: usize) {
    let channels = channels.max(1);
    let mut channel_energy = vec![0.0f32; channels];
    for frame in samples.chunks_exact(channels) {
        for (channel, sample) in frame.iter().copied().enumerate() {
            channel_energy[channel] += sample * sample;
        }
    }
    let energy = channel_energy
        .into_iter()
        .map(f32::sqrt)
        .fold(0.0f32, f32::max);
    if energy <= f32::EPSILON {
        return;
    }
    let gain = (1.0 / energy).min(8.0);
    for sample in samples {
        *sample *= gain;
    }
}

fn split_impulse_channels(samples: &[f32], channels: usize) -> Vec<Vec<f32>> {
    let channels = channels.max(1);
    let mut output = (0..channels)
        .map(|_| Vec::with_capacity(samples.len() / channels))
        .collect::<Vec<_>>();
    for frame in samples.chunks_exact(channels) {
        for (channel, sample) in frame.iter().copied().enumerate() {
            output[channel].push(sample);
        }
    }
    output
}

struct MultichannelEqualizer {
    sample_rate: u32,
    channels: usize,
    filters: Vec<Vec<Biquad>>,
}

impl MultichannelEqualizer {
    fn new(sample_rate: u32, channels: usize, gains: &[f32; 10]) -> Self {
        let channels = channels.max(1);
        Self {
            sample_rate,
            channels,
            filters: (0..channels)
                .map(|_| make_eq_filters(sample_rate, gains))
                .collect(),
        }
    }

    fn process_interleaved(&mut self, samples: &mut [f32]) {
        if self.filters.iter().all(Vec::is_empty) {
            return;
        }
        for frame in samples.chunks_exact_mut(self.channels) {
            for (channel, sample) in frame.iter_mut().enumerate() {
                let mut value = *sample;
                for filter in &mut self.filters[channel] {
                    value = filter.process(value);
                }
                *sample = value;
            }
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
    channels: usize,
    convolvers: Vec<PartitionedConvolver>,
}

impl SpatialEffect {
    fn new(prepared: &PreparedSpatialEffect) -> Self {
        Self {
            mix: prepared.mix,
            channels: prepared.channels,
            convolvers: prepared
                .responses
                .iter()
                .cloned()
                .map(PartitionedConvolver::new)
                .collect(),
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
            let (wet_left, wet_right) = if self.channels >= 4 && self.convolvers.len() >= 4 {
                (
                    self.convolvers[0].process_sample(left)
                        + self.convolvers[2].process_sample(right),
                    self.convolvers[1].process_sample(left)
                        + self.convolvers[3].process_sample(right),
                )
            } else if self.convolvers.len() >= 2 {
                (
                    self.convolvers[0].process_sample(left),
                    self.convolvers[1].process_sample(right),
                )
            } else if let Some(convolver) = self.convolvers.first_mut() {
                let wet_left = convolver.process_sample(left);
                (wet_left, wet_left)
            } else {
                (left, right)
            };
            frame[0] = left * dry + wet_left * wet;
            frame[1] = right * dry + wet_right * wet;
        }
    }

    fn set_mix(&mut self, mix: f32) {
        self.mix = clamp_spatial_mix(mix);
    }

    fn latency_frames(&self) -> usize {
        if self.mix <= 0.0 {
            0
        } else {
            self.convolvers
                .iter()
                .map(PartitionedConvolver::latency_frames)
                .max()
                .unwrap_or_default()
        }
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

    fn latency_frames(&self) -> usize {
        if self.prepared.partitions.is_empty() {
            0
        } else {
            self.prepared.block_size
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared_spatial(channels: usize, responses: &[&[f32]]) -> PreparedSpatialEffect {
        PreparedSpatialEffect {
            file_path: "test.irs".to_string(),
            mix: 1.0,
            sample_rate: 48_000,
            channels,
            responses: responses
                .iter()
                .map(|response| Arc::new(PreparedImpulseChannel::new(response)))
                .collect(),
        }
    }

    fn rms(samples: &[f32]) -> f32 {
        let energy = samples.iter().map(|sample| sample * sample).sum::<f32>();
        (energy / samples.len().max(1) as f32).sqrt()
    }

    #[test]
    fn equalizer_changes_target_band_energy() {
        let sample_rate = 48_000;
        let mut settings = DspSettings::default();
        settings.equalizer[4] = -12.0;
        let mut chain = DspChain::new(sample_rate, 2, &settings);
        let frames = sample_rate as usize / 20;
        let mut samples = Vec::with_capacity(frames * 2);
        for frame in 0..frames {
            let value = (2.0 * std::f32::consts::PI * 1_000.0 * frame as f32 / sample_rate as f32)
                .sin()
                * 0.25;
            samples.push(value);
            samples.push(value);
        }
        let before = rms(&samples);

        chain.process_interleaved(&mut samples);

        assert!(rms(&samples) < before * 0.75);
    }

    #[test]
    fn spatial_impulse_response_adds_wet_signal() {
        let prepared = prepared_spatial(2, &[&[1.0], &[1.0]]);
        let mut spatial = SpatialEffect::new(&prepared);
        let mut samples = vec![0.0f32; CONVOLUTION_BLOCK_SIZE * 2];
        samples[0] = 0.5;
        samples[1] = -0.25;

        spatial.process_interleaved(&mut samples);

        let delayed_frame = (CONVOLUTION_BLOCK_SIZE - 1) * 2;
        assert!((samples[delayed_frame] - 0.5).abs() < 0.00001);
        assert!((samples[delayed_frame + 1] + 0.25).abs() < 0.00001);
    }

    #[test]
    fn true_stereo_impulse_response_routes_cross_channels() {
        let prepared = prepared_spatial(4, &[&[1.0], &[0.25], &[0.5], &[1.0]]);
        let mut spatial = SpatialEffect::new(&prepared);
        let mut samples = vec![0.0f32; CONVOLUTION_BLOCK_SIZE * 2];
        samples[0] = 0.4;
        samples[1] = 0.2;

        spatial.process_interleaved(&mut samples);

        let delayed_frame = (CONVOLUTION_BLOCK_SIZE - 1) * 2;
        assert!((samples[delayed_frame] - 0.5).abs() < 0.00001);
        assert!((samples[delayed_frame + 1] - 0.3).abs() < 0.00001);
    }
}
