use super::limiter::LinkedLimiter;
use super::provider::{NativeDspProvider, ProviderDescriptor, PROVIDER_MODE_SPEAKER};
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
const IR_SILENCE_THRESHOLD: f32 = 0.00000001;
const IR_TRIM_RELATIVE_THRESHOLD: f32 = 0.00001;
const IR_ANALYSIS_OVERSAMPLING: usize = 4;
const EQ_RESPONSE_BINS: usize = 32768;
const DSP_TRANSITION_FADE_SECONDS: f32 = 0.015;

#[derive(Clone, Debug)]
pub struct DspSettings {
    pub equalizer: [f32; EQ_BAND_COUNT],
    pub normalization_gain_db: f32,
    pub speed: f32,
    pub provider_path: Option<String>,
    pub provider_preset_json: Option<String>,
    pub provider_resource_json: Option<String>,
    pub provider_mode: u32,
    pub spatial: Option<PreparedSpatialEffect>,
    pub spatial_mix: f32,
}

impl Default for DspSettings {
    fn default() -> Self {
        Self {
            equalizer: [0.0; EQ_BAND_COUNT],
            normalization_gain_db: 0.0,
            speed: 1.0,
            provider_path: None,
            provider_preset_json: None,
            provider_resource_json: None,
            provider_mode: PROVIDER_MODE_SPEAKER,
            spatial: None,
            spatial_mix: 0.5,
        }
    }
}

impl DspSettings {
    pub fn requires_stereo_graph(&self) -> bool {
        self.provider_path.is_some() || self.spatial.is_some()
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
    frames: usize,
    peak_response_db: f32,
    output_gain_linear: f32,
    content_fingerprint: u64,
    responses: Vec<Arc<PreparedImpulseChannel>>,
}

#[derive(Debug)]
struct PreparedImpulseChannel {
    segments: Vec<Arc<PreparedImpulseSegment>>,
    latency_frames: usize,
    impulse_frames: usize,
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
    eq_transition: Option<EqualizerTransition>,
    eq_transition_buffer: Vec<f32>,
    spatial: Option<SpatialEffect>,
    provider: Option<NativeDspProvider>,
    spatial_limiter: Option<LinkedLimiter>,
    spatial_transition: Option<OutputFadeIn>,
}

impl DspChain {
    pub fn new(sample_rate: u32, channels: usize, settings: &DspSettings) -> Result<Self, String> {
        let channels = channels.max(1);
        let provider = settings
            .provider_path
            .as_deref()
            .map(|path| {
                NativeDspProvider::load(
                    std::path::Path::new(path),
                    sample_rate,
                    channels as u32,
                    settings.provider_mode,
                    settings.provider_preset_json.as_deref(),
                    settings.provider_resource_json.as_deref(),
                )
            })
            .transpose()?;
        if let Some(provider) = provider.as_ref() {
            ensure_provider_accepts_resources(
                provider,
                settings.provider_resource_json.as_deref(),
            )?;
        }
        let spatial = settings
            .spatial
            .as_ref()
            .filter(|spatial| channels == 2 && spatial.sample_rate == sample_rate)
            .map(|spatial| SpatialEffect::new(spatial, settings.spatial_mix));
        let spatial_limiter =
            (spatial.is_some() && settings.provider_path.is_none() && channels == 2)
                .then(|| LinkedLimiter::new(sample_rate, channels));
        Ok(Self {
            settings: settings.clone(),
            channels,
            eq_headroom_linear: eq_headroom_gain(sample_rate, &settings.equalizer),
            eq: MultichannelEqualizer::new(sample_rate, channels, &settings.equalizer),
            eq_transition: None,
            eq_transition_buffer: Vec::new(),
            spatial,
            provider,
            spatial_limiter,
            spatial_transition: None,
        })
    }

    pub fn update_settings(&mut self, settings: &DspSettings) -> Result<(), String> {
        let sample_rate = self.eq.sample_rate;
        let eq_changed = self.settings.equalizer != settings.equalizer;
        let spatial_changed = spatial_resource_identity(&self.settings.spatial)
            != spatial_resource_identity(&settings.spatial);
        let provider_preset_changed =
            self.settings.provider_preset_json != settings.provider_preset_json;
        let spatial_mix_changed =
            (self.settings.spatial_mix - settings.spatial_mix).abs() >= f32::EPSILON;

        if !eq_changed && !spatial_changed && !provider_preset_changed && !spatial_mix_changed {
            return Ok(());
        }
        if eq_changed {
            let next_headroom = eq_headroom_gain(sample_rate, &settings.equalizer);
            let next_eq =
                MultichannelEqualizer::new(sample_rate, self.channels, &settings.equalizer);
            let previous_headroom = std::mem::replace(&mut self.eq_headroom_linear, next_headroom);
            let previous = std::mem::replace(&mut self.eq, next_eq);
            self.eq_transition = self
                .provider
                .is_none()
                .then(|| EqualizerTransition::new(sample_rate, previous, previous_headroom));
            self.settings.equalizer = settings.equalizer;
        }
        if spatial_changed {
            self.spatial = settings
                .spatial
                .as_ref()
                .filter(|spatial| self.channels == 2 && spatial.sample_rate == sample_rate)
                .map(|spatial| SpatialEffect::new(spatial, settings.spatial_mix));
            self.spatial_limiter =
                (self.spatial.is_some() && settings.provider_path.is_none() && self.channels == 2)
                    .then(|| LinkedLimiter::new(sample_rate, self.channels));
            self.settings.spatial = settings.spatial.clone();
        }
        if spatial_mix_changed {
            if !spatial_changed {
                if let Some(spatial) = self.spatial.as_mut() {
                    spatial.set_mix(settings.spatial_mix);
                }
            }
            self.settings.spatial_mix = settings.spatial_mix;
        }
        if spatial_changed {
            self.spatial_transition = Some(OutputFadeIn::new(
                sample_rate,
                self.spatial_latency_frames(),
            ));
        }
        if provider_preset_changed {
            if let Some(preset_json) = settings.provider_preset_json.as_deref() {
                if let Some(provider) = self.provider.as_mut() {
                    provider.configure(preset_json)?;
                }
            }
            self.settings.provider_preset_json = settings.provider_preset_json.clone();
        }
        Ok(())
    }

