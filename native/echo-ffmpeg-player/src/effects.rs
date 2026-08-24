use crate::builtin_effects::{BuiltinEffect, BuiltinEffectProcessor};
use crate::vpf::{PreparedVpf, SoftwareLimiter, VpfProcessor};
use ffmpeg_audio::{AudioReader, ResampleOptions};
use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use std::collections::VecDeque;
use std::fs::File;
use std::sync::Arc;

const EQ_FREQUENCIES: [f32; 10] = [
    31.0, 62.0, 125.0, 250.0, 500.0, 1_000.0, 2_000.0, 4_000.0, 8_000.0, 16_000.0,
];
pub const EQ_BAND_COUNT: usize = EQ_FREQUENCIES.len();
const EQ_Q: f32 = 1.414;
const EARLY_CONVOLUTION_BLOCK_SIZE: usize = 256;
const LATE_CONVOLUTION_BLOCK_SIZE: usize = 1024;
const EARLY_CONVOLUTION_FRAMES: usize = 4096;
const MAX_IR_SECONDS: f32 = 8.0;
const IR_TRIM_THRESHOLD: f32 = 0.00003;

#[derive(Clone, Debug)]
pub struct DspSettings {
    pub equalizer: [f32; EQ_BAND_COUNT],
    pub normalization_gain_db: f32,
    pub speed: f32,
    pub builtin: BuiltinEffect,
    pub spatial: Option<PreparedSpatialEffect>,
    pub vpf: Option<PreparedVpf>,
}

impl Default for DspSettings {
    fn default() -> Self {
        Self {
            equalizer: [0.0; EQ_BAND_COUNT],
            normalization_gain_db: 0.0,
            speed: 1.0,
            builtin: BuiltinEffect::None,
            spatial: None,
            vpf: None,
        }
    }
}

impl DspSettings {
    pub fn requires_stereo_graph(&self) -> bool {
        self.builtin.enabled() || self.spatial.is_some() || self.vpf.is_some()
    }

    pub fn normalization_gain_linear(&self) -> f32 {
        db_to_gain(self.normalization_gain_db)
    }
}

#[derive(Clone, Debug)]
pub struct PreparedSpatialEffect {
    pub file_path: String,
    sample_rate: u32,
    channels: usize,
    responses: Vec<Arc<PreparedImpulseChannel>>,
}

#[derive(Debug)]
struct PreparedImpulseChannel {
    segments: Vec<Arc<PreparedImpulseSegment>>,
    latency_frames: usize,
}

#[derive(Debug)]
struct PreparedImpulseSegment {
    partitions: Vec<Vec<Complex32>>,
    block_size: usize,
    fft_size: usize,
    output_delay_frames: usize,
}

pub struct DspChain {
    settings: DspSettings,
    channels: usize,
    eq_headroom_linear: f32,
    eq: MultichannelEqualizer,
    spatial: Option<SpatialEffect>,
    vpf: Option<VpfProcessor>,
    builtin: Option<BuiltinEffectProcessor>,
    spatial_limiters: Option<[SoftwareLimiter; 2]>,
}

impl DspChain {
    pub fn new(sample_rate: u32, channels: usize, settings: &DspSettings) -> Self {
        let channels = channels.max(1);
        Self {
            settings: settings.clone(),
            channels,
            eq_headroom_linear: eq_headroom_gain(&settings.equalizer),
            eq: MultichannelEqualizer::new(sample_rate, channels, &settings.equalizer),
            spatial: settings
                .spatial
                .as_ref()
                .filter(|spatial| channels == 2 && spatial.sample_rate == sample_rate)
                .map(SpatialEffect::new),
            vpf: settings
                .vpf
                .as_ref()
                .filter(|_| channels == 2)
                .map(|vpf| VpfProcessor::new(sample_rate, vpf)),
            builtin: (settings.builtin.enabled() && channels == 2)
                .then(|| BuiltinEffectProcessor::new(sample_rate, settings.builtin)),
            spatial_limiters: (settings.spatial.is_some()
                && settings.vpf.is_none()
                && channels == 2)
                .then(|| std::array::from_fn(|_| SoftwareLimiter::new())),
        }
    }

