use super::*;

const IDLE_OUTPUT_RELEASE_DELAY_SECS: u64 = 3;

pub(crate) fn schedule_idle_output_release_for_runtime(runtime: &mut PlayerRuntime) {
    if !runtime.core_state.allows_idle_output_release() {
        return;
    }
    let Some(shared) = runtime.session.as_ref().and_then(|session| {
        session
            .output_thread
            .as_ref()
            .map(|_| session.shared.clone())
    }) else {
        return;
    };
    let release_seq = runtime.next_idle_output_release_seq();
    schedule_idle_output_release(shared, release_seq);
}

fn schedule_idle_output_release(shared: Arc<SharedAudio>, release_seq: u64) {
    let _ = thread::Builder::new()
        .name("player-output-idle-release".to_string())
        .spawn(move || {
            thread::sleep(Duration::from_secs(IDLE_OUTPUT_RELEASE_DELAY_SECS));
            dispatch_core_command(
                "idle-output-release",
                Box::new(move |runtime| {
                    if runtime.idle_output_release_seq != release_seq
                        || !runtime.core_state.allows_idle_output_release()
                    {
                        return;
                    }
                    let output = {
                        let Some(session) = runtime.session.as_mut() else {
                            return;
                        };
                        if !Arc::ptr_eq(&session.shared, &shared) {
                            return;
                        }
                        session.output_thread.take()
                    };
                    let Some(output) = output else {
                        return;
                    };

                    // Keep the Bluetooth-friendly release policy, but serialize it with every
                    // other AO transition. A later play command creates a fresh AO generation.
                    output.shutdown();
                    emit_runtime_event(
                        runtime,
                        PlayerEvent::log(
                            "info",
                            format!(
                                "audio output released after {}s pause",
                                IDLE_OUTPUT_RELEASE_DELAY_SECS
                            ),
                        ),
                    );
                }),
            );
        });
}

pub(crate) fn request_output_recovery(
    shared: Arc<SharedAudio>,
    reason: &'static str,
    message: String,
) {
    if !shared.try_begin_output_recovery() {
        emit_shared_event(
            &shared,
            PlayerEvent::log(
                "debug",
                format!("audio output recovery already running: reason={reason}"),
            ),
        );
        return;
    }

    let recovery_shared = shared.clone();
    match thread::Builder::new()
        .name("player-output-recovery".to_string())
        .spawn(move || {
            run_output_recovery(recovery_shared, reason, message);
        }) {
        Ok(_) => {}
        Err(err) => {
            shared.finish_output_recovery();
            let message = format!("failed to start audio output recovery: {err}");
            emit_shared_event(
                &shared,
                PlayerEvent::error_with_reason(
                    events::PlayerErrorCode::OutputRuntime,
                    message,
                    reason,
                ),
            );
        }
    }
}

pub(crate) fn handle_playback_output_device_event(
    event: device::watcher::PlaybackOutputDeviceEvent,
) {
    dispatch_core_command(
        "playback-output-device-event",
        Box::new(move |runtime| {
            let should_reload = match &event {
                device::watcher::PlaybackOutputDeviceEvent::DefaultRouteChanged => {
                    if !device::selection::is_default_device_name(&runtime.config.audio_device) {
                        false
                    } else {
                        #[cfg(target_os = "linux")]
                        {
                            runtime
                                .session
                                .as_ref()
                                .and_then(|session| session.shared.output_stats())
                                .is_some_and(|stats| stats.backend == "pulseaudio")
                        }
                        #[cfg(not(target_os = "linux"))]
                        {
                            true
                        }
                    }
                }
                device::watcher::PlaybackOutputDeviceEvent::BoundDeviceChanged(device_name)
                | device::watcher::PlaybackOutputDeviceEvent::BoundDeviceUnavailable(device_name) => {
                    playback_event_targets_config(&runtime.config.audio_device, device_name)
                }
            };
            if !should_reload {
                return;
            }
            let Some(session) = runtime.session.as_ref() else {
                return;
            };
            if session.output_thread.is_none() {
                return;
            }
            let reason = match &event {
                device::watcher::PlaybackOutputDeviceEvent::DefaultRouteChanged
                | device::watcher::PlaybackOutputDeviceEvent::BoundDeviceChanged(_) => {
                    "device-changed"
                }
                device::watcher::PlaybackOutputDeviceEvent::BoundDeviceUnavailable(_) => {
                    "device-not-available"
                }
            };
            request_output_recovery(
                session.shared.clone(),
                reason,
                format!("playback output device event: {event:?}"),
            );
        }),
    );
}

fn playback_event_targets_config(configured_device: &str, event_device: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        return crate::device::platform_windows::output_device_event_matches_config(
            configured_device,
            event_device,
        );
    }
    #[cfg(not(target_os = "windows"))]
    {
        configured_device == event_device
    }
}

