use super::*;
use crate::audio_graph::{
    AudioGraphNodePlanPatch, AudioGraphParameterPatch, AudioGraphPlanPatch, AudioGraphSnapshot,
};
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;

#[napi]
pub fn get_audio_graph() -> napi::Result<AudioGraphSnapshot> {
    with_runtime(|runtime| Ok(runtime.audio_graph.clone()))
}

pub struct SetAudioGraphParameterTask {
    patch: AudioGraphParameterPatch,
}

pub struct SetAudioGraphPlanTask {
    plan: AudioGraphPlanPatch,
}

impl Task for SetAudioGraphParameterTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_runtime(|runtime| apply_audio_graph_parameter_patches(runtime, &[self.patch.clone()]))
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

impl Task for SetAudioGraphPlanTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_runtime(|runtime| apply_audio_graph_plan_patch(runtime, &self.plan))
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

struct GraphPatchEffects {
    changed: bool,
    tempo_changed: bool,
    spatial_resource_changed: bool,
}

#[derive(Clone)]
struct GraphPlanDraft {
    dsp_settings: DspSettings,
    spatial_file_path: Option<String>,
}

fn apply_audio_graph_parameter_patches(
    runtime: &mut PlayerRuntime,
    patches: &[AudioGraphParameterPatch],
) -> napi::Result<()> {
    apply_audio_graph_plan_parts(runtime, None, patches)
}

fn apply_audio_graph_plan_patch(
    runtime: &mut PlayerRuntime,
    plan: &AudioGraphPlanPatch,
) -> napi::Result<()> {
    apply_audio_graph_plan_parts(runtime, plan.nodes.as_deref(), &plan.patches)
}

fn apply_audio_graph_plan_parts(
    runtime: &mut PlayerRuntime,
    nodes: Option<&[AudioGraphNodePlanPatch]>,
    patches: &[AudioGraphParameterPatch],
) -> napi::Result<()> {
    if nodes.is_none_or(|nodes| nodes.is_empty()) && patches.is_empty() {
        return Ok(());
    }
    let mut effects = GraphPatchEffects {
        changed: false,
        tempo_changed: false,
        spatial_resource_changed: false,
    };
    let mut draft = GraphPlanDraft {
        dsp_settings: runtime.dsp_settings.clone(),
        spatial_file_path: runtime.spatial_file_path.clone(),
    };
    if let Some(nodes) = nodes {
        for node in nodes {
            apply_audio_graph_node_patch_to_draft(&mut draft, node, &mut effects)?;
        }
    }
    for patch in patches {
        apply_audio_graph_parameter_patch_to_draft(&mut draft, patch, &mut effects)?;
    }
    if !effects.changed {
        return Ok(());
    }
    runtime.dsp_settings = draft.dsp_settings;
    runtime.spatial_file_path = draft.spatial_file_path;
    if effects.spatial_resource_changed {
        runtime.spatial_request_seq = runtime.spatial_request_seq.wrapping_add(1);
    }
    if effects.tempo_changed {
        if let Some(session) = runtime.session.as_ref() {
            session
                .shared
                .reset_filter_for_dsp_change(&runtime.dsp_settings);
            let position = session.shared.position_secs();
            update_runtime_audio_graph(runtime);
            emit_runtime_event(runtime, PlayerEvent::time_update(position));
        } else {
            update_runtime_audio_graph(runtime);
        }
    } else {
        sync_current_session_dsp_settings(runtime);
        update_runtime_audio_graph(runtime);
    }
    Ok(())
}

fn apply_audio_graph_node_patch_to_draft(
    draft: &mut GraphPlanDraft,
    node: &AudioGraphNodePlanPatch,
    effects: &mut GraphPatchEffects,
) -> napi::Result<()> {
    let Some(enabled) = node.enabled else {
        return Ok(());
    };
    match node.kind.trim() {
        "equalizer" => {
            if !enabled
                && draft
                    .dsp_settings
                    .equalizer
                    .iter()
                    .any(|gain| gain.abs() >= 0.05)
            {
                draft.dsp_settings.equalizer = [0.0; EQ_BAND_COUNT];
                effects.changed = true;
            }
            Ok(())
        }
        "normalization" => {
            if !enabled && draft.dsp_settings.normalization_gain_db.abs() >= 0.01 {
                draft.dsp_settings.normalization_gain_db = 0.0;
                effects.changed = true;
            }
            Ok(())
        }
        "spatial" => {
            if enabled {
                if draft.dsp_settings.spatial.is_none() {
                    return Err(napi::Error::from_reason(
                        "spatial node requires an impulse response resource".to_string(),
                    ));
                }
                return Ok(());
            }
            if draft.dsp_settings.spatial.is_some() || draft.spatial_file_path.is_some() {
                draft.spatial_file_path = None;
                draft.dsp_settings.spatial = None;
                effects.changed = true;
                effects.spatial_resource_changed = true;
            }
            Ok(())
        }
        "vpf" => {
            if enabled {
                if draft.dsp_settings.vpf.is_none() {
                    return Err(napi::Error::from_reason(
                        "vpf node requires a VPF resource".to_string(),
                    ));
                }
                return Ok(());
            }
            if draft.dsp_settings.vpf.take().is_some() {
                effects.changed = true;
            }
            Ok(())
        }
        "tempo" => {
            if !enabled && (draft.dsp_settings.speed - 1.0).abs() >= f32::EPSILON {
                draft.dsp_settings.speed = 1.0;
                effects.changed = true;
                effects.tempo_changed = true;
            }
            Ok(())
        }
        "format-convert" | "limiter" => {
            if enabled {
                return Ok(());
            }
            Err(napi::Error::from_reason(format!(
                "audio graph node '{}' cannot be disabled",
                node.kind
            )))
        }
        _ => Err(napi::Error::from_reason(format!(
            "unsupported audio graph node '{}'",
            node.kind
        ))),
    }
}

