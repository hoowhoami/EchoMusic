//! 输出线程启动阶段探针。
//!
//! 输出线程每进入一个启动步骤（解析设备 → 激活探测客户端 → 格式协商 →
//! Initialize → …）就推进一次探针；看门狗超时后据此还原"线程卡在哪个
//! 调用里"，错误不再被折叠成一句 GenericFailure。探针只承载诊断信息，
//! 不参与任何控制流判定。

use std::sync::atomic::{AtomicI32, AtomicU32, AtomicU64, AtomicU8, Ordering};
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
            _ => "not-reported",
        }
    }
}

#[derive(Default)]
pub(crate) struct OutputStartupProbe {
    /// 当前启动尝试的代号；每次创建输出线程时递增。
    /// 旧线程（例如看门狗超时后被弃用、仍卡在某个 COM 调用里的线程）只持有旧代号，
    /// 其后续写入会被忽略，无法覆盖新尝试的阶段与 HRESULT。
    generation: AtomicU64,
    stage: AtomicU8,
    /// 进入当前阶段时距本次尝试开始的毫秒数。
    stage_entered_ms: AtomicU64,
    /// 最近一次记录的 COM HRESULT；0 表示尚未记录。
    last_hresult: AtomicI32,
    /// 端点释放等待（AUDCLNT_E_DEVICE_IN_USE）的重试次数。
    device_in_use_retries: AtomicU32,
    /// 本次尝试中已上报过慢启动日志的阶段位图（bit = stage）。
    slow_stages_reported: AtomicU32,
}

impl OutputStartupProbe {
    /// 开始一次新的启动尝试并返回其代号；清空上一次尝试的痕迹。
    /// 必须在输出线程创建前调用：即使旧线程随后才进入启动流程，也只会带着旧代号，
    /// 无法重置或覆盖新尝试的探针。
    pub(crate) fn begin_attempt(&self) -> u64 {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.stage
            .store(output_startup_stage::NOT_REPORTED, Ordering::Release);
        self.stage_entered_ms.store(0, Ordering::Release);
        self.last_hresult.store(0, Ordering::Release);
        self.device_in_use_retries.store(0, Ordering::Release);
        self.slow_stages_reported.store(0, Ordering::Release);
        generation
    }

    fn is_current(&self, attempt: u64) -> bool {
        self.generation.load(Ordering::Acquire) == attempt
    }

    /// 推进到 `stage`；`attempt_start` 为本次尝试的起点。
    /// 返回 `Some(entered_ms)` 表示该阶段来得偏慢（≥ OUTPUT_START_SLOW_STAGE_MS），
    /// 且本次尝试尚未上报过该阶段的慢启动日志。
    pub(crate) fn advance(&self, attempt: u64, stage: u8, attempt_start: Instant) -> Option<u64> {
        if !self.is_current(attempt) {
            return None;
        }
        let entered_ms = attempt_start.elapsed().as_millis() as u64;
        self.stage_entered_ms.store(entered_ms, Ordering::Release);
        self.stage.store(stage, Ordering::Release);
        if entered_ms < OUTPUT_START_SLOW_STAGE_MS || stage >= 32 {
            return None;
        }
        let bit = 1u32 << stage;
        let previous = self.slow_stages_reported.fetch_or(bit, Ordering::AcqRel);
        (previous & bit == 0).then_some(entered_ms)
    }

    pub(crate) fn record_hresult(&self, attempt: u64, code: i32) {
        if self.is_current(attempt) {
            self.last_hresult.store(code, Ordering::Release);
        }
    }

    pub(crate) fn record_device_in_use_retry(&self, attempt: u64) {
        if self.is_current(attempt) {
            self.device_in_use_retries.fetch_add(1, Ordering::AcqRel);
        }
    }

    /// 看门狗超时侧读取的快照：(阶段, 进入毫秒, 最后 HRESULT, 端点释放重试次数)。
    /// 快照非原子整体，仅作诊断展示。
    pub(crate) fn snapshot(&self) -> (u8, u64, i32, u32) {
        (
            self.stage.load(Ordering::Acquire),
            self.stage_entered_ms.load(Ordering::Acquire),
            self.last_hresult.load(Ordering::Acquire),
            self.device_in_use_retries.load(Ordering::Acquire),
        )
    }

    /// 拼进看门狗超时错误消息的诊断尾巴。
    pub(crate) fn describe(&self) -> String {
        let (stage, entered_ms, last_hresult, device_in_use_retries) = self.snapshot();
        let hresult_text = if last_hresult == 0 {
            "-".to_string()
        } else {
            format!("0x{last_hresult:08X}")
        };
        format!(
            "stage={}, entered_at_ms={entered_ms}, last_hresult={hresult_text}, device_in_use_retries={device_in_use_retries}",
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
            "stage=not-reported, entered_at_ms=0, last_hresult=-, device_in_use_retries=0"
        );

        let start = Instant::now();
        probe.advance(attempt, output_startup_stage::CHOOSE_FORMAT, start);
        probe.record_hresult(attempt, -1);
        probe.record_device_in_use_retry(attempt);
        probe.record_device_in_use_retry(attempt);

        let described = probe.describe();
        assert!(described.starts_with("stage=choose-format, entered_at_ms="), "{described}");
        assert!(described.contains("last_hresult=0xFFFFFFFF"), "{described}");
        assert!(described.contains("device_in_use_retries=2"), "{described}");
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
        probe.begin_attempt();
        assert!(probe.describe().contains("last_hresult=-"));
        let (stage, _, last_hresult, _) = probe.snapshot();
        assert_eq!(stage, output_startup_stage::NOT_REPORTED);
        assert_eq!(last_hresult, 0);
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

        assert_eq!(
            probe.describe(),
            "stage=not-reported, entered_at_ms=0, last_hresult=-, device_in_use_retries=0"
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
