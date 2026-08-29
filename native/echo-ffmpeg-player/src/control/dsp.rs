use super::*;
use crate::audio_graph::AudioFilterGraph;
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;

pub struct SetSpeedTask {
    speed: f64,
}

impl Task for SetSpeedTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        ensure_finite_parameter(self.speed, "playback speed")?;
        let speed = tempo::normalize_speed(self.speed);
        call_core_command("set-speed", move |runtime| {
            if (runtime.dsp_settings.speed - speed).abs() < f32::EPSILON {
                return Ok(());
            }
            runtime.dsp_settings.speed = speed;
            let Some(session) = runtime.session.as_ref() else {
                return Ok(());
            };
            session
                .shared
                .reset_filter_for_dsp_change(&runtime.dsp_settings);
            let position = session.shared.position_secs();
            update_runtime_audio_graph(runtime);
            emit_runtime_event(runtime, PlayerEvent::time_update(position));
            Ok(())
        })
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn set_speed(speed: f64) -> AsyncTask<SetSpeedTask> {
    AsyncTask::new(SetSpeedTask { speed })
}

pub struct SetEqualizerTask {
    gains: Vec<f64>,
}

impl Task for SetEqualizerTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        if self.gains.len() != EQ_BAND_COUNT {
            return Err(napi::Error::from_reason(format!(
                "equalizer requires exactly {EQ_BAND_COUNT} gains"
            )));
        }
        if self.gains.iter().any(|value| !value.is_finite()) {
            return Err(napi::Error::from_reason(
                "equalizer gains must be finite".to_string(),
            ));
        }
        let mut next = [0.0f32; EQ_BAND_COUNT];
        for (index, value) in self.gains.iter().enumerate() {
            next[index] = value.clamp(-12.0, 12.0) as f32;
        }
        call_core_command("set-equalizer", move |runtime| {
            runtime.dsp_settings.equalizer = next;
            sync_current_session_dsp_settings(runtime);
            update_runtime_audio_graph(runtime);
            Ok(())
        })
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn set_equalizer(gains: Vec<f64>) -> AsyncTask<SetEqualizerTask> {
    AsyncTask::new(SetEqualizerTask { gains })
}

pub(crate) fn sync_current_session_dsp_settings(runtime: &PlayerRuntime) {
    if let Some(session) = runtime.session.as_ref() {
        session.shared.update_dsp_settings(&runtime.dsp_settings);
    }
}

pub(crate) fn prepare_dsp_settings_for_mix_rate(
    mut settings: DspSettings,
    spatial_file_path: Option<&str>,
    mix_sample_rate: u32,
) -> Result<DspSettings, String> {
    let Some(file_path) = spatial_file_path else {
        settings.spatial = None;
        return Ok(settings);
    };

    let can_reuse = settings.spatial.as_ref().is_some_and(|spatial| {
        spatial.file_path == file_path && spatial.sample_rate() == mix_sample_rate
    });
    if can_reuse {
        return Ok(settings);
    }

    settings.spatial = Some(prepare_spatial_effect(file_path, mix_sample_rate)?);
    Ok(settings)
}

pub struct SetAudioEffectTask {
    payload: serde_json::Value,
}

impl Task for SetAudioEffectTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let (
            impulse_response_path,
            provider_path,
            provider_preset_json,
            provider_resource_json,
            provider_mode,
            impulse_response_mix,
        ) = parse_audio_effect_payload(&self.payload).map_err(napi::Error::from_reason)?;
        let has_provider_resources = provider_resource_json.is_some();
        let provider_resource_json = provider_path.as_ref().map(|_| {
            let mut resources = provider_resource_json
                .as_deref()
                .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            if let Some(path) = impulse_response_path.as_deref() {
                resources.push(serde_json::json!({
                    "kind": "impulse-response",
                    "path": path,
                }));
            }
            serde_json::Value::Array(resources).to_string()
        });
        let (mix_format, request_seq, base_settings, session_shared) =
            call_core_command("begin-audio-effect", |runtime| {
                runtime.spatial_request_seq = runtime.spatial_request_seq.wrapping_add(1);
                Ok((
                    runtime
                        .session
                        .as_ref()
                        .map(|session| session.shared.mix_format)
                        .unwrap_or_else(|| MixFormat::stereo_f32(48_000)),
                    runtime.spatial_request_seq,
                    runtime.dsp_settings.clone(),
                    runtime
                        .session
                        .as_ref()
                        .map(|session| session.shared.clone()),
                ))
            })?;

        if has_provider_resources && provider_path.is_none() {
            return Err(napi::Error::from_reason(
                "该音效资源需要外部 Provider，当前 Basic DSP 不支持".to_string(),
            ));
        }
        let spatial = match (
            provider_path.is_none(),
            impulse_response_path.as_deref(),
            Some(mix_format.sample_rate),
        ) {
            (true, Some(path), Some(rate)) => {
                Some(prepare_spatial_effect(path, rate).map_err(napi::Error::from_reason)?)
            }
            _ => None,
        };

        // Provider creation happens on the filter thread. Validate the complete
        // candidate graph first so a bad VPF/IRS is rejected by this command
        // while the currently playing graph remains untouched.
        let mut candidate = base_settings;
        candidate.provider_path = provider_path.clone();
        candidate.provider_preset_json = provider_preset_json.clone();
        candidate.provider_resource_json = provider_resource_json.clone();
        candidate.provider_mode = provider_mode;
        candidate.spatial = spatial.clone();
        candidate.spatial_mix = impulse_response_mix;
        let mut prepared_graph =
            Some(AudioFilterGraph::new(mix_format, &candidate).map_err(napi::Error::from_reason)?);

        call_core_command("commit-audio-effect", move |runtime| {
            if runtime.spatial_request_seq != request_seq {
                emit_runtime_event(
                    runtime,
                    PlayerEvent::log("debug", "stale audio effect load ignored".to_string()),
                );
                return Ok(());
            }
            let current_shared = runtime
                .session
                .as_ref()
                .map(|session| session.shared.clone());
            if session_shared
                .as_ref()
                .zip(current_shared.as_ref())
                .is_some_and(|(before, current)| !Arc::ptr_eq(before, current))
                || session_shared.is_some() != current_shared.is_some()
            {
                return Err(napi::Error::from_reason(
                    "audio session changed while preparing effect".to_string(),
                ));
            }
            runtime.spatial_file_path = impulse_response_path;
            runtime.dsp_settings.provider_path = provider_path;
            runtime.dsp_settings.provider_preset_json = provider_preset_json;
            runtime.dsp_settings.provider_resource_json = provider_resource_json;
            runtime.dsp_settings.provider_mode = provider_mode;
            runtime.dsp_settings.spatial = spatial;
            runtime.dsp_settings.spatial_mix = impulse_response_mix;
            if let Some(shared) = current_shared {
                shared.stage_audio_effect_graph(
                    &runtime.dsp_settings,
                    prepared_graph
                        .take()
                        .expect("prepared graph is consumed exactly once"),
                );
            }
            update_runtime_audio_graph(runtime);
            emit_runtime_event(
                runtime,
                PlayerEvent::log(
                    "info",
                    format!(
                        "audio effect applied: provider={}, impulse_response={}",
                        runtime.dsp_settings.provider_path.is_some(),
                        runtime.spatial_file_path.is_some()
                    ),
                ),
            );
            Ok(())
        })
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

