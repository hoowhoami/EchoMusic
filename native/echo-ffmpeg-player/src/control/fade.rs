use super::*;
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;

pub struct FadeTask {
    from: f64,
    to: f64,
    duration_ms: f64,
    start_playback: bool,
    fade_stop: Arc<AtomicBool>,
}

impl Task for FadeTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let steps = (self.duration_ms / 16.0).ceil().max(1.0) as u32;
        self.fade_stop.store(false, Ordering::Release);
        if self.start_playback {
            set_volume(self.from)?;
            with_runtime(|runtime| {
                if let Some(session) = runtime.session.as_ref() {
                    session.shared.paused.store(false, Ordering::Release);
                }
                runtime.state.playing = true;
                runtime.state.paused = false;
                emit_runtime_event(runtime, PlayerEvent::state_change(runtime.state.clone()));
                Ok(())
            })?;
        }
        let first_step = if self.start_playback { 1 } else { 0 };
        for step in first_step..=steps {
            if self.fade_stop.load(Ordering::Acquire) {
                break;
            }
            let t = step as f64 / steps as f64;
            let value = self.from + (self.to - self.from) * t;
            set_volume(value)?;
            thread::sleep(Duration::from_millis(16));
        }
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

fn fade_stop_handle() -> Arc<AtomicBool> {
    RUNTIME
        .lock()
        .ok()
        .and_then(|runtime| runtime.as_ref().map(|runtime| runtime.fade_stop.clone()))
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)))
}

#[napi]
pub fn fade(from: f64, to: f64, duration_ms: f64) -> AsyncTask<FadeTask> {
    AsyncTask::new(FadeTask {
        from,
        to,
        duration_ms,
        start_playback: false,
        fade_stop: fade_stop_handle(),
    })
}

#[napi]
pub fn cancel_fade() -> napi::Result<()> {
    with_runtime(|runtime| {
        runtime.fade_stop.store(true, Ordering::Release);
        Ok(())
    })
}

#[napi]
pub fn pause_with_fade(saved_volume: f64, duration_ms: f64) -> AsyncTask<FadeTask> {
    AsyncTask::new(FadeTask {
        from: saved_volume,
        to: 0.0,
        duration_ms,
        start_playback: false,
        fade_stop: fade_stop_handle(),
    })
}

#[napi]
pub fn play_with_fade(target_volume: f64, duration_ms: f64) -> AsyncTask<FadeTask> {
    AsyncTask::new(FadeTask {
        from: 0.0,
        to: target_volume,
        duration_ms,
        start_playback: true,
        fade_stop: fade_stop_handle(),
    })
}
