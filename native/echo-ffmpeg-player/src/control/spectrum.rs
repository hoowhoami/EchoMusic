use super::*;
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;

#[napi]
pub fn configure_spectrum(options: Option<SpectrumOptions>) -> napi::Result<SpectrumStatus> {
    with_runtime(|runtime| {
        runtime.spectrum_config = SpectrumConfig::from_options(options);
        runtime.spectrum_analyzer =
            crate::dsp::SpectrumAnalyzer::new(runtime.spectrum_config.clone());
        runtime.spectrum_signal_logged = false;
        Ok(SpectrumStatus {
            available: true,
            running: true,
            reason: None,
        })
    })
}

#[napi]
pub fn get_spectrum_status() -> napi::Result<SpectrumStatus> {
    with_runtime(|_| {
        Ok(SpectrumStatus {
            available: true,
            running: true,
            reason: None,
        })
    })
}

pub struct GetSpectrumSnapshotTask;

impl Task for GetSpectrumSnapshotTask {
    type Output = Option<SpectrumFrame>;
    type JsValue = Option<SpectrumFrame>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_runtime(|runtime| {
            let Some(session) = runtime.session.as_ref() else {
                return Ok(None);
            };
            let frame = session
                .shared
                .spectrum_ring
                .lock()
                .map(|ring| {
                    runtime
                        .spectrum_analyzer
                        .analyze(&ring, session.shared.spectrum_sample_rate())
                })
                .ok();
            if let Some(frame) = frame.as_ref() {
                if !runtime.spectrum_signal_logged && (frame.peak > 0.0 || frame.rms > 0.0) {
                    runtime.spectrum_signal_logged = true;
                    emit_runtime_event(
                        runtime,
                        PlayerEvent::log(
                            "info",
                            format!(
                                "spectrum signal detected: peak={:.4}, rms={:.4}, bins={}",
                                frame.peak,
                                frame.rms,
                                frame.bins.len()
                            ),
                        ),
                    );
                }
            }
            Ok(frame)
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn get_spectrum_snapshot() -> AsyncTask<GetSpectrumSnapshotTask> {
    AsyncTask::new(GetSpectrumSnapshotTask)
}