    pub fn provider_identity(&self) -> Option<&str> {
        self.settings.provider_path.as_deref()
    }

    pub fn provider_mode(&self) -> u32 {
        self.settings.provider_mode
    }

    pub fn provider_resource_identity(&self) -> Option<&str> {
        self.settings.provider_resource_json.as_deref()
    }

    pub fn provider_descriptor(&self) -> Option<ProviderDescriptor> {
        self.provider.as_ref().map(NativeDspProvider::descriptor)
    }

    pub fn drain(&mut self, output: &mut Vec<f32>) -> Result<(), String> {
        if let Some(provider) = self.provider.as_mut() {
            provider.drain(output, self.channels)?;
            return Ok(());
        }
        let Some(spatial) = self.spatial.as_mut() else {
            return Ok(());
        };
        let tail_start = output.len();
        if !spatial.drain_interleaved(output) {
            return Ok(());
        }
        if let Some(limiter) = self.spatial_limiter.as_mut() {
            limiter.process_interleaved(&mut output[tail_start..]);
            limiter.drain_interleaved(output);
        }
        if let Some(transition) = self.spatial_transition.as_mut() {
            transition.apply_interleaved(&mut output[tail_start..], self.channels);
            if transition.is_complete() {
                self.spatial_transition = None;
            }
        }
        Ok(())
    }

    pub fn process_interleaved(&mut self, samples: &mut [f32]) -> Result<(), String> {
        if let Some(provider) = self.provider.as_mut() {
            provider.process(samples, self.channels)?;
            return Ok(());
        }
        if let Some(transition) = self.eq_transition.as_mut() {
            self.eq_transition_buffer.clear();
            self.eq_transition_buffer.extend_from_slice(samples);
            process_equalizer(
                &mut transition.previous,
                transition.previous_headroom_linear,
                &mut self.eq_transition_buffer,
            );
            process_equalizer(&mut self.eq, self.eq_headroom_linear, samples);
            transition.mix_interleaved(&self.eq_transition_buffer, samples, self.channels);
            if transition.is_complete() {
                self.eq_transition = None;
            }
        } else {
            process_equalizer(&mut self.eq, self.eq_headroom_linear, samples);
        }
        if self.channels == 2 {
            if let Some(spatial) = self.spatial.as_mut() {
                spatial.process_interleaved(samples);
            }
            if let Some(limiter) = self.spatial_limiter.as_mut() {
                limiter.process_interleaved(samples);
            }
        }
        if let Some(transition) = self.spatial_transition.as_mut() {
            transition.apply_interleaved(samples, self.channels);
            if transition.is_complete() {
                self.spatial_transition = None;
            }
        }
        Ok(())
    }

    pub fn latency_secs(&self) -> f64 {
        let provider_latency = self
            .provider
            .as_ref()
            .map(|provider| {
                f64::from(provider.info().latency_frames) / f64::from(self.eq.sample_rate.max(1))
            })
            .unwrap_or_default();
        provider_latency.max(self.spatial_latency_secs())
    }

    pub fn spatial_latency_secs(&self) -> f64 {
        self.spatial_latency_frames() as f64 / f64::from(self.eq.sample_rate.max(1))
    }

    fn spatial_latency_frames(&self) -> usize {
        let limiter_latency = if self.spatial_limiter.is_some() {
            LinkedLimiter::LOOKAHEAD
        } else {
            0
        };
        self.spatial
            .as_ref()
            .map(SpatialEffect::latency_frames)
            .unwrap_or_default()
            .saturating_add(limiter_latency)
    }
}

fn process_equalizer(
    equalizer: &mut MultichannelEqualizer,
    headroom_linear: f32,
    samples: &mut [f32],
) {
    if (headroom_linear - 1.0).abs() >= f32::EPSILON {
        for sample in samples.iter_mut() {
            *sample *= headroom_linear;
        }
    }
    equalizer.process_interleaved(samples);
}

struct EqualizerTransition {
    previous: MultichannelEqualizer,
    previous_headroom_linear: f32,
    fade_frames: usize,
    elapsed_frames: usize,
}

impl EqualizerTransition {
    fn new(
        sample_rate: u32,
        previous: MultichannelEqualizer,
        previous_headroom_linear: f32,
    ) -> Self {
        Self {
            previous,
            previous_headroom_linear,
            fade_frames: transition_fade_frames(sample_rate),
            elapsed_frames: 0,
        }
    }

