use crate::effects::{DspChain, DspSettings};
use crate::shared::{
    AudioSampleFormat, DecodedAudioChunk, DecodedAudioData, DecodedAudioFormat, MixFormat,
};
use crate::tempo::{TempoProcessor, MAX_SPEED, MIN_SPEED};
use ffmpeg_audio::{sys, SwrContext};
use std::{mem, ptr};

pub struct AudioFilterGraph {
    output_format: MixFormat,
    process_format: MixFormat,
    nodes: Vec<AudioFilterNode>,
    converter: SwrMixConverter,
    tempo: TempoProcessor,
    effects: DspChain,
    converted_output: Vec<f32>,
    processed_output: Vec<f32>,
    mapped_output: Vec<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChannelRequirement {
    Preserve,
    Stereo,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FilterFlushMode {
    Drain,
    Reset,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AudioFilterNodeKind {
    FormatConvert,
    Tempo,
    Equalizer,
    Spatial,
    Normalization,
    Limiter,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AudioFilterNode {
    kind: AudioFilterNodeKind,
    channels: ChannelRequirement,
    flush: FilterFlushMode,
}

impl AudioFilterGraph {
    pub fn new(output_format: MixFormat, settings: &DspSettings) -> Result<Self, String> {
        let process_format = process_format_for_output(output_format, settings);
        let nodes = filter_nodes_for_settings(settings);
        Ok(Self {
            output_format,
            process_format,
            nodes,
            converter: SwrMixConverter::default(),
            tempo: TempoProcessor::new(
                settings.speed,
                process_format.sample_rate,
                process_format.channels,
            )?,
            effects: DspChain::new(
                process_format.sample_rate,
                process_format.channels,
                settings,
            ),
            converted_output: Vec::new(),
            processed_output: Vec::new(),
            mapped_output: Vec::new(),
        })
    }

    pub fn reset(
        &mut self,
        output_format: MixFormat,
        settings: &DspSettings,
    ) -> Result<(), String> {
        *self = Self::new(output_format, settings)?;
        Ok(())
    }

    pub fn process_decoded(
        &mut self,
        chunk: &DecodedAudioChunk,
        settings: &DspSettings,
        output: &mut Vec<f32>,
    ) -> Result<u64, String> {
        output.clear();
        if chunk.frames == 0 {
            return Ok(0);
        }
        self.converted_output.clear();
        self.converter
            .process(chunk, self.process_format, &mut self.converted_output)?;
        if self.converted_output.is_empty() {
            return Ok(0);
        }
        self.effects.update_settings(settings);
        self.effects.process_interleaved(&mut self.converted_output);
        output.extend_from_slice(&self.converted_output);

        self.process_graph_output(settings, output)
    }

    pub fn finish(&mut self, settings: &DspSettings, output: &mut Vec<f32>) -> Result<u64, String> {
        output.clear();
        let mut source_frames = 0u64;
        self.converted_output.clear();
        self.converter.finish(&mut self.converted_output)?;
        if !self.converted_output.is_empty() {
            self.effects.update_settings(settings);
            self.effects.process_interleaved(&mut self.converted_output);
            output.extend_from_slice(&self.converted_output);
            source_frames =
                source_frames.saturating_add(self.process_graph_output(settings, output)?);
        }

        self.processed_output.clear();
        self.tempo.finish_into(&mut self.processed_output)?;
        if !self.processed_output.is_empty() {
            soft_limit_interleaved(&mut self.processed_output);
            source_frames = source_frames.saturating_add(tempo_source_frames(
                self.processed_output.len(),
                self.tempo.speed(),
                self.process_format.channels,
            ));
            append_graph_output(
                self.process_format,
                self.output_format,
                &self.processed_output,
                &mut self.mapped_output,
                output,
            );
        }
        Ok(source_frames)
    }

    pub fn latency_secs(&self) -> f64 {
        self.tempo.latency_secs(self.process_format.sample_rate) + self.effects.latency_secs()
    }

    fn process_graph_output(
        &mut self,
        settings: &DspSettings,
        output: &mut Vec<f32>,
    ) -> Result<u64, String> {
        if output.is_empty() {
            return Ok(0);
        }
        debug_assert!(
            !self
                .nodes
                .iter()
                .any(|node| node.channels == ChannelRequirement::Stereo)
                || self.process_format.channels == 2
        );
        let speed = settings.speed.clamp(MIN_SPEED, MAX_SPEED);
        self.processed_output.clear();
        self.tempo
            .set_speed(speed)
            .and_then(|_| self.tempo.process_into(output, &mut self.processed_output))?;
        soft_limit_interleaved(&mut self.processed_output);
        let source_frames = tempo_source_frames(
            self.processed_output.len(),
            speed,
            self.process_format.channels,
        );
        output.clear();
        append_graph_output(
            self.process_format,
            self.output_format,
            &self.processed_output,
            &mut self.mapped_output,
            output,
        );
        Ok(source_frames)
    }
}

fn process_format_for_output(output_format: MixFormat, settings: &DspSettings) -> MixFormat {
    if filter_nodes_for_settings(settings)
        .iter()
        .any(|node| node.channels == ChannelRequirement::Stereo)
    {
        MixFormat::stereo_f32(output_format.sample_rate)
    } else {
        output_format
    }
}

fn filter_nodes_for_settings(settings: &DspSettings) -> Vec<AudioFilterNode> {
    let mut nodes = Vec::with_capacity(6);
    nodes.push(AudioFilterNode {
        kind: AudioFilterNodeKind::FormatConvert,
        channels: ChannelRequirement::Preserve,
        flush: FilterFlushMode::Drain,
    });
    if settings.equalizer.iter().any(|gain| gain.abs() >= 0.05) {
        nodes.push(AudioFilterNode {
            kind: AudioFilterNodeKind::Equalizer,
            channels: ChannelRequirement::Preserve,
            flush: FilterFlushMode::Reset,
        });
    }
    if settings.spatial.is_some() {
        nodes.push(AudioFilterNode {
            kind: AudioFilterNodeKind::Spatial,
            channels: ChannelRequirement::Stereo,
            flush: FilterFlushMode::Reset,
        });
    }
    if settings.normalization_gain_db.abs() >= 0.01 {
        nodes.push(AudioFilterNode {
            kind: AudioFilterNodeKind::Normalization,
            channels: ChannelRequirement::Preserve,
            flush: FilterFlushMode::Reset,
        });
    }
    nodes.push(AudioFilterNode {
        kind: AudioFilterNodeKind::Tempo,
        channels: ChannelRequirement::Preserve,
        flush: FilterFlushMode::Drain,
    });
    nodes.push(AudioFilterNode {
        kind: AudioFilterNodeKind::Limiter,
        channels: ChannelRequirement::Preserve,
        flush: FilterFlushMode::Reset,
    });
    nodes
}

#[derive(Default)]
struct SwrMixConverter {
    context: Option<SwrContext>,
    input_format: Option<DecodedAudioFormat>,
    output_format: Option<MixFormat>,
}

impl SwrMixConverter {
    fn process(
        &mut self,
        chunk: &DecodedAudioChunk,
        output_format: MixFormat,
        output: &mut Vec<f32>,
    ) -> Result<(), String> {
        if can_copy_directly(chunk.format, output_format) {
            if let DecodedAudioData::F32(samples) = &chunk.data {
                output.extend_from_slice(samples);
            }
            return Ok(());
        }

        self.ensure_context(chunk.format, output_format)?;
        let input_data = chunk_input_data(chunk);
        let input_frames = i32::try_from(chunk.frames)
            .map_err(|_| "decoded audio chunk is too large for swresample".to_string())?;
        let context = self
            .context
            .as_mut()
            .ok_or_else(|| "swresample context was not initialized".to_string())?;
        convert_with_swr(
            context,
            input_data.as_ptr(),
            input_frames,
            output_format.channels,
            output,
        )
    }

    fn finish(&mut self, output: &mut Vec<f32>) -> Result<(), String> {
        let Some(context) = self.context.as_mut() else {
            return Ok(());
        };
        let channels = self
            .output_format
            .map(|format| format.channels)
            .unwrap_or(2);
        let result = convert_with_swr(context, ptr::null(), 0, channels, output);
        self.context = None;
        self.input_format = None;
        self.output_format = None;
        result
    }

    fn ensure_context(
        &mut self,
        input_format: DecodedAudioFormat,
        output_format: MixFormat,
    ) -> Result<(), String> {
        if self.input_format == Some(input_format) && self.output_format == Some(output_format) {
            return Ok(());
        }
        if output_format.sample_format != AudioSampleFormat::F32 {
            return Err("audio graph currently requires f32 packed output".to_string());
        }
        let context = build_swr_context(input_format, output_format)?;
        self.context = Some(context);
        self.input_format = Some(input_format);
        self.output_format = Some(output_format);
        Ok(())
    }
}

fn can_copy_directly(input: DecodedAudioFormat, output: MixFormat) -> bool {
    input.sample_rate == output.sample_rate
        && input.sample_format == AudioSampleFormat::F32
        && input.channels == output.channels
        && output.sample_format == AudioSampleFormat::F32
}

fn build_swr_context(
    input_format: DecodedAudioFormat,
    output_format: MixFormat,
) -> Result<SwrContext, String> {
    let input_sample_format = av_sample_format(input_format.sample_format)?;
    let output_sample_format = av_sample_format(output_format.sample_format)?;
    let input_sample_rate = i32::try_from(input_format.sample_rate.max(1))
        .map_err(|_| "input sample rate is too large for swresample".to_string())?;
    let output_sample_rate = i32::try_from(output_format.sample_rate.max(1))
        .map_err(|_| "output sample rate is too large for swresample".to_string())?;
    let input_channels = i32::try_from(input_format.channels.max(1))
        .map_err(|_| "input channel count is too large for swresample".to_string())?;
    let output_channels = i32::try_from(output_format.channels.max(1))
        .map_err(|_| "output channel count is too large for swresample".to_string())?;

    unsafe {
        let mut input_layout = mem::zeroed::<sys::AVChannelLayout>();
        let mut output_layout = mem::zeroed::<sys::AVChannelLayout>();
        sys::av_channel_layout_default(&raw mut input_layout, input_channels);
        sys::av_channel_layout_default(&raw mut output_layout, output_channels);
        let result = SwrContext::new(
            &output_layout,
            output_sample_format,
            output_sample_rate,
            &input_layout,
            input_sample_format,
            input_sample_rate,
        )
        .map_err(|err| format!("failed to create audio graph converter: {err}"));
        sys::av_channel_layout_uninit(&raw mut input_layout);
        sys::av_channel_layout_uninit(&raw mut output_layout);
        result
    }
}

fn av_sample_format(format: AudioSampleFormat) -> Result<sys::AVSampleFormat, String> {
    match format {
        AudioSampleFormat::U8 => Ok(sys::AVSampleFormat_AV_SAMPLE_FMT_U8),
        AudioSampleFormat::S16 => Ok(sys::AVSampleFormat_AV_SAMPLE_FMT_S16),
        AudioSampleFormat::S32 => Ok(sys::AVSampleFormat_AV_SAMPLE_FMT_S32),
        AudioSampleFormat::F32 => Ok(sys::AVSampleFormat_AV_SAMPLE_FMT_FLT),
        AudioSampleFormat::F64 => Ok(sys::AVSampleFormat_AV_SAMPLE_FMT_DBL),
        AudioSampleFormat::Unknown => Err("unknown audio sample format".to_string()),
    }
}

fn chunk_input_data(chunk: &DecodedAudioChunk) -> [*const u8; 1] {
    match &chunk.data {
        DecodedAudioData::U8(samples) => [samples.as_ptr().cast::<u8>()],
        DecodedAudioData::I16(samples) => [samples.as_ptr().cast::<u8>()],
        DecodedAudioData::I32(samples) => [samples.as_ptr().cast::<u8>()],
        DecodedAudioData::F32(samples) => [samples.as_ptr().cast::<u8>()],
        DecodedAudioData::F64(samples) => [samples.as_ptr().cast::<u8>()],
    }
}

fn convert_with_swr(
    context: &mut SwrContext,
    input_data: *const *const u8,
    input_frames: i32,
    output_channels: usize,
    output: &mut Vec<f32>,
) -> Result<(), String> {
    let expected_frames = context
        .get_out_samples(input_frames)
        .map_err(|err| format!("failed to size audio graph converter output: {err}"))?;
    if expected_frames <= 0 {
        return Ok(());
    }
    let expected_samples = (expected_frames as usize)
        .checked_mul(output_channels.max(1))
        .ok_or_else(|| "audio graph converter output size overflowed".to_string())?;
    output.resize(expected_samples, 0.0);
    let byte_len = output
        .len()
        .checked_mul(mem::size_of::<f32>())
        .ok_or_else(|| "audio graph converter byte size overflowed".to_string())?;
    let actual_frames = unsafe {
        let output_bytes = std::slice::from_raw_parts_mut(
            output.as_mut_ptr().cast::<mem::MaybeUninit<u8>>(),
            byte_len,
        );
        context
            .convert_packed(input_data, input_frames, output_bytes)
            .map_err(|err| format!("failed to convert audio graph samples: {err}"))?
    };
    output.truncate(actual_frames.saturating_mul(output_channels.max(1)));
    for sample in output.iter_mut() {
        *sample = sample.clamp(-1.0, 1.0);
    }
    Ok(())
}

fn tempo_source_frames(output_samples: usize, speed: f32, channels: usize) -> u64 {
    let output_frames = output_samples / channels.max(1);
    ((output_frames as f64) * speed.clamp(MIN_SPEED, MAX_SPEED) as f64).round() as u64
}

fn append_graph_output(
    process_format: MixFormat,
    output_format: MixFormat,
    processed: &[f32],
    scratch: &mut Vec<f32>,
    output: &mut Vec<f32>,
) {
    if process_format.channels == output_format.channels {
        output.extend_from_slice(processed);
        return;
    }
    let input_channels = process_format.channels.max(1);
    let output_channels = output_format.channels.max(1);
    let frames = processed.len() / input_channels;
    scratch.clear();
    scratch.resize(frames * output_channels, 0.0);
    map_channels(processed, input_channels, scratch, output_channels);
    output.extend_from_slice(scratch);
}

fn soft_limit_interleaved(samples: &mut [f32]) {
    for sample in samples {
        *sample = soft_limit_sample(*sample);
    }
}

fn soft_limit_sample(sample: f32) -> f32 {
    const KNEE: f32 = 0.95;
    const RANGE: f32 = 1.0 - KNEE;
    if !sample.is_finite() {
        return 0.0;
    }
    let magnitude = sample.abs();
    if magnitude <= KNEE {
        return sample;
    }
    let limited = KNEE + RANGE * (1.0 - (-(magnitude - KNEE) / RANGE).exp());
    sample.signum() * limited.min(1.0)
}

fn map_channels(input: &[f32], input_channels: usize, output: &mut [f32], output_channels: usize) {
    let input_channels = input_channels.max(1);
    let output_channels = output_channels.max(1);
    for (frame_index, frame) in output.chunks_exact_mut(output_channels).enumerate() {
        let input_frame_start = frame_index * input_channels;
        if output_channels == 1 {
            let mut sum = 0.0;
            let mut count = 0usize;
            for sample in input
                .get(input_frame_start..input_frame_start + input_channels)
                .unwrap_or(&[])
            {
                sum += *sample;
                count += 1;
            }
            frame[0] = if count == 0 { 0.0 } else { sum / count as f32 };
            continue;
        }
        if input_channels == 1 {
            let sample = input.get(input_frame_start).copied().unwrap_or(0.0);
            for target in frame.iter_mut() {
                *target = sample;
            }
            continue;
        }
        let copy_channels = output_channels.min(input_channels);
        if let Some(input_frame) = input.get(input_frame_start..input_frame_start + input_channels)
        {
            frame[..copy_channels].copy_from_slice(&input_frame[..copy_channels]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::{AudioSampleFormat, MIX_CHANNELS};

    #[test]
    fn graph_converts_i16_mono_to_f32_stereo() {
        let mut graph =
            AudioFilterGraph::new(MixFormat::stereo_f32(48_000), &DspSettings::default())
                .expect("graph should initialize");
        let chunk = DecodedAudioChunk::new(
            DecodedAudioFormat {
                sample_rate: 48_000,
                sample_format: AudioSampleFormat::S16,
                channels: 1,
            },
            2,
            None,
            DecodedAudioData::I16(vec![16_384, -16_384]),
        );
        let mut output = Vec::new();

        graph
            .process_decoded(&chunk, &DspSettings::default(), &mut output)
            .expect("graph should process");

        assert_eq!(output.len(), 4);
        assert!((output[0] - 0.35355338).abs() < 0.00001);
        assert!((output[1] - 0.35355338).abs() < 0.00001);
        assert!((output[2] + 0.35355338).abs() < 0.00001);
        assert!((output[3] + 0.35355338).abs() < 0.00001);
    }

    #[test]
    fn graph_preserves_mono_when_stereo_dsp_is_not_required() {
        let mut graph = AudioFilterGraph::new(MixFormat::f32(48_000, 1), &DspSettings::default())
            .expect("graph should initialize");
        let chunk = DecodedAudioChunk::new(
            DecodedAudioFormat {
                sample_rate: 48_000,
                sample_format: AudioSampleFormat::F32,
                channels: 1,
            },
            3,
            None,
            DecodedAudioData::F32(vec![0.25, -0.25, 0.5]),
        );
        let mut output = Vec::new();

        let source_frames = graph
            .process_decoded(&chunk, &DspSettings::default(), &mut output)
            .expect("graph should process");

        assert_eq!(source_frames, 3);
        assert_eq!(output, vec![0.25, -0.25, 0.5]);
    }

    #[test]
    fn filter_nodes_declare_format_and_flush_semantics() {
        let mut settings = DspSettings::default();
        settings.equalizer[0] = 3.0;
        settings.normalization_gain_db = -4.0;

        let nodes = filter_nodes_for_settings(&settings);

        assert_eq!(
            nodes.iter().map(|node| node.kind).collect::<Vec<_>>(),
            vec![
                AudioFilterNodeKind::FormatConvert,
                AudioFilterNodeKind::Equalizer,
                AudioFilterNodeKind::Normalization,
                AudioFilterNodeKind::Tempo,
                AudioFilterNodeKind::Limiter,
            ]
        );
        assert!(nodes
            .iter()
            .all(|node| node.channels == ChannelRequirement::Preserve));
        assert_eq!(nodes[0].flush, FilterFlushMode::Drain);
        assert_eq!(nodes[1].flush, FilterFlushMode::Reset);
        assert_eq!(nodes[3].flush, FilterFlushMode::Drain);
    }

    #[test]
    fn graph_resamples_into_mix_rate() {
        let mut graph =
            AudioFilterGraph::new(MixFormat::stereo_f32(48_000), &DspSettings::default())
                .expect("graph should initialize");
        let frames = 1024usize;
        let mut samples = Vec::with_capacity(frames * MIX_CHANNELS);
        for frame in 0..frames {
            let value = frame as f32 / frames as f32;
            samples.push(value);
            samples.push(value);
        }
        let chunk = DecodedAudioChunk::new(
            DecodedAudioFormat {
                sample_rate: 24_000,
                sample_format: AudioSampleFormat::F32,
                channels: 2,
            },
            frames,
            None,
            DecodedAudioData::F32(samples),
        );
        let mut output = Vec::new();

        graph
            .process_decoded(&chunk, &DspSettings::default(), &mut output)
            .expect("graph should process");
        let mut total_output = output.clone();

        graph
            .finish(&DspSettings::default(), &mut output)
            .expect("graph should finish");
        total_output.extend_from_slice(&output);

        assert!(total_output.len() >= frames * MIX_CHANNELS);
        assert_eq!(total_output[0], 0.0);
        assert_eq!(total_output[1], 0.0);
    }

    #[test]
    fn soft_limiter_preserves_low_level_samples_and_limits_overload() {
        assert_eq!(soft_limit_sample(0.5), 0.5);
        assert_eq!(soft_limit_sample(-0.5), -0.5);
        assert!(soft_limit_sample(1.5) < 1.0);
        assert!(soft_limit_sample(1.5) > 0.95);
        assert!(soft_limit_sample(-1.5) > -1.0);
        assert!(soft_limit_sample(-1.5) < -0.95);
    }
}
