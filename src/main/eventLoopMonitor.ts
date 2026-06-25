import log from './logger';

// 主进程事件循环卡顿探测器
// ──────────────────────────────────────────────────────────────────────────
// 原理：用固定间隔的定时器，对比"实际触发时刻"与"预期触发时刻"。Node 的定时器
// 只能在事件循环空闲时才被回调，如果主线程被同步任务（原生 FFI、同步 IO、重计算等）
// 占住，定时器就会延迟触发——延迟量 ≈ 主线程被阻塞的时长。
// 一旦单次延迟超过阈值，就打一条 warn 日志，记录卡了多久、发生在什么时间点，
// 便于和切歌、af、媒体控制等周边日志对齐，定位真正阻塞主线程的那一步。
//
// 仅在主进程运行，开销极小（一个轻量定时器），平时不产生日志，只有卡顿时才记录。

/** 探测间隔：每 50ms 醒来一次 */
const TICK_INTERVAL_MS = 50;
/** 超过此延迟判定为一次卡顿（实际间隔 - 预期间隔 > 阈值） */
const STALL_THRESHOLD_MS = 100;

let timer: ReturnType<typeof setInterval> | null = null;
let lastTickAt = 0;

const formatClock = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  );
};

/** 启动主进程卡顿探测器（幂等） */
export function startEventLoopMonitor(): void {
  if (timer) return;
  lastTickAt = Date.now();

  timer = setInterval(() => {
    const now = Date.now();
    const actualGap = now - lastTickAt;
    const lag = actualGap - TICK_INTERVAL_MS;
    lastTickAt = now;

    if (lag >= STALL_THRESHOLD_MS) {
      // 这条 warn 出现的时间点即"主线程恢复响应"的时刻；阻塞发生在它之前的 lag 毫秒内。
      log.warn(
        `[EventLoopMonitor] 主进程事件循环卡顿 ~${lag}ms` +
          `（恢复于 ${formatClock(now)}，阻塞区间约 ${formatClock(now - lag)} ~ ${formatClock(now)}）`,
      );
    }
  }, TICK_INTERVAL_MS);

  // 探测器本身不应阻止进程退出
  if (typeof timer.unref === 'function') timer.unref();

  log.info('[EventLoopMonitor] 已启动（诊断模式），阈值', `${STALL_THRESHOLD_MS}ms`);
}

/** 停止探测器 */
export function stopEventLoopMonitor(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
