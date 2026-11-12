//! 输出线程启动阶段探针。
//!
//! 输出线程每进入一个启动步骤（解析设备 → 激活探测客户端 → 格式协商 →
//! Initialize → …）就推进一次探针；看门狗超时后据此还原"线程卡在哪个
//! 调用里"，错误不再被折叠成一句 GenericFailure。探针只承载诊断信息，
//! 不参与任何控制流判定。

use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

/// 单个启动阶段超过该耗时即视为"慢启动"，输出线程会打一条 info 日志。
pub(crate) const OUTPUT_START_SLOW_STAGE_MS: u64 = 300;

/// 启动阶段编号。语义为"线程正要进入/正卡在该调用里"。
pub(crate) mod output_startup_stage {
    pub(crate) const NOT_REPORTED: u8 = 0;
    pub(crate) const RESOLVING_DEVICE: u8 = 1;
    pub(crate) const PROBE_ACTIVATE: u8 = 2;
    pub(crate) const CHOOSE_FORMAT: u8 = 3;
    pub(crate) const CREATE_EVENT: u8 = 4;
    pub(crate) const OPEN_ACTIVATE: u8 = 5;
    pub(crate) const INITIALIZE: u8 = 6;
    pub(crate) const GET_SERVICE: u8 = 7;
    pub(crate) const BUFFER_QUERY: u8 = 8;
    pub(crate) const WRITE_AND_START: u8 = 9;
    pub(crate) const STARTED: u8 = 10;
    /// 正在等待同一端点上一条输出流让出 open 闸门；此时还没有发起新的 COM 调用。
    pub(crate) const WAITING_ENDPOINT: u8 = 11;

    pub(crate) fn label(stage: u8) -> &'static str {
        match stage {
            RESOLVING_DEVICE => "resolving-device",
            PROBE_ACTIVATE => "probe-activate",
            CHOOSE_FORMAT => "choose-format",
            CREATE_EVENT => "create-event",
            OPEN_ACTIVATE => "open-activate",
            INITIALIZE => "initialize",
            GET_SERVICE => "get-service",
            BUFFER_QUERY => "buffer-query",
            WRITE_AND_START => "write-and-start",
            STARTED => "started",
            WAITING_ENDPOINT => "waiting-endpoint",
            _ => "not-reported",
        }
    }
}

/// 一次阻塞调用（COM / Win32）的结果状态。区分「尚未发起调用」「已发起但未返回」
/// 「返回了错误码」，否则看门狗超时只能看到一个 `-`，无法判断是卡在调用里还是
/// 根本没调用到。
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum HresultState {
    #[default]
    Unset,
    Pending,
    Recorded(i32),
}

/// 一次启动尝试的完整诊断状态。整体包在互斥锁里，保证「校验代号 + 写入字段」
/// 处在同一个临界区：旧线程不可能在通过代号校验后、新尝试清空探针之后
/// 再把自己的阶段/HRESULT 写进新尝试。
#[derive(Default)]
struct ProbeState {
    /// 当前启动尝试的代号；每次创建输出线程时递增。
    /// 旧线程（例如看门狗超时后被弃用、仍卡在某个 COM 调用里的线程）只持有旧代号，
    /// 其后续写入会被忽略，无法覆盖新尝试的阶段与 HRESULT。
    generation: u64,
    stage: u8,
    /// 进入当前阶段时距本次尝试开始的毫秒数。
    stage_entered_ms: u64,
    /// 当前阶段 COM 调用的结果状态。
    last_hresult: HresultState,
    /// 端点释放等待（AUDCLNT_E_DEVICE_IN_USE）的重试次数。
    device_in_use_retries: u32,
    /// 等待同一端点上一代输出流释放 / 其他 open 完成所花的毫秒数。
    gate_wait_ms: u64,
    /// 等待期间读到的闸门持有者已持锁毫秒数（用于识别永久卡在 Initialize 的流）。
    gate_holder_age_ms: u64,
    /// 本次尝试中已上报过慢启动日志的阶段位图（bit = stage）。
    slow_stages_reported: u32,
}

#[derive(Default)]
pub(crate) struct OutputStartupProbe {
    state: Mutex<ProbeState>,
}

impl OutputStartupProbe {
    fn lock_state(&self) -> MutexGuard<'_, ProbeState> {
        // 探针只承载诊断信息，锁中毒（上一次持锁线程 panic）不应连带让
        // 输出线程失败，直接取回内部状态继续使用。
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 开始一次新的启动尝试并返回其代号；清空上一次尝试的痕迹。
    /// 必须在输出线程创建前调用：即使旧线程随后才进入启动流程，也只会带着旧代号，
    /// 无法重置或覆盖新尝试的探针。
    pub(crate) fn begin_attempt(&self) -> u64 {
        let mut state = self.lock_state();
        state.generation = state.generation.wrapping_add(1);
        state.stage = output_startup_stage::NOT_REPORTED;
        state.stage_entered_ms = 0;
        state.last_hresult = HresultState::Unset;
        state.device_in_use_retries = 0;
        state.gate_wait_ms = 0;
        state.gate_holder_age_ms = 0;
        state.slow_stages_reported = 0;
        state.generation
    }