pub(crate) fn handle_output_device_list_change(devices: Vec<AudioDevice>) {
    dispatch_core_command(
        "output-device-list-changed",
        Box::new(move |runtime| {
            if device::selection::is_default_device_name(&runtime.config.audio_device) {
                return;
            }
            let configured_device_available = devices
                .iter()
                .any(|device| device.name == runtime.config.audio_device);
            if configured_device_available {
                let Some(session) = runtime.session.as_ref() else {
                    return;
                };
                let output_needs_recovery = runtime.core_state == PlaybackCoreState::DeviceLost
                    && session
                        .output_thread
                        .as_ref()
                        .is_none_or(crate::output::AudioOutputHandle::has_exited);
                if output_needs_recovery {
                    request_output_recovery(
                        session.shared.clone(),
                        "device-available",
                        format!(
                            "selected audio output is available again: {}",
                            runtime.config.audio_device
                        ),
                    );
                }
                return;
            }
            let Some(session) = runtime.session.as_ref() else {
                return;
            };
            let shared = session.shared.clone();
            let message = format!(
                "selected audio output is no longer available: {}",
                runtime.config.audio_device
            );
            if shared.should_pause_on_device_disconnect() {
                if let Some(output) = runtime
                    .session
                    .as_mut()
                    .and_then(|session| session.output_thread.take())
                {
                    output.shutdown();
                }
                shared.paused.store(true, Ordering::Release);
                runtime.state.playing = false;
                runtime.state.paused = true;
                set_runtime_core_state(runtime, PlaybackCoreState::DeviceLost, "device-lost");
                emit_runtime_events(
                    runtime,
                    vec![
                        PlayerEvent::state_change(runtime.state.clone()),
                        PlayerEvent::error_with_reason(
                            events::PlayerErrorCode::OutputRuntime,
                            message,
                            "device-not-available",
                        ),
                    ],
                );
            } else {
                request_output_recovery(shared, "device-not-available", message);
            }
        }),
    );
}

fn run_output_recovery(shared: Arc<SharedAudio>, reason: &'static str, message: String) {
    emit_shared_event(
        &shared,
        PlayerEvent::log(
            "warn",
            format!("audio output recovery requested: reason={reason}, message={message}"),
        ),
    );

    let retry_delays = [
        Duration::from_millis(0),
        Duration::from_millis(500),
        Duration::from_millis(1_000),
    ];
    let mut last_error = message;
    for (attempt, delay) in retry_delays.iter().enumerate() {
        if shared.stop.load(Ordering::Acquire) {
            shared.finish_output_recovery();
            return;
        }
        if !delay.is_zero() {
            thread::sleep(*delay);
        }
        let attempt_shared = shared.clone();
        let result = call_core_command_blocking("output-recovery", move |runtime| {
            let Some(session) = runtime.session.as_ref() else {
                return Ok(false);
            };
            if !Arc::ptr_eq(&session.shared, &attempt_shared) {
                return Ok(false);
            }
            let config = runtime.config.clone();
            restart_output_for_runtime(runtime, config, false)?;
            Ok(true)
        });
        match result {
            Ok(true) => {
                emit_shared_event(
                    &shared,
                    PlayerEvent::log(
                        "info",
                        format!(
                            "audio output recovery completed: reason={reason}, attempt={}",
                            attempt + 1
                        ),
                    ),
                );
                shared.finish_output_recovery();
                return;
            }
            Ok(false) => {
                shared.finish_output_recovery();
                return;
            }
            Err(err) => {
                last_error = err.to_string();
                emit_shared_event(
                    &shared,
                    PlayerEvent::log(
                        "warn",
                        format!(
                            "audio output recovery failed: reason={reason}, attempt={}, error={last_error}",
                            attempt + 1
                        ),
                    ),
                );
            }
        }
    }

    shared.finish_output_recovery();
    emit_shared_event(
        &shared,
        PlayerEvent::error_with_reason(
            events::PlayerErrorCode::OutputRuntime,
            format!("audio output recovery failed: {last_error}"),
            reason,
        ),
    );
}

#[derive(Clone)]
struct OutputPlaybackSnapshot {
    output_paused: bool,
    state: PlayerState,
    core_state: PlaybackCoreState,
}

impl OutputPlaybackSnapshot {
    fn capture(state: PlayerState, core_state: PlaybackCoreState, shared: &SharedAudio) -> Self {
        let core_state = if core_state == PlaybackCoreState::DeviceLost {
            if state.playing && !state.paused {
                PlaybackCoreState::Playing
            } else {
                PlaybackCoreState::Paused
            }
        } else {
            core_state
        };
        Self {
            output_paused: shared.paused.load(Ordering::Acquire),
            state,
            core_state,
        }
    }