    fn mix_interleaved(&mut self, previous: &[f32], next: &mut [f32], channels: usize) {
        for (previous_frame, next_frame) in previous
            .chunks_exact(channels.max(1))
            .zip(next.chunks_exact_mut(channels.max(1)))
        {
            let next_gain = ((self.elapsed_frames + 1) as f32 / self.fade_frames as f32).min(1.0);
            let previous_gain = 1.0 - next_gain;
            for (previous, next) in previous_frame.iter().zip(next_frame) {
                *next = *previous * previous_gain + *next * next_gain;
            }
            self.elapsed_frames = self.elapsed_frames.saturating_add(1);
        }
    }

    fn is_complete(&self) -> bool {
        self.elapsed_frames >= self.fade_frames
    }
}

struct OutputFadeIn {
    delay_frames: usize,
    fade_frames: usize,
    elapsed_frames: usize,
}

impl OutputFadeIn {
    fn new(sample_rate: u32, delay_frames: usize) -> Self {
        Self {
            delay_frames,
            fade_frames: transition_fade_frames(sample_rate),
            elapsed_frames: 0,
        }
    }

    fn apply_interleaved(&mut self, samples: &mut [f32], channels: usize) {
        for frame in samples.chunks_exact_mut(channels.max(1)) {
            let gain = if self.elapsed_frames < self.delay_frames {
                0.0
            } else {
                let fade_index = self.elapsed_frames - self.delay_frames;
                ((fade_index + 1) as f32 / self.fade_frames as f32).min(1.0)
            };
            for sample in frame {
                *sample *= gain;
            }
            self.elapsed_frames = self.elapsed_frames.saturating_add(1);
        }
    }

    fn is_complete(&self) -> bool {
        self.elapsed_frames >= self.delay_frames.saturating_add(self.fade_frames)
    }
}

fn transition_fade_frames(sample_rate: u32) -> usize {
    (sample_rate as f32 * DSP_TRANSITION_FADE_SECONDS)
        .round()
        .max(1.0) as usize
}

fn ensure_provider_accepts_resources(
    provider: &NativeDspProvider,
    resource_json: Option<&str>,
) -> Result<(), String> {
    let Some(resource_json) = resource_json else {
        return Ok(());
    };
    let resources: Vec<serde_json::Value> = serde_json::from_str(resource_json)
        .map_err(|error| format!("invalid Provider resource JSON: {error}"))?;
    if resources.is_empty() {
        return Ok(());
    }
    let descriptor = provider.descriptor();
    let manifest: serde_json::Value = serde_json::from_str(&descriptor.manifest_json)
        .map_err(|error| format!("invalid Provider manifest JSON: {error}"))?;
    let accepted = manifest
        .get("resources")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "Provider manifest does not declare resources".to_string())?;
    for resource in resources {
        let kind = resource
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let extension = resource
            .get("path")
            .and_then(serde_json::Value::as_str)
            .and_then(|path| std::path::Path::new(path).extension())
            .and_then(|extension| extension.to_str())
            .map(|extension| format!(".{extension}"));
        let supported = accepted.iter().any(|entry| {
            entry.get("kind").and_then(serde_json::Value::as_str) == Some(kind)
                || extension.as_deref().is_some_and(|extension| {
                    entry
                        .get("extensions")
                        .and_then(serde_json::Value::as_array)
                        .is_some_and(|extensions| {
                            extensions.iter().any(|value| {
                                value
                                    .as_str()
                                    .is_some_and(|value| value.eq_ignore_ascii_case(extension))
                            })
                        })
                })
        });
        if !supported {
            return Err(format!(
                "Provider {} does not support resource kind {kind}",
                descriptor.id
            ));
        }
    }
    Ok(())
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

    pub fn duration_secs(&self) -> f64 {
        self.frames as f64 / f64::from(self.sample_rate.max(1))
    }

    pub fn peak_response_db(&self) -> f32 {
        self.peak_response_db
    }

    pub fn output_gain_db(&self) -> f32 {
        gain_to_db(self.output_gain_linear)
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
        .ok_or_else(|| "impulse response has an invalid channel count".to_string())?;
    let ir_channels = impulse_output_channels(source_channels)?;
    let mut resampler = reader
        .build_resampler(
            ResampleOptions::new()
                .sample_rate(sample_rate as i32)
                .channels(ir_channels as i32)
                .preserve_channel_layout()
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
            append_impulse_samples(&mut interleaved, resampler.output_as::<f32>(), max_samples)?;
        }
        if frame.is_none() {
            break;
        }
    }

    if interleaved.is_empty() {
        return Err("impulse response file did not contain audio samples".to_string());
    }
    for sample in &mut interleaved {
        if !sample.is_finite() {
            *sample = 0.0;
        }
    }

    if !trim_impulse_response(&mut interleaved, ir_channels) {
        return Err("impulse response file is silent".to_string());
    }

    let response_samples = split_impulse_channels(&interleaved, ir_channels);
    let frames = response_samples
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or_default();
    let peak_response_linear = impulse_matrix_peak_gain(&response_samples, ir_channels);
    if !peak_response_linear.is_finite() || peak_response_linear <= 0.0 {
        return Err("impulse response has an invalid frequency response".to_string());
    }
    let peak_response_db = gain_to_db(peak_response_linear);
    let output_gain_linear = automatic_ir_output_gain(peak_response_linear);
    let content_fingerprint = impulse_content_fingerprint(&interleaved, ir_channels, sample_rate);
    let responses = response_samples
        .into_iter()
        .map(|channel| Arc::new(PreparedImpulseChannel::new(&channel)))
        .collect();
    Ok(PreparedSpatialEffect {
        file_path: file_path.to_string(),
        sample_rate,
        channels: ir_channels,
        frames,
        peak_response_db,
        output_gain_linear,
        content_fingerprint,
        responses,
    })
}