    /// 推进到 `stage`；`attempt_start` 为本次尝试的起点。
    /// 返回 `Some(entered_ms)` 表示该阶段来得偏慢（≥ OUTPUT_START_SLOW_STAGE_MS），
    /// 且本次尝试尚未上报过该阶段的慢启动日志。
    pub(crate) fn advance(&self, attempt: u64, stage: u8, attempt_start: Instant) -> Option<u64> {
        let mut state = self.lock_state();
        if state.generation != attempt {
            return None;
        }
        // 排除等待端点闸门的时间，避免把排队时间算到 activate/initialize 头上。
        let entered_ms =
            (attempt_start.elapsed().as_millis() as u64).saturating_sub(state.gate_wait_ms);
        state.stage_entered_ms = entered_ms;
        state.stage = stage;
        // 进入一个执行 COM 调用的阶段 → 该调用已发起但还没有结果；超时时若停在
        // Pending，说明线程正卡在这条调用里（没有错误码可报）。等待端点闸门不是
        // COM 调用，保持 Unset。
        state.last_hresult = match stage {
            output_startup_stage::NOT_REPORTED
            | output_startup_stage::STARTED
            | output_startup_stage::WAITING_ENDPOINT => HresultState::Unset,
            _ => HresultState::Pending,
        };
        if entered_ms < OUTPUT_START_SLOW_STAGE_MS || stage >= 32 {
            return None;
        }
        let bit = 1u32 << stage;
        let previous = state.slow_stages_reported;
        state.slow_stages_reported |= bit;
        (previous & bit == 0).then_some(entered_ms)
    }

    pub(crate) fn record_hresult(&self, attempt: u64, code: i32) {
        let mut state = self.lock_state();
        if state.generation == attempt {
            state.last_hresult = HresultState::Recorded(code);
        }
    }

    /// 记录等待上一代输出流让出端点的耗时（open 串行化闸门）。
    pub(crate) fn record_gate_wait(&self, attempt: u64, waited_ms: u64) {
        let mut state = self.lock_state();
        if state.generation == attempt {
            state.gate_wait_ms = waited_ms;
        }
    }

    /// 记录等待期间观察到的闸门持有者年龄；0 表示闸门已空闲/已拿到。
    pub(crate) fn record_gate_holder_age(&self, attempt: u64, age_ms: u64) {
        let mut state = self.lock_state();
        if state.generation == attempt {
            state.gate_holder_age_ms = age_ms;
        }
    }

    pub(crate) fn record_device_in_use_retry(&self, attempt: u64) {
        let mut state = self.lock_state();
        if state.generation == attempt {
            state.device_in_use_retries = state.device_in_use_retries.wrapping_add(1);
        }
    }

    /// 看门狗超时侧读取的快照：(阶段, 进入毫秒, 最后 HRESULT, 闸门等待, 持有者年龄, 端点释放重试次数)。
    /// 所有字段在同一临界区内读取，不会再拼出跨尝试的混合状态。
    fn snapshot(&self) -> (u8, u64, HresultState, u64, u64, u32) {
        let state = self.lock_state();
        (
            state.stage,
            state.stage_entered_ms,
            state.last_hresult,
            state.gate_wait_ms,
            state.gate_holder_age_ms,
            state.device_in_use_retries,
        )
    }

