use super::*;
use crate::vpf::load_vpf;
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
        let speed = tempo::normalize_speed(self.speed);
        with_runtime(|runtime| {
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
        with_runtime(|runtime| {
            let mut next = [0.0f32; EQ_BAND_COUNT];
            for (index, value) in self.gains.iter().enumerate() {
                next[index] = value.clamp(-12.0, 12.0) as f32;
            }
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

fn reset_current_filter_for_audio_effect_change(runtime: &PlayerRuntime) {
    let Some(session) = runtime.session.as_ref() else {
        return;
    };
    session
        .shared
        .reset_filter_for_dsp_change(&runtime.dsp_settings);
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
        let (vpf_path, impulse_response_path) =
            parse_audio_effect_payload(&self.payload).map_err(napi::Error::from_reason)?;
        let (sample_rate, request_seq) = with_runtime(|runtime| {
            runtime.spatial_request_seq = runtime.spatial_request_seq.wrapping_add(1);
            Ok((
                runtime
                    .session
                    .as_ref()
                    .map(|session| session.shared.mix_format.sample_rate),
                runtime.spatial_request_seq,
            ))
        })?;

        let vpf = vpf_path
            .as_deref()
            .map(load_vpf)
            .transpose()
            .map_err(napi::Error::from_reason)?;
        let spatial = match (impulse_response_path.as_deref(), sample_rate) {
            (Some(path), Some(rate)) => {
                Some(prepare_spatial_effect(path, rate).map_err(napi::Error::from_reason)?)
            }
            _ => None,
        };

        with_runtime(|runtime| {
            if runtime.spatial_request_seq != request_seq {
                emit_runtime_event(
                    runtime,
                    PlayerEvent::log("debug", "stale audio effect load ignored".to_string()),
                );
                return Ok(());
            }
            runtime.spatial_file_path = impulse_response_path;
            runtime.dsp_settings.spatial = spatial;
            runtime.dsp_settings.vpf = vpf;
            reset_current_filter_for_audio_effect_change(runtime);
            update_runtime_audio_graph(runtime);
            emit_runtime_event(
                runtime,
                PlayerEvent::log(
                    "info",
                    format!(
                        "audio effect applied: vpf={}, impulse_response={}",
                        vpf_path.is_some(),
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
) -> Result<(Option<String>, Option<String>), String> {
    if payload.is_null() {
        return Ok((None, None));
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
    Ok((path("vpfPath")?, path("impulseResponsePath")?))
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
        with_runtime(|runtime| {
            runtime.dsp_settings.normalization_gain_db = self.gain_db.clamp(-40.0, 24.0) as f32;
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
