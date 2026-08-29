use super::*;
use napi_derive::napi;

struct FadeJob {
    from: f64,
    to: f64,
    duration_ms: f64,
    start_playback: bool,
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
        if self.persist_target_volume {
            let normalized = (self.to / 100.0).clamp(0.0, 1.5) as f32;
            USER_VOLUME_BITS.store(normalized.to_bits(), Ordering::Release);
        }
        if self.start_playback {
            set_session_volume(self.from)?;
            call_core_command("fade-play", |runtime| {
                if let Some(session) = runtime.session.as_ref() {
                    session.shared.paused.store(false, Ordering::Release);
                }
                runtime.state.playing = true;
                runtime.state.paused = false;
                set_runtime_core_state(runtime, PlaybackCoreState::Playing, "fade-play");
                emit_runtime_event(runtime, PlayerEvent::state_change(runtime.state.clone()));
                Ok(())
            })?;
        }
        let first_step = if self.start_playback { 1 } else { 0 };
        for step in first_step..=steps {
            if FADE_GENERATION.load(Ordering::Acquire) != self.generation {
                break;
            }
            let t = step as f64 / steps as f64;
            let value = self.from + (self.to - self.from) * t;
            set_session_volume(value)?;
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
        start_playback: false,
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
        start_playback: false,
        persist_target_volume: false,
        generation,
    })
    .await
}

#[napi]
pub async fn play_with_fade(target_volume: f64, duration_ms: f64) -> napi::Result<()> {
    let generation = next_fade_generation();
    run_fade(FadeJob {
        from: 0.0,
        to: target_volume,
        duration_ms,
        start_playback: true,
        persist_target_volume: true,
        generation,
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(from: f64, generation: u64) -> FadeJob {
        FadeJob {
            from,
            to: 50.0,
            duration_ms: 0.0,
            start_playback: false,
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
}
