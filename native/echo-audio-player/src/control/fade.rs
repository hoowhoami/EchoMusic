use super::*;
use napi_derive::napi;

struct FadeJob {
    from: f64,
    to: f64,
    duration_ms: f64,
    persist_target_volume: bool,
    generation: u64,
}

const MAX_FADE_DURATION_MS: f64 = 60_000.0;

impl FadeJob {
    fn run(self) -> napi::Result<()> {
        if !self.from.is_finite() || !self.to.is_finite() || !self.duration_ms.is_finite() {
            return Err(napi::Error::from_reason(
                "fade values and duration must be finite".to_string(),
            ));
        }
        let duration_ms = self.duration_ms.clamp(0.0, MAX_FADE_DURATION_MS);
        let steps = (duration_ms / 16.0).ceil().max(1.0) as u32;
        if FADE_GENERATION.load(Ordering::Acquire) != self.generation {
            return Ok(());
        }
        for step in 0..=steps {
            if FADE_GENERATION.load(Ordering::Acquire) != self.generation {
                break;
            }
            let t = step as f64 / steps as f64;
            let value = self.from + (self.to - self.from) * t;
            let generation = self.generation;
            let persist = self.persist_target_volume;
            let target = self.to;
            // Check and write on the core together: a cancelled fade must never
            // regain control of the replacement session after a source reset.
            call_core_command("fade-step", move |runtime| {
                if FADE_GENERATION.load(Ordering::Acquire) != generation {
                    return Ok(());
                }
                if persist {
                    USER_VOLUME_BITS.store(
                        ((target / 100.0).clamp(0.0, 1.5) as f32).to_bits(),
                        Ordering::Release,
                    );
                }
                if let Some(session) = runtime.session.as_ref() {
                    session
                        .shared
                        .set_volume((value / 100.0).clamp(0.0, 1.5) as f32);
                }
                Ok(())
            })?;
            thread::sleep(Duration::from_millis(16));
        }
        Ok(())
    }
}

async fn run_fade(job: FadeJob) -> napi::Result<()> {
    napi::tokio::task::spawn_blocking(move || job.run())
        .await
        .map_err(|err| napi::Error::from_reason(format!("fade worker failed: {err}")))?
}

fn next_fade_generation() -> u64 {
    FADE_GENERATION
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1)
}

#[napi]
pub async fn fade(from: f64, to: f64, duration_ms: f64) -> napi::Result<()> {
    let generation = next_fade_generation();
    run_fade(FadeJob {
        from,
        to,
        duration_ms,
        persist_target_volume: false,
        generation,
    })
    .await
}

#[napi]
pub fn cancel_fade() -> napi::Result<()> {
    if !RUNTIME_READY.load(Ordering::Acquire) {
        return Err(napi::Error::from_reason(
            "player addon not initialized".to_string(),
        ));
    }
    cancel_runtime_fade();
    Ok(())
}

#[napi]
pub async fn pause_with_fade(saved_volume: f64, duration_ms: f64) -> napi::Result<()> {
    let generation = next_fade_generation();
    run_fade(FadeJob {
        from: saved_volume,
        to: 0.0,
        duration_ms,
        persist_target_volume: false,
        generation,
    })
    .await
}

pub struct PlayWithFadeTask {
    target_volume: f64,
    duration_ms: f64,
    generation: u64,
    source_request_seq: u64,
}

impl Task for PlayWithFadeTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<()> {
        let target_volume = self.target_volume;
        let duration_ms = self.duration_ms;
        let generation = self.generation;
        let source_request_seq = self.source_request_seq;
        if !target_volume.is_finite() || !duration_ms.is_finite() {
            return Err(napi::Error::from_reason(
                "fade values and duration must be finite".to_string(),
            ));
        }
        let started = call_core_command_blocking("fade-play", move |runtime| {
            if FADE_GENERATION.load(Ordering::Acquire) != generation
                || !is_latest_source_open_request_seq(source_request_seq)
            {
                return Ok(false);
            }
            resume_runtime_playback(runtime, true)?;
            USER_VOLUME_BITS.store(
                ((target_volume / 100.0).clamp(0.0, 1.5) as f32).to_bits(),
                Ordering::Release,
            );
            Ok(true)
        })?;
        if started {
            thread::Builder::new()
                .name("player-play-fade".to_string())
                .spawn(move || {
                    let _ = FadeJob {
                        from: 0.0,
                        to: target_volume,
                        duration_ms,
                        persist_target_volume: false,
                        generation,
                    }
                    .run();
                })
                .map_err(|err| napi::Error::from_reason(format!("fade worker failed: {err}")))?;
        }
        // Resolve after native accepts playback, without waiting for the volume ramp.
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> napi::Result<()> {
        Ok(())
    }
}

#[napi]
pub fn play_with_fade(target_volume: f64, duration_ms: f64) -> AsyncTask<PlayWithFadeTask> {
    AsyncTask::new(PlayWithFadeTask {
        target_volume,
        duration_ms,
        generation: next_fade_generation(),
        source_request_seq: LATEST_SOURCE_OPEN_REQUEST_SEQ.load(Ordering::Acquire),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(from: f64, generation: u64) -> FadeJob {
        FadeJob {
            from,
            to: 50.0,
            duration_ms: 0.0,
            persist_target_volume: false,
            generation,
        }
    }

    #[test]
    fn fade_job_rejects_non_finite_values() {
        let generation = next_fade_generation();
        let err = job(f64::NAN, generation)
            .run()
            .expect_err("NaN fade endpoint must be rejected");
        assert!(err.reason.contains("must be finite"));
    }

    #[test]
    fn superseded_fade_finishes_without_touching_runtime() {
        let generation = next_fade_generation();
        cancel_runtime_fade();
        job(0.0, generation)
            .run()
            .expect("superseded fade should be a no-op");
    }

    #[test]
    fn delayed_fade_play_cannot_resume_a_superseded_source() {
        initialize(None).unwrap();
        let mut task = PlayWithFadeTask {
            target_volume: 50.0,
            duration_ms: 1000.0,
            generation: next_fade_generation(),
            source_request_seq: LATEST_SOURCE_OPEN_REQUEST_SEQ.load(Ordering::Acquire),
        };
        begin_source_change().unwrap();
        task.compute()
            .expect("old play must be a no-op, even without a loaded source");
        assert!(!get_state().unwrap().playing);
        destroy().unwrap();
    }

    #[test]
    fn fade_play_requires_a_loaded_source_before_acknowledging_start() {
        initialize(None).unwrap();
        let mut task = PlayWithFadeTask {
            target_volume: 50.0,
            duration_ms: 1000.0,
            generation: next_fade_generation(),
            source_request_seq: LATEST_SOURCE_OPEN_REQUEST_SEQ.load(Ordering::Acquire),
        };
        let err = task
            .compute()
            .expect_err("empty session cannot accept playback");
        assert!(err.reason.contains("no audio source loaded"));
        assert!(!get_state().unwrap().playing);
        destroy().unwrap();
    }
}
