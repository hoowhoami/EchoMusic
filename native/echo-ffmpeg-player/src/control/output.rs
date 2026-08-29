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
    if !seconds.is_finite() {
        return Err(napi::Error::from_reason(
            "stall timeout must be finite".to_string(),
        ));
    }
    call_core_command("set-stall-timeout", move |runtime| {
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
    call_core_command("set-pause-on-device-disconnect", move |runtime| {
        runtime.pause_on_device_disconnect = enabled;
        if let Some(session) = runtime.session.as_ref() {
            session.shared.set_pause_on_device_disconnect(enabled);
        }
        Ok(())
    })
}

#[napi]
pub fn set_network_timeout(seconds: f64) -> napi::Result<()> {
    if !seconds.is_finite() {
        return Err(napi::Error::from_reason(
            "network timeout must be finite".to_string(),
        ));
    }
    call_core_command("set-network-timeout", move |runtime| {
        runtime.config.network_timeout_secs = seconds.clamp(1.0, 300.0);
        Ok(())
    })
}

#[napi]
pub fn set_http_proxy(proxy: String) -> napi::Result<()> {
    let proxy = (!proxy.trim().is_empty()).then(|| proxy.trim().to_string());
    call_core_command("set-http-proxy", move |runtime| {
        runtime.config.http_proxy = proxy;
        Ok(())
    })
}
