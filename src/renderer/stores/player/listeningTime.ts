import { getUserGradeInfo, reportListenTime } from '@/api/user';
import { useListenReportStore } from '@/stores/listenReport';
import { useUserStore } from '@/stores/user';
import logger from '@/utils/logger';
import type { PlayerState } from './state';
import { getPlaybackIsLoading, getPlaybackIsPlaying } from './stateMachine';
import { resolveTrackMxid } from './utils';

// 待上报增量达到该阈值后才尝试同步。
const MIN_REPORT_DIFF_SEC = 60;
// 上报尝试的最小间隔，成功和失败都共用同一退避窗口。
const MIN_REPORT_INTERVAL_MS = 5 * 60 * 1000;
// 单次 tick 的累计上限，避免 seek 或异常进度回报导致时长虚增。
const MAX_TICK_DELTA_SEC = 30;

/**
 * 听歌时长累计与上报管理器。
 *
 * 上报参数使用整数秒。播放进度是浮点秒，提交前需要取整以匹配服务端签名规则。
 * 上报前会先查询服务端累计值，并以服务端值作为基准，避免多端使用时本地累计落后。
 * 失败时保留待上报增量，下次达到退避间隔后合并重试。
 */
export const createListeningTimeManager = (state: PlayerState) => {
  // 上次累计基准点（运行时状态，不持久化；seek/切歌/首帧时重置）
  let lastPosition = 0;
  // 并发互斥：同时仅允许一个上报在途，防止同一增量重复上报
  let flushing = false;
  // 上次上报尝试时间，成功和失败都会更新。
  let lastAttemptAt = 0;

  const currentUid = () => useUserStore().info?.userid;

  // 每 HISTORY_CHECK_MS（5s）由 timeUpdate 调用一次
  const tick = () => {
    const report = useListenReportStore();
    if (!useUserStore().isLoggedIn) return;
    // 复用播放器现有护栏：仅真实播放中且无加载/卡死恢复/切歌残留
    if (!getPlaybackIsPlaying(state) || getPlaybackIsLoading(state)) return;
    if (state.awaitingTrackLoad || state.stallRecovering) return;
    // 仅统计酷狗源（本地文件/插件源不计费）
    if (!state.currentTrackSnapshot || !resolveTrackMxid(state.currentTrackSnapshot)) return;

    const now = state.currentTime;
    // 首帧或 seek 后退/切歌归零：重置基准点，不累计
    if (lastPosition <= 0 || now < lastPosition) {
      lastPosition = now;
      return;
    }
    const delta = Math.min(now - lastPosition, MAX_TICK_DELTA_SEC);
    lastPosition = now;
    if (delta <= 0) return;
    report.pendingDiff += delta;

    if (report.pendingDiff >= MIN_REPORT_DIFF_SEC) void flush();
  };

  // 上报入口。未满足阈值、退避或登录条件时会直接返回。
  const flush = async () => {
    if (flushing) return;
    const report = useListenReportStore();
    const userStore = useUserStore();
    if (!userStore.isLoggedIn) return;
    if (report.pendingDiff < MIN_REPORT_DIFF_SEC) return;
    if (Date.now() - lastAttemptAt < MIN_REPORT_INTERVAL_MS) return;

    flushing = true;
    try {
      const uid = userStore.info?.userid;
      // diff_sec 必须为整数秒，否则服务端签名校验会失败。
      const reportedDiff = Math.floor(report.pendingDiff);
      if (reportedDiff <= 0) return;

      // 查询服务端累计值，用它作为本次上报的基准。
      // 本地累计可能因上次失败或多端播放落后于服务端，因此不直接信任本地值。
      let serverDSec = 0;
      try {
        const gradeRes = await getUserGradeInfo();
        serverDSec = Math.floor(
          Number((gradeRes as { data?: { d_sec?: unknown } })?.data?.d_sec) || 0,
        );
      } catch {
        // 对账失败不阻断上报
      }
      // 查询成功时以服务端为基准；查询失败时回退到本地累计。
      const base = serverDSec > 0 ? serverDSec : Math.floor(report.dSec);

      try {
        const res = await reportListenTime({ dSec: base, diffSec: reportedDiff });
        const body = res as { status?: number | string; error_code?: number | string } | null;
        if (body && (Number(body.status ?? 1) !== 1 || Number(body.error_code ?? 0) !== 0)) {
          // 业务失败按普通失败处理，保留增量等待下次重试。
          throw new Error(`report rejected error_code=${body.error_code}`);
        }

        // 请求期间账号可能变化，写入前再确认一次。
        if (currentUid() !== uid) return;
        // 只扣减本次已上报的快照值，不清零请求期间新累计的增量
        report.dSec = base + reportedDiff;
        report.pendingDiff -= reportedDiff;
        report.lastReportAt = Date.now();
        logger.info('ListenTime', 'Listening duration reported', { dSec: report.dSec });
      } catch (error) {
        // 失败保留 pendingDiff，退避 5 分钟后合并重试；不阻塞播放
        logger.warn('ListenTime', 'Report listening duration failed, will retry later:', error);
      }
    } finally {
      lastAttemptAt = Date.now();
      flushing = false;
    }
  };

  // seek/切歌时重置累计基准点，避免跨曲目/跳转误累计
  const resetPosition = () => {
    lastPosition = 0;
  };

  return { tick, flush, resetPosition };
};
