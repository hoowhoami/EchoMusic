use crate::audio_graph::AudioFilterGraph;
use crate::shared::{DecodedAudioChunk, SharedAudio};
use std::sync::mpsc::SyncSender;

#[derive(Debug, PartialEq)]
pub(crate) enum DeckFilterOperation {
    Preroll,
    Process {
        incoming: bool,
        chunk: DecodedAudioChunk,
    },
    Finish {
        incoming: bool,
    },
    Promote,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::DspSettings;
    use crate::shared::{AudioSampleFormat, DecodedAudioData, DecodedAudioFormat, MixFormat};

    fn chunk(sample_rate: u32, value: f32) -> DecodedAudioChunk {
        DecodedAudioChunk::new(
            DecodedAudioFormat {
                sample_rate,
                sample_format: AudioSampleFormat::F32,
                channels: 2,
            },
            4096,
            None,
            DecodedAudioData::F32(vec![value; 8192]),
        )
    }

    fn request(shared: &SharedAudio, operation: DeckFilterOperation) -> DeckFilterRequest {
        DeckFilterRequest {
            request_id: 1,
            generation: shared.current_decode_generation(),
            speed: shared.dsp_settings().speed,
            operation,
            reply: std::sync::mpsc::sync_channel(1).0,
        }
    }

    #[test]
    fn outgoing_nonlinear_dsp_precedes_transition_trim() {
        let settings = DspSettings::default();
        let format = MixFormat::stereo_f32(48_000);
        let shared = SharedAudio::new(format, 1.0, 8.0, &settings);
        let mut active = AudioFilterGraph::new(format, &settings).unwrap();
        let mut baseline = AudioFilterGraph::new(format, &settings).unwrap();
        let mut decks = IncomingDeckFilter::default();
        let a = chunk(48_000, 1.2);
        let mut normal = Vec::new();
        baseline
            .process_decoded(&a, &settings, &mut normal)
            .unwrap();
        let processed = decks
            .process(
                &mut active,
                &shared,
                &request(
                    &shared,
                    DeckFilterOperation::Process {
                        incoming: false,
                        chunk: a.clone(),
                    },
                ),
            )
            .unwrap();
        let norm_a = 10.0f32.powf(-9.3 / 20.0);
        let reference = 10.0f32.powf(-3.5 / 20.0);
        let trim = norm_a / reference;
        assert_eq!(processed.len(), normal.len());
        for (sample, baseline) in processed.iter().zip(&normal) {
            assert!((sample * trim * reference - baseline * norm_a).abs() < 1e-6);
        }
        // The former shared-graph order is observably louder even with B silent.
        let mut old_graph = AudioFilterGraph::new(format, &settings).unwrap();
        let mut old = Vec::new();
        old_graph
            .process_decoded(&chunk(48_000, 1.2 * trim), &settings, &mut old)
            .unwrap();
        assert!(old.last().unwrap() * reference > normal.last().unwrap() * norm_a * 1.1);
    }

    #[test]
    fn incoming_dsp_resampler_and_tempo_survive_handoff() {
        for speed in [0.75, 1.0, 1.25] {
            let settings = DspSettings {
                speed,
                equalizer: [6.0; 10],
                ..DspSettings::default()
            };
            let format = MixFormat::stereo_f32(48_000);
            let shared = SharedAudio::new(format, 1.0, 8.0, &settings);
            let mut active = AudioFilterGraph::new(format, &settings).unwrap();
            let mut reference = AudioFilterGraph::new(format, &settings).unwrap();
            let mut decks = IncomingDeckFilter::default();
            let mut expected = Vec::new();
            for value in [0.1, -0.2, 0.4] {
                let source = chunk(44_100, value);
                reference
                    .process_decoded(&source, &settings, &mut expected)
                    .unwrap();
                let actual = decks
                    .process(
                        &mut active,
                        &shared,
                        &request(
                            &shared,
                            DeckFilterOperation::Process {
                                incoming: true,
                                chunk: source,
                            },
                        ),
                    )
                    .unwrap();
                assert_eq!(actual, expected, "speed={speed}");
            }
            decks
                .process(
                    &mut active,
                    &shared,
                    &request(&shared, DeckFilterOperation::Promote),
                )
                .unwrap();
            let source = chunk(44_100, -0.1);
            reference
                .process_decoded(&source, &settings, &mut expected)
                .unwrap();
            let mut actual = Vec::new();
            active
                .process_decoded(&source, &settings, &mut actual)
                .unwrap();
            assert_eq!(
                actual, expected,
                "handoff must retain state at speed={speed}"
            );
        }
    }

