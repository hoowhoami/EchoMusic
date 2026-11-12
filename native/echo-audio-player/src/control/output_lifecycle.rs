use super::*;
use crate::output::OUTPUT_START_CANCELLED_MESSAGE;
use crate::shared::startup_probe::OutputStartupProbe;
use std::sync::mpsc::Receiver;

/// 暂停后保留共享输出流的时长。3 s 会把每次「暂停 → 播放」都变成一次冷启动的
/// `Initialize`，而 WASAPI/audiodg 的端点拆除是异步的，冷启动很容易撞上尚未
/// 完成的释放。30 s 仍然满足蓝牙端点休眠的诉求，同时让常见的暂停/恢复直接复用
/// 已启动的流，避免把冷启动成本摊到每次暂停上。
const IDLE_OUTPUT_RELEASE_DELAY_SECS: u64 = 30;
/// 独占模式沿用较短的释放窗口：暂停时继续占着设备会阻止其他应用独占播放，
/// 而独占流的冷启动通常很快，不需要用设备占用换恢复速度。
const IDLE_EXCLUSIVE_OUTPUT_RELEASE_DELAY_SECS: u64 = 3;

/// 输出启动看门狗：超过该时长未收到启动确认即判失败。
const OUTPUT_START_WATCHDOG: Duration = Duration::from_secs(3);
/// 看门狗超时后在同端点重试的总尝试次数。只有 `AUDCLNT_E_DEVICE_IN_USE` 这类
/// 立即返回的瞬时错误才重试；看门狗超时**不再重试**——被弃用的线程仍卡在
/// `Initialize` 里并持有端点闸门，立刻再 spawn 一个只会让两次初始化继续排队。
const OUTPUT_START_ATTEMPTS: u32 = 2;
/// 两次尝试之间的间隔：给被弃用的输出线程留出撞上停止令牌检查点退出的时间。
const OUTPUT_START_RETRY_DELAY: Duration = Duration::from_millis(250);
/// 启动确认的轮询步长。加载预热需要在等待期间响应新请求的取消令牌，
/// 避免 stale load 排满端点闸门、拖慢最新一首的首帧。
const OUTPUT_START_POLL_INTERVAL: Duration = Duration::from_millis(50);
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
    let delay_secs = if runtime.config.exclusive_output {
        IDLE_EXCLUSIVE_OUTPUT_RELEASE_DELAY_SECS
    } else {
        IDLE_OUTPUT_RELEASE_DELAY_SECS
    };
    schedule_idle_output_release(shared, release_seq, delay_secs);
}