fn impulse_output_channels(source_channels: usize) -> Result<usize, String> {
    match source_channels {
        1 | 2 => Ok(2),
        4 => Ok(4),
        _ => Err(format!(
            "unsupported impulse response channel count: {source_channels}; expected mono, stereo, or 4-channel true-stereo"
        )),
    }
}

fn append_impulse_samples(
    target: &mut Vec<f32>,
    decoded: &[f32],
    max_samples: usize,
) -> Result<(), String> {
    if decoded.len() > max_samples.saturating_sub(target.len()) {
        return Err(format!(
            "impulse response exceeds the {MAX_IR_SECONDS:.0}-second limit"
        ));
    }
    target.extend_from_slice(decoded);
    Ok(())
}

fn spatial_resource_identity(spatial: &Option<PreparedSpatialEffect>) -> Option<(&str, u32, u64)> {
    spatial.as_ref().map(|spatial| {
        (
            spatial.file_path.as_str(),
            spatial.sample_rate,
            spatial.content_fingerprint,
        )
    })
}

fn trim_impulse_response(samples: &mut Vec<f32>, channels: usize) -> bool {
    let channels = channels.max(1);
    let frames = samples.len() / channels;
    let overall_peak = samples
        .iter()
        .copied()
        .filter(|sample| sample.is_finite())
        .map(f32::abs)
        .fold(0.0, f32::max);
    if overall_peak < IR_SILENCE_THRESHOLD {
        return false;
    }
    let trim_threshold = (overall_peak * IR_TRIM_RELATIVE_THRESHOLD).max(IR_SILENCE_THRESHOLD);
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
        if peak >= trim_threshold {
            last_active = frame;
        }
    }
    let keep_frames = last_active + 1;
    samples.truncate(keep_frames * channels);
    true
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

fn impulse_matrix_peak_gain(responses: &[Vec<f32>], channels: usize) -> f32 {
    let max_frames = responses.iter().map(Vec::len).max().unwrap_or_default();
    if max_frames == 0 {
        return 0.0;
    }
    let analysis_frames = max_frames
        .saturating_mul(IR_ANALYSIS_OVERSAMPLING)
        .max(2)
        .next_power_of_two();
    let magnitudes = responses
        .iter()
        .map(|response| impulse_frequency_magnitudes(response, analysis_frames))
        .collect::<Vec<_>>();

    if channels >= 4 && magnitudes.len() >= 4 {
        let mut peak = 0.0f32;
        for (((left_direct, right_cross), left_cross), right_direct) in magnitudes[0]
            .iter()
            .zip(&magnitudes[1])
            .zip(&magnitudes[2])
            .zip(&magnitudes[3])
        {
            let left = left_direct + left_cross;
            let right = right_cross + right_direct;
            peak = peak.max(left).max(right);
        }
        peak
    } else {
        magnitudes
            .iter()
            .flat_map(|response| response.iter().copied())
            .fold(0.0, f32::max)
    }
}

fn impulse_frequency_magnitudes(samples: &[f32], fft_size: usize) -> Vec<f32> {
    let mut spectrum = vec![Complex32::ZERO; fft_size];
    for (target, sample) in spectrum.iter_mut().zip(samples.iter().copied()) {
        target.re = if sample.is_finite() { sample } else { 0.0 };
    }
    let mut planner = FftPlanner::<f32>::new();
    planner.plan_fft_forward(fft_size).process(&mut spectrum);
    spectrum
        .into_iter()
        .take(fft_size / 2 + 1)
        .map(|value| value.norm())
        .collect()
}

fn automatic_ir_output_gain(peak_response_linear: f32) -> f32 {
    if peak_response_linear <= 1.0 {
        return 1.0;
    }
    peak_response_linear.recip().clamp(0.0, 1.0)
}

fn impulse_content_fingerprint(samples: &[f32], channels: usize, sample_rate: u32) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = FNV_OFFSET;
    for byte in (channels as u64)
        .to_le_bytes()
        .into_iter()
        .chain(sample_rate.to_le_bytes())
        .chain(
            samples
                .iter()
                .flat_map(|sample| sample.to_bits().to_le_bytes()),
        )
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

#[cfg(test)]
pub(crate) fn prepared_spatial_effect_for_test(
    channels: usize,
    responses: &[&[f32]],
) -> PreparedSpatialEffect {
    let response_samples = responses
        .iter()
        .map(|response| response.to_vec())
        .collect::<Vec<_>>();
    let frames = response_samples
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or_default();
    let peak_response_db = gain_to_db(impulse_matrix_peak_gain(&response_samples, channels));
    let content_fingerprint = response_samples
        .iter()
        .flatten()
        .fold(0xcbf2_9ce4_8422_2325u64, |hash, sample| {
            (hash ^ u64::from(sample.to_bits())).wrapping_mul(0x0000_0100_0000_01b3)
        });
    PreparedSpatialEffect {
        file_path: "test.irs".to_string(),
        sample_rate: 48_000,
        channels,
        frames,
        peak_response_db,
        output_gain_linear: 1.0,
        content_fingerprint,
        responses: response_samples
            .iter()
            .map(|response| Arc::new(PreparedImpulseChannel::new(response)))
            .collect(),
    }
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
        let sample = if sample.is_finite() { sample } else { 0.0 };
        let out = self.b0 * sample + self.z1;
        if !out.is_finite() {
            self.z1 = 0.0;
            self.z2 = 0.0;
            return 0.0;
        }
        self.z1 = self.b1 * sample - self.a1 * out + self.z2;
        self.z2 = self.b2 * sample - self.a2 * out;
        if !self.z1.is_finite() || !self.z2.is_finite() {
            self.z1 = 0.0;
            self.z2 = 0.0;
        }
        out
    }

    fn frequency_response(&self, omega: f32) -> Complex32 {
        let z1 = Complex32::new(omega.cos(), -omega.sin());
        let z2 = z1 * z1;
        let numerator = self.b0 + self.b1 * z1 + self.b2 * z2;
        let denominator = 1.0 + self.a1 * z1 + self.a2 * z2;
        numerator / denominator
    }
}

