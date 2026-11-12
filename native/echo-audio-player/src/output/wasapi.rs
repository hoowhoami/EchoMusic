use super::cpal_shared::{fill_output_reusing, OutputResampler};
use crate::device::platform_windows::{
    activate_wasapi_audio_client, choose_wasapi_output_format, choose_wasapi_shared_output_format,
    is_wasapi_buffer_size_not_aligned, is_wasapi_device_in_use, resolve_wasapi_output_device,
    wasapi_client_error_message, wasapi_duration_from_frames, wasapi_exclusive_buffer_duration,
    ComApartment, WasapiOutputFormat, WasapiResolvedFormat, WasapiSampleFormat,
};
use crate::events::{PlayerErrorCode, PlayerEvent};
use crate::output::{
    build_output_stats, output_buffer_mode_for_frames, output_start_was_cancelled,
    report_output_start, report_output_start_failure, service_wasapi_event, OutputStartSender,
    OutputStopToken, OUTPUT_START_CANCELLED_MESSAGE,
};
use crate::platform_qos;
use crate::shared::startup_probe::output_startup_stage;
use crate::shared::SharedAudio;
use std::collections::HashMap;
use std::ptr;
use std::slice;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, TryLockError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use windows::core::HRESULT;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Media::Audio;
use windows::Win32::System::Threading;

const WASAPI_EVENT_WAIT_MS: u32 = 10;
// 端点释放（含独占流拆除后音频引擎的异步收尾）期间，共享与独占初始化都可能
// 拿到 AUDCLNT_E_DEVICE_IN_USE，统一等待重试而不是立即判失败。
const WASAPI_DEVICE_RELEASE_TIMEOUT: Duration = Duration::from_millis(1500);
const WASAPI_DEVICE_RELEASE_RETRY: Duration = Duration::from_millis(50);
/// 等待端点闸门超过该时长时打一条 info 日志，便于确认 open 是否被上一代流拖住。
const WASAPI_OPEN_GATE_LOG_MS: u64 = 50;
/// 闸门持有者超过该时长仍未释放时打一条 warn，帮助识别永久卡在 Initialize 的流。
const WASAPI_OPEN_GATE_HOLDER_WARN_MS: u64 = 2_000;

/// 端点级 open 闸门：audiodg 对同一端点的新建流是串行的，两个线程并发
/// `IAudioClient::Initialize` 时后到者会继承前者的耗时，最终一起撞满启动看门狗。
/// 因此同一端点同一时刻只允许一条输出线程执行「激活客户端 → 协商格式 →
/// Initialize」；后面被取消的线程也会在离开临界区前让出闸门。
struct EndpointOpenGate {
    mutex: Mutex<()>,
    /// 当前持闸线程开始持锁的时刻（进程启动起的毫秒）。0 保留表示空闲，
    /// 因此实际持锁时间写入 `max(1)`，避免 0ms 的语义双关；等待者据此判断
    /// 「是不是有流永久卡在 Initialize」并输出 holder age。
    holder_acquired_ms: AtomicU64,
}

impl Default for EndpointOpenGate {
    fn default() -> Self {
        Self {
            mutex: Mutex::new(()),
            holder_acquired_ms: AtomicU64::new(0),
        }
    }
}

/// 闸门守卫：离开 open 临界区时清空持有者时间戳。
struct EndpointOpenGuard<'a> {
    _guard: MutexGuard<'a, ()>,
    gate: &'a EndpointOpenGate,
}

impl Drop for EndpointOpenGuard<'_> {
    fn drop(&mut self) {
        self.gate.holder_acquired_ms.store(0, Ordering::Release);
    }
}

/// 端点数量受设备枚举限制，这里不做淘汰也保持有界（不会随播放次数增长）。
static ENDPOINT_OPEN_GATES: OnceLock<Mutex<HashMap<String, Arc<EndpointOpenGate>>>> =
    OnceLock::new();
/// 闸门时间的统一基准；`Instant` 单调且不受系统时间调整影响。
static GATE_CLOCK: OnceLock<Instant> = OnceLock::new();

fn gate_now_ms() -> u64 {
    GATE_CLOCK.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// 当前进程内已成功初始化、尚未释放的 WASAPI 输出流数量。
/// 注意：仍卡在 `Initialize` 里的 client 不计入，这类情况由超时诊断里的
/// `gate_holder_age_ms` 反映。
static LIVE_OUTPUT_STREAMS: AtomicU32 = AtomicU32::new(0);

pub(crate) fn live_output_stream_count() -> u32 {
    LIVE_OUTPUT_STREAMS.load(Ordering::Acquire)
}

fn endpoint_open_gate(endpoint_key: &str) -> Arc<EndpointOpenGate> {
    let gates = ENDPOINT_OPEN_GATES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = gates
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.entry(endpoint_key.to_string()).or_default().clone()
}

/// 闸门等待期间打日志所需的上下文（打包参数，避免函数超出 clippy 参数上限）。
struct GateWaitLog<'a> {
    endpoint_key: &'a str,
    share_mode: WasapiShareMode,
    emit: fn(PlayerEvent),
}

