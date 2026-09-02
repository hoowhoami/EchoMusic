use crate::dsp::provider::ProviderDescriptor;
use crate::dsp::{DspChain, DspSettings};
use crate::shared::{
    AudioOutputStats, AudioSampleFormat, DecodedAudioChunk, DecodedAudioData, DecodedAudioFormat,
    MixFormat,
};
use crate::tempo::{TempoProcessor, MAX_SPEED, MIN_SPEED};
use ffmpeg_audio::{sys, SwrContext};
use napi_derive::napi;
use std::{mem, ptr};

pub struct AudioFilterGraph {
    output_format: MixFormat,
    process_format: MixFormat,
    nodes: Vec<AudioFilterNode>,
    converter: SwrMixConverter,
    output_converter: SwrGraphOutputConverter,
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

#[napi(object)]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AudioGraphFormatSnapshot {
    pub sample_rate: f64,
    pub channels: f64,
    pub sample_format: String,
}

#[napi(object)]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AudioGraphNodeParameterSnapshot {
    pub name: String,
    pub value: String,
    pub unit: Option<String>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub runtime_editable: bool,
}

#[napi(object)]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AudioGraphNodeSnapshot {
    pub kind: String,
    pub channel_requirement: String,
    pub flush_mode: String,
    pub reinit_on_format_change: bool,
    pub latency_secs: f64,
    pub runtime_editable: bool,
    pub parameters: Vec<AudioGraphNodeParameterSnapshot>,
}

#[napi(object)]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AudioGraphDeviceOutputSnapshot {
    pub backend: String,
    pub format: AudioGraphFormatSnapshot,
    pub buffer_mode: Option<String>,
    pub buffer_secs: f64,
    pub requested_buffer_secs: Option<f64>,
    pub device_buffer_secs: Option<f64>,
    pub software_buffer_secs: Option<f64>,
    pub delay_secs: f64,
    pub underruns: f64,
}

#[napi(object)]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AudioGraphSnapshot {
    pub revision: f64,
    pub process_format: AudioGraphFormatSnapshot,
    pub output_format: AudioGraphFormatSnapshot,
    pub device_output: Option<AudioGraphDeviceOutputSnapshot>,
    pub latency_secs: f64,
    pub nodes: Vec<AudioGraphNodeSnapshot>,
    pub provider_id: Option<String>,
    pub provider_version: Option<String>,
    pub provider_path: Option<String>,
    pub provider_mode: Option<String>,
    pub provider_resource_json: Option<String>,
    pub provider_preset_json: Option<String>,
    pub provider_latency_frames: Option<f64>,
    pub provider_preferred_block_frames: Option<f64>,
    pub provider_manifest_json: Option<String>,
    pub provider_state_json: Option<String>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct AudioGraphParameterPatch {
    pub kind: String,
    pub name: String,
    pub value: f64,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct AudioGraphNodePlanPatch {
    pub kind: String,
    pub enabled: Option<bool>,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct AudioGraphPlanPatch {
    pub nodes: Option<Vec<AudioGraphNodePlanPatch>>,
    pub patches: Vec<AudioGraphParameterPatch>,
}

#[cfg(test)]
fn snapshot_filter_graph(output_format: MixFormat, settings: &DspSettings) -> AudioGraphSnapshot {
    snapshot_filter_graph_with_device_output(output_format, settings, None, None)
}

pub fn snapshot_filter_graph_with_device_output(
    output_format: MixFormat,
    settings: &DspSettings,
    device_output: Option<&AudioOutputStats>,
    running_provider: Option<&ProviderDescriptor>,
) -> AudioGraphSnapshot {
    let process_format = process_format_for_output(output_format, settings);
    let tempo_latency_secs = TempoProcessor::new(
        settings.speed,
        process_format.sample_rate,
        process_format.channels,
    )
    .map(|tempo| tempo.latency_secs(process_format.sample_rate))
    .unwrap_or_default();
    // A diagnostic snapshot must not instantiate a Provider: creation can load resources and
    // initialize a full DSP engine. Provider metadata comes from the active filter graph instead.
    let builtin_effects = settings.provider_path.is_none().then(|| {
        DspChain::new(
            process_format.sample_rate,
            process_format.channels,
            settings,
        )
        .expect("builtin audio graph should initialize")
    });
    let effect_latency_secs = running_provider
        .map(|provider| {
            f64::from(provider.latency_frames) / f64::from(process_format.sample_rate.max(1))
        })
        .or_else(|| builtin_effects.as_ref().map(DspChain::latency_secs))
        .unwrap_or_default();
    let spatial_latency_secs = builtin_effects
        .as_ref()
        .map(DspChain::spatial_latency_secs)
        .unwrap_or_default();
    let latency_secs = tempo_latency_secs + effect_latency_secs;
    AudioGraphSnapshot {
        revision: 0.0,
        process_format: format_snapshot(process_format),
        output_format: format_snapshot(output_format),
        device_output: device_output.map(device_output_snapshot),
        latency_secs,
        nodes: filter_nodes_for_settings(settings)
            .into_iter()
            .map(|node| {
                graph_node_snapshot(node, settings, tempo_latency_secs, spatial_latency_secs)
            })
            .collect(),
        provider_id: running_provider.map(|info| info.id.clone()),
        provider_version: running_provider.map(|info| info.version.clone()),
        provider_path: settings.provider_path.clone(),
        provider_mode: settings.provider_path.as_ref().map(|_| {
            if settings.provider_mode == 1 {
                "speaker".to_string()
            } else {
                "headphone".to_string()
            }
        }),
        provider_resource_json: settings.provider_resource_json.clone(),
        provider_preset_json: settings.provider_preset_json.clone(),
        provider_latency_frames: running_provider.map(|info| f64::from(info.latency_frames)),
        provider_preferred_block_frames: running_provider
            .map(|info| f64::from(info.preferred_block_frames)),
        provider_manifest_json: running_provider.map(|info| info.manifest_json.clone()),
        provider_state_json: running_provider.map(|info| info.state_json.clone()),
    }
}

fn device_output_snapshot(stats: &AudioOutputStats) -> AudioGraphDeviceOutputSnapshot {
    AudioGraphDeviceOutputSnapshot {
        backend: stats.backend.clone(),
        format: AudioGraphFormatSnapshot {
            sample_rate: stats.sample_rate,
            channels: stats.channels,
            sample_format: stats.format.clone(),
        },
        buffer_mode: Some(stats.buffer_mode.clone()),
        buffer_secs: stats.buffer_secs.max(0.0),
        requested_buffer_secs: Some(stats.requested_buffer_secs.max(0.0)),
        device_buffer_secs: Some(stats.device_buffer_secs.max(0.0)),
        software_buffer_secs: Some(stats.software_buffer_secs.max(0.0)),
        delay_secs: stats.delay_secs.max(0.0),
        underruns: stats.underruns.max(0.0),
    }
}

fn format_snapshot(format: MixFormat) -> AudioGraphFormatSnapshot {
    AudioGraphFormatSnapshot {
        sample_rate: f64::from(format.sample_rate),
        channels: format.channels as f64,
        sample_format: format.sample_format.as_str().to_string(),
    }
}

impl ChannelRequirement {
    fn as_str(self) -> &'static str {
        match self {
            Self::Preserve => "preserve",
            Self::Stereo => "stereo",
        }
    }
}

impl FilterFlushMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Drain => "drain",
            Self::Reset => "reset",
        }
    }
}

