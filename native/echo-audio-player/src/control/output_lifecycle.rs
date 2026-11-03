use super::*;
use crate::shared::startup_probe::OutputStartupProbe;

const IDLE_OUTPUT_RELEASE_DELAY_SECS: u64 = 3;

/// 输出启动看门狗：超过该时长未收到启动确认即判失败。
const OUTPUT_START_WATCHDOG: Duration = Duration::from_secs(3);
/// 看门狗超时后在同端点重试的总尝试次数。第一次失败常是引擎/驱动侧的
/// 瞬时串行化（端点刚经历路由切换或被弃用线程占用），立即重试一次通常即可成功。
const OUTPUT_START_ATTEMPTS: u32 = 2;
/// 两次尝试之间的间隔：给被弃用的输出线程留出撞上停止令牌检查点退出的时间。
const OUTPUT_START_RETRY_DELAY: Duration = Duration::from_millis(250);
/// 看门狗超时消息前缀；重试判定与消息构造共用，避免文案漂移。
const OUTPUT_START_TIMEOUT_MESSAGE_PREFIX: &str = "audio output did not start within";

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
    confirm_output_start_with_retries(
        || confirm_output_start_once(&shared, config),
        OUTPUT_START_ATTEMPTS,
        OUTPUT_START_RETRY_DELAY,
        is_retryable_output_start_error,
    )
}

/// 带重试的启动确认：`confirm` 返回可重试错误后延迟 `retry_delay` 再试，直到用完
/// `attempts` 次数；永久错误立即返回，避免白等并拖住后续核心命令。
/// 独立成闭包形式便于单测重试语义。
fn confirm_output_start_with_retries<F>(
    mut confirm: F,
    attempts: u32,
    retry_delay: Duration,
    should_retry: impl Fn(&str) -> bool,
) -> Result<crate::output::AudioOutputHandle, String>
where
    F: FnMut() -> Result<crate::output::AudioOutputHandle, String>,
{
    let mut last_error = String::new();
    for attempt in 0..attempts {
        if attempt > 0 {
            // 上一线程可能仍卡在某个启动调用里；等它撞上停止令牌检查点退出，
            // 再在同端点重试，避免两次 open 在驱动里互相串行化拖满看门狗。
            thread::sleep(retry_delay);
        }
        match confirm() {
            Ok(output) => return Ok(output),
            Err(err) => {
                let retryable = should_retry(&err);
                last_error = err;
                if !retryable {
                    break;
                }
            }
        }
    }
    Err(last_error)
}

/// 启动错误是否值得在同端点立即重试。
/// 只重试看门狗超时（端点可能被弃用的旧线程占着）与端点占用这类瞬时错误；
/// 取消、设备不存在、格式不支持等永久错误立即返回。
fn is_retryable_output_start_error(message: &str) -> bool {
    message.starts_with(OUTPUT_START_TIMEOUT_MESSAGE_PREFIX)
        || message.contains("0x88890010")
        || message.contains("device is already in use")
}

/// 看门狗超时的错误消息。只承载受控字段（exclusive 标志 + 启动探针快照），
/// 不内嵌端点名：该消息会原样透传给前端，被 `resolveAudioFailureReason` /
/// `isOutputDeviceError` 按关键词归类，设备名里出现 network、decode、
/// "output device" 等字样会把超时误分类成网络/解码/输出设备错误。
fn output_start_timeout_message(
    watchdog: Duration,
    exclusive: bool,
    probe: &OutputStartupProbe,
) -> String {
    format!(
        "{} {} ms (exclusive={}, startup {})",
        OUTPUT_START_TIMEOUT_MESSAGE_PREFIX,
        watchdog.as_millis(),
        exclusive,
        probe.describe(),
    )
}