/// 取消感知地获取端点闸门：等待期间一旦输出被弃用（设备切换 / 启动超时），
/// 立刻退出而不是继续排队。返回 `None` 表示本次启动已被取消。
///
/// 参数刻意控制在 clippy 阈值内；等待耗时通过返回值交给调用方打日志。
fn lock_endpoint_open_gate<'a>(
    gate: &'a EndpointOpenGate,
    stop: &OutputStopToken,
    shared: &SharedAudio,
    start_notify: &mut Option<OutputStartSender>,
    probe_attempt: u64,
    attempt_start: Instant,
    log: GateWaitLog<'_>,
) -> Option<(EndpointOpenGuard<'a>, u64)> {
    let wait_started = Instant::now();
    let mut waiting_stage_reported = false;
    let mut holder_age_warned = false;
    loop {
        let acquired = match gate.mutex.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => {
                let waited_ms = wait_started.elapsed().as_millis() as u64;
                let holder_acquired_ms = gate.holder_acquired_ms.load(Ordering::Acquire);
                let holder_age_ms = if holder_acquired_ms == 0 {
                    waited_ms
                } else {
                    gate_now_ms().saturating_sub(holder_acquired_ms)
                };
                shared
                    .output_startup_probe
                    .record_gate_wait(probe_attempt, waited_ms);
                shared
                    .output_startup_probe
                    .record_gate_holder_age(probe_attempt, holder_age_ms);
                if !waiting_stage_reported {
                    // 让超时诊断直接显示「卡在等端点闸门」，而不是停在 resolve 阶段。
                    shared.output_startup_probe.advance(
                        probe_attempt,
                        output_startup_stage::WAITING_ENDPOINT,
                        attempt_start,
                    );
                    waiting_stage_reported = true;
                }
                if holder_age_ms >= WASAPI_OPEN_GATE_HOLDER_WARN_MS && !holder_age_warned {
                    holder_age_warned = true;
                    (log.emit)(PlayerEvent::log(
                        "warn",
                        format!(
                            "WASAPI {} output open is waiting for a previous stream on device='{}' that has been initializing for {holder_age_ms} ms",
                            log.share_mode.label(),
                            log.endpoint_key,
                        ),
                    ));
                }
                if output_start_was_cancelled(stop, shared, start_notify) {
                    return None;
                }
                thread::sleep(Duration::from_millis(5));
                continue;
            }
        };
        let waited_ms = wait_started.elapsed().as_millis() as u64;
        shared
            .output_startup_probe
            .record_gate_wait(probe_attempt, waited_ms);
        shared
            .output_startup_probe
            .record_gate_holder_age(probe_attempt, 0);
        // 等待期间也可能被弃用；拿到闸门后立刻复查，别再白白激活一个 client。
        if output_start_was_cancelled(stop, shared, start_notify) {
            return None;
        }
        gate.holder_acquired_ms
            .store(gate_now_ms().max(1), Ordering::Release);
        return Some((
            EndpointOpenGuard {
                _guard: acquired,
                gate,
            },
            waited_ms,
        ));
    }
}

struct EventHandle(HANDLE);

impl Drop for EventHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WasapiShareMode {
    Shared,
    Exclusive,
}

impl WasapiShareMode {
    fn from_exclusive(exclusive: bool) -> Self {
        if exclusive {
            Self::Exclusive
        } else {
            Self::Shared
        }
    }

    fn as_wasapi(self) -> Audio::AUDCLNT_SHAREMODE {
        match self {
            Self::Shared => Audio::AUDCLNT_SHAREMODE_SHARED,
            Self::Exclusive => Audio::AUDCLNT_SHAREMODE_EXCLUSIVE,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Shared => "shared",
            Self::Exclusive => "exclusive",
        }
    }

    fn backend(self) -> &'static str {
        match self {
            Self::Shared => "wasapi",
            Self::Exclusive => "wasapi-exclusive",
        }
    }

    fn error_code(self) -> PlayerErrorCode {
        match self {
            Self::Shared => PlayerErrorCode::OutputStream,
            Self::Exclusive => PlayerErrorCode::OutputExclusive,
        }
    }
}

struct WasapiOutput {
    audio_client: Audio::IAudioClient,
    render_client: Audio::IAudioRenderClient,
    buffer_frames: u32,
    buffer_duration: i64,
    stream_latency_100ns: i64,
}

impl Drop for WasapiOutput {
    fn drop(&mut self) {
        decrement_live_output_streams();
    }
}

