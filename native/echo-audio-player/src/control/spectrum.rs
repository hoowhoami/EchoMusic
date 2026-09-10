use super::*;
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;

#[napi]
pub fn configure_spectrum(options: Option<SpectrumOptions>) -> napi::Result<SpectrumStatus> {
    let config = SpectrumConfig::from_options(options);
    let analyzer = crate::spectrum::SpectrumAnalyzer::new(config.clone());
    call_core_command("configure-spectrum", move |runtime| {
        runtime.spectrum_config = config;
        runtime.spectrum_analyzer = analyzer;
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
            let Some((shared, sample_rate)) = runtime.session.as_ref().map(|session| {
                (
                    session.shared.clone(),
                    session.shared.spectrum_sample_rate(),
                )
            }) else {
                return Ok(None);
            };
            let snapshot_ready = shared
                .spectrum_ring
                .lock()
                .map(|ring| runtime.spectrum_analyzer.snapshot_ring(&ring))
                .is_ok();
            let frame =
                snapshot_ready.then(|| runtime.spectrum_analyzer.analyze_snapshot(sample_rate));
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