    #[test]
    #[ignore = "requires ECHOMUSIC_TEST_DSP_PROVIDER to point to a built Provider library"]
    fn real_provider_keeps_both_decks_independent_and_continuous() {
        let settings = DspSettings {
            provider_path: Some(
                std::env::var("ECHOMUSIC_TEST_DSP_PROVIDER").expect("provider path"),
            ),
            provider_preset_json: Some(r#"{"presetId":"kugou-super-bass"}"#.to_string()),
            ..DspSettings::default()
        };
        let format = MixFormat::stereo_f32(192_000);
        let (settings, mut active) =
            crate::audio_graph::prepare_filter_graph(format, settings).unwrap();
        let shared = SharedAudio::new(format, 1.0, 8.0, &settings);
        let mut reference_a = AudioFilterGraph::new(format, &settings).unwrap();
        let mut reference_b = AudioFilterGraph::new(format, &settings).unwrap();
        let mut decks = IncomingDeckFilter::default();
        let mut expected = Vec::new();
        let mut actual = Vec::new();
        let mut peak = 0.0f32;
        for block in 0..36 {
            let make_chunk = |hz: f32| {
                let samples = (0..4096)
                    .flat_map(|frame| {
                        let sample = ((block * 4096 + frame) as f32 * hz * std::f32::consts::TAU
                            / 44_100.0)
                            .sin()
                            * 0.75;
                        [sample, sample]
                    })
                    .collect();
                let mut source = chunk(44_100, 0.0);
                source.data = DecodedAudioData::F32(samples);
                source
            };
            let a = make_chunk(440.0);
            reference_a
                .process_decoded(&a, &settings, &mut expected)
                .unwrap();
            if block < 12 {
                active.process_decoded(&a, &settings, &mut actual).unwrap();
            } else {
                actual = decks
                    .process(
                        &mut active,
                        &shared,
                        &request(
                            &shared,
                            DeckFilterOperation::Process {
                                incoming: false,
                                chunk: a,
                            },
                        ),
                    )
                    .unwrap();
            }
            assert_eq!(actual.len(), expected.len());
            assert!(
                actual
                    .iter()
                    .zip(&expected)
                    .all(|(a, b)| (a - b).abs() < 1e-5),
                "A block={block}"
            );
            if block >= 12 {
                let b = make_chunk(170.0);
                reference_b
                    .process_decoded(&b, &settings, &mut expected)
                    .unwrap();
                actual = decks
                    .process(
                        &mut active,
                        &shared,
                        &request(
                            &shared,
                            DeckFilterOperation::Process {
                                incoming: true,
                                chunk: b,
                            },
                        ),
                    )
                    .unwrap();
                assert_eq!(actual.len(), expected.len());
                assert!(
                    actual
                        .iter()
                        .zip(&expected)
                        .all(|(a, b)| (a - b).abs() < 1e-5),
                    "B block={block}"
                );
                peak = actual
                    .iter()
                    .fold(peak, |peak, sample| peak.max(sample.abs()));
            }
        }
        assert!(peak > 0.01, "provider output must not be silent");
        decks
            .process(
                &mut active,
                &shared,
                &request(&shared, DeckFilterOperation::Promote),
            )
            .unwrap();
        let b = chunk(44_100, 0.1);
        reference_b
            .process_decoded(&b, &settings, &mut expected)
            .unwrap();
        active.process_decoded(&b, &settings, &mut actual).unwrap();
        assert_eq!(actual.len(), expected.len());
        assert!(actual
            .iter()
            .zip(&expected)
            .all(|(a, b)| (a - b).abs() < 1e-5));
    }
}

#[derive(Debug)]
pub(crate) struct DeckFilterRequest {
    pub request_id: u64,
    pub generation: u64,
    pub speed: f32,
    pub operation: DeckFilterOperation,
    pub reply: SyncSender<Result<Vec<f32>, String>>,
}

impl PartialEq for DeckFilterRequest {
    fn eq(&self, other: &Self) -> bool {
        self.request_id == other.request_id
            && self.generation == other.generation
            && self.speed == other.speed
            && self.operation == other.operation
    }
}

// Owned exclusively by the filter worker. A is the existing live graph, never a copy.
#[derive(Default)]
pub(crate) struct IncomingDeckFilter {
    graph: Option<(u64, AudioFilterGraph)>,
    recent: std::collections::VecDeque<f32>,
    metered: [bool; 2],
    speed: f32,
}

impl IncomingDeckFilter {
    pub fn clear(&mut self) {
        self.graph = None;
        self.recent.clear();
        self.metered = [false; 2];
    }

