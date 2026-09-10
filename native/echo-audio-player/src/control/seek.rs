use super::*;

pub struct SeekTask {
    position: f64,
    request_seq: u64,
}

pub(crate) struct SeekPlan {
    pub(crate) shared: Arc<SharedAudio>,
    pub(crate) was_paused: bool,
    pub(crate) url: String,
    pub(crate) audio_stream_ordinal: Option<usize>,
    pub(crate) generation: u64,
    pub(crate) request_seq: u64,
    pub(crate) config: PlayerConfig,
    pub(crate) interrupt: Option<Arc<AtomicBool>>,
    pub(crate) decode_commands: Option<SyncSender<decoder::DecodeCommand>>,
}

fn is_seek_plan_current(plan: &SeekPlan) -> napi::Result<bool> {
    with_runtime(|runtime| {
        let Some(session) = runtime.session.as_ref() else {
            return Ok(false);
        };
        Ok(Arc::ptr_eq(&session.shared, &plan.shared)
            && session.shared.is_decode_generation_current(plan.generation)
            && runtime.is_seek_request_current(plan.request_seq))
    })
}

pub(crate) fn mark_seek_plan_failed(plan: &SeekPlan) -> napi::Result<()> {
    let interrupt = plan.interrupt.clone();
    let request_seq = plan.request_seq;
    let shared = plan.shared.clone();
    let generation = plan.generation;
    call_core_command("mark-seek-failed", move |runtime| {
        runtime.clear_pending_seek_restart(interrupt.as_ref());
        if !runtime.is_seek_request_current(request_seq) {
            return Ok(());
        }
        let matches_plan = runtime.session.as_ref().is_some_and(|session| {
            Arc::ptr_eq(&session.shared, &shared)
                && session.shared.is_decode_generation_current(generation)
        });
        if !matches_plan {
            return Ok(());
        }
        runtime.clear_seek_restore_paused_if_current(request_seq);
        let Some(session) = runtime.session.as_mut() else {
            return Ok(());
        };
        session.shared.mark_decode_failed();
        session.shared.paused.store(true, Ordering::Release);
        runtime.state.playing = false;
        runtime.state.paused = true;
        set_runtime_core_state(runtime, PlaybackCoreState::Error, "seek-error");
        emit_runtime_event(runtime, PlayerEvent::state_change(runtime.state.clone()));
        schedule_idle_output_release_for_runtime(runtime);
        Ok(())
    })
}

pub(crate) fn open_decoder_at_position(
    plan: &SeekPlan,
    position: f64,
) -> napi::Result<decoder::DecoderData> {
    let mut decoder = if let Some(interrupt) = plan.interrupt.as_ref() {
        decoder::DecoderData::open(
            plan.url.clone(),
            plan.audio_stream_ordinal,
            Some(plan.shared.mix_format.sample_rate),
            interrupt.clone(),
            plan.config.packet_cache_options_for_url(&plan.url),
            &plan.config.stream_options(),
        )
    } else {
        open_decoder(
            plan.url.clone(),
            plan.audio_stream_ordinal,
            Some(plan.shared.mix_format.sample_rate),
            plan.config.packet_cache_options_for_url(&plan.url),
            &plan.config.stream_options(),
        )
    }
    .map_err(napi::Error::from_reason)?;

    if position > 0.0 {
        decoder.seek(position).map_err(napi::Error::from_reason)?;
    } else {
        decoder.confirm_playback_restart_when_audio_ready(position);
    }

    Ok(decoder)
}

pub(crate) fn attach_restarted_decoder(
    plan: &SeekPlan,
    decoder: decoder::DecoderData,
    position: f64,
    defer_restart_events_until_audio_ready: bool,
) -> napi::Result<()> {
    let mut decoder = Some(decoder);
    let interrupt = plan.interrupt.clone();
    let request_seq = plan.request_seq;
    let shared = plan.shared.clone();
    let generation = plan.generation;
    let was_paused = plan.was_paused;
    let config = plan.config.clone();
    call_core_command("attach-restarted-decoder", move |runtime| {
        runtime.clear_pending_seek_restart(interrupt.as_ref());
        if !runtime.is_seek_request_current(request_seq) {
            return Ok(());
        }
        let matches_plan = runtime.session.as_ref().is_some_and(|session| {
            Arc::ptr_eq(&session.shared, &shared)
                && session.shared.is_decode_generation_current(generation)
        });
        if !matches_plan {
            return Ok(());
        }
        let restore_paused = runtime.take_seek_restore_paused(request_seq, was_paused);
        let Some(session) = runtime.session.as_mut() else {
            return Ok(());
        };
        let decoder = decoder
            .take()
            .ok_or_else(|| napi::Error::from_reason("decoder already attached".to_string()))?;
        let source_sample_format = decoder.source_sample_format();
        session
            .shared
            .set_source_sample_format(source_sample_format);
        session.shared.set_preferred_output_sample_format(
            config.resolve_output_sample_format(source_sample_format),
        );
        session.shared.bind_interrupt(decoder.interrupt_handle());
        let (decode_thread, decode_commands) =
            decoder::spawn_decode_worker(decoder, session.shared.clone(), generation)
                .map_err(napi::Error::from_reason)?;
        session.decode_thread = Some(decode_thread);
        session.decode_commands = Some(decode_commands);
        session
            .shared
            .paused
            .store(restore_paused, Ordering::Release);
        runtime.state.time_pos = position;
        runtime.state.playing = !restore_paused;
        runtime.state.paused = restore_paused;
        set_runtime_core_state(
            runtime,
            if restore_paused {
                PlaybackCoreState::Paused
            } else {
                PlaybackCoreState::Playing
            },
            "seek-complete",
        );
        if !defer_restart_events_until_audio_ready {
            emit_runtime_event(runtime, PlayerEvent::time_update(position));
        }
        Ok(())
    })
}