fn confirm_output_start_once(
    shared: &Arc<SharedAudio>,
    config: &PlayerConfig,
) -> Result<crate::output::AudioOutputHandle, String> {
    let (start_tx, start_rx) = sync_channel(1);
    let output_thread = crate::output::spawn_output_backend(
        config.audio_device.clone(),
        config.exclusive_output,
        shared.clone(),
        emit_event,
        Some(start_tx),
    );

    match start_rx.recv_timeout(OUTPUT_START_WATCHDOG) {
        Ok(Ok(())) => Ok(output_thread),
        Ok(Err(err)) => {
            output_thread.shutdown();
            Err(err)
        }
        Err(RecvTimeoutError::Timeout) => {
            output_thread.shutdown_in_background("startup-timeout");
            // 超时不是系统返回的错误，线程卡在哪个启动调用里必须跟着报出来，
            // 否则共享模式这类"无 HRESULT 的 3 秒静默超时"完全无法定位。
            // 端点名走诊断日志而非错误消息：错误字符串会原样透传给前端并被
            // 关键词分类器扫描，设备名属于不受控文本（可能含 network、
            // "output device" 等字样），会污染前端对超时错误的归类。
            emit_shared_event(
                shared,
                PlayerEvent::log(
                    "warn",
                    format!(
                        "audio output startup timeout diagnostics: device='{}', exclusive={}, startup {}",
                        config.audio_device,
                        config.exclusive_output,
                        shared.output_startup_probe.describe(),
                    ),
                ),
            );
            Err(output_start_timeout_message(
                OUTPUT_START_WATCHDOG,
                config.exclusive_output,
                &shared.output_startup_probe,
            ))
        }
        Err(RecvTimeoutError::Disconnected) => {
            output_thread.shutdown();
            Err("audio output exited before startup completed".to_string())
        }
    }
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
    fn state_events_use_live_progress_after_pause_and_output_restart() {
        let shared = Arc::new(SharedAudio::new(
            MixFormat::stereo_f32(48_000),
            0.2,
            1.0,
            &DspSettings::default(),
        ));
        let mut runtime = PlayerRuntime::new(PlayerConfig::default());
        runtime.current_seq = 7;
        shared.set_track_seq(7);
        runtime.session = Some(PlaybackSession {
            shared: shared.clone(),
            output_thread: None,
            filter_thread: None,
            decode_thread: None,
            decode_commands: None,
            position_thread: None,
        });

        for (cached, live, paused) in [(0.0, 12.0, false), (12.0, 37.0, true), (37.0, 45.0, false)]
        {
            runtime.state.time_pos = cached;
            runtime.state.playing = !paused;
            runtime.state.paused = paused;
            shared.set_position_secs(live);
            let event = contextualize_runtime_event(
                &runtime,
                PlayerEvent::state_change(runtime.state.clone()),
            );
            let state = event.state.unwrap();
            assert_eq!(state.time_pos, live);
            assert_eq!(state.paused, paused);
            assert_eq!(event.track_seq, Some(7.0));
        }
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

    #[test]
    fn output_start_retry_exhausts_attempts_and_returns_last_error() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let attempts = Arc::new(AtomicUsize::new(0));
        let counter = attempts.clone();
        let result = confirm_output_start_with_retries(
            move || {
                let attempt = counter.fetch_add(1, Ordering::SeqCst) + 1;
                Err(format!(
                    "{OUTPUT_START_TIMEOUT_MESSAGE_PREFIX} 3 ms (attempt-{attempt})"
                ))
            },
            OUTPUT_START_ATTEMPTS,
            Duration::from_millis(1),
            is_retryable_output_start_error,
        );
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            OUTPUT_START_ATTEMPTS as usize
        );
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("all attempts failed, must return the last error"),
        };
        assert_eq!(
            error,
            format!(
                "{OUTPUT_START_TIMEOUT_MESSAGE_PREFIX} 3 ms (attempt-{})",
                OUTPUT_START_ATTEMPTS
            )
        );
    }

    #[test]
    fn output_start_retry_stops_on_permanent_error() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        for message in [
            "failed to resolve WASAPI output device: not found",
            crate::output::OUTPUT_START_CANCELLED_MESSAGE,
        ] {
            let attempts = Arc::new(AtomicUsize::new(0));
            let counter = attempts.clone();
            let result = confirm_output_start_with_retries(
                move || {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Err(message.to_string())
                },
                OUTPUT_START_ATTEMPTS,
                Duration::from_millis(1),
                is_retryable_output_start_error,
            );
            assert_eq!(attempts.load(Ordering::SeqCst), 1, "message={message}");
            assert_eq!(result.err().as_deref(), Some(message));
        }
    }

    #[test]
    fn output_start_retry_short_circuits_on_first_success() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};

        let attempts = Arc::new(AtomicUsize::new(0));
        let counter = attempts.clone();
        let handle = crate::output::AudioOutputHandle::new(
            crate::output::OutputStopToken::new(),
            thread::spawn(|| {}),
        );
        let slot = Mutex::new(Some(handle));
        let result = confirm_output_start_with_retries(
            move || {
                let attempt = counter.fetch_add(1, Ordering::SeqCst) + 1;
                if attempt < OUTPUT_START_ATTEMPTS as usize {
                    Err(format!(
                        "{OUTPUT_START_TIMEOUT_MESSAGE_PREFIX} 3 ms (attempt-{attempt})"
                    ))
                } else {
                    slot.lock()
                        .unwrap()
                        .take()
                        .ok_or_else(|| "handle already taken".to_string())
                }
            },
            OUTPUT_START_ATTEMPTS,
            Duration::from_millis(1),
            is_retryable_output_start_error,
        );
        assert!(result.is_ok());
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            OUTPUT_START_ATTEMPTS as usize
        );
    }

    #[test]
    fn output_start_retry_classifies_transient_and_permanent_errors() {
        assert!(is_retryable_output_start_error(
            "audio output did not start within 3000 ms (exclusive=false, startup stage=initialize)"
        ));
        assert!(is_retryable_output_start_error(
            "failed to open WASAPI shared output: device is already in use by another exclusive stream or driver session (0x88890010)"
        ));
        assert!(!is_retryable_output_start_error(
            "failed to open WASAPI exclusive output: device rejected the exclusive PCM format (0x88890008)"
        ));
        assert!(!is_retryable_output_start_error(
            "failed to resolve WASAPI output device: not found"
        ));
        assert!(!is_retryable_output_start_error(
            crate::output::OUTPUT_START_CANCELLED_MESSAGE
        ));
    }

    #[test]
    fn output_start_timeout_message_keeps_uncontrolled_device_name_out() {
        let probe = OutputStartupProbe::default();
        let message = output_start_timeout_message(OUTPUT_START_WATCHDOG, false, &probe);
        // 设备名属于不受控文本，绝不能进入会按关键词归类的错误消息。
        assert!(!message.contains("device='"), "{message}");
        assert!(message.contains("exclusive=false"), "{message}");
        assert!(message.contains("startup stage=not-reported"), "{message}");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn output_start_confirmed_reports_backend_failure_for_bogus_device() {
        let shared = Arc::new(SharedAudio::new(
            MixFormat::stereo_f32(48_000),
            0.2,
            1.0,
            &DspSettings::default(),
        ));
        let mut config = PlayerConfig::default();
        config.set_audio_device("echo-music-nonexistent-output-endpoint");
        let error = match spawn_output_thread_confirmed(shared, &config) {
            Ok(_) => panic!("bogus device must fail to start"),
            Err(error) => error,
        };
        assert!(error.contains("not found"), "{error}");
    }
}