    pub fn update_settings(&mut self, settings: &DspSettings) {
        let sample_rate = self.eq.sample_rate;
        let eq_changed = self.settings.equalizer != settings.equalizer;
        let spatial_changed = spatial_resource_identity(&self.settings.spatial)
            != spatial_resource_identity(&settings.spatial);
        let vpf_changed = self.settings.vpf != settings.vpf;
        let builtin_changed = self.settings.builtin != settings.builtin;

        self.settings = settings.clone();
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
        }
        if vpf_changed {
            self.vpf = settings
                .vpf
                .as_ref()
                .filter(|_| self.channels == 2)
                .map(|vpf| VpfProcessor::new(sample_rate, vpf));
        }
        if builtin_changed {
            self.builtin = (settings.builtin.enabled() && self.channels == 2)
                .then(|| BuiltinEffectProcessor::new(sample_rate, settings.builtin));
        }
        if spatial_changed || vpf_changed {
            self.spatial_limiters =
                (settings.spatial.is_some() && settings.vpf.is_none() && self.channels == 2)
                    .then(|| std::array::from_fn(|_| SoftwareLimiter::new()));
        }
    }

    pub fn process_interleaved(&mut self, samples: &mut [f32]) {
        if self.vpf.is_none() {
            self.eq.process_interleaved(samples);
            if (self.eq_headroom_linear - 1.0).abs() >= f32::EPSILON {
                for sample in samples.iter_mut() {
                    *sample *= self.eq_headroom_linear;
                }
            }
        }
        if self.channels == 2 {
            if let Some(builtin) = self.builtin.as_mut() {
                builtin.process_interleaved(samples);
            }
            if let Some(spatial) = self.spatial.as_mut() {
                spatial.process_interleaved(samples);
            }
            if let Some(vpf) = self.vpf.as_mut() {
                vpf.process_interleaved(samples);
            } else if let Some(limiters) = self.spatial_limiters.as_mut() {
                for frame in samples.chunks_exact_mut(2) {
                    frame[0] = limiters[0].process(frame[0]);
                    frame[1] = limiters[1].process(frame[1]);
                }
            }
        }
    }

    pub fn owns_output_limiter(&self) -> bool {
        self.builtin.is_some() || self.vpf.is_some() || self.spatial_limiters.is_some()
    }

    pub fn latency_secs(&self) -> f64 {
        self.builtin_latency_secs() + self.spatial_latency_secs() + self.vpf_latency_secs()
    }

    pub fn builtin_latency_secs(&self) -> f64 {
        self.builtin
            .as_ref()
            .map(|builtin| builtin.latency_frames() as f64 / f64::from(self.eq.sample_rate.max(1)))
            .unwrap_or_default()
    }

    pub fn spatial_latency_secs(&self) -> f64 {
        let convolution = self
            .spatial
            .as_ref()
            .map(|spatial| spatial.latency_frames() as f64 / f64::from(self.eq.sample_rate.max(1)))
            .unwrap_or_default();
        let limiter = if self.spatial_limiters.is_some() {
            SoftwareLimiter::LOOKAHEAD as f64 / f64::from(self.eq.sample_rate.max(1))
        } else {
            0.0
        };
        convolution + limiter
    }

    pub fn vpf_latency_secs(&self) -> f64 {
        self.vpf
            .as_ref()
            .map(|vpf| vpf.latency_frames() as f64 / f64::from(self.eq.sample_rate.max(1)))
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
    sample_rate: u32,
) -> Result<PreparedSpatialEffect, String> {
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

    let responses = split_impulse_channels(&interleaved, ir_channels)
        .into_iter()
        .map(|channel| Arc::new(PreparedImpulseChannel::new(&channel)))
        .collect();
    Ok(PreparedSpatialEffect {
        file_path: file_path.to_string(),
        sample_rate,
        channels: ir_channels,
        responses,
    })
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
    fn new(sample_rate: u32, channels: usize, gains: &[f32; EQ_BAND_COUNT]) -> Self {
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

fn make_eq_filters(sample_rate: u32, gains: &[f32; EQ_BAND_COUNT]) -> Vec<Biquad> {
    let nyquist = sample_rate as f32 * 0.5;
    EQ_FREQUENCIES
        .iter()
        .zip(gains.iter())
        .filter_map(|(frequency, gain)| {
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
    channels: usize,
    convolvers: Vec<PartitionedConvolver>,
}

impl SpatialEffect {
    fn new(prepared: &PreparedSpatialEffect) -> Self {
        let convolvers = prepared
            .responses
            .iter()
            .cloned()
            .map(PartitionedConvolver::new)
            .collect::<Vec<_>>();
        Self {
            channels: prepared.channels,
            convolvers,
        }
    }

    fn process_interleaved(&mut self, samples: &mut [f32]) {
        for frame in samples.chunks_exact_mut(2) {
            let left = frame[0];
            let right = frame[1];
            let (wet_left, wet_right) = self.process_wet_frame(left, right);
            frame[0] = wet_left;
            frame[1] = wet_right;
        }
    }

    fn process_wet_frame(&mut self, left: f32, right: f32) -> (f32, f32) {
        if self.channels >= 4 && self.convolvers.len() >= 4 {
            (
                self.convolvers[0].process_sample(left) + self.convolvers[2].process_sample(right),
                self.convolvers[1].process_sample(left) + self.convolvers[3].process_sample(right),
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
        }
    }

    fn latency_frames(&self) -> usize {
        self.convolvers
            .iter()
            .map(PartitionedConvolver::latency_frames)
            .max()
            .unwrap_or_default()
    }
}

struct PartitionedConvolver {
    segments: Vec<SegmentConvolver>,
    latency_frames: usize,
}

impl PartitionedConvolver {
    fn new(prepared: Arc<PreparedImpulseChannel>) -> Self {
        Self {
            segments: prepared
                .segments
                .iter()
                .cloned()
                .map(SegmentConvolver::new)
                .collect(),
            latency_frames: prepared.latency_frames,
        }
    }

    fn process_sample(&mut self, sample: f32) -> f32 {
        self.segments
            .iter_mut()
            .map(|segment| segment.process_sample(sample))
            .sum()
    }

    fn latency_frames(&self) -> usize {
        self.latency_frames
    }
}

struct SegmentConvolver {
    prepared: Arc<PreparedImpulseSegment>,
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

impl SegmentConvolver {
    fn new(prepared: Arc<PreparedImpulseSegment>) -> Self {
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
            output: VecDeque::from(vec![0.0; prepared.output_delay_frames]),
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
        let mut segments = Vec::new();
        let latency_frames = EARLY_CONVOLUTION_BLOCK_SIZE.saturating_sub(1);
        let early_len = samples.len().min(EARLY_CONVOLUTION_FRAMES);
        if early_len > 0 {
            segments.push(Arc::new(PreparedImpulseSegment::new(
                &samples[..early_len],
                0,
                EARLY_CONVOLUTION_BLOCK_SIZE,
                latency_frames,
            )));
        }
        if samples.len() > early_len {
            segments.push(Arc::new(PreparedImpulseSegment::new(
                &samples[early_len..],
                early_len,
                LATE_CONVOLUTION_BLOCK_SIZE,
                latency_frames,
            )));
        }
        Self {
            segments,
            latency_frames: if samples.is_empty() {
                0
            } else {
                latency_frames
            },
        }
    }
}

impl PreparedImpulseSegment {
    fn new(
        samples: &[f32],
        impulse_offset: usize,
        block_size: usize,
        target_latency_frames: usize,
    ) -> Self {
        let block_size = block_size.max(1);
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
            output_delay_frames: impulse_offset.saturating_add(target_latency_frames),
        }
    }
}

fn db_to_gain(db: f32) -> f32 {
    10.0f32.powf(db / 20.0)
}

fn eq_headroom_gain(gains: &[f32; EQ_BAND_COUNT]) -> f32 {
    let max_boost = gains.iter().copied().fold(0.0f32, f32::max);
    db_to_gain(-max_boost.max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prepared_spatial(channels: usize, responses: &[&[f32]]) -> PreparedSpatialEffect {
        PreparedSpatialEffect {
            file_path: "test.irs".to_string(),
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
    fn spatial_impulse_response_applies_full_convolution() {
        let prepared = prepared_spatial(2, &[&[1.0], &[1.0]]);
        let mut spatial = SpatialEffect::new(&prepared);
        let mut samples = vec![0.0f32; EARLY_CONVOLUTION_BLOCK_SIZE * 2];
        samples[0] = 0.5;
        samples[1] = -0.25;

        spatial.process_interleaved(&mut samples);

        let delayed_frame = (EARLY_CONVOLUTION_BLOCK_SIZE - 1) * 2;
        assert!(samples[0].abs() < 0.00001);
        assert!(samples[1].abs() < 0.00001);
        assert!((samples[delayed_frame] - 0.5).abs() < 0.00001);
        assert!((samples[delayed_frame + 1] + 0.25).abs() < 0.00001);
    }

    #[test]
    fn standalone_spatial_effect_uses_process_unit_limiter() {
        let mut settings = DspSettings::default();
        settings.spatial = Some(prepared_spatial(2, &[&[1.0], &[1.0]]));
        let mut chain = DspChain::new(48_000, 2, &settings);
        let output_frame = EARLY_CONVOLUTION_BLOCK_SIZE - 1 + SoftwareLimiter::LOOKAHEAD;
        let mut samples = vec![0.0f32; (output_frame + 1) * 2];
        samples[0] = 0.5;
        samples[1] = -0.25;

        chain.process_interleaved(&mut samples);

        assert!(chain.owns_output_limiter());
        assert!(samples[..output_frame * 2]
            .iter()
            .all(|sample| sample.abs() < 0.00001));
        assert!((samples[output_frame * 2] - 0.5).abs() < 0.00001);
        assert!((samples[output_frame * 2 + 1] + 0.25).abs() < 0.00001);
    }

    #[test]
    fn spatial_impulse_response_keeps_late_segment_timing() {
        let mut left_ir = vec![0.0f32; EARLY_CONVOLUTION_FRAMES + 1];
        let mut right_ir = vec![0.0f32; EARLY_CONVOLUTION_FRAMES + 1];
        left_ir[EARLY_CONVOLUTION_FRAMES] = 0.75;
        right_ir[EARLY_CONVOLUTION_FRAMES] = -0.5;
        let prepared = prepared_spatial(2, &[&left_ir, &right_ir]);
        let mut spatial = SpatialEffect::new(&prepared);
        let frames = EARLY_CONVOLUTION_FRAMES + EARLY_CONVOLUTION_BLOCK_SIZE;
        let mut samples = vec![0.0f32; frames * 2];
        samples[0] = 1.0;
        samples[1] = 1.0;

        spatial.process_interleaved(&mut samples);

        let expected_frame = EARLY_CONVOLUTION_FRAMES + EARLY_CONVOLUTION_BLOCK_SIZE - 1;
        assert!(samples[..expected_frame * 2]
            .iter()
            .all(|sample| sample.abs() < 0.00001));
        assert!((samples[expected_frame * 2] - 0.75).abs() < 0.00001);
        assert!((samples[expected_frame * 2 + 1] + 0.5).abs() < 0.00001);
    }

    #[test]
    fn partitioned_convolution_matches_direct_convolution_across_segments() {
        let mut impulse = vec![0.0f32; EARLY_CONVOLUTION_FRAMES + 513];
        impulse[0] = 0.5;
        impulse[255] = -0.2;
        impulse[EARLY_CONVOLUTION_FRAMES - 1] = 0.125;
        impulse[EARLY_CONVOLUTION_FRAMES] = -0.375;
        impulse[EARLY_CONVOLUTION_FRAMES + 512] = 0.25;
        let input = (0..700)
            .map(|index| ((index * 17 % 101) as f32 - 50.0) / 100.0)
            .collect::<Vec<_>>();
        let prepared = Arc::new(PreparedImpulseChannel::new(&impulse));
        let latency_frames = prepared.latency_frames;
        let mut convolver = PartitionedConvolver::new(prepared);
        let output_frames = latency_frames + input.len() + impulse.len() - 1;
        let mut actual = Vec::with_capacity(output_frames);

        for frame in 0..output_frames {
            actual.push(convolver.process_sample(input.get(frame).copied().unwrap_or(0.0)));
        }

        let mut expected = vec![0.0f32; output_frames];
        for (input_index, input_sample) in input.iter().copied().enumerate() {
            for (impulse_index, impulse_sample) in impulse.iter().copied().enumerate() {
                expected[latency_frames + input_index + impulse_index] +=
                    input_sample * impulse_sample;
            }
        }
        for (frame, (actual, expected)) in actual.iter().zip(expected.iter()).enumerate() {
            assert!(
                (actual - expected).abs() < 0.0001,
                "convolution mismatch at frame {frame}: actual={actual}, expected={expected}"
            );
        }
    }

    #[test]
    fn true_stereo_impulse_response_routes_cross_channels() {
        let prepared = prepared_spatial(4, &[&[1.0], &[0.25], &[0.5], &[1.0]]);
        let mut spatial = SpatialEffect::new(&prepared);
        let mut samples = vec![0.0f32; EARLY_CONVOLUTION_BLOCK_SIZE * 2];
        samples[0] = 0.4;
        samples[1] = 0.2;

        spatial.process_interleaved(&mut samples);

        let delayed_frame = (EARLY_CONVOLUTION_BLOCK_SIZE - 1) * 2;
        assert!((samples[delayed_frame] - 0.5).abs() < 0.00001);
        assert!((samples[delayed_frame + 1] - 0.3).abs() < 0.00001);
    }
}