    pub fn remember(&mut self, samples: &[f32], capacity: usize) {
        self.recent.extend(samples);
        let excess = self.recent.len().saturating_sub(capacity);
        self.recent.drain(..excess);
    }

    pub fn active_speed(&self) -> Option<f32> {
        self.graph.as_ref().map(|_| self.speed)
    }

    pub fn process(
        &mut self,
        active: &mut AudioFilterGraph,
        shared: &SharedAudio,
        request: &DeckFilterRequest,
    ) -> Result<Vec<f32>, String> {
        if !shared.is_decode_generation_current(request.generation) {
            return Err("transition DSP request cancelled by playback reset".to_string());
        }
        let mut settings = shared.dsp_settings();
        settings.speed = request.speed;
        if self
            .graph
            .as_ref()
            .is_none_or(|(id, _)| *id != request.request_id)
        {
            let started = std::time::Instant::now();
            self.graph = Some((
                request.request_id,
                AudioFilterGraph::new(shared.mix_format, &settings)?,
            ));
            self.metered = [false; 2];
            self.speed = request.speed;
            crate::decoder::emit_decode_info(shared, &format!(
                "transition DSP separated: request={} generation={} provider_enabled={} speed={:.3} a_state=retained b_state=new gain_stage=post-deck-dsp init_ms={:.3}",
                request.request_id, request.generation, settings.provider_path.is_some(), request.speed, started.elapsed().as_secs_f64() * 1000.0,
            ));
        }
        let incoming = &mut self.graph.as_mut().expect("incoming graph initialized").1;
        if incoming.process_format()
            != crate::audio_graph::process_format_for_output(shared.mix_format, &settings)
            || incoming.provider_identity() != settings.provider_path.as_deref()
            || incoming.provider_mode() != settings.provider_mode
            || incoming.provider_resource_identity() != settings.provider_resource_json.as_deref()
        {
            incoming.reset(shared.mix_format, &settings)?;
            crate::decoder::emit_decode_info(shared, &format!(
                "transition DSP reconfigured: request={} deck=B reason=structural-settings-change", request.request_id,
            ));
        }
        let mut output = Vec::new();
        match &request.operation {
            DeckFilterOperation::Preroll => output.extend(self.recent.iter().copied()),
            DeckFilterOperation::Process {
                incoming: is_incoming,
                chunk,
            } => {
                let graph = if *is_incoming { incoming } else { active };
                graph.update_settings(&settings)?;
                let started = std::time::Instant::now();
                graph.process_decoded(chunk, &settings, &mut output)?;
                let deck_index = usize::from(*is_incoming);
                if !self.metered[deck_index] && !output.is_empty() {
                    let peak = output
                        .iter()
                        .fold(0.0f32, |peak, value| peak.max(value.abs()));
                    let rms = (output
                        .iter()
                        .map(|value| f64::from(*value).powi(2))
                        .sum::<f64>()
                        / output.len() as f64)
                        .sqrt();
                    crate::decoder::emit_decode_info(shared, &format!(
                        "transition loudness deck: request={} deck={} frames={} dsp_peak={peak:.6} dsp_rms={rms:.6} dsp_latency_ms={:.3} processing_ms={:.3}",
                        request.request_id, if *is_incoming { "B" } else { "A" }, output.len() / shared.mix_format.channels.max(1),
                        graph.latency_secs() * 1000.0, started.elapsed().as_secs_f64() * 1000.0,
                    ));
                    self.metered[deck_index] = true;
                }
            }
            DeckFilterOperation::Finish {
                incoming: is_incoming,
            } => {
                let graph = if *is_incoming { incoming } else { active };
                graph.finish(&settings, &mut output)?;
            }
            DeckFilterOperation::Promote => {
                *active = self.graph.take().expect("incoming graph initialized").1;
                active.update_settings(&shared.dsp_settings())?;
                crate::decoder::emit_decode_info(shared, &format!(
                    "transition DSP handoff: request={} generation={} b_state=retained mixed_dsp_passes=0",
                    request.request_id, request.generation,
                ));
            }
        }
        Ok(output)
    }
}