/// 配对 +1/-1；用饱和 CAS 兜底，诊断计数不应因异常路径下溢成巨值。
fn decrement_live_output_streams() {
    let mut current = LIVE_OUTPUT_STREAMS.load(Ordering::Acquire);
    loop {
        let next = current.saturating_sub(1);
        match LIVE_OUTPUT_STREAMS.compare_exchange_weak(
            current,
            next,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return,
            Err(observed) => current = observed,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WasapiOutputErrorAction {
    Ignore { reason: &'static str },
    Recover { reason: &'static str },
    Escalate { reason: &'static str },
}

impl WasapiOutputErrorAction {
    fn with_endpoint_active(self, active: bool) -> Self {
        // DEVICE_INVALIDATED also means the engine format changed (for example
        // when toggling spatial sound). Check the original endpoint, not the
        // current default, which may already have switched after an unplug.
        match self {
            Self::Recover {
                reason: "device-not-available",
            } if active => Self::Recover {
                reason: "stream-invalidated",
            },
            action => action,
        }
    }

    fn should_pause(self, pause_on_disconnect: bool) -> bool {
        pause_on_disconnect
            && matches!(
                self,
                Self::Recover {
                    reason: "device-not-available"
                }
            )
    }
}

#[derive(Clone, Debug)]
struct WasapiOutputFailure {
    message: String,
    action: WasapiOutputErrorAction,
}

impl WasapiOutputFailure {
    fn backend(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            action: WasapiOutputErrorAction::Escalate { reason: "backend" },
        }
    }

    fn recover(message: impl Into<String>, reason: &'static str) -> Self {
        Self {
            message: message.into(),
            action: WasapiOutputErrorAction::Recover { reason },
        }
    }

    fn from_client_error(context: &str, err: &windows::core::Error) -> Self {
        Self {
            message: wasapi_client_error_message(context, err),
            action: classify_wasapi_client_error(err.code()),
        }
    }
}

fn classify_wasapi_client_error(code: HRESULT) -> WasapiOutputErrorAction {
    if code == Audio::AUDCLNT_E_DEVICE_INVALIDATED {
        WasapiOutputErrorAction::Recover {
            reason: "device-not-available",
        }
    } else if code == Audio::AUDCLNT_E_RESOURCES_INVALIDATED
        || code == Audio::AUDCLNT_E_SERVICE_NOT_RUNNING
    {
        WasapiOutputErrorAction::Recover {
            reason: "stream-invalidated",
        }
    } else if code == Audio::AUDCLNT_E_BUFFER_ERROR || code == Audio::AUDCLNT_E_CPUUSAGE_EXCEEDED {
        WasapiOutputErrorAction::Ignore { reason: "xrun" }
    } else {
        WasapiOutputErrorAction::Escalate { reason: "backend" }
    }
}

fn handle_wasapi_output_failure(
    requested_mode: WasapiShareMode,
    shared: &Arc<SharedAudio>,
    stop: &OutputStopToken,
    emit: fn(PlayerEvent),
    start_notify: &mut Option<OutputStartSender>,
    failure: WasapiOutputFailure,
) -> bool {
    let WasapiOutputFailure { message, action } = failure;
    let startup_failure = report_output_start_failure(start_notify, message.clone());
    if startup_failure {
        stop.request_stop();
        return true;
    }

    match action {
        WasapiOutputErrorAction::Ignore { reason } => {
            emit(PlayerEvent::log(
                "warn",
                format!(
                    "WASAPI {} ignored output error after stream exit: reason={reason}, message={message}",
                    requested_mode.label()
                ),
            ));
        }
        WasapiOutputErrorAction::Recover { reason } => {
            if action.should_pause(shared.should_pause_on_device_disconnect()) {
                stop.request_stop();
                emit(PlayerEvent::error_with_reason(
                    PlayerErrorCode::OutputRuntime,
                    message,
                    reason,
                ));
            } else {
                crate::request_output_recovery(Arc::clone(shared), reason, message);
            }
        }
        WasapiOutputErrorAction::Escalate { reason } => {
            stop.request_stop();
            emit(PlayerEvent::error_with_reason(
                requested_mode.error_code(),
                message,
                reason,
            ));
        }
    }
    false
}

pub fn spawn_output_thread(
    device_name: String,
    exclusive: bool,
    shared: Arc<SharedAudio>,
    stop: OutputStopToken,
    emit: fn(PlayerEvent),
    start_notify: Option<OutputStartSender>,
) -> JoinHandle<()> {
    // 在创建线程前就开启新一次尝试：即使旧线程仍卡在 COM 初始化/MMCSS 注册，
    // 或者晚于新线程进入 run_wasapi_output，也只能携带旧代号，无法污染新探针。
    let attempt_start = Instant::now();
    let probe_attempt = shared.output_startup_probe.begin_attempt();
    thread::Builder::new()
        .name("player-wasapi-output".to_string())
        .spawn(move || {
            let mut start_notify = start_notify;
            let requested_mode = WasapiShareMode::from_exclusive(exclusive);
            match run_wasapi_output(
                &device_name,
                requested_mode,
                shared.clone(),
                stop.clone(),
                emit,
                probe_attempt,
                attempt_start,
                &mut start_notify,
            ) {
                Ok(()) => {}
                Err(failure) => {
                    if handle_wasapi_output_failure(
                        requested_mode,
                        &shared,
                        &stop,
                        emit,
                        &mut start_notify,
                        failure,
                    ) {
                        return;
                    }
                }
            }
        })
        .expect("failed to spawn WASAPI output thread")
}

/// 记录启动阶段耗时；某阶段进入得偏慢时打一条限频 info 日志（每阶段至多一条），
/// 让"端点能开但开得慢"在日志里直接可见。
fn advance_startup_stage(
    shared: &SharedAudio,
    share_mode: WasapiShareMode,
    emit: fn(PlayerEvent),
    probe_attempt: u64,
    stage: u8,
    attempt_start: Instant,
) {
    if let Some(entered_ms) =
        shared
            .output_startup_probe
            .advance(probe_attempt, stage, attempt_start)
    {
        emit(PlayerEvent::log(
            "info",
            format!(
                "WASAPI {} startup slow: stage={}, entered_at_ms={entered_ms}",
                share_mode.label(),
                output_startup_stage::label(stage),
            ),
        ));
    }
}

fn run_wasapi_output(
    device_name: &str,
    share_mode: WasapiShareMode,
    shared: Arc<SharedAudio>,
    stop: OutputStopToken,
    emit: fn(PlayerEvent),
    probe_attempt: u64,
    attempt_start: Instant,
    start_notify: &mut Option<OutputStartSender>,
) -> Result<(), WasapiOutputFailure> {
    let _com = ComApartment::init().map_err(WasapiOutputFailure::backend)?;
    let _mmcss = match platform_qos::boost_audio_output_thread() {
        Ok(task) => {
            emit(PlayerEvent::log(
                "info",
                format!(
                    "WASAPI {} output thread registered with MMCSS Pro Audio",
                    share_mode.label()
                ),
            ));
            Some(task)
        }
        Err(err) => {
            emit(PlayerEvent::log("warn", err));
            None
        }
    };

    // 每个启动阶段之间检查停止令牌：被弃用的输出线程（设备切换、启动超时）最坏
    // 只多跑一个 COM 调用就退出，不再与下一个输出线程在同一端点上互相卡死。
    if output_start_was_cancelled(&stop, &shared, start_notify) {
        return Ok(());
    }
    advance_startup_stage(
        &shared,
        share_mode,
        emit,
        probe_attempt,
        output_startup_stage::RESOLVING_DEVICE,
        attempt_start,
    );
    let device = resolve_wasapi_output_device(device_name).map_err(WasapiOutputFailure::backend)?;
    let preferred_output_format = shared.preferred_output_sample_format();
    // 同端点只允许一条 open 序列在飞：后面的线程（设备切换、超时后的替代尝试）
    // 在这里排队等待，而不是与前者并发调用 Initialize 被 audiodg 串行化。
    let endpoint_key = match crate::device::platform_windows::wasapi_endpoint_id(&device) {
        Some(endpoint_id) => endpoint_id,
        None => {
            // 逻辑名（auto/default）和具体端点 ID 混用会绕过串行化，必须留痕。
            emit(PlayerEvent::log(
                "warn",
                format!(
                    "WASAPI {} output open could not resolve endpoint id; using configured device key '{device_name}' for open serialization",
                    share_mode.label()
                ),
            ));
            device_name.to_string()
        }
    };
    let open_gate = endpoint_open_gate(&endpoint_key);
    let gate_log = GateWaitLog {
        endpoint_key: &endpoint_key,
        share_mode,
        emit,
    };
    let output_format;
    let event;
    let output = {
        let (open_guard, gate_waited_ms) = match lock_endpoint_open_gate(
            &open_gate,
            &stop,
            &shared,
            start_notify,
            probe_attempt,
            attempt_start,
            gate_log,
        ) {
            Some(acquired) => acquired,
            None => return Ok(()),
        };
        if gate_waited_ms >= WASAPI_OPEN_GATE_LOG_MS {
            emit(PlayerEvent::log(
                "info",
                format!(
                    "WASAPI {} output open serialized behind previous stream: device='{endpoint_key}', waited_ms={gate_waited_ms}, active_streams={}",
                    share_mode.label(),
                    live_output_stream_count(),
                ),
            ));
        }
        advance_startup_stage(
            &shared,
            share_mode,
            emit,
            probe_attempt,
            output_startup_stage::PROBE_ACTIVATE,
            attempt_start,
        );
        let probe_client =
            activate_wasapi_audio_client(&device).map_err(WasapiOutputFailure::backend)?;
        advance_startup_stage(
            &shared,
            share_mode,
            emit,
            probe_attempt,
            output_startup_stage::CHOOSE_FORMAT,
            attempt_start,
        );
        let resolved_format = match share_mode {
            WasapiShareMode::Shared => {
                choose_wasapi_shared_output_format(&probe_client, shared.mix_format.channels)
                    .map_err(WasapiOutputFailure::backend)?
            }
            WasapiShareMode::Exclusive => choose_wasapi_output_format(
                &probe_client,
                shared.mix_format.sample_rate,
                shared.mix_format.channels,
                preferred_output_format,
            )
            .map_err(WasapiOutputFailure::backend)?,
        };
        output_format = resolved_format.output;
        advance_startup_stage(
            &shared,
            share_mode,
            emit,
            probe_attempt,
            output_startup_stage::CREATE_EVENT,
            attempt_start,
        );
        event = EventHandle(
            unsafe {
                Threading::CreateEventA(None, false, false, windows::core::PCSTR(ptr::null()))
            }
            .map_err(|err| {
                WasapiOutputFailure::backend(format!("failed to create WASAPI output event: {err}"))
            })?,
        );
        if output_start_was_cancelled(&stop, &shared, start_notify) {
            return Ok(());
        }
        let open_context = WasapiOpenContext {
            stop: &stop,
            shared: &shared,
            probe_attempt,
            attempt_start,
        };
        let output = match open_wasapi_output(
            &device,
            event.0,
            resolved_format,
            share_mode,
            emit,
            &open_context,
        )? {
            Some(output) => output,
            None => {
                // open 中途被弃用：向启动确认通道回报取消后静默退出，不再打 opening 日志。
                report_output_start(
                    start_notify,
                    Err(OUTPUT_START_CANCELLED_MESSAGE.to_string()),
                );
                return Ok(());
            }
        };
        // 流已初始化完成，立即让出端点闸门；后续 Start/渲染循环不需要串行。
        drop(open_guard);
        output
    };
    let device_buffer_secs =
        output.buffer_frames as f64 / f64::from(output_format.sample_rate.max(1));
    shared.update_output_stats(build_output_stats(
        share_mode.backend(),
        &shared,
        output_format.sample_rate,
        output_format.channels,
        format!("{:?}", output_format.sample_format),
        output_buffer_mode_for_frames(output.buffer_frames),
        f64::from(output.buffer_frames),
        device_buffer_secs,
    ));
    emit(PlayerEvent::log(
        "info",
        format!(
            "WASAPI {} opening: requested='{device_name}', sample_rate={}, engine_sample_rate={}, channels={}, preferred_output_format={:?}, format={:?}, buffer_frames={}, buffer_100ns={buffer_duration}",
            share_mode.label(),
            output_format.sample_rate,
            shared.mix_format.sample_rate,
            output_format.channels,
            preferred_output_format,
            output_format.sample_format,
            output.buffer_frames,
            buffer_duration = output.buffer_duration
        ),
    ));

    let realtime_frames = output.buffer_frames.max(1) as usize;
    let mut output_scratch =
        Vec::<f32>::with_capacity(realtime_frames.saturating_mul(output_format.channels.max(1)));
    let mut graph_scratch = Vec::<f32>::with_capacity(
        realtime_frames.saturating_mul(shared.mix_format.channels.max(1)),
    );
    let mut resampler = OutputResampler::new(
        shared.mix_format.sample_rate,
        output_format.sample_rate,
        shared.mix_format.channels,
        output_format.channels,
    )
    .map_err(WasapiOutputFailure::backend)?;
    resampler
        .reserve_realtime_capacity(realtime_frames)
        .map_err(WasapiOutputFailure::backend)?;

    unsafe {
        if output_start_was_cancelled(&stop, &shared, start_notify) {
            return Ok(());
        }
        advance_startup_stage(
            &shared,
            share_mode,
            emit,
            probe_attempt,
            output_startup_stage::WRITE_AND_START,
            attempt_start,
        );
        write_frames(
            &output.render_client,
            output.buffer_frames,
            output_format,
            &shared,
            &mut output_scratch,
            &mut graph_scratch,
            &mut resampler,
        )?;
        // 初始缓冲写完可能已耗时较久；被看门狗放弃的旧线程绝不能在 Start 上
        // 与新线程争用端点，因此 Start 前再检查一次停止令牌。
        if output_start_was_cancelled(&stop, &shared, start_notify) {
            return Ok(());
        }
        output.audio_client.Start().map_err(|err| {
            shared
                .output_startup_probe
                .record_hresult(probe_attempt, err.code().0);
            WasapiOutputFailure::from_client_error(
                &format!("failed to start WASAPI {} output", share_mode.label()),
                &err,
            )
        })?;
        shared.mark_output_started();
        shared.output_startup_probe.advance(
            probe_attempt,
            output_startup_stage::STARTED,
            attempt_start,
        );
        report_output_start(start_notify, Ok(()));
        emit(PlayerEvent::log(
            "info",
            format!(
                "WASAPI {} output started: requested='{device_name}', sample_rate={}, engine_sample_rate={}",
                share_mode.label(), output_format.sample_rate, shared.mix_format.sample_rate
            ),
        ));
        while !stop.should_stop(&shared) {
            match Threading::WaitForSingleObject(event.0, WASAPI_EVENT_WAIT_MS) {
                WAIT_OBJECT_0 => {
                    match feed_wasapi_output(
                        &output.audio_client,
                        &output.render_client,
                        output.buffer_frames,
                        output.stream_latency_100ns,
                        output_format,
                        share_mode,
                        &shared,
                        &mut output_scratch,
                        &mut graph_scratch,
                        &mut resampler,
                    ) {
                        Ok(()) => {}
                        Err(failure)
                            if matches!(failure.action, WasapiOutputErrorAction::Ignore { .. }) =>
                        {
                            emit(PlayerEvent::log(
                                "warn",
                                format!(
                                    "WASAPI {} transient output error: {}",
                                    share_mode.label(),
                                    failure.message
                                ),
                            ));
                            continue;
                        }
                        Err(mut failure) => {
                            if matches!(failure.action, WasapiOutputErrorAction::Recover { .. }) {
                                let active = device
                                    .GetState()
                                    .is_ok_and(|state| state == Audio::DEVICE_STATE_ACTIVE);
                                failure.action = failure.action.with_endpoint_active(active);
                            }
                            return Err(failure);
                        }
                    }
                }
                WAIT_TIMEOUT => {}
                WAIT_FAILED => {
                    return Err(WasapiOutputFailure::recover(
                        "waiting for WASAPI output event failed",
                        "stream-invalidated",
                    ));
                }
                other => {
                    return Err(WasapiOutputFailure::backend(format!(
                        "unexpected WASAPI wait result: {other:?}"
                    )));
                }
            }
        }

        let _ = output.audio_client.Stop();
    }

    Ok(())
}

/// open 阶段共用的启动上下文：停止令牌 + 探针宿主 + 本次尝试起点。
struct WasapiOpenContext<'a> {
    stop: &'a OutputStopToken,
    shared: &'a SharedAudio,
    probe_attempt: u64,
    attempt_start: Instant,
}

/// 返回 `Ok(None)` 表示输出在启动中途被弃用（设备切换 / 启动超时已请求停止），
/// 调用方应回报取消并静默退出，而不是把它当成一次真实的开流失败。
fn open_wasapi_output(
    device: &Audio::IMMDevice,
    event: HANDLE,
    resolved_format: WasapiResolvedFormat,
    share_mode: WasapiShareMode,
    emit: fn(PlayerEvent),
    context: &WasapiOpenContext<'_>,
) -> Result<Option<WasapiOutput>, WasapiOutputFailure> {
    let WasapiOpenContext {
        stop,
        shared,
        probe_attempt,
        attempt_start,
    } = context;
    let output_format = resolved_format.output;
    let startup_probe = &shared.output_startup_probe;
    let mut aligned_buffer_frames = None;
    let wait_started_at = Instant::now();
    let mut logged_device_wait = false;

    loop {
        // 每轮（含端点释放等待的每一轮重试）都先看停止令牌，弃用线程不再占用端点。
        if stop.should_stop(shared) {
            return Ok(None);
        }
        advance_startup_stage(
            shared,
            share_mode,
            emit,
            *probe_attempt,
            output_startup_stage::OPEN_ACTIVATE,
            *attempt_start,
        );
        let audio_client =
            activate_wasapi_audio_client(device).map_err(WasapiOutputFailure::backend)?;
        let buffer_duration = aligned_buffer_frames
            .map(|frames| wasapi_duration_from_frames(frames, output_format.sample_rate))
            .unwrap_or_else(|| {
                // In event-driven exclusive mode this is also the wakeup period.
                // Keep larger user buffers in the software queue instead of
                // turning each device packet (and pause/fade response) into seconds.
                match share_mode {
                    WasapiShareMode::Shared => 0,
                    WasapiShareMode::Exclusive => wasapi_exclusive_buffer_duration(&audio_client),
                }
            });
        advance_startup_stage(
            shared,
            share_mode,
            emit,
            *probe_attempt,
            output_startup_stage::INITIALIZE,
            *attempt_start,
        );
        let result = unsafe {
            audio_client.Initialize(
                share_mode.as_wasapi(),
                Audio::AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                buffer_duration,
                buffer_duration,
                &resolved_format.wave_format.Format,
                None,
            )
        };

        match result {
            Ok(()) => unsafe {
                // Initialize 可能已经让线程在端点闸门里排了很久；返回后立刻检查
                // 弃用状态，把闸门尽早让给后继线程，避免"僵尸流"继续占着端点。
                if stop.should_stop(shared) {
                    return Ok(None);
                }
                advance_startup_stage(
                    shared,
                    share_mode,
                    emit,
                    *probe_attempt,
                    output_startup_stage::GET_SERVICE,
                    *attempt_start,
                );
                audio_client.SetEventHandle(event).map_err(|err| {
                    startup_probe.record_hresult(*probe_attempt, err.code().0);
                    WasapiOutputFailure::from_client_error(
                        "failed to bind WASAPI output event",
                        &err,
                    )
                })?;
                let render_client = audio_client
                    .GetService::<Audio::IAudioRenderClient>()
                    .map_err(|err| {
                        startup_probe.record_hresult(*probe_attempt, err.code().0);
                        WasapiOutputFailure::from_client_error(
                            "failed to create WASAPI render client",
                            &err,
                        )
                    })?;
                advance_startup_stage(
                    shared,
                    share_mode,
                    emit,
                    *probe_attempt,
                    output_startup_stage::BUFFER_QUERY,
                    *attempt_start,
                );
                let buffer_frames = audio_client.GetBufferSize().map_err(|err| {
                    startup_probe.record_hresult(*probe_attempt, err.code().0);
                    WasapiOutputFailure::from_client_error(
                        "failed to query WASAPI buffer size",
                        &err,
                    )
                })?;
                let stream_latency_100ns = audio_client.GetStreamLatency().unwrap_or(0);
                LIVE_OUTPUT_STREAMS.fetch_add(1, Ordering::AcqRel);
                return Ok(Some(WasapiOutput {
                    audio_client,
                    render_client,
                    buffer_frames,
                    buffer_duration,
                    stream_latency_100ns,
                }));
            },
            Err(err)
                if share_mode == WasapiShareMode::Exclusive
                    && is_wasapi_buffer_size_not_aligned(&err)
                    && aligned_buffer_frames.is_none() =>
            {
                startup_probe.record_hresult(*probe_attempt, err.code().0);
                let frames = unsafe { audio_client.GetBufferSize() }.map_err(|err| {
                    WasapiOutputFailure::from_client_error(
                        "failed to read WASAPI aligned buffer size",
                        &err,
                    )
                })?;
                aligned_buffer_frames = Some(frames);
            }
            Err(err)
                if is_wasapi_device_in_use(&err)
                    && wait_started_at.elapsed() < WASAPI_DEVICE_RELEASE_TIMEOUT =>
            {
                startup_probe.record_hresult(*probe_attempt, err.code().0);
                startup_probe.record_device_in_use_retry(*probe_attempt);
                if !logged_device_wait {
                    emit(PlayerEvent::log(
                        "info",
                        format!(
                            "WASAPI {} output waiting for endpoint release",
                            share_mode.label()
                        ),
                    ));
                    logged_device_wait = true;
                }
                thread::sleep(WASAPI_DEVICE_RELEASE_RETRY);
            }
            Err(err) => {
                startup_probe.record_hresult(*probe_attempt, err.code().0);
                return Err(WasapiOutputFailure::from_client_error(
                    &format!("failed to open WASAPI {} output", share_mode.label()),
                    &err,
                ));
            }
        }
    }
}

fn feed_wasapi_output(
    audio_client: &Audio::IAudioClient,
    render_client: &Audio::IAudioRenderClient,
    buffer_frames: u32,
    stream_latency_100ns: i64,
    output_format: WasapiOutputFormat,
    share_mode: WasapiShareMode,
    shared: &SharedAudio,
    output_scratch: &mut Vec<f32>,
    graph_scratch: &mut Vec<f32>,
    resampler: &mut OutputResampler,
) -> Result<(), WasapiOutputFailure> {
    let queued_frames = service_wasapi_event(
        share_mode == WasapiShareMode::Exclusive,
        buffer_frames,
        || unsafe {
            audio_client.GetCurrentPadding().map_err(|err| {
                WasapiOutputFailure::from_client_error(
                    "failed to query WASAPI output padding",
                    &err,
                )
            })
        },
        |frames| {
            write_frames(
                render_client,
                frames,
                output_format,
                shared,
                output_scratch,
                graph_scratch,
                resampler,
            )
        },
    )?;
    update_wasapi_live_output_delay(
        shared,
        share_mode,
        queued_frames,
        buffer_frames,
        output_format.sample_rate,
        stream_latency_100ns,
    );
    Ok(())
}

fn write_frames(
    render_client: &Audio::IAudioRenderClient,
    frames: u32,
    output_format: WasapiOutputFormat,
    shared: &SharedAudio,
    output_scratch: &mut Vec<f32>,
    graph_scratch: &mut Vec<f32>,
    resampler: &mut OutputResampler,
) -> Result<(), WasapiOutputFailure> {
    unsafe {
        let buffer = render_client.GetBuffer(frames).map_err(|err| {
            WasapiOutputFailure::from_client_error("failed to obtain WASAPI output buffer", &err)
        })?;
        let output_channels = output_format.channels.max(1);
        let sample_count = frames as usize * output_channels;
        match output_format.sample_format {
            WasapiSampleFormat::F32 => {
                let data = slice::from_raw_parts_mut(buffer as *mut f32, sample_count);
                fill_wasapi_output(
                    data,
                    output_format.sample_rate,
                    output_channels,
                    shared,
                    graph_scratch,
                    resampler,
                );
            }
            WasapiSampleFormat::I16 => {
                let data = slice::from_raw_parts_mut(buffer as *mut i16, sample_count);
                output_scratch.resize(sample_count, 0.0);
                fill_wasapi_output(
                    output_scratch,
                    output_format.sample_rate,
                    output_channels,
                    shared,
                    graph_scratch,
                    resampler,
                );
                for (target, sample) in data.iter_mut().zip(output_scratch.iter().copied()) {
                    *target = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
                }
            }
            WasapiSampleFormat::U8 => {
                let data = slice::from_raw_parts_mut(buffer as *mut u8, sample_count);
                output_scratch.resize(sample_count, 0.0);
                fill_wasapi_output(
                    output_scratch,
                    output_format.sample_rate,
                    output_channels,
                    shared,
                    graph_scratch,
                    resampler,
                );
                for (target, sample) in data.iter_mut().zip(output_scratch.iter().copied()) {
                    *target = ((sample.clamp(-1.0, 1.0) + 1.0) * 127.5).round() as u8;
                }
            }
            WasapiSampleFormat::I24 => {
                let data = slice::from_raw_parts_mut(buffer as *mut u8, sample_count * 3);
                output_scratch.resize(sample_count, 0.0);
                fill_wasapi_output(
                    output_scratch,
                    output_format.sample_rate,
                    output_channels,
                    shared,
                    graph_scratch,
                    resampler,
                );
                for (target, sample) in data.chunks_exact_mut(3).zip(output_scratch.iter().copied())
                {
                    let value = (sample.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
                    let bytes = value.to_le_bytes();
                    target[0] = bytes[0];
                    target[1] = bytes[1];
                    target[2] = bytes[2];
                }
            }
            WasapiSampleFormat::I24In32 => {
                let data = slice::from_raw_parts_mut(buffer as *mut i32, sample_count);
                output_scratch.resize(sample_count, 0.0);
                fill_wasapi_output(
                    output_scratch,
                    output_format.sample_rate,
                    output_channels,
                    shared,
                    graph_scratch,
                    resampler,
                );
                for (target, sample) in data.iter_mut().zip(output_scratch.iter().copied()) {
                    let value = (sample.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
                    *target = value << 8;
                }
            }
            WasapiSampleFormat::I32 => {
                let data = slice::from_raw_parts_mut(buffer as *mut i32, sample_count);
                output_scratch.resize(sample_count, 0.0);
                fill_wasapi_output(
                    output_scratch,
                    output_format.sample_rate,
                    output_channels,
                    shared,
                    graph_scratch,
                    resampler,
                );
                for (target, sample) in data.iter_mut().zip(output_scratch.iter().copied()) {
                    *target = (sample.clamp(-1.0, 1.0) * i32::MAX as f32).round() as i32;
                }
            }
        }
        render_client.ReleaseBuffer(frames, 0).map_err(|err| {
            WasapiOutputFailure::from_client_error("failed to release WASAPI output buffer", &err)
        })
    }
}

fn update_wasapi_live_output_delay(
    shared: &SharedAudio,
    share_mode: WasapiShareMode,
    queued_frames: u32,
    buffer_frames: u32,
    sample_rate: u32,
    stream_latency_100ns: i64,
) {
    shared.update_live_output_delay_secs(wasapi_live_output_delay_secs(
        share_mode,
        queued_frames,
        buffer_frames,
        sample_rate,
        stream_latency_100ns,
    ));
}

fn wasapi_live_output_delay_secs(
    share_mode: WasapiShareMode,
    queued_frames: u32,
    buffer_frames: u32,
    sample_rate: u32,
    stream_latency_100ns: i64,
) -> f64 {
    let sample_rate = f64::from(sample_rate.max(1));
    let queued_secs = match share_mode {
        WasapiShareMode::Shared => f64::from(queued_frames) / sample_rate,
        WasapiShareMode::Exclusive => f64::from(buffer_frames) / sample_rate,
    };
    let stream_latency_secs = (stream_latency_100ns.max(0) as f64) / 10_000_000.0;
    queued_secs + stream_latency_secs
}

fn fill_wasapi_output(
    output: &mut [f32],
    output_sample_rate: u32,
    output_channels: usize,
    shared: &SharedAudio,
    graph_scratch: &mut Vec<f32>,
    resampler: &mut OutputResampler,
) {
    if output_sample_rate == shared.mix_format.sample_rate
        && shared.mix_format.channels == output_channels
    {
        fill_output_reusing(output, output_channels, shared, graph_scratch);
    } else {
        resampler.fill_output(output, output_channels, shared);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_open_gate_serializes_opens_and_skips_cancelled_waiters() {
        fn ignore_event(_: PlayerEvent) {}

        let shared = Arc::new(SharedAudio::new(
            crate::shared::MixFormat::stereo_f32(48_000),
            0.2,
            1.0,
            &crate::dsp::DspSettings::default(),
        ));
        let gate = Arc::new(EndpointOpenGate::default());
        let attempt = shared.output_startup_probe.begin_attempt();

        let holder = gate.clone();
        let (held_tx, held_rx) = std::sync::mpsc::sync_channel(1);
        let holder_thread = thread::spawn(move || {
            let _guard = holder.mutex.lock().unwrap();
            holder
                .holder_acquired_ms
                .store(gate_now_ms().max(1), Ordering::Release);
            let _ = held_tx.send(());
            thread::sleep(Duration::from_millis(60));
            holder.holder_acquired_ms.store(0, Ordering::Release);
        });
        held_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        let stop = OutputStopToken::new();
        let mut start_notify = None;
        let gate_log = GateWaitLog {
            endpoint_key: "test-endpoint",
            share_mode: WasapiShareMode::Shared,
            emit: ignore_event,
        };
        let wait_started = Instant::now();
        let (guard, waited_ms) = lock_endpoint_open_gate(
            &gate,
            &stop,
            &shared,
            &mut start_notify,
            attempt,
            Instant::now(),
            gate_log,
        )
        .expect("gate must be acquired after the holder releases");
        assert!(wait_started.elapsed() >= Duration::from_millis(40));
        let described = shared.output_startup_probe.describe();
        assert!(described.contains("gate_wait_ms="), "{described}");
        assert!(described.contains("gate_holder_age_ms="), "{described}");
        assert!(waited_ms >= 40, "waited_ms={waited_ms}");
        drop(guard);
        holder_thread.join().unwrap();

        // 已经取消的等待者不会占用闸门，也不会再发起一次 open。
        let cancelled = OutputStopToken::new();
        cancelled.request_stop();
        let mut cancelled_notify = None;
        assert!(lock_endpoint_open_gate(
            &gate,
            &cancelled,
            &shared,
            &mut cancelled_notify,
            attempt,
            Instant::now(),
            GateWaitLog {
                endpoint_key: "test-endpoint",
                share_mode: WasapiShareMode::Shared,
                emit: ignore_event,
            },
        )
        .is_none());
    }

    #[test]
    fn spatial_format_change_recovers_even_with_pause_on_disconnect() {
        let action = classify_wasapi_client_error(Audio::AUDCLNT_E_DEVICE_INVALIDATED)
            .with_endpoint_active(true);
        assert_eq!(
            action,
            WasapiOutputErrorAction::Recover {
                reason: "stream-invalidated"
            }
        );
        assert!(!action.should_pause(true));
    }

    #[test]
    fn unavailable_original_endpoint_preserves_disconnect_pause_policy() {
        // A failed GetState query is also treated conservatively as inactive.
        let action = classify_wasapi_client_error(Audio::AUDCLNT_E_DEVICE_INVALIDATED)
            .with_endpoint_active(false);
        assert_eq!(
            action,
            WasapiOutputErrorAction::Recover {
                reason: "device-not-available"
            }
        );
        assert!(action.should_pause(true));
        assert!(!action.should_pause(false));
    }

    #[test]
    fn invalidated_resources_and_service_restart_do_not_mean_unplugged() {
        for code in [
            Audio::AUDCLNT_E_RESOURCES_INVALIDATED,
            Audio::AUDCLNT_E_SERVICE_NOT_RUNNING,
        ] {
            let action = classify_wasapi_client_error(code).with_endpoint_active(true);
            assert!(!action.should_pause(true));
        }
        let backend = WasapiOutputErrorAction::Escalate { reason: "backend" };
        assert_eq!(backend.with_endpoint_active(true), backend);
    }

    #[test]
    fn wasapi_client_error_classification_marks_disconnects_recoverable() {
        assert_eq!(
            classify_wasapi_client_error(Audio::AUDCLNT_E_DEVICE_INVALIDATED),
            WasapiOutputErrorAction::Recover {
                reason: "device-not-available"
            }
        );
        assert_eq!(
            classify_wasapi_client_error(Audio::AUDCLNT_E_RESOURCES_INVALIDATED),
            WasapiOutputErrorAction::Recover {
                reason: "stream-invalidated"
            }
        );
        assert_eq!(
            classify_wasapi_client_error(Audio::AUDCLNT_E_SERVICE_NOT_RUNNING),
            WasapiOutputErrorAction::Recover {
                reason: "stream-invalidated"
            }
        );
    }

    #[test]
    fn wasapi_client_error_classification_keeps_xruns_nonfatal() {
        assert_eq!(
            classify_wasapi_client_error(Audio::AUDCLNT_E_BUFFER_ERROR),
            WasapiOutputErrorAction::Ignore { reason: "xrun" }
        );
        assert_eq!(
            classify_wasapi_client_error(Audio::AUDCLNT_E_CPUUSAGE_EXCEEDED),
            WasapiOutputErrorAction::Ignore { reason: "xrun" }
        );
        assert_eq!(
            classify_wasapi_client_error(Audio::AUDCLNT_E_UNSUPPORTED_FORMAT),
            WasapiOutputErrorAction::Escalate { reason: "backend" }
        );
    }

    #[test]
    fn wasapi_live_output_delay_uses_padding_and_stream_latency() {
        assert!(
            (wasapi_live_output_delay_secs(WasapiShareMode::Shared, 480, 960, 48_000, 10_000)
                - 0.011)
                .abs()
                < f64::EPSILON
        );
        assert!(
            (wasapi_live_output_delay_secs(WasapiShareMode::Exclusive, 0, 960, 48_000, 10_000)
                - 0.021)
                .abs()
                < f64::EPSILON
        );
    }
}