impl AudioFilterNodeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::FormatConvert => "format-convert",
            Self::Tempo => "tempo",
            Self::Equalizer => "equalizer",
            Self::Spatial => "spatial",
            Self::Normalization => "normalization",
            Self::Limiter => "limiter",
        }
    }
}

impl AudioSampleFormat {
    fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::U8 => "u8",
            Self::S16 => "s16",
            Self::S32 => "s32",
            Self::F32 => "f32",
            Self::F64 => "f64",
        }
    }
}

fn graph_node_snapshot(
    node: AudioFilterNode,
    settings: &DspSettings,
    tempo_latency_secs: f64,
    spatial_latency_secs: f64,
) -> AudioGraphNodeSnapshot {
    let latency_secs = match node.kind {
        AudioFilterNodeKind::Tempo => tempo_latency_secs,
        AudioFilterNodeKind::Spatial => spatial_latency_secs,
        _ => 0.0,
    };
    let parameters = graph_node_parameters(node.kind, settings);
    AudioGraphNodeSnapshot {
        kind: node.kind.as_str().to_string(),
        channel_requirement: node.channels.as_str().to_string(),
        flush_mode: node.flush.as_str().to_string(),
        reinit_on_format_change: matches!(node.flush, FilterFlushMode::Reset),
        latency_secs,
        runtime_editable: node_kind_runtime_editable(node.kind),
        parameters,
    }
}

