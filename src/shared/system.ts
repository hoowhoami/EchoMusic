/**
 * 系统运行状态。
 *
 * 只暴露进程能直接拿到的事实，不做推断：uptimeSec 是 Node os.uptime() 的返回值，
 * bootTimeMs 由它与当前时间换算，调用方自己决定怎么用。
 */
export interface BootInfo {
  /** 系统已连续运行的秒数。 */
  uptimeSec: number;
  /** 本次开机的时刻（毫秒时间戳，按 uptimeSec 反推）。 */
  bootTimeMs: number;
}