fn parse_audio_effect_payload(
    payload: &serde_json::Value,
) -> Result<
    (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        u32,
        f32,
    ),
    String,
> {
    if payload.is_null() {
        return Ok((None, None, None, None, 0, 0.5));
    }
    let object = payload
        .as_object()
        .ok_or_else(|| "invalid audio effect payload".to_string())?;
    let path = |name: &str| -> Result<Option<String>, String> {
        match object.get(name) {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(serde_json::Value::String(value)) => {
                let value = value.trim();
                Ok((!value.is_empty()).then(|| value.to_string()))
            }
            _ => Err(format!("invalid audio effect path: {name}")),
        }
    };
    let impulse_response_path = path("impulseResponsePath")?;
    let provider_path = path("providerPath")?;
    let provider_preset_json = match object.get("providerPresetJson") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(value)) => Some(value.clone()),
        _ => return Err("invalid provider preset".to_string()),
    };
    let provider_resource_json = object
        .get("providerResources")
        .filter(|value| !value.is_null())
        .map(serde_json::Value::to_string);
    let provider_mode = match object.get("providerMode") {
        None | Some(serde_json::Value::Null) => 1,
        Some(serde_json::Value::String(value)) if value == "speaker" => 1,
        Some(serde_json::Value::String(value)) if value == "headphone" => 0,
        _ => return Err("invalid provider mode".to_string()),
    };
    let impulse_response_mix = match object.get("impulseResponseMix") {
        None | Some(serde_json::Value::Null) => 0.5,
        Some(serde_json::Value::Number(value)) => value
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| "invalid impulse response mix".to_string())?
            .clamp(0.0, 1.0) as f32,
        _ => return Err("invalid impulse response mix".to_string()),
    };
    Ok((
        impulse_response_path,
        provider_path,
        provider_preset_json,
        provider_resource_json,
        provider_mode,
        impulse_response_mix,
    ))
}

#[napi]
pub fn set_audio_effect(payload: serde_json::Value) -> AsyncTask<SetAudioEffectTask> {
    AsyncTask::new(SetAudioEffectTask { payload })
}

pub struct SetNormalizationGainTask {
    gain_db: f64,
}

impl Task for SetNormalizationGainTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        ensure_finite_parameter(self.gain_db, "normalization gain")?;
        let gain_db = self.gain_db.clamp(-40.0, 24.0) as f32;
        call_core_command("set-normalization-gain", move |runtime| {
            runtime.dsp_settings.normalization_gain_db = gain_db;
            sync_current_session_dsp_settings(runtime);
            update_runtime_audio_graph(runtime);
            Ok(())
        })
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn set_normalization_gain(gain_db: f64) -> AsyncTask<SetNormalizationGainTask> {
    AsyncTask::new(SetNormalizationGainTask { gain_db })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_effect_payload_normalizes_basic_dsp_mix() {
        let payload = serde_json::json!({
            "impulseResponsePath": "/tmp/test.wav",
            "impulseResponseMix": 1.5,
        });
        let parsed = parse_audio_effect_payload(&payload).expect("payload should parse");
        assert_eq!(parsed.5, 1.0);

        let defaulted = parse_audio_effect_payload(&serde_json::json!({
            "impulseResponsePath": "/tmp/test.wav"
        }))
        .expect("payload should default");
        assert_eq!(defaulted.5, 0.5);
    }

    #[test]
    fn audio_effect_payload_rejects_non_numeric_mix() {
        let payload = serde_json::json!({
            "impulseResponsePath": "/tmp/test.wav",
            "impulseResponseMix": "50%",
        });
        assert!(parse_audio_effect_payload(&payload).is_err());
    }
}