fn graph_node_parameters(
    kind: AudioFilterNodeKind,
    settings: &DspSettings,
) -> Vec<AudioGraphNodeParameterSnapshot> {
    match kind {
        AudioFilterNodeKind::Equalizer => settings
            .equalizer
            .iter()
            .enumerate()
            .filter(|(_, gain)| gain.abs() >= 0.05)
            .map(|(index, gain)| AudioGraphNodeParameterSnapshot {
                name: format!("band{index}"),
                value: format!("{gain:.2}"),
                unit: Some("dB".to_string()),
                min: Some(-12.0),
                max: Some(12.0),
                runtime_editable: true,
            })
            .collect(),
        AudioFilterNodeKind::Spatial => {
            let Some(spatial) = settings.spatial.as_ref() else {
                return Vec::new();
            };
            vec![
                AudioGraphNodeParameterSnapshot {
                    name: "mix".to_string(),
                    value: format!("{:.3}", settings.spatial_mix),
                    unit: None,
                    min: Some(0.0),
                    max: Some(1.0),
                    runtime_editable: true,
                },
                AudioGraphNodeParameterSnapshot {
                    name: "mode".to_string(),
                    value: spatial.mode().to_string(),
                    unit: None,
                    min: None,
                    max: None,
                    runtime_editable: false,
                },
                AudioGraphNodeParameterSnapshot {
                    name: "peak-response".to_string(),
                    value: format!("{:.2}", spatial.peak_response_db()),
                    unit: Some("dB".to_string()),
                    min: None,
                    max: None,
                    runtime_editable: false,
                },
                AudioGraphNodeParameterSnapshot {
                    name: "duration".to_string(),
                    value: format!("{:.2}", spatial.duration_secs() * 1_000.0),
                    unit: Some("ms".to_string()),
                    min: Some(0.0),
                    max: None,
                    runtime_editable: false,
                },
            ]
        }
        AudioFilterNodeKind::Normalization => vec![AudioGraphNodeParameterSnapshot {
            name: "gain".to_string(),
            value: format!("{:.2}", settings.normalization_gain_db),
            unit: Some("dB".to_string()),
            min: Some(-40.0),
            max: Some(24.0),
            runtime_editable: true,
        }],
        AudioFilterNodeKind::Tempo => vec![AudioGraphNodeParameterSnapshot {
            name: "speed".to_string(),
            value: format!("{:.3}", settings.speed),
            unit: None,
            min: Some(f64::from(MIN_SPEED)),
            max: Some(f64::from(MAX_SPEED)),
            runtime_editable: true,
        }],
        AudioFilterNodeKind::FormatConvert | AudioFilterNodeKind::Limiter => Vec::new(),
    }
}

fn node_kind_runtime_editable(kind: AudioFilterNodeKind) -> bool {
    matches!(
        kind,
        AudioFilterNodeKind::Equalizer
            | AudioFilterNodeKind::Spatial
            | AudioFilterNodeKind::Normalization
            | AudioFilterNodeKind::Tempo
    )
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
            output_converter: SwrGraphOutputConverter::default(),
            tempo: TempoProcessor::new(
                settings.speed,
                process_format.sample_rate,
                process_format.channels,
            )?,
            effects: DspChain::new(
                process_format.sample_rate,
                process_format.channels,
                settings,
            )?,
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
        let process_format = process_format_for_output(output_format, settings);
        if self.output_format == output_format
            && self.process_format == process_format
            && self.effects.can_reset_state(settings)
        {
            // Prepare the new fallible tempo state first, then reset effects, and only commit
            // converter/tempo after both operations succeed. This keeps the existing graph
            // intact if construction or the in-place reset is rejected.
            let next_tempo = TempoProcessor::new(
                settings.speed,
                process_format.sample_rate,
                process_format.channels,
            )?;
            self.effects.reset_state(settings)?;
            self.converter = SwrMixConverter::default();
            self.output_converter = SwrGraphOutputConverter::default();
            self.tempo = next_tempo;
            self.nodes = filter_nodes_for_settings(settings);
            self.converted_output.clear();
            self.processed_output.clear();
            self.mapped_output.clear();
            return Ok(());
        }
        *self = Self::new(output_format, settings)?;
        Ok(())
    }

    /// Apply DSP setting changes without rebuilding the graph or sample converter.
    /// The caller keeps already-produced output as the old-settings hand-off tail; the tempo
    /// processor drains its own pending state when speed changes so source frames are not lost.
    /// Does **not** recreate `SwrMixConverter`, `DspChain`, or internal buffers.
    pub fn update_settings(&mut self, settings: &DspSettings) -> Result<(), String> {
        self.tempo.set_speed(settings.speed)?;
        self.effects.update_settings(settings)?;
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
        self.effects.update_settings(settings)?;
        self.effects
            .process_interleaved(&mut self.converted_output)?;
        output.extend_from_slice(&self.converted_output);

        self.process_graph_output(output)
    }

    pub fn finish(&mut self, settings: &DspSettings, output: &mut Vec<f32>) -> Result<u64, String> {
        output.clear();
        let mut source_frames = 0u64;
        self.converted_output.clear();
        self.converter.finish(&mut self.converted_output)?;
        if !self.converted_output.is_empty() {
            self.effects.update_settings(settings)?;
            self.effects
                .process_interleaved(&mut self.converted_output)?;
            output.extend_from_slice(&self.converted_output);
            source_frames = source_frames.saturating_add(self.process_graph_output(output)?);
        }

        self.converted_output.clear();
        self.effects.drain(&mut self.converted_output)?;
        if !self.converted_output.is_empty() {
            let mut effect_tail = std::mem::take(&mut self.converted_output);
            // A drained tail has no new source frames, but it must still pass through tempo and
            // final peak protection before it reaches the output queue.
            self.process_graph_output(&mut effect_tail)?;
            output.extend_from_slice(&effect_tail);
        }

        self.processed_output.clear();
        self.tempo.finish_into(&mut self.processed_output)?;
        if !self.processed_output.is_empty() {
            soft_limit_interleaved(&mut self.processed_output);
            source_frames = source_frames.saturating_add(tempo_source_frames(
                self.processed_output.len(),
                self.tempo.speed(),
                self.process_format,
                self.output_format,
            ));
            self.output_converter.process(
                self.process_format,
                self.output_format,
                &self.processed_output,
                &mut self.mapped_output,
                output,
            )?;
        }
        self.mapped_output.clear();
        self.output_converter.finish(&mut self.mapped_output)?;
        output.extend_from_slice(&self.mapped_output);
        Ok(source_frames)
    }

    /// The internal processing format (sample rate and channel layout) that the graph currently
    /// operates in.  Used by the filter thread to decide whether a generation bump requires a
    /// full graph rebuild or can be handled via a lightweight parameter update.
    pub fn process_format(&self) -> MixFormat {
        self.process_format
    }

    pub fn provider_identity(&self) -> Option<&str> {
        self.effects.provider_identity()
    }

    pub fn provider_mode(&self) -> u32 {
        self.effects.provider_mode()
    }

    pub fn provider_resource_identity(&self) -> Option<&str> {
        self.effects.provider_resource_identity()
    }

    pub fn provider_descriptor(&self) -> Option<ProviderDescriptor> {
        self.effects.provider_descriptor()
    }

    pub fn latency_secs(&self) -> f64 {
        self.converter.latency_secs()
            + self.tempo.latency_secs(self.process_format.sample_rate)
            + self.effects.latency_secs()
            + self.output_converter.latency_secs()
    }

    fn process_graph_output(&mut self, output: &mut Vec<f32>) -> Result<u64, String> {
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
        let speed = self.tempo.speed();
        self.processed_output.clear();
        self.tempo
            .process_into(output, &mut self.processed_output)?;
        soft_limit_interleaved(&mut self.processed_output);
        let source_frames = tempo_source_frames(
            self.processed_output.len(),
            speed,
            self.process_format,
            self.output_format,
        );
        output.clear();
        self.output_converter.process(
            self.process_format,
            self.output_format,
            &self.processed_output,
            &mut self.mapped_output,
            output,
        )?;
        Ok(source_frames)
    }
}