fn restore_seek_playback_state(
    plan: &SeekPlan,
    position: f64,
    reason: &'static str,
) -> napi::Result<()> {
    let shared = plan.shared.clone();
    let generation = plan.generation;
    let request_seq = plan.request_seq;
    let was_paused = plan.was_paused;
    call_core_command("restore-seek-playback-state", move |runtime| {
        let Some(shared) = runtime.session.as_ref().and_then(|session| {
            (Arc::ptr_eq(&session.shared, &shared)
                && session.shared.is_decode_generation_current(generation)
                && runtime.is_seek_request_current(request_seq))
            .then(|| session.shared.clone())
        }) else {
            return Ok(());
        };
        let restore_paused = runtime.take_seek_restore_paused(request_seq, was_paused);
        shared.paused.store(restore_paused, Ordering::Release);
        runtime.state.time_pos = position;
        runtime.state.playing = !restore_paused;
        runtime.state.paused = restore_paused;
        set_runtime_core_state(
            runtime,
            if restore_paused {
                PlaybackCoreState::Paused
            } else {
                PlaybackCoreState::Playing
            },
            reason,
        );
        emit_runtime_event(runtime, PlayerEvent::state_change(runtime.state.clone()));
        Ok(())
    })
}

fn try_seek_current_decoder(plan: &SeekPlan, position: f64) -> napi::Result<bool> {
    let Some(sender) = plan.decode_commands.as_ref() else {
        return Ok(false);
    };
    if !is_seek_plan_current(plan)? {
        return Ok(true);
    }

    // Retry loop for transient channel-full conditions.  The decoder drains the command
    // queue once per decode iteration; a Full error means the decoder is mid-frame but
    // will clear the backlog in <~20 ms.  Retrying avoids the expensive reopen path
    // (~50 ms) when the decoder only needs a moment to catch up.
    const SEEK_COMMAND_RETRIES: u32 = 8;
    let reply_rx = {
        let mut retries = 0u32;
        loop {
            let (reply_tx, reply_rx) = sync_channel(1);
            match sender.try_send(decoder::DecodeCommand::Seek {
                position_secs: position,
                generation: plan.generation,
                reply: reply_tx,
            }) {
                Ok(()) => break reply_rx,
                Err(TrySendError::Full(_)) => {
                    retries += 1;
                    if retries >= SEEK_COMMAND_RETRIES || !is_seek_plan_current(plan)? {
                        plan.shared.request_decode_interrupt();
                        emit_shared_event(
                            &plan.shared,
                            PlayerEvent::log(
                                "warn",
                                format!(
                                    "decoder seek command full after {retries} retries; \
                                     falling back to reopen"
                                ),
                            ),
                        );
                        return Ok(false);
                    }
                    // Brief sleep so the decoder can drain its command queue.
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
                Err(TrySendError::Disconnected(_)) => {
                    if !is_seek_plan_current(plan)? {
                        return Ok(true);
                    }
                    emit_shared_event(
                        &plan.shared,
                        PlayerEvent::log(
                            "warn",
                            "decoder seek command disconnected; falling back to reopen".to_string(),
                        ),
                    );
                    return Ok(false);
                }
            }
        }
    };

    plan.shared.request_decode_interrupt();

    // A network demuxer may need a fresh HTTP range request before it can acknowledge the
    // command. Reopening after the local two-second budget cancels that useful request and starts
    // the same slow operation again. Keep the short bound for local files, but let remote seeks
    // finish within a bounded portion of the configured network timeout.
    let command_timeout = plan.config.seek_timeout_for_url(&plan.url);
    match reply_rx.recv_timeout(command_timeout) {
        Ok(Ok(())) => {
            restore_seek_playback_state(plan, position, "seek-command")?;
            Ok(true)
        }
        Ok(Err(err)) => {
            if !is_seek_plan_current(plan)? {
                return Ok(true);
            }
            emit_shared_event(
                &plan.shared,
                PlayerEvent::log(
                    "warn",
                    format!("decoder seek command failed; falling back to reopen: {err}"),
                ),
            );
            Ok(false)
        }
        Err(RecvTimeoutError::Timeout) => {
            if !is_seek_plan_current(plan)? {
                return Ok(true);
            }
            emit_shared_event(
                &plan.shared,
                PlayerEvent::log(
                    "warn",
                    "decoder seek command timed out; falling back to reopen".to_string(),
                ),
            );
            Ok(false)
        }
        Err(RecvTimeoutError::Disconnected) => {
            if !is_seek_plan_current(plan)? {
                return Ok(true);
            }
            emit_shared_event(
                &plan.shared,
                PlayerEvent::log(
                    "warn",
                    "decoder seek command disconnected; falling back to reopen".to_string(),
                ),
            );
            Ok(false)
        }
    }
}

fn prepare_reopen_seek_plan(previous: &SeekPlan, position: f64) -> napi::Result<Option<SeekPlan>> {
    let interrupt = Arc::new(AtomicBool::new(false));
    let previous_shared = previous.shared.clone();
    let previous_generation = previous.generation;
    let request_seq = previous.request_seq;
    let was_paused = previous.was_paused;
    call_core_command("prepare-reopen-seek", move |runtime| {
        if !runtime.is_seek_request_current(request_seq) {
            return Ok(None);
        }
        let Some(session) = runtime.session.as_mut() else {
            return Ok(None);
        };
        if !Arc::ptr_eq(&session.shared, &previous_shared)
            || !session
                .shared
                .is_decode_generation_current(previous_generation)
        {
            return Ok(None);
        }
        runtime.seek_restart_interrupt = Some(interrupt.clone());
        session.shared.paused.store(true, Ordering::Release);
        session.shared.request_decode_stop();
        session.stop_decode_background("seek-fallback");
        let generation = session
            .shared
            .reset_for_decode_resume(position, &runtime.dsp_settings);
        runtime.state.time_pos = position;
        runtime.state.playing = false;
        runtime.state.paused = true;
        Ok(runtime.current_url.clone().map(|url| SeekPlan {
            shared: session.shared.clone(),
            was_paused,
            url,
            audio_stream_ordinal: runtime.current_audio_stream_ordinal,
            generation,
            request_seq,
            config: runtime.config.clone(),
            interrupt: Some(interrupt),
            decode_commands: None,
        }))
    })
}

impl Task for SeekTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let position = self.position.max(0.0);
        let request_seq = self.request_seq;
        if !is_latest_seek_request_seq(request_seq) {
            return Ok(());
        }
        let plan = call_core_command("begin-seek", move |runtime| {
            if !runtime.accept_seek_request_seq(request_seq) {
                return Ok(None);
            }
            runtime.cancel_pending_source_open();
            let Some((shared, decode_commands)) = runtime
                .session
                .as_ref()
                .map(|session| (session.shared.clone(), session.decode_commands.clone()))
            else {
                return Ok(None);
            };
            let was_paused = runtime.begin_seek_restore_paused();
            set_runtime_core_state(runtime, PlaybackCoreState::Seeking, "seek");
            runtime.cancel_pending_seek_restart();
            shared.paused.store(true, Ordering::Release);
            let generation = shared.reset_for_decode_resume(position, &runtime.dsp_settings);
            runtime.state.time_pos = position;
            runtime.state.playing = false;
            runtime.state.paused = true;
            emit_runtime_event(runtime, PlayerEvent::seek(position));
            Ok(runtime.current_url.clone().map(|url| SeekPlan {
                shared,
                was_paused,
                url,
                audio_stream_ordinal: runtime.current_audio_stream_ordinal,
                generation,
                request_seq,
                config: runtime.config.clone(),
                interrupt: None,
                decode_commands,
            }))
        })?;

        let Some(plan) = plan else {
            return Ok(());
        };

        if try_seek_current_decoder(&plan, position)? {
            return Ok(());
        }

        let Some(plan) = prepare_reopen_seek_plan(&plan, position)? else {
            return Ok(());
        };

        match open_decoder_at_position(&plan, position)
            .and_then(|decoder| attach_restarted_decoder(&plan, decoder, position, true))
        {
            Ok(()) => Ok(()),
            Err(err) => {
                mark_seek_plan_failed(&plan)?;
                emit_event(
                    PlayerEvent::error(
                        events::PlayerErrorCode::Seek,
                        format!("failed to seek playback: {err}"),
                    )
                    .with_playback_context(plan.shared.current_track_seq(), plan.generation),
                );
                Err(err)
            }
        }
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

#[napi]
pub fn seek(time: f64) -> AsyncTask<SeekTask> {
    invalidate_source_open_requests();
    AsyncTask::new(SeekTask {
        position: time,
        request_seq: next_seek_request_seq(),
    })
}