fn apply_audio_graph_parameter_patch_to_draft(
    draft: &mut GraphPlanDraft,
    patch: &AudioGraphParameterPatch,
    effects: &mut GraphPatchEffects,
) -> napi::Result<()> {
    let kind = patch.kind.trim();
    let name = patch.name.trim();
    match kind {
        "tempo" if name == "speed" => {
            let speed = tempo::normalize_speed(patch.value);
            if (draft.dsp_settings.speed - speed).abs() < f32::EPSILON {
                return Ok(());
            }
            draft.dsp_settings.speed = speed;
            effects.changed = true;
            effects.tempo_changed = true;
            Ok(())
        }
        "equalizer" => {
            let index = parse_equalizer_band_name(name)?;
            let value = patch.value.clamp(-12.0, 12.0) as f32;
            if (draft.dsp_settings.equalizer[index] - value).abs() < f32::EPSILON {
                return Ok(());
            }
            draft.dsp_settings.equalizer[index] = value;
            effects.changed = true;
            Ok(())
        }
        "normalization" if name == "gain" => {
            let value = patch.value.clamp(-40.0, 24.0) as f32;
            if (draft.dsp_settings.normalization_gain_db - value).abs() < f32::EPSILON {
                return Ok(());
            }
            draft.dsp_settings.normalization_gain_db = value;
            effects.changed = true;
            Ok(())
        }
        _ => Err(napi::Error::from_reason(format!(
            "unsupported audio graph parameter '{}.{}'",
            patch.kind, patch.name
        ))),
    }
}

fn parse_equalizer_band_name(name: &str) -> napi::Result<usize> {
    let Some(suffix) = name.strip_prefix("band") else {
        return Err(napi::Error::from_reason(format!(
            "unsupported equalizer parameter '{name}'"
        )));
    };
    let index = suffix
        .parse::<usize>()
        .map_err(|_| napi::Error::from_reason(format!("invalid equalizer band '{name}")))?;
    if index >= EQ_BAND_COUNT {
        return Err(napi::Error::from_reason(format!(
            "equalizer band index out of range: {index}"
        )));
    }
    Ok(index)
}

#[napi]
pub fn set_audio_graph_parameter(
    patch: AudioGraphParameterPatch,
) -> AsyncTask<SetAudioGraphParameterTask> {
    AsyncTask::new(SetAudioGraphParameterTask { patch })
}

#[napi]
pub fn set_audio_graph_plan(plan: AudioGraphPlanPatch) -> AsyncTask<SetAudioGraphPlanTask> {
    AsyncTask::new(SetAudioGraphPlanTask { plan })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_graph_plan_is_transactional_when_validation_fails() {
        let mut runtime = PlayerRuntime::new(PlayerConfig::default());
        runtime.dsp_settings.equalizer[0] = 3.0;
        runtime.dsp_settings.normalization_gain_db = -4.0;
        let before_settings = runtime.dsp_settings.clone();

        let plan = AudioGraphPlanPatch {
            nodes: Some(vec![AudioGraphNodePlanPatch {
                kind: "equalizer".to_string(),
                enabled: Some(false),
            }]),
            patches: vec![AudioGraphParameterPatch {
                kind: "equalizer".to_string(),
                name: "band99".to_string(),
                value: 6.0,
            }],
        };

        let err = apply_audio_graph_plan_patch(&mut runtime, &plan)
            .expect_err("invalid patch should reject the whole plan");

        assert!(err.reason.contains("equalizer band index out of range"));
        assert_eq!(runtime.dsp_settings.equalizer, before_settings.equalizer);
        assert_eq!(
            runtime.dsp_settings.normalization_gain_db,
            before_settings.normalization_gain_db
        );
        assert_eq!(runtime.audio_graph_revision, 0);
    }

    #[test]
    fn audio_graph_plan_commits_nodes_and_parameters_together() {
        let mut runtime = PlayerRuntime::new(PlayerConfig::default());
        runtime.dsp_settings.equalizer[0] = 3.0;
        runtime.dsp_settings.normalization_gain_db = -4.0;
        runtime.dsp_settings.speed = 1.5;
        runtime.spatial_file_path = Some("room.wav".to_string());
        runtime.spatial_request_seq = 7;

        let plan = AudioGraphPlanPatch {
            nodes: Some(vec![
                AudioGraphNodePlanPatch {
                    kind: "equalizer".to_string(),
                    enabled: Some(false),
                },
                AudioGraphNodePlanPatch {
                    kind: "tempo".to_string(),
                    enabled: Some(false),
                },
                AudioGraphNodePlanPatch {
                    kind: "spatial".to_string(),
                    enabled: Some(false),
                },
            ]),
            patches: vec![AudioGraphParameterPatch {
                kind: "normalization".to_string(),
                name: "gain".to_string(),
                value: 2.5,
            }],
        };

        apply_audio_graph_plan_patch(&mut runtime, &plan).expect("valid plan should commit");

        assert_eq!(runtime.dsp_settings.equalizer, [0.0; EQ_BAND_COUNT]);
        assert_eq!(runtime.dsp_settings.speed, 1.0);
        assert_eq!(runtime.dsp_settings.normalization_gain_db, 2.5);
        assert!(runtime.spatial_file_path.is_none());
        assert_eq!(runtime.spatial_request_seq, 8);
        assert_eq!(runtime.audio_graph_revision, 0);
    }
}