pub fn process_format_for_output(output_format: MixFormat, settings: &DspSettings) -> MixFormat {
    if settings.requires_stereo_graph()
        || filter_nodes_for_settings(settings)
            .iter()
            .any(|node| node.channels == ChannelRequirement::Stereo)
    {
        MixFormat::stereo_f32(
            settings
                .provider_path
                .as_ref()
                .and(settings.provider_process_sample_rate)
                .unwrap_or(output_format.sample_rate),
        )
    } else {
        output_format
    }
}

/// Build a graph whose external format remains fixed while a Provider may run at an independent
/// supported sample rate. Provider construction is intentionally done here, off the filter/audio
/// callback threads, so failed candidates never disturb the active graph.
pub fn prepare_filter_graph(
    output_format: MixFormat,
    mut settings: DspSettings,
) -> Result<(DspSettings, AudioFilterGraph), String> {
    if settings.provider_path.is_none() {
        settings.provider_process_sample_rate = None;
        let graph = AudioFilterGraph::new(output_format, &settings)?;
        return Ok((settings, graph));
    }

    let mut sample_rates = Vec::with_capacity(5);
    for sample_rate in [
        settings.provider_process_sample_rate,
        Some(output_format.sample_rate),
        Some(96_000),
        Some(48_000),
        Some(44_100),
    ]
    .into_iter()
    .flatten()
    {
        let sample_rate = sample_rate.max(1);
        if !sample_rates.contains(&sample_rate) {
            sample_rates.push(sample_rate);
        }
    }

    let mut last_error = None;
    for sample_rate in sample_rates {
        let mut candidate = settings.clone();
        candidate.provider_process_sample_rate = Some(sample_rate);
        match AudioFilterGraph::new(output_format, &candidate) {
            Ok(graph)
                if provider_manifest_supports_sample_rate(
                    &graph,
                    candidate.provider_preset_json.as_deref(),
                    sample_rate,
                ) =>
            {
                return Ok((candidate, graph));
            }
            Ok(_) => {
                last_error = Some(format!(
                    "DSP provider preset does not support {sample_rate} Hz"
                ));
            }
            Err(err) => last_error = Some(err),
        }
    }
    Err(last_error.unwrap_or_else(|| "failed to prepare audio filter graph".to_string()))
}