    fn should_release_when_idle(&self) -> bool {
        self.core_state.allows_idle_output_release()
    }
}

pub(crate) fn restart_output_for_runtime(
    runtime: &mut PlayerRuntime,
    next_config: PlayerConfig,
    restore_previous_on_failure: bool,
) -> napi::Result<()> {
    runtime.cancel_idle_output_release();
    let previous_config = runtime.config.clone();
    if runtime.session.is_none() {
        validate_output_restart_config(&next_config, None).map_err(napi::Error::from_reason)?;
        runtime.config = next_config;
        return Ok(());
    }

    let previous_state = runtime.state.clone();
    let previous_core_state = runtime.core_state;
    let (shared, playback, previous_output) = {
        let session = runtime.session.as_mut().expect("session checked above");
        let shared = session.shared.clone();
        let playback =
            OutputPlaybackSnapshot::capture(previous_state, previous_core_state, &shared);
        (shared, playback, session.output_thread.take())
    };
    set_runtime_core_state(runtime, PlaybackCoreState::OutputReconfig, "output-restart");
    if let Some(output) = previous_output {
        if shared.output_has_started() {
            output.shutdown();
        } else {
            output.shutdown_in_background("unconfirmed-restart");
        }
    }

    if let Err(err) = validate_output_restart_config(&next_config, Some(&shared)) {
        emit_shared_event(
            &shared,
            PlayerEvent::log(
                "warn",
                format!("audio output restart validation failed, restoring previous output: {err}"),
            ),
        );
        if restore_previous_on_failure {
            restore_previous_output(runtime, shared, previous_config, &playback)?;
        } else {
            set_runtime_core_state(
                runtime,
                PlaybackCoreState::DeviceLost,
                "output-restart-failed",
            );
        }
        return Err(napi::Error::from_reason(err));
    }

    shared.prepare_output_start();
    match spawn_output_thread_confirmed(shared.clone(), &next_config) {
        Ok(output) => {
            let Some(session) = runtime.session.as_mut() else {
                output.shutdown();
                return Err(napi::Error::from_reason(
                    "audio session ended during output restart".to_string(),
                ));
            };
            if !Arc::ptr_eq(&session.shared, &shared) {
                output.shutdown();
                return Err(napi::Error::from_reason(
                    "audio session changed during output restart".to_string(),
                ));
            }
            session.output_thread = Some(output);
            runtime.config = next_config;
            restore_output_restart_playback_state(runtime, &shared, &playback);
            if playback.should_release_when_idle() {
                schedule_idle_output_release_for_runtime(runtime);
            }
            Ok(())
        }
        Err(err) => {
            emit_shared_event(
                &shared,
                PlayerEvent::log(
                    "warn",
                    format!("audio output restart failed, restoring previous output: {err}"),
                ),
            );
            if restore_previous_on_failure {
                restore_previous_output(runtime, shared, previous_config, &playback)?;
            } else {
                set_runtime_core_state(
                    runtime,
                    PlaybackCoreState::DeviceLost,
                    "output-restart-failed",
                );
            }
            Err(napi::Error::from_reason(err))
        }
    }
}

fn restore_previous_output(
    runtime: &mut PlayerRuntime,
    shared: Arc<SharedAudio>,
    previous_config: PlayerConfig,
    playback: &OutputPlaybackSnapshot,
) -> napi::Result<()> {
    shared.prepare_output_start();
    let output = match spawn_output_thread_confirmed(shared.clone(), &previous_config) {
        Ok(output) => output,
        Err(err) => {
            shared.paused.store(true, Ordering::Release);
            runtime.state.playing = false;
            runtime.state.paused = true;
            set_runtime_core_state(
                runtime,
                PlaybackCoreState::DeviceLost,
                "output-restore-failed",
            );
            emit_runtime_events(
                runtime,
                vec![
                    PlayerEvent::state_change(runtime.state.clone()),
                    PlayerEvent::error_with_reason(
                        events::PlayerErrorCode::OutputRuntime,
                        format!(
                            "output change failed and previous output could not be restored: {err}"
                        ),
                        "output-restore-failed",
                    ),
                ],
            );
            return Err(napi::Error::from_reason(format!(
                "output change failed and previous output could not be restored: {err}"
            )));
        }
    };
    let Some(session) = runtime.session.as_mut() else {
        output.shutdown();
        return Err(napi::Error::from_reason(
            "audio session ended while restoring previous output".to_string(),
        ));
    };
    if !Arc::ptr_eq(&session.shared, &shared) {
        output.shutdown();
        return Err(napi::Error::from_reason(
            "audio session changed while restoring previous output".to_string(),
        ));
    }
    session.output_thread = Some(output);
    runtime.config = previous_config;
    restore_output_restart_playback_state(runtime, &shared, playback);
    if playback.should_release_when_idle() {
        schedule_idle_output_release_for_runtime(runtime);
    }
    Ok(())
}