    /// 拼进看门狗超时错误消息的诊断尾巴。
    pub(crate) fn describe(&self) -> String {
        let (stage, entered_ms, last_hresult, gate_wait_ms, gate_holder_age_ms, retries) =
            self.snapshot();
        let hresult_text = match last_hresult {
            HresultState::Unset => "unset".to_string(),
            HresultState::Pending => "pending".to_string(),
            HresultState::Recorded(code) => format!("0x{code:08X}"),
        };
        format!(
            "stage={}, entered_at_ms={entered_ms}, last_hresult={hresult_text}, gate_wait_ms={gate_wait_ms}, gate_holder_age_ms={gate_holder_age_ms}, device_in_use_retries={retries}",
            output_startup_stage::label(stage),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn describe_reports_stage_and_retries_without_hresult() {
        let probe = OutputStartupProbe::default();
        let attempt = probe.begin_attempt();
        assert_eq!(
            probe.describe(),
            "stage=not-reported, entered_at_ms=0, last_hresult=unset, gate_wait_ms=0, gate_holder_age_ms=0, device_in_use_retries=0"
        );

        let start = Instant::now();
        probe.advance(attempt, output_startup_stage::CHOOSE_FORMAT, start);
        probe.record_hresult(attempt, -1);
        probe.record_gate_wait(attempt, 42);
        probe.record_gate_holder_age(attempt, 1234);
        probe.record_device_in_use_retry(attempt);
        probe.record_device_in_use_retry(attempt);

        let described = probe.describe();
        assert!(
            described.starts_with("stage=choose-format, entered_at_ms="),
            "{described}"
        );
        assert!(described.contains("last_hresult=0xFFFFFFFF"), "{described}");
        assert!(described.contains("gate_wait_ms=42"), "{described}");
        assert!(described.contains("gate_holder_age_ms=1234"), "{described}");
        assert!(described.contains("device_in_use_retries=2"), "{described}");
    }

    #[test]
    fn describe_distinguishes_pending_call_from_unset_and_error() {
        let probe = OutputStartupProbe::default();
        let attempt = probe.begin_attempt();
        let start = Instant::now();

        // 进入 Initialize 阶段 → 调用已发起但未返回。
        probe.advance(attempt, output_startup_stage::INITIALIZE, start);
        assert!(
            probe.describe().contains("last_hresult=pending"),
            "{}",
            probe.describe()
        );

        // 返回错误后 → 记录真实 HRESULT。
        probe.record_hresult(attempt, 0x88890008u32 as i32);
        assert!(
            probe.describe().contains("last_hresult=0x88890008"),
            "{}",
            probe.describe()
        );

        // 启动成功 → 不再有在飞调用。
        probe.advance(attempt, output_startup_stage::STARTED, start);
        assert!(
            probe.describe().contains("last_hresult=unset"),
            "{}",
            probe.describe()
        );
    }

    #[test]
    fn advance_flags_slow_stages_and_reset_clears_state() {
        let probe = OutputStartupProbe::default();
        let start = Instant::now();
        let attempt = probe.begin_attempt();
        // 刚起步的阶段不会立刻被判定为慢启动。
        assert_eq!(
            probe.advance(attempt, output_startup_stage::INITIALIZE, start),
            None
        );
        probe.record_hresult(attempt, -1);
        probe.record_gate_wait(attempt, 12);
        probe.record_gate_holder_age(attempt, 34);
        probe.begin_attempt();
        assert!(probe.describe().contains("last_hresult=unset"));
        assert!(probe.describe().contains("gate_wait_ms=0"));
        assert!(probe.describe().contains("gate_holder_age_ms=0"));
        let (stage, _, last_hresult, gate_wait_ms, gate_holder_age_ms, _) = probe.snapshot();
        assert_eq!(stage, output_startup_stage::NOT_REPORTED);
        assert_eq!(last_hresult, HresultState::Unset);
        assert_eq!(gate_wait_ms, 0);
        assert_eq!(gate_holder_age_ms, 0);
    }

    #[test]
    fn stale_attempt_writes_are_ignored_after_new_attempt_begins() {
        let probe = OutputStartupProbe::default();
        let stale = probe.begin_attempt();
        let current = probe.begin_attempt();

        let start = Instant::now();
        probe.advance(stale, output_startup_stage::INITIALIZE, start);
        probe.record_hresult(stale, -1);
        probe.record_device_in_use_retry(stale);
        probe.record_gate_wait(stale, 99);
        probe.record_gate_holder_age(stale, 88);

        assert_eq!(
            probe.describe(),
            "stage=not-reported, entered_at_ms=0, last_hresult=unset, gate_wait_ms=0, gate_holder_age_ms=0, device_in_use_retries=0"
        );

        probe.advance(current, output_startup_stage::CHOOSE_FORMAT, start);
        probe.record_hresult(current, 0);
        assert!(probe
            .describe()
            .starts_with("stage=choose-format, entered_at_ms="));
    }

    #[test]
    fn slow_stage_is_reported_at_most_once_per_attempt() {
        let probe = OutputStartupProbe::default();
        let attempt = probe.begin_attempt();
        let slow_start = Instant::now() - Duration::from_millis(OUTPUT_START_SLOW_STAGE_MS);

        assert!(probe
            .advance(attempt, output_startup_stage::OPEN_ACTIVATE, slow_start)
            .is_some());
        // 端点释放重试循环会反复进入同一阶段，不能重复刷慢启动日志。
        assert_eq!(
            probe.advance(attempt, output_startup_stage::OPEN_ACTIVATE, slow_start),
            None
        );
        // 换一个阶段仍可正常上报。
        assert!(probe
            .advance(attempt, output_startup_stage::INITIALIZE, slow_start)
            .is_some());
    }
}