struct SpatialEffect {
    channels: usize,
    output_gain_linear: f32,
    mix: f32,
    dry_delay_frames: usize,
    dry_delay: VecDeque<[f32; 2]>,
    tail_frames: usize,
    has_input: bool,
    convolvers: Vec<PartitionedConvolver>,
}

impl SpatialEffect {
    fn new(prepared: &PreparedSpatialEffect, mix: f32) -> Self {
        let convolvers = prepared
            .responses
            .iter()
            .cloned()
            .map(PartitionedConvolver::new)
            .collect::<Vec<_>>();
        let dry_delay_frames = convolvers
            .iter()
            .map(PartitionedConvolver::latency_frames)
            .max()
            .unwrap_or_default();
        Self {
            channels: prepared.channels,
            output_gain_linear: prepared.output_gain_linear,
            mix: mix.clamp(0.0, 1.0),
            dry_delay_frames,
            dry_delay: std::iter::repeat([0.0, 0.0])
                .take(dry_delay_frames)
                .collect(),
            tail_frames: prepared
                .responses
                .iter()
                .map(|response| {
                    response
                        .impulse_frames
                        .saturating_sub(1)
                        .saturating_add(response.latency_frames)
                })
                .max()
                .unwrap_or_default(),
            has_input: false,
            convolvers,
        }
    }

    fn process_interleaved(&mut self, samples: &mut [f32]) {
        self.has_input |= !samples.is_empty();
        for frame in samples.chunks_exact_mut(2) {
            let left = frame[0];
            let right = frame[1];
            let [dry_left, dry_right] = self.delay_dry_frame(left, right);
            let (wet_left, wet_right) = self.process_wet_frame(left, right);
            let dry_mix = 1.0 - self.mix;
            frame[0] = dry_left * dry_mix + wet_left * self.output_gain_linear * self.mix;
            frame[1] = dry_right * dry_mix + wet_right * self.output_gain_linear * self.mix;
        }
    }

    fn drain_interleaved(&mut self, output: &mut Vec<f32>) -> bool {
        if !self.has_input {
            return false;
        }
        output.reserve(self.tail_frames.saturating_mul(2));
        for _ in 0..self.tail_frames {
            let [dry_left, dry_right] = self.delay_dry_frame(0.0, 0.0);
            let (left, right) = self.process_wet_frame(0.0, 0.0);
            let dry_mix = 1.0 - self.mix;
            output.push(dry_left * dry_mix + left * self.output_gain_linear * self.mix);
            output.push(dry_right * dry_mix + right * self.output_gain_linear * self.mix);
        }
        self.reset();
        true
    }

    fn reset(&mut self) {
        for convolver in &mut self.convolvers {
            convolver.reset();
        }
        self.dry_delay.clear();
        self.dry_delay
            .extend(std::iter::repeat([0.0, 0.0]).take(self.dry_delay_frames));
        self.has_input = false;
    }

    fn set_mix(&mut self, mix: f32) {
        self.mix = mix.clamp(0.0, 1.0);
    }