fn restore_output_restart_playback_state(
    runtime: &mut PlayerRuntime,
    shared: &SharedAudio,
    playback: &OutputPlaybackSnapshot,
) {
    shared
        .paused
        .store(playback.output_paused, Ordering::Release);
    runtime.state = playback.state.clone();
    set_runtime_core_state(runtime, playback.core_state, "output-restart-restored");
    emit_runtime_event(runtime, PlayerEvent::state_change(runtime.state.clone()));
}

fn validate_output_restart_config(
    config: &PlayerConfig,
    shared: Option<&SharedAudio>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    if config.exclusive_output {
        let _ = shared;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    if config.exclusive_output {
        let sample_rate = shared
            .map(|shared| shared.mix_format.sample_rate)
            .unwrap_or_else(|| {
                device::resolve_output_sample_rate(&config.audio_device, config.exclusive_output)
            });
        return device::platform_macos::validate_coreaudio_exclusive_output(
            &config.audio_device,
            sample_rate,
        );
    }
    #[cfg(target_os = "linux")]
    if config.exclusive_output {
        let sample_rate = shared
            .map(|shared| shared.mix_format.sample_rate)
            .unwrap_or_else(|| {
                device::resolve_output_sample_rate(&config.audio_device, config.exclusive_output)
            });
        return device::platform_linux::validate_alsa_exclusive_output(
            &config.audio_device,
            sample_rate,
        );
    }

    let _ = shared;
    device::validate_output_device(&config.audio_device, config.exclusive_output)
}

fn spawn_output_thread_confirmed(
    shared: Arc<SharedAudio>,
    config: &PlayerConfig,
) -> Result<crate::output::AudioOutputHandle, String> {
    let (start_tx, start_rx) = sync_channel(1);
    let output_thread = crate::output::spawn_output_backend(
        config.audio_device.clone(),
        config.exclusive_output,
        shared,
        emit_event,
        Some(start_tx),
    );

    match start_rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            output_thread.shutdown();
            return Err(err);
        }
        Err(RecvTimeoutError::Timeout) => {
            output_thread.shutdown_in_background("startup-timeout");
            return Err("audio output did not start within 3 seconds".to_string());
        }
        Err(RecvTimeoutError::Disconnected) => {
            output_thread.shutdown();
            return Err("audio output exited before startup completed".to_string());
        }
    }
    Ok(output_thread)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn playback_snapshot(core_state: PlaybackCoreState) -> OutputPlaybackSnapshot {
        let idle = core_state.allows_idle_output_release();
        OutputPlaybackSnapshot {
            output_paused: false,
            state: PlayerState {
                playing: !idle,
                paused: idle,
                ..PlayerState::default()
            },
            core_state,
        }
    }

    #[test]
    fn output_restart_only_reschedules_release_for_logically_idle_playback() {
        assert!(playback_snapshot(PlaybackCoreState::Paused).should_release_when_idle());
        assert!(!playback_snapshot(PlaybackCoreState::Buffering).should_release_when_idle());
    }

    #[test]
    fn idle_output_release_only_allows_stable_non_playing_states() {
        for state in [
            PlaybackCoreState::Paused,
            PlaybackCoreState::Draining,
            PlaybackCoreState::Error,
        ] {
            assert!(
                state.allows_idle_output_release(),
                "{} should allow idle output release",
                state.as_str()
            );
        }

        for state in [
            PlaybackCoreState::Idle,
            PlaybackCoreState::Loading,
            PlaybackCoreState::Seeking,
            PlaybackCoreState::Buffering,
            PlaybackCoreState::OutputReconfig,
            PlaybackCoreState::Playing,
            PlaybackCoreState::DeviceLost,
        ] {
            assert!(
                !state.allows_idle_output_release(),
                "{} must keep idle output release disabled",
                state.as_str()
            );
        }
    }

    #[test]
    fn device_lost_snapshot_restores_the_logical_playback_state() {
        let shared = SharedAudio::new(
            crate::shared::MixFormat::stereo_f32(48_000),
            0.2,
            1.0,
            &DspSettings::default(),
        );
        let playing = OutputPlaybackSnapshot::capture(
            PlayerState {
                playing: true,
                paused: false,
                ..PlayerState::default()
            },
            PlaybackCoreState::DeviceLost,
            &shared,
        );
        let paused = OutputPlaybackSnapshot::capture(
            PlayerState {
                playing: false,
                paused: true,
                ..PlayerState::default()
            },
            PlaybackCoreState::DeviceLost,
            &shared,
        );

        assert_eq!(playing.core_state, PlaybackCoreState::Playing);
        assert_eq!(paused.core_state, PlaybackCoreState::Paused);
    }
}