fn schedule_idle_output_release(shared: Arc<SharedAudio>, release_seq: u64, delay_secs: u64) {
    let _ = thread::Builder::new()
        .name("player-output-idle-release".to_string())
        .spawn(move || {
            thread::sleep(Duration::from_secs(delay_secs));
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
                            format!("audio output released after {delay_secs}s pause"),
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

/// 是否需要重建输出流。
///
/// 会话里的句柄只有在启动确认成功后才写入（加载预热与 restart 都走
/// `spawn_output_thread_confirmed`），所以「句柄存在且线程未退出」即等价于
/// 「输出已经启动」。这里绝不能把启动中的线程判成未启动——那会在同一端点上
/// 叠加第二次 open，正是共享模式 3 s 看门狗超时的直接来源。
pub(crate) fn output_needs_restart(session: &PlaybackSession) -> bool {
    session
        .output_thread
        .as_ref()
        .is_none_or(crate::output::AudioOutputHandle::has_exited)
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
    match spawn_output_thread_confirmed(shared.clone(), &next_config, None) {
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
    let output = match spawn_output_thread_confirmed(shared.clone(), &previous_config, None) {
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

pub(crate) fn spawn_output_thread_confirmed(
    shared: Arc<SharedAudio>,
    config: &PlayerConfig,
    cancel: Option<&AtomicBool>,
) -> Result<crate::output::AudioOutputHandle, String> {
    confirm_output_start_with_retries(
        || confirm_output_start_once(&shared, config, cancel),
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
/// 只重试端点占用（`AUDCLNT_E_DEVICE_IN_USE`）这种立即返回的瞬时错误；
/// 看门狗超时意味着旧线程可能仍卡在 `Initialize` 里占着端点闸门，此时再 spawn
/// 一个只会把两次 open 继续排进 audiodg 的串行队列；取消、设备不存在、格式
/// 不支持等永久错误同样立即返回。
fn is_retryable_output_start_error(message: &str) -> bool {
    message.contains("0x88890010") || message.contains("device is already in use")
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
    cancel: Option<&AtomicBool>,
) -> Result<crate::output::AudioOutputHandle, String> {
    if cancel.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err(OUTPUT_START_CANCELLED_MESSAGE.to_string());
    }
    let (start_tx, start_rx) = sync_channel(1);
    let output_thread = crate::output::spawn_output_backend(
        config.audio_device.clone(),
        config.exclusive_output,
        shared.clone(),
        emit_event,
        Some(start_tx),
    );
    await_output_start_once(output_thread, &start_rx, shared, config, cancel)
}

/// 等待输出线程确认启动；每 50ms 复查一次取消令牌。独立成函数便于单测
/// 「等待途中被取消」这条路径（spawn 本身依赖真实后端，无法在单测里跑）。
fn await_output_start_once(
    output_thread: crate::output::AudioOutputHandle,
    start_rx: &Receiver<Result<(), String>>,
    shared: &Arc<SharedAudio>,
    config: &PlayerConfig,
    cancel: Option<&AtomicBool>,
) -> Result<crate::output::AudioOutputHandle, String> {
    let deadline = Instant::now() + OUTPUT_START_WATCHDOG;
    loop {
        if cancel.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            // 预热已被新 load 取代：后台回收线程（可能正卡在 Initialize），立刻返回。
            output_thread.shutdown_in_background("cancelled-prewarm");
            emit_shared_event(
                shared,
                PlayerEvent::log(
                    "debug",
                    "audio output startup cancelled by superseded load".to_string(),
                ),
            );
            return Err(OUTPUT_START_CANCELLED_MESSAGE.to_string());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
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
                        "audio output startup timeout diagnostics: device='{}', exclusive={}, active_streams={}, startup {}",
                        config.audio_device,
                        config.exclusive_output,
                        crate::output::live_output_stream_count(),
                        shared.output_startup_probe.describe(),
                    ),
                ),
            );
            return Err(output_start_timeout_message(
                OUTPUT_START_WATCHDOG,
                config.exclusive_output,
                &shared.output_startup_probe,
            ));
        }
        // 没有取消令牌（restart/recovery 路径）时一次等到截止，不做 50ms 空转。
        let poll = if cancel.is_some() {
            remaining.min(OUTPUT_START_POLL_INTERVAL)
        } else {
            remaining
        };
        match start_rx.recv_timeout(poll) {
            Ok(Ok(())) => return Ok(output_thread),
            Ok(Err(err)) => {
                output_thread.shutdown();
                return Err(err);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                output_thread.shutdown();
                return Err("audio output exited before startup completed".to_string());
            }
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
    fn output_restart_depends_on_handle_presence_and_liveness() {
        let shared = Arc::new(SharedAudio::new(
            MixFormat::stereo_f32(48_000),
            0.2,
            1.0,
            &DspSettings::default(),
        ));
        let session = |output_thread| PlaybackSession {
            shared: shared.clone(),
            output_thread,
            filter_thread: None,
            decode_thread: None,
            decode_commands: None,
            position_thread: None,
        };

        // 没有输出线程 → 需要重建。
        assert!(output_needs_restart(&session(None)));

        let stop = crate::output::OutputStopToken::new();
        let thread_stop = stop.clone();
        let thread_shared = shared.clone();
        let thread = thread::spawn(move || {
            while !thread_stop.should_stop(&thread_shared) {
                thread::sleep(Duration::from_millis(5));
            }
        });
        let mut live_session = session(Some(crate::output::AudioOutputHandle::new(stop, thread)));
        // 活着的句柄一定来自启动确认成功的路径 → 直接复用，不再叠加 open。
        assert!(!output_needs_restart(&live_session));
        live_session.output_thread.take().unwrap().shutdown();

        // 线程已经退出 → 需要重建。
        let exited = crate::output::AudioOutputHandle::new(
            crate::output::OutputStopToken::new(),
            thread::spawn(|| {}),
        );
        let mut attempts = 0;
        while !exited.has_exited() && attempts < 2000 {
            thread::sleep(Duration::from_millis(1));
            attempts += 1;
        }
        assert!(output_needs_restart(&session(Some(exited))));
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
                    "failed to open WASAPI shared output: device is already in use (0x88890010, attempt-{attempt})"
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
                "failed to open WASAPI shared output: device is already in use (0x88890010, attempt-{})",
                OUTPUT_START_ATTEMPTS
            )
        );
    }

    #[test]
    fn output_start_timeout_is_not_retried_while_the_zombie_open_may_hold_the_gate() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let attempts = Arc::new(AtomicUsize::new(0));
        let counter = attempts.clone();
        let result = confirm_output_start_with_retries(
            move || {
                counter.fetch_add(1, Ordering::SeqCst);
                Err(output_start_timeout_message(
                    OUTPUT_START_WATCHDOG,
                    false,
                    &OutputStartupProbe::default(),
                ))
            },
            OUTPUT_START_ATTEMPTS,
            Duration::from_millis(1),
            is_retryable_output_start_error,
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert!(result.is_err());
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
                        "failed to open WASAPI shared output: device is already in use (0x88890010, attempt-{attempt})"
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
        assert!(!is_retryable_output_start_error(
            "audio output did not start within 3000 ms (exclusive=false, startup stage=initialize, last_hresult=pending)"
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

    #[test]
    fn cancelled_prewarm_returns_before_spawning_an_output() {
        let shared = Arc::new(SharedAudio::new(
            MixFormat::stereo_f32(48_000),
            0.2,
            1.0,
            &DspSettings::default(),
        ));
        let cancel = AtomicBool::new(true);
        let error = confirm_output_start_once(&shared, &PlayerConfig::default(), Some(&cancel))
            .err()
            .expect("cancelled prewarm must not spawn an output thread");
        assert_eq!(error, crate::output::OUTPUT_START_CANCELLED_MESSAGE);
    }

    #[test]
    fn awaited_output_start_observes_cancellation_while_waiting() {
        // 取消分支会经 emit_shared_event 向全局 TEST_EVENT_SINK 注入日志事件；
        // 与其它触碰全局事件管道的测试共用一把锁，避免并行时污染断言。
        let _runtime_guard = crate::TEST_RUNTIME_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let shared = Arc::new(SharedAudio::new(
            MixFormat::stereo_f32(48_000),
            0.2,
            1.0,
            &DspSettings::default(),
        ));
        let config = PlayerConfig::default();
        // sender 保持存活，让 recv_timeout 反复 Timeout 而不是 Disconnected。
        let (_start_tx, start_rx) = sync_channel::<Result<(), String>>(1);
        let stop = crate::output::OutputStopToken::new();
        let thread_stop = stop.clone();
        let thread_shared = shared.clone();
        let thread = thread::spawn(move || {
            while !thread_stop.should_stop(&thread_shared) {
                thread::sleep(Duration::from_millis(1));
            }
        });
        let output_thread = crate::output::AudioOutputHandle::new(stop, thread);

        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_for_thread = cancel.clone();
        let canceller = thread::spawn(move || {
            thread::sleep(Duration::from_millis(30));
            cancel_for_thread.store(true, Ordering::Release);
        });

        let started = Instant::now();
        let error = await_output_start_once(
            output_thread,
            &start_rx,
            &shared,
            &config,
            Some(cancel.as_ref()),
        )
        .err()
        .expect("waiting prewarm must observe cancellation");
        assert_eq!(error, crate::output::OUTPUT_START_CANCELLED_MESSAGE);
        assert!(started.elapsed() >= Duration::from_millis(20));
        assert!(started.elapsed() < Duration::from_secs(2));
        canceller.join().unwrap();
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
        let error = match spawn_output_thread_confirmed(shared, &config, None) {
            Ok(_) => panic!("bogus device must fail to start"),
            Err(error) => error,
        };
        assert!(error.contains("not found"), "{error}");
    }
}
