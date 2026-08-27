use crate::dsp::provider::{NativeDspProvider, PROVIDER_MODE_SPEAKER};
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Result, Task};
use napi_derive::napi;
use std::path::Path;

#[napi(object)]
pub struct DspProviderInspection {
    pub provider_id: String,
    pub provider_version: String,
    pub latency_frames: f64,
    pub preferred_block_frames: f64,
    pub max_channels: f64,
    pub manifest_json: String,
    pub state_json: String,
}

pub struct InspectDspProviderTask {
    path: String,
}

impl Task for InspectDspProviderTask {
    type Output = DspProviderInspection;
    type JsValue = DspProviderInspection;

    fn compute(&mut self) -> Result<Self::Output> {
        let provider = NativeDspProvider::load(
            Path::new(&self.path),
            48_000,
            2,
            PROVIDER_MODE_SPEAKER,
            None,
            None,
        )
        .map_err(napi::Error::from_reason)?;
        let descriptor = provider.descriptor();
        Ok(DspProviderInspection {
            provider_id: descriptor.id,
            provider_version: descriptor.version,
            latency_frames: f64::from(descriptor.latency_frames),
            preferred_block_frames: f64::from(descriptor.preferred_block_frames),
            max_channels: f64::from(descriptor.max_channels),
            manifest_json: descriptor.manifest_json,
            state_json: descriptor.state_json,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn inspect_dsp_provider(path: String) -> AsyncTask<InspectDspProviderTask> {
    AsyncTask::new(InspectDspProviderTask { path })
}