fn provider_manifest_supports_sample_rate(
    graph: &AudioFilterGraph,
    preset_json: Option<&str>,
    sample_rate: u32,
) -> bool {
    let Some(preset_id) = preset_json
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .and_then(|value| {
            value
                .get("presetId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
    else {
        return true;
    };
    let Some(manifest) = graph.provider_descriptor().and_then(|descriptor| {
        serde_json::from_str::<serde_json::Value>(&descriptor.manifest_json).ok()
    }) else {
        return true;
    };
    let Some(supported_rates) = manifest
        .get("presets")
        .and_then(serde_json::Value::as_array)
        .and_then(|presets| {
            presets.iter().find(|preset| {
                preset.get("id").and_then(serde_json::Value::as_str) == Some(preset_id.as_str())
            })
        })
        .and_then(|preset| preset.get("supportedSampleRates"))
        .and_then(serde_json::Value::as_array)
    else {
        return true;
    };
    supported_rates
        .iter()
        .filter_map(serde_json::Value::as_u64)
        .any(|rate| rate == u64::from(sample_rate))
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
            flush: FilterFlushMode::Drain,
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

    fn latency_secs(&self) -> f64 {
        let sample_rate = self
            .output_format
            .map(|format| format.sample_rate)
            .unwrap_or(1)
            .max(1);
        self.context
            .as_ref()
            .map(|context| context.delay(i64::from(sample_rate)) as f64 / f64::from(sample_rate))
            .unwrap_or_default()
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
        *sample = if sample.is_finite() {
            sample.clamp(-1.0, 1.0)
        } else {
            0.0
        };
    }
    Ok(())
}

fn tempo_source_frames(
    output_samples: usize,
    speed: f32,
    process_format: MixFormat,
    output_format: MixFormat,
) -> u64 {
    let process_frames = output_samples / process_format.channels.max(1);
    let engine_frames = process_frames as f64 * f64::from(output_format.sample_rate.max(1))
        / f64::from(process_format.sample_rate.max(1));
    (engine_frames * speed.clamp(MIN_SPEED, MAX_SPEED) as f64).round() as u64
}

#[derive(Default)]
struct SwrGraphOutputConverter {
    context: Option<SwrContext>,
    input_format: Option<MixFormat>,
    output_format: Option<MixFormat>,
}

impl SwrGraphOutputConverter {
    fn process(
        &mut self,
        input_format: MixFormat,
        output_format: MixFormat,
        input: &[f32],
        scratch: &mut Vec<f32>,
        output: &mut Vec<f32>,
    ) -> Result<(), String> {
        if input.is_empty() {
            return Ok(());
        }
        if input_format == output_format {
            output.extend_from_slice(input);
            return Ok(());
        }
        self.ensure_context(input_format, output_format)?;
        let frames = input.len() / input_format.channels.max(1);
        let input_frames = i32::try_from(frames)
            .map_err(|_| "audio graph output chunk is too large".to_string())?;
        let input_data = [input.as_ptr().cast::<u8>()];
        scratch.clear();
        convert_with_swr(
            self.context
                .as_mut()
                .ok_or_else(|| "audio graph output resampler was not initialized".to_string())?,
            input_data.as_ptr(),
            input_frames,
            output_format.channels,
            scratch,
        )?;
        output.extend_from_slice(scratch);
        Ok(())
    }

    fn finish(&mut self, output: &mut Vec<f32>) -> Result<(), String> {
        let Some(context) = self.context.as_mut() else {
            return Ok(());
        };
        let channels = self
            .output_format
            .map(|format| format.channels)
            .unwrap_or(2);
        convert_with_swr(context, ptr::null(), 0, channels, output)?;
        self.context = None;
        self.input_format = None;
        self.output_format = None;
        Ok(())
    }

    fn latency_secs(&self) -> f64 {
        let sample_rate = self
            .output_format
            .map(|format| format.sample_rate)
            .unwrap_or(1)
            .max(1);
        self.context
            .as_ref()
            .map(|context| context.delay(i64::from(sample_rate)) as f64 / f64::from(sample_rate))
            .unwrap_or_default()
    }

    fn ensure_context(
        &mut self,
        input_format: MixFormat,
        output_format: MixFormat,
    ) -> Result<(), String> {
        if self.input_format == Some(input_format) && self.output_format == Some(output_format) {
            return Ok(());
        }
        let decoded_input = DecodedAudioFormat {
            sample_rate: input_format.sample_rate,
            sample_format: input_format.sample_format,
            channels: input_format.channels,
        };
        self.context = Some(build_swr_context(decoded_input, output_format)?);
        self.input_format = Some(input_format);
        self.output_format = Some(output_format);
        Ok(())
    }
}

fn soft_limit_interleaved(samples: &mut [f32]) {
    for sample in samples {
        *sample = soft_limit_sample(*sample);
    }
}

pub(crate) fn soft_limit_sample(sample: f32) -> f32 {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::basic::prepared_spatial_effect_for_test;
    use crate::shared::{AudioSampleFormat, MIX_CHANNELS};

    #[test]
    fn provider_process_rate_is_independent_from_engine_output_rate() {
        let settings = DspSettings {
            provider_path: Some("provider.dylib".to_string()),
            provider_process_sample_rate: Some(96_000),
            ..DspSettings::default()
        };

        let process = process_format_for_output(MixFormat::stereo_f32(192_000), &settings);

        assert_eq!(process.sample_rate, 96_000);
        assert_eq!(process.channels, 2);
    }

    #[test]
    fn dsp_process_frames_are_credited_on_the_engine_clock() {
        assert_eq!(
            tempo_source_frames(
                96_000 * MIX_CHANNELS,
                1.0,
                MixFormat::stereo_f32(96_000),
                MixFormat::stereo_f32(192_000),
            ),
            192_000
        );
        assert_eq!(
            tempo_source_frames(
                48_000 * MIX_CHANNELS,
                2.0,
                MixFormat::stereo_f32(48_000),
                MixFormat::stereo_f32(44_100),
            ),
            88_200
        );
    }

    #[test]
    fn graph_output_resampler_preserves_duration_across_chunk_boundaries() {
        let input_format = MixFormat::stereo_f32(96_000);
        let output_format = MixFormat::stereo_f32(192_000);
        let mut converter = SwrGraphOutputConverter::default();
        let mut scratch = Vec::new();
        let mut output = Vec::new();
        let chunk_frames = 960usize;
        let chunk = vec![0.25f32; chunk_frames * MIX_CHANNELS];

        for _ in 0..3 {
            converter
                .process(
                    input_format,
                    output_format,
                    &chunk,
                    &mut scratch,
                    &mut output,
                )
                .expect("DSP output resampling should succeed");
        }
        scratch.clear();
        converter
            .finish(&mut scratch)
            .expect("DSP output resampler should flush");
        output.extend_from_slice(&scratch);

        let expected_frames = chunk_frames * 3 * 2;
        let actual_frames = output.len() / MIX_CHANNELS;
        assert!(actual_frames.abs_diff(expected_frames) <= 2);
        assert!(output.iter().all(|sample| sample.is_finite()));
        assert!(output
            .iter()
            .skip(MIX_CHANNELS * 64)
            .take(MIX_CHANNELS * 256)
            .all(|sample| (*sample - 0.25).abs() < 0.001));
    }

    #[test]
    #[ignore = "requires ECHOMUSIC_TEST_DSP_PROVIDER to point to a built Provider library"]
    fn real_provider_runs_on_independent_bus_at_high_engine_rate() {
        let provider_path = std::env::var("ECHOMUSIC_TEST_DSP_PROVIDER")
            .expect("ECHOMUSIC_TEST_DSP_PROVIDER must point to a Provider library");
        let settings = DspSettings {
            provider_path: Some(provider_path),
            provider_preset_json: Some(r#"{"presetId":"kugou-super-bass"}"#.to_string()),
            ..DspSettings::default()
        };
        let engine_format = MixFormat::stereo_f32(192_000);
        let (settings, mut graph) = prepare_filter_graph(engine_format, settings)
            .expect("Provider graph should negotiate an independent rate");

        assert_eq!(settings.provider_process_sample_rate, Some(96_000));
        assert_eq!(graph.process_format(), MixFormat::stereo_f32(96_000));
        assert_eq!(graph.output_format, engine_format);
        assert!(graph.provider_descriptor().is_some());

        let chunk_frames = 1_920usize;
        let samples = (0..chunk_frames)
            .flat_map(|frame| {
                let phase = frame as f32 * 440.0 * std::f32::consts::TAU / 192_000.0;
                let sample = phase.sin() * 0.05;
                [sample, sample]
            })
            .collect::<Vec<_>>();
        let chunk = DecodedAudioChunk::new(
            DecodedAudioFormat {
                sample_rate: 192_000,
                sample_format: AudioSampleFormat::F32,
                channels: MIX_CHANNELS,
            },
            chunk_frames,
            None,
            DecodedAudioData::F32(samples),
        );
        let mut output = Vec::new();
        let mut output_frames = 0usize;
        let mut source_frames = 0u64;
        for _ in 0..8 {
            source_frames += graph
                .process_decoded(&chunk, &settings, &mut output)
                .expect("Provider graph should process high-rate input");
            assert!(output.iter().all(|sample| sample.is_finite()));
            output_frames += output.len() / MIX_CHANNELS;
        }
        source_frames += graph
            .finish(&settings, &mut output)
            .expect("Provider graph should drain");
        assert!(output.iter().all(|sample| sample.is_finite()));
        output_frames += output.len() / MIX_CHANNELS;

        let input_frames = chunk_frames * 8;
        assert!(output_frames.abs_diff(input_frames) <= 8);
        assert_eq!(source_frames, input_frames as u64);
    }

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
    fn graph_snapshot_exposes_structured_node_metadata() {
        let mut settings = DspSettings::default();
        settings.equalizer[1] = 2.0;
        settings.speed = 1.5;

        let snapshot = snapshot_filter_graph(MixFormat::stereo_f32(48_000), &settings);

        assert_eq!(snapshot.process_format.sample_rate, 48_000.0);
        assert_eq!(snapshot.process_format.channels, 2.0);
        assert_eq!(snapshot.process_format.sample_format, "f32");
        assert_eq!(snapshot.output_format.sample_rate, 48_000.0);
        assert!(snapshot.latency_secs > 0.0);
        assert_eq!(
            snapshot
                .nodes
                .iter()
                .map(|node| node.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["format-convert", "equalizer", "tempo", "limiter"]
        );
        assert_eq!(snapshot.nodes[1].flush_mode, "reset");
        assert!(snapshot.nodes[1].reinit_on_format_change);
        assert!(snapshot.nodes[1].runtime_editable);
        assert_eq!(snapshot.nodes[1].parameters[0].name, "band1");
        assert_eq!(snapshot.nodes[1].parameters[0].unit.as_deref(), Some("dB"));
        assert_eq!(snapshot.nodes[2].parameters[0].name, "speed");
        assert!(snapshot.nodes[2].latency_secs > 0.0);
    }

    #[test]
    fn graph_snapshot_exposes_basic_spatial_safety_metadata() {
        let settings = DspSettings {
            spatial: Some(prepared_spatial_effect_for_test(
                2,
                &[&[1.0, 0.5], &[1.0, 0.5]],
            )),
            ..DspSettings::default()
        };

        let snapshot = snapshot_filter_graph(MixFormat::stereo_f32(48_000), &settings);
        let spatial = snapshot
            .nodes
            .iter()
            .find(|node| node.kind == "spatial")
            .expect("spatial node should be present");
        assert_eq!(spatial.flush_mode, "drain");
        assert_eq!(
            spatial
                .parameters
                .iter()
                .map(|parameter| parameter.name.as_str())
                .collect::<Vec<_>>(),
            vec!["mix", "mode", "peak-response", "duration"]
        );
        let mix = spatial
            .parameters
            .iter()
            .find(|parameter| parameter.name == "mix")
            .expect("mix parameter should be present");
        assert_eq!(mix.value, "1.000");
        assert!(mix.runtime_editable);
    }

    #[test]
    fn graph_snapshot_includes_runtime_device_output_when_available() {
        let stats = AudioOutputStats {
            backend: "cpal".to_string(),
            sample_rate: 44_100.0,
            engine_sample_rate: 48_000.0,
            channels: 2.0,
            format: "f32".to_string(),
            buffer_mode: "fixed(512)".to_string(),
            buffer_frames: 512.0,
            buffer_secs: 512.0 / 44_100.0,
            requested_buffer_secs: 0.02,
            device_buffer_secs: 512.0 / 44_100.0,
            software_buffer_secs: 0.02 - (512.0 / 44_100.0),
            ao_buffer_target_secs: 0.02,
            ao_buffer_capacity_secs: 2.0,
            ao_request_frames: 0.0,
            delay_secs: 0.02,
            underruns: 3.0,
        };

        let snapshot = snapshot_filter_graph_with_device_output(
            MixFormat::stereo_f32(48_000),
            &DspSettings::default(),
            Some(&stats),
            None,
        );

        let device_output = snapshot
            .device_output
            .expect("runtime device output should be present");
        assert_eq!(device_output.backend, "cpal");
        assert_eq!(device_output.buffer_mode.as_deref(), Some("fixed(512)"));
        assert_eq!(device_output.format.sample_rate, 44_100.0);
        assert_eq!(device_output.format.sample_format, "f32");
        assert_eq!(device_output.underruns, 3.0);
    }

    #[test]
    fn provider_snapshot_uses_running_descriptor_without_loading_provider_path() {
        let settings = DspSettings {
            provider_path: Some("/definitely/not/a/provider.dylib".to_string()),
            provider_preset_json: Some(r#"{"presetId":"test"}"#.to_string()),
            provider_resource_json: Some(r#"[{"kind":"impulse-response"}]"#.to_string()),
            ..DspSettings::default()
        };
        let descriptor = ProviderDescriptor {
            id: "running-provider".to_string(),
            version: "1.2.3".to_string(),
            latency_frames: 480,
            preferred_block_frames: 512,
            manifest_json: "{}".to_string(),
            state_json: r#"{"latencyFrames":480}"#.to_string(),
            ..ProviderDescriptor::default()
        };

        let snapshot = snapshot_filter_graph_with_device_output(
            MixFormat::stereo_f32(48_000),
            &settings,
            None,
            Some(&descriptor),
        );

        assert_eq!(snapshot.provider_id.as_deref(), Some("running-provider"));
        assert_eq!(snapshot.provider_path, settings.provider_path);
        assert_eq!(snapshot.provider_latency_frames, Some(480.0));
        assert_eq!(snapshot.latency_secs, 0.01);
    }

    #[test]
    fn idle_provider_snapshot_has_no_provider_creation_side_effects() {
        let settings = DspSettings {
            provider_path: Some("/definitely/not/a/provider.dylib".to_string()),
            ..DspSettings::default()
        };

        let snapshot = snapshot_filter_graph_with_device_output(
            MixFormat::stereo_f32(48_000),
            &settings,
            None,
            None,
        );

        assert_eq!(snapshot.provider_path, settings.provider_path);
        assert_eq!(snapshot.provider_id, None);
        assert_eq!(snapshot.provider_latency_frames, None);
    }

    #[test]
    fn graph_resamples_into_mix_rate() {
        let mut graph =
            AudioFilterGraph::new(MixFormat::stereo_f32(48_000), &DspSettings::default())
                .expect("graph should initialize");
        let frames = 48_000usize;
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
    fn graph_finish_drains_complete_basic_spatial_tail() {
        let settings = DspSettings {
            spatial: Some(prepared_spatial_effect_for_test(
                2,
                &[&[0.5, 0.25], &[0.5, 0.25]],
            )),
            spatial_mix: 1.0,
            ..DspSettings::default()
        };
        let mut graph = AudioFilterGraph::new(MixFormat::stereo_f32(48_000), &settings)
            .expect("graph should initialize");
        let first_tail_frame = (graph.latency_secs() * 48_000.0).round() as usize - 1;
        let chunk = DecodedAudioChunk::new(
            DecodedAudioFormat {
                sample_rate: 48_000,
                sample_format: AudioSampleFormat::F32,
                channels: 2,
            },
            1,
            None,
            DecodedAudioData::F32(vec![0.4, -0.2]),
        );
        let mut output = Vec::new();

        graph
            .process_decoded(&chunk, &settings, &mut output)
            .expect("graph should process");
        assert_eq!(output, vec![0.0, 0.0]);

        let source_frames = graph
            .finish(&settings, &mut output)
            .expect("graph should drain");
        assert_eq!(source_frames, 0);
        assert_eq!(output.len() / 2, first_tail_frame + 2);
        assert!((output[first_tail_frame * 2] - 0.2).abs() < 0.00001);
        assert!((output[first_tail_frame * 2 + 1] + 0.1).abs() < 0.00001);
        assert!((output[(first_tail_frame + 1) * 2] - 0.1).abs() < 0.00001);
        assert!((output[(first_tail_frame + 1) * 2 + 1] + 0.05).abs() < 0.00001);

        let spatial = filter_nodes_for_settings(&settings)
            .into_iter()
            .find(|node| node.kind == AudioFilterNodeKind::Spatial)
            .expect("spatial node should be present");
        assert_eq!(spatial.flush, FilterFlushMode::Drain);
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

    #[test]
    fn update_settings_preserves_process_format_and_changes_tempo() {
        let mut graph =
            AudioFilterGraph::new(MixFormat::stereo_f32(48_000), &DspSettings::default())
                .expect("graph should initialize");
        let original_format = graph.process_format();

        let settings = DspSettings {
            speed: 2.0,
            ..DspSettings::default()
        };

        // update_settings should NOT rebuild the graph; process_format must stay the same.
        graph
            .update_settings(&settings)
            .expect("update_settings should succeed");
        assert_eq!(
            graph.process_format(),
            original_format,
            "process_format must not change after a lightweight speed update"
        );

        // After a full reset with the same settings, process_format should match as well.
        graph
            .reset(MixFormat::stereo_f32(48_000), &DspSettings::default())
            .expect("reset should succeed");
        assert_eq!(
            graph.process_format(),
            original_format,
            "process_format must match after a full reset with identical settings"
        );

        // Verify that the speed actually took effect by processing audio.
        let frames = 48_000usize;
        let mut samples = Vec::with_capacity(frames * MIX_CHANNELS);
        for frame in 0..frames {
            let value = frame as f32 / frames as f32;
            samples.push(value);
            samples.push(value);
        }
        let chunk = DecodedAudioChunk::new(
            DecodedAudioFormat {
                sample_rate: 48_000,
                sample_format: AudioSampleFormat::F32,
                channels: 2,
            },
            frames,
            None,
            DecodedAudioData::F32(samples),
        );

        // Process at 1x speed with fresh graph.
        let mut graph_1x =
            AudioFilterGraph::new(MixFormat::stereo_f32(48_000), &DspSettings::default())
                .expect("graph should initialize");
        let mut out_1x = Vec::new();
        graph_1x
            .process_decoded(&chunk, &DspSettings::default(), &mut out_1x)
            .expect("1x process should succeed");
        let mut tail_1x = Vec::new();
        graph_1x
            .finish(&DspSettings::default(), &mut tail_1x)
            .expect("1x finish should succeed");
        out_1x.extend(tail_1x);

        // Same input, same graph, but update_settings(2.0 speed) before processing.
        let mut graph_2x =
            AudioFilterGraph::new(MixFormat::stereo_f32(48_000), &DspSettings::default())
                .expect("graph should initialize");
        let settings_2x = DspSettings {
            speed: 2.0,
            ..DspSettings::default()
        };
        graph_2x
            .update_settings(&settings_2x)
            .expect("update_settings should succeed");
        let mut out_2x = Vec::new();
        graph_2x
            .process_decoded(&chunk, &settings_2x, &mut out_2x)
            .expect("2x process should succeed");
        let mut tail_2x = Vec::new();
        graph_2x
            .finish(&settings_2x, &mut tail_2x)
            .expect("2x finish should succeed");
        out_2x.extend(tail_2x);

        // 2x speed should produce fewer output frames. The exact byte count depends on
        // SoundTouch internals, but the key invariant is that update_settings updates tempo
        // without changing the graph process format.
        assert!(
            out_2x.len() < out_1x.len(),
            "2x speed should produce less output than 1x speed: {} vs {}",
            out_2x.len(),
            out_1x.len()
        );
    }
}
