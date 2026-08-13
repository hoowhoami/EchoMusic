use super::*;
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;

pub struct SetAudioOutputTask {
    device_name: String,
    exclusive: bool,
}

impl Task for SetAudioOutputTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let device_name = self.device_name.clone();
        let exclusive = self.exclusive;
        call_core_command_blocking("set-audio-output", move |runtime| {
            let mut config = runtime.config.clone();
            config.set_audio_device(&device_name);
            config.exclusive_output = exclusive;
            restart_output_for_runtime(runtime, config, true)
        })
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn set_audio_output(device_name: String, exclusive: bool) -> AsyncTask<SetAudioOutputTask> {
    AsyncTask::new(SetAudioOutputTask {
        device_name,
        exclusive,
    })
}

pub struct GetAudioDevicesTask;

impl Task for GetAudioDevicesTask {
    type Output = Vec<AudioDevice>;
    type JsValue = Vec<AudioDevice>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(device::list_output_devices())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn get_audio_devices() -> AsyncTask<GetAudioDevicesTask> {
    AsyncTask::new(GetAudioDevicesTask)
}

#[napi]
pub fn set_stall_timeout(seconds: f64) -> napi::Result<()> {
    with_runtime(|runtime| {
        let timeout = if seconds <= 0.0 {
            0.0
        } else {
            seconds.clamp(1.0, 60.0)
        };
        runtime.config.playback_stall_timeout_secs = timeout;
        if let Some(session) = runtime.session.as_ref() {
            session.shared.set_stall_timeout(timeout);
        }
        Ok(())
    })
}

#[napi]
pub fn set_pause_on_device_disconnect(enabled: bool) -> napi::Result<()> {
    with_runtime(|runtime| {
        runtime.pause_on_device_disconnect = enabled;
        if let Some(session) = runtime.session.as_ref() {
            session.shared.set_pause_on_device_disconnect(enabled);
        }
        Ok(())
    })
}

#[napi]
pub fn set_network_timeout(seconds: f64) -> napi::Result<()> {
    with_runtime(|runtime| {
        runtime.config.network_timeout_secs = seconds.clamp(1.0, 300.0);
        Ok(())
    })
}

#[napi]
pub fn set_http_proxy(proxy: String) -> napi::Result<()> {
    with_runtime(|runtime| {
        let trimmed = proxy.trim();
        runtime.config.http_proxy = (!trimmed.is_empty()).then(|| trimmed.to_string());
        Ok(())
    })
}
