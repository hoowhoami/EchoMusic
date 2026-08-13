use super::*;
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
        with_runtime(|runtime| {
            let mut next = [0.0f32; EQ_BAND_COUNT];
            for (index, value) in self.gains.iter().take(EQ_BAND_COUNT).enumerate() {
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

pub struct SetImpulseResponseTask {
    payload: serde_json::Value,
}

impl Task for SetImpulseResponseTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let Some((file_path, mix)) =
            parse_impulse_response_payload(&self.payload).map_err(napi::Error::from_reason)?
        else {
            with_runtime(|runtime| {
                runtime.spatial_request_seq = runtime.spatial_request_seq.wrapping_add(1);
                runtime.spatial_file_path = None;
                runtime.dsp_settings.spatial = None;
                sync_current_session_dsp_settings(runtime);
                update_runtime_audio_graph(runtime);
                emit_runtime_event(
                    runtime,
                    PlayerEvent::log("info", "impulse response disabled".to_string()),
                );
                Ok(())
            })?;
            return Ok(());
        };

        let prepare = with_runtime(|runtime| {
            runtime.spatial_request_seq = runtime.spatial_request_seq.wrapping_add(1);
            runtime.spatial_mix = clamp_spatial_mix(mix);
            runtime.spatial_file_path = Some(file_path.clone());
            let Some(session) = runtime.session.as_ref() else {
                runtime.dsp_settings.spatial = None;
                emit_runtime_event(
                    runtime,
                    PlayerEvent::log(
                        "info",
                        format!(
                            "impulse response pending: path='{file_path}', mix={:.2}",
                            runtime.spatial_mix
                        ),
                    ),
                );
                return Ok(None);
            };
            let sample_rate = session.shared.mix_format.sample_rate;

            let can_reuse_current = runtime
                .dsp_settings
                .spatial
                .as_ref()
                .is_some_and(|spatial| {
                    spatial.file_path == file_path && spatial.sample_rate() == sample_rate
                });
            if can_reuse_current {
                update_spatial_mix(runtime, mix);
                return Ok(None);
            }

            Ok(Some((sample_rate, runtime.spatial_request_seq)))
        })?;

        let Some((sample_rate, request_seq)) = prepare else {
            return Ok(());
        };

        let spatial = match prepare_spatial_effect(&file_path, mix, sample_rate) {
            Ok(spatial) => spatial,
            Err(err) => {
                emit_event(PlayerEvent::impulse_response_disabled(err.clone()));
                with_runtime(|runtime| {
                    if runtime.spatial_request_seq == request_seq {
                        runtime.spatial_file_path = None;
                        runtime.dsp_settings.spatial = None;
                        sync_current_session_dsp_settings(runtime);
                        update_runtime_audio_graph(runtime);
                    }
                    Ok(())
                })?;
                return Err(napi::Error::from_reason(err));
            }
        };

        with_runtime(|runtime| {
            if runtime.spatial_request_seq != request_seq {
                emit_runtime_event(
                    runtime,
                    PlayerEvent::log("debug", "stale impulse response load ignored".to_string()),
                );
                return Ok(());
            }
            let mut spatial = spatial;
            spatial.mix = runtime.spatial_mix;
            let spatial_path = spatial.file_path.clone();
            let spatial_mix = spatial.mix;
            let spatial_sample_rate = spatial.sample_rate();
            let spatial_channels = spatial.channels();
            let spatial_mode = spatial.mode();
            apply_prepared_spatial_effect(runtime, spatial);
            emit_runtime_event(
                runtime,
                PlayerEvent::log(
                    "info",
                    format!(
                        "impulse response enabled: path='{spatial_path}', mix={spatial_mix:.2}, mix_sample_rate={spatial_sample_rate}, ir_channels={spatial_channels}, mode={spatial_mode}"
                    ),
                ),
            );
            Ok(())
        })?;
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

fn apply_prepared_spatial_effect(runtime: &mut PlayerRuntime, spatial: PreparedSpatialEffect) {
    runtime.dsp_settings.spatial = Some(spatial);
    sync_current_session_dsp_settings(runtime);
    reset_current_filter_if_process_format_changed(runtime);
    update_runtime_audio_graph(runtime);
}

pub(crate) fn sync_current_session_dsp_settings(runtime: &PlayerRuntime) {
    if let Some(session) = runtime.session.as_ref() {
        session.shared.update_dsp_settings(&runtime.dsp_settings);
    }
}

fn reset_current_filter_if_process_format_changed(runtime: &PlayerRuntime) {
    let Some(session) = runtime.session.as_ref() else {
        return;
    };
    if runtime.dsp_settings.requires_stereo_graph() && session.shared.mix_format.channels != 2 {
        session
            .shared
            .reset_filter_for_dsp_change(&runtime.dsp_settings);
    }
}

pub(crate) fn prepare_dsp_settings_for_mix_rate(
    mut settings: DspSettings,
    spatial_file_path: Option<&str>,
    spatial_mix: f32,
    mix_sample_rate: u32,
) -> Result<DspSettings, String> {
    let Some(file_path) = spatial_file_path else {
        settings.spatial = None;
        return Ok(settings);
    };

    let mix = clamp_spatial_mix(spatial_mix);
    let can_reuse = settings.spatial.as_ref().is_some_and(|spatial| {
        spatial.file_path == file_path && spatial.sample_rate() == mix_sample_rate
    });
    if can_reuse {
        if let Some(spatial) = settings.spatial.as_mut() {
            spatial.mix = mix;
        }
        return Ok(settings);
    }

    settings.spatial = Some(prepare_spatial_effect(file_path, mix, mix_sample_rate)?);
    Ok(settings)
}

fn update_spatial_mix(runtime: &mut PlayerRuntime, mix: f32) {
    let mix = clamp_spatial_mix(mix);
    runtime.spatial_mix = mix;
    if let Some(spatial) = runtime.dsp_settings.spatial.as_mut() {
        spatial.mix = mix;
    }
    sync_current_session_dsp_settings(runtime);
    update_runtime_audio_graph(runtime);
}

fn parse_impulse_response_payload(
    payload: &serde_json::Value,
) -> Result<Option<(String, f32)>, String> {
    match payload {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(path) => {
            let path = path.trim();
            if path.is_empty() {
                Ok(None)
            } else {
                Ok(Some((path.to_string(), DEFAULT_SPATIAL_MIX)))
            }
        }
        serde_json::Value::Object(object) => {
            let path = object
                .get("filePath")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .trim();
            if path.is_empty() {
                return Ok(None);
            }
            let mix = object
                .get("mix")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(DEFAULT_SPATIAL_MIX as f64)
                .clamp(0.0, 1.0) as f32;
            Ok(Some((path.to_string(), mix)))
        }
        _ => Err("invalid impulse response payload".to_string()),
    }
}

#[napi]
pub fn set_impulse_response(payload: serde_json::Value) -> AsyncTask<SetImpulseResponseTask> {
    AsyncTask::new(SetImpulseResponseTask { payload })
}

pub struct SetImpulseResponseMixTask {
    mix: f64,
}

impl Task for SetImpulseResponseMixTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_runtime(|runtime| {
            update_spatial_mix(runtime, self.mix as f32);
            Ok(())
        })
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn set_impulse_response_mix(mix: f64) -> AsyncTask<SetImpulseResponseMixTask> {
    AsyncTask::new(SetImpulseResponseMixTask { mix })
}

pub struct SetNormalizationGainTask {
    gain_db: f64,
}

impl Task for SetNormalizationGainTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_runtime(|runtime| {
            runtime.dsp_settings.normalization_gain_db = self.gain_db.clamp(-24.0, 24.0) as f32;
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