    fn delay_dry_frame(&mut self, left: f32, right: f32) -> [f32; 2] {
        if self.dry_delay_frames == 0 {
            return [left, right];
        }
        let delayed = self.dry_delay.pop_front().unwrap_or([0.0, 0.0]);
        self.dry_delay.push_back([left, right]);
        delayed
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

    fn reset(&mut self) {
        for segment in &mut self.segments {
            segment.reset();
        }
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
        let mut output = VecDeque::with_capacity(
            prepared
                .output_delay_frames
                .saturating_add(prepared.block_size),
        );
        output.extend(std::iter::repeat_n(0.0, prepared.output_delay_frames));
        Self {
            input_spectra: vec![vec![Complex32::ZERO; prepared.fft_size]; partitions],
            input_fft: vec![Complex32::ZERO; prepared.fft_size],
            input_block: Vec::with_capacity(prepared.block_size),
            overlap: vec![0.0; prepared.block_size],
            scratch: vec![Complex32::ZERO; prepared.fft_size],
            output,
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

    fn reset(&mut self) {
        for spectrum in &mut self.input_spectra {
            spectrum.fill(Complex32::ZERO);
        }
        self.input_fft.fill(Complex32::ZERO);
        self.input_block.clear();
        self.overlap.fill(0.0);
        self.scratch.fill(Complex32::ZERO);
        self.output.clear();
        self.output
            .extend(std::iter::repeat_n(0.0, self.prepared.output_delay_frames));
        self.write_pos = 0;
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
            impulse_frames: samples.len(),
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
    fundsp::prelude32::db_amp(db)
}

fn gain_to_db(gain: f32) -> f32 {
    20.0 * gain.max(f32::MIN_POSITIVE).log10()
}

fn eq_headroom_gain(sample_rate: u32, gains: &[f32; EQ_BAND_COUNT]) -> f32 {
    let filters = make_eq_filters(sample_rate, gains);
    if filters.is_empty() {
        return 1.0;
    }
    let peak = (0..=EQ_RESPONSE_BINS)
        .map(|index| std::f32::consts::PI * index as f32 / EQ_RESPONSE_BINS as f32)
        .map(|omega| {
            filters
                .iter()
                .fold(Complex32::new(1.0, 0.0), |response, filter| {
                    response * filter.frequency_response(omega)
                })
                .norm()
        })
        .filter(|gain| gain.is_finite())
        .fold(1.0f32, f32::max);
    automatic_ir_output_gain(peak)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEST_FILE_ID: AtomicU64 = AtomicU64::new(0);

    struct TestWav(PathBuf);

    impl TestWav {
        fn extensible_quad_impulse() -> Self {
            let mut wav = Vec::new();
            wav.extend_from_slice(b"RIFF");
            wav.extend_from_slice(&76u32.to_le_bytes());
            wav.extend_from_slice(b"WAVEfmt ");
            wav.extend_from_slice(&40u32.to_le_bytes());
            wav.extend_from_slice(&0xfffeu16.to_le_bytes());
            wav.extend_from_slice(&4u16.to_le_bytes());
            wav.extend_from_slice(&48_000u32.to_le_bytes());
            wav.extend_from_slice(&(48_000u32 * 16).to_le_bytes());
            wav.extend_from_slice(&16u16.to_le_bytes());
            wav.extend_from_slice(&32u16.to_le_bytes());
            wav.extend_from_slice(&22u16.to_le_bytes());
            wav.extend_from_slice(&32u16.to_le_bytes());
            wav.extend_from_slice(&0x33u32.to_le_bytes()); // FL, FR, BL, BR (quad)
            wav.extend_from_slice(&[
                0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38,
                0x9b, 0x71,
            ]);
            wav.extend_from_slice(b"data");
            wav.extend_from_slice(&16u32.to_le_bytes());
            for sample in [0.1f32, 0.2, 0.3, 0.4] {
                wav.extend_from_slice(&sample.to_le_bytes());
            }

            let path = std::env::temp_dir().join(format!(
                "echo-basic-quad-{}-{}.wav",
                std::process::id(),
                TEST_FILE_ID.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::write(&path, wav).expect("write quad WAV fixture");
            Self(path)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TestWav {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn prepared_spatial(channels: usize, responses: &[&[f32]]) -> PreparedSpatialEffect {
        prepared_spatial_effect_for_test(channels, responses)
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
        let mut chain = DspChain::new(sample_rate, 2, &settings).expect("chain should initialize");
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

        chain
            .process_interleaved(&mut samples)
            .expect("basic DSP should process");

        assert!(rms(&samples) < before * 0.75);
    }

    #[test]
    fn equalizer_headroom_uses_the_combined_filter_response() {
        let mut gains = [0.0; EQ_BAND_COUNT];
        gains[3] = 12.0;
        gains[4] = 12.0;

        let headroom = eq_headroom_gain(48_000, &gains);
        let single_band_headroom = db_to_gain(-12.0);

        assert!(headroom.is_finite());
        assert!(headroom > 0.0);
        assert!(headroom < single_band_headroom);
        assert_eq!(eq_headroom_gain(48_000, &[0.0; EQ_BAND_COUNT]), 1.0);
    }

    #[test]
    fn boosted_equalizer_stays_finite_without_internal_hard_clipping() {
        let settings = DspSettings {
            equalizer: [12.0; EQ_BAND_COUNT],
            ..DspSettings::default()
        };
        let mut chain = DspChain::new(48_000, 2, &settings).expect("chain should initialize");
        let mut samples = (0..48_000)
            .flat_map(|frame| {
                let value = (2.0 * std::f32::consts::PI * 997.0 * frame as f32 / 48_000.0).sin();
                [value, value]
            })
            .collect::<Vec<_>>();

        chain
            .process_interleaved(&mut samples)
            .expect("boosted equalizer should process");

        assert!(samples.iter().all(|sample| sample.is_finite()));
        assert!(samples.iter().all(|sample| sample.abs() <= 1.05));
    }

    #[test]
    fn equalizer_updates_crossfade_from_the_previous_filter_state() {
        let mut chain =
            DspChain::new(48_000, 2, &DspSettings::default()).expect("chain should initialize");
        let mut next = DspSettings::default();
        next.equalizer[5] = 12.0;
        chain.update_settings(&next).expect("EQ should update");
        let mut first = vec![0.5; 64 * 2];

        chain
            .process_interleaved(&mut first)
            .expect("transition should process");

        assert!(
            first[0] > 0.45,
            "first EQ transition frame must stay continuous"
        );
        assert!(chain.eq_transition.is_some());

        let mut remainder = vec![0.5; transition_fade_frames(48_000) * 2];
        chain
            .process_interleaved(&mut remainder)
            .expect("transition should finish");
        assert!(chain.eq_transition.is_none());
    }

    #[test]
    fn impulse_channel_contract_rejects_ambiguous_surround_layouts() {
        assert_eq!(impulse_output_channels(1).expect("mono"), 2);
        assert_eq!(impulse_output_channels(2).expect("stereo"), 2);
        assert_eq!(impulse_output_channels(4).expect("true stereo"), 4);
        for channels in [0, 3, 5, 6, 8] {
            assert!(impulse_output_channels(channels).is_err());
        }
    }

    #[test]
    fn impulse_sample_budget_rejects_instead_of_truncating() {
        let mut samples = vec![0.25, -0.25];
        let before = samples.clone();
        let err = append_impulse_samples(&mut samples, &[0.5, -0.5], 3)
            .expect_err("oversized impulse should be rejected");

        assert!(err.contains("8-second limit"));
        assert_eq!(samples, before);
    }

    #[test]
    fn impulse_trim_preserves_quiet_tail_relative_to_peak() {
        let mut samples = vec![1.0, 0.00002, 0.0, 0.0];
        assert!(trim_impulse_response(&mut samples, 1));
        assert_eq!(samples, vec![1.0, 0.00002]);

        let mut silent = vec![IR_SILENCE_THRESHOLD * 0.5; 8];
        assert!(!trim_impulse_response(&mut silent, 1));
    }

    #[test]
    fn spatial_impulse_response_applies_full_convolution() {
        let prepared = prepared_spatial(2, &[&[1.0], &[1.0]]);
        let mut spatial = SpatialEffect::new(&prepared, 1.0);
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
    fn spatial_mix_delays_dry_signal_to_match_convolution() {
        let prepared = prepared_spatial(2, &[&[0.5], &[0.5]]);
        let mut spatial = SpatialEffect::new(&prepared, 0.5);
        let mut samples = vec![0.0f32; EARLY_CONVOLUTION_BLOCK_SIZE * 2];
        samples[0] = 0.4;
        samples[1] = -0.2;

        spatial.process_interleaved(&mut samples);

        let delayed_frame = (EARLY_CONVOLUTION_BLOCK_SIZE - 1) * 2;
        assert!(samples[..delayed_frame]
            .iter()
            .all(|sample| sample.abs() < 0.00001));
        assert!((samples[delayed_frame] - 0.3).abs() < 0.00001);
        assert!((samples[delayed_frame + 1] + 0.15).abs() < 0.00001);
    }

    #[test]
    fn spatial_mix_updates_without_resetting_dry_delay() {
        let prepared = prepared_spatial(2, &[&[1.0], &[1.0]]);
        let mut spatial = SpatialEffect::new(&prepared, 1.0);
        let mut first = vec![0.4, -0.2];
        spatial.process_interleaved(&mut first);
        spatial.set_mix(0.0);

        let mut remainder = vec![0.0; (EARLY_CONVOLUTION_BLOCK_SIZE - 1) * 2];
        spatial.process_interleaved(&mut remainder);

        let last = remainder.len() - 2;
        assert!((remainder[last] - 0.4).abs() < 0.00001);
        assert!((remainder[last + 1] + 0.2).abs() < 0.00001);
    }

    #[test]
    fn standalone_spatial_effect_uses_linked_lookahead_limiter() {
        let settings = DspSettings {
            spatial: Some(prepared_spatial(2, &[&[1.0], &[1.0]])),
            spatial_mix: 1.0,
            ..DspSettings::default()
        };
        let mut chain = DspChain::new(48_000, 2, &settings).expect("chain should initialize");
        let output_frame = EARLY_CONVOLUTION_BLOCK_SIZE - 1 + LinkedLimiter::LOOKAHEAD;
        let mut samples = vec![0.0f32; (output_frame + 1) * 2];
        samples[0] = 0.5;
        samples[1] = -0.25;

        chain
            .process_interleaved(&mut samples)
            .expect("basic DSP should process");

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
        let mut spatial = SpatialEffect::new(&prepared, 1.0);
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
        let mut spatial = SpatialEffect::new(&prepared, 1.0);
        let mut samples = vec![0.0f32; EARLY_CONVOLUTION_BLOCK_SIZE * 2];
        samples[0] = 0.4;
        samples[1] = 0.2;

        spatial.process_interleaved(&mut samples);

        let delayed_frame = (EARLY_CONVOLUTION_BLOCK_SIZE - 1) * 2;
        assert!((samples[delayed_frame] - 0.5).abs() < 0.00001);
        assert!((samples[delayed_frame + 1] - 0.3).abs() < 0.00001);
    }

    #[test]
    fn extensible_quad_impulse_preserves_true_stereo_channel_matrix() {
        let fixture = TestWav::extensible_quad_impulse();
        let prepared = prepare_spatial_effect(
            fixture
                .path()
                .to_str()
                .expect("fixture path should be UTF-8"),
            48_000,
        )
        .expect("quad impulse should prepare");
        assert_eq!(prepared.channels(), 4);
        assert_eq!(prepared.mode(), "true-stereo");

        let delayed_frame = (EARLY_CONVOLUTION_BLOCK_SIZE - 1) * 2;
        let mut left_input = vec![0.0f32; EARLY_CONVOLUTION_BLOCK_SIZE * 2];
        left_input[0] = 1.0;
        SpatialEffect::new(&prepared, 1.0).process_interleaved(&mut left_input);
        assert!((left_input[delayed_frame] - 0.1).abs() < 0.00001);
        assert!((left_input[delayed_frame + 1] - 0.2).abs() < 0.00001);

        let mut right_input = vec![0.0f32; EARLY_CONVOLUTION_BLOCK_SIZE * 2];
        right_input[1] = 1.0;
        SpatialEffect::new(&prepared, 1.0).process_interleaved(&mut right_input);
        assert!((right_input[delayed_frame] - 0.3).abs() < 0.00001);
        assert!((right_input[delayed_frame + 1] - 0.4).abs() < 0.00001);
    }

    #[test]
    fn automatic_ir_headroom_caps_high_gain_response_and_preserves_unity() {
        let unity = vec![vec![1.0], vec![1.0]];
        let unity_peak = impulse_matrix_peak_gain(&unity, 2);
        assert!((unity_peak - 1.0).abs() < 0.00001);
        assert_eq!(automatic_ir_output_gain(unity_peak), 1.0);

        let boosted = vec![vec![1.0, 1.0], vec![1.0, 1.0]];
        let boosted_peak = impulse_matrix_peak_gain(&boosted, 2);
        let output_gain = automatic_ir_output_gain(boosted_peak);
        assert!((boosted_peak - 2.0).abs() < 0.00001);
        assert!((output_gain - 0.5).abs() < 0.00001);
        assert!(boosted_peak * output_gain <= 1.0 + 0.00001);
    }

    #[test]
    fn output_transition_honors_latency_then_fades_per_frame() {
        let mut transition = OutputFadeIn {
            delay_frames: 2,
            fade_frames: 4,
            elapsed_frames: 0,
        };
        let mut samples = vec![1.0; 6 * 2];

        transition.apply_interleaved(&mut samples, 2);

        let expected = [0.0, 0.0, 0.25, 0.5, 0.75, 1.0];
        for (frame, expected) in samples.chunks_exact(2).zip(expected) {
            assert!((frame[0] - expected).abs() < f32::EPSILON);
            assert!((frame[1] - expected).abs() < f32::EPSILON);
        }
        assert!(transition.is_complete());
    }

    #[test]
    fn mismatched_spatial_plan_does_not_enable_a_dry_signal_limiter() {
        let settings = DspSettings {
            spatial: Some(prepared_spatial(2, &[&[1.0], &[1.0]])),
            ..DspSettings::default()
        };
        let chain = DspChain::new(44_100, 2, &settings).expect("chain should initialize");

        assert!(chain.spatial.is_none());
        assert!(chain.spatial_limiter.is_none());
        assert_eq!(chain.spatial_latency_secs(), 0.0);
    }

    #[test]
    fn spatial_drain_emits_complete_tail_and_resets_for_reuse() {
        let settings = DspSettings {
            spatial: Some(prepared_spatial(2, &[&[0.5, 0.25], &[0.5, 0.25]])),
            spatial_mix: 1.0,
            ..DspSettings::default()
        };
        let mut chain = DspChain::new(48_000, 2, &settings).expect("chain should initialize");

        let mut first = vec![0.4, -0.2];
        chain
            .process_interleaved(&mut first)
            .expect("basic DSP should process");
        let mut tail = Vec::new();
        chain.drain(&mut tail).expect("basic DSP should drain");
        first.extend_from_slice(&tail);

        let first_output_frame = EARLY_CONVOLUTION_BLOCK_SIZE - 1 + LinkedLimiter::LOOKAHEAD;
        assert_eq!(first.len() / 2, first_output_frame + 2);
        assert!((first[first_output_frame * 2] - 0.2).abs() < 0.00001);
        assert!((first[first_output_frame * 2 + 1] + 0.1).abs() < 0.00001);
        assert!((first[(first_output_frame + 1) * 2] - 0.1).abs() < 0.00001);
        assert!((first[(first_output_frame + 1) * 2 + 1] + 0.05).abs() < 0.00001);

        let mut second = vec![0.4, -0.2];
        chain
            .process_interleaved(&mut second)
            .expect("reused chain should process");
        let mut second_tail = Vec::new();
        chain
            .drain(&mut second_tail)
            .expect("reused chain should drain");
        second.extend_from_slice(&second_tail);
        assert_eq!(second, first);
    }

    #[test]
    fn spatial_drain_flushes_partial_late_partition() {
        let late_index = EARLY_CONVOLUTION_FRAMES + 512;
        let mut impulse = vec![0.0; late_index + 1];
        impulse[late_index] = 0.25;
        let settings = DspSettings {
            spatial: Some(prepared_spatial(2, &[&impulse, &impulse])),
            spatial_mix: 1.0,
            ..DspSettings::default()
        };
        let mut chain = DspChain::new(48_000, 2, &settings).expect("chain should initialize");
        let mut output = vec![0.4, -0.2];
        chain
            .process_interleaved(&mut output)
            .expect("basic DSP should process");
        let mut tail = Vec::new();
        chain.drain(&mut tail).expect("basic DSP should drain");
        output.extend_from_slice(&tail);

        let expected_frame =
            late_index + EARLY_CONVOLUTION_BLOCK_SIZE - 1 + LinkedLimiter::LOOKAHEAD;
        assert_eq!(output.len() / 2, expected_frame + 1);
        assert!((output[expected_frame * 2] - 0.1).abs() < 0.00001);
        assert!((output[expected_frame * 2 + 1] + 0.05).abs() < 0.00001);
    }

    #[test]
    fn spatial_identity_changes_when_same_path_content_changes() {
        let first = prepared_spatial(2, &[&[1.0], &[1.0]]);
        let second = prepared_spatial(2, &[&[0.5], &[0.5]]);
        assert_eq!(first.file_path, second.file_path);
        assert_ne!(first.content_fingerprint, second.content_fingerprint);
    }
}
