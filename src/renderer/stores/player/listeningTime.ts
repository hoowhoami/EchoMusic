import { getUserGradeInfo, reportListenTime } from '@/api/user';
import { useListenReportStore } from '@/stores/listenReport';
import { useUserStore } from '@/stores/user';
import logger from '@/utils/logger';
import type { PlayerState } from './state';
import { getPlaybackIsLoading, getPlaybackIsPlaying } from './stateMachine';
import { resolveTrackMxid } from './utils';

// 累计达到该秒数才触发上报，避免碎时间片高频请求
const MIN_REPORT_DIFF_SEC = 60;
// 距上次上报尝试至少间隔该时长（成功/失败均退避，上游按 diff_sec 记账且受距上次上报时间约束）
const MIN_REPORT_INTERVAL_MS = 5 * 60 * 1000;
// 单次 tick 累计上限，防御 seek 大跳/异常进度回报导致的虚增
const MAX_TICK_DELTA_SEC = 30;

/**
 * 听歌时长累计与上报管理器（对接 GET /user/grade/info）
 *
 * 关键约束：d_sec / diff_sec 必须为**整数秒**。tick 内 currentTime 差值为浮点，
 * 直接上送会导致酷狗服务端 md5 签名校验失败（error_code=20006），上报前必须取整。
 *
 * 上报节奏：pendingDiff ≥ 60s 且距上次上报尝试 ≥ 5 分钟；失败保留增量下次合并，
 * 成功/失败均更新退避时间，杜绝高频重试风暴。
 * 上报前先查询对账，取 max(本地累计, 服务端值) 作为 d_sec，避免多设备登录时
 * 本地值小于服务端而被拒记。
 */
export const createListeningTimeManager = (state: PlayerState) => {
  // 上次累计基准点（运行时状态，不持久化；seek/切歌/首帧时重置）
  let lastPosition = 0;
  // 并发互斥：同时仅允许一个上报在途，防止同一增量重复上报
  let flushing = false;
  // 上次上报尝试时间（成功/失败均更新）：失败也退避，杜绝 5s 级别的重试风暴
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

  // 上报：受 5 分钟退避约束，可安全在暂停/切歌/结束时调用（未达条件直接返回）
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
      // ★ 关键修复：diff_sec 取整，浮点会导致上游 md5 校验失败（20006）
      const reportedDiff = Math.floor(report.pendingDiff);
      if (reportedDiff <= 0) return;

      // ① 查询对账：以服务端为基准强制对齐。
      // 酷狗 v2 记账要求 d_sec - diff_sec 落在服务端当前基准上（即 d_sec == 服务端值 + diff_sec）；
      // 若本地累计因历史失败上报偏离服务端（幽灵增量），上报会被静默忽略（error_code=0 但不记账）。
      let serverDSec = 0;
      try {
        const gradeRes = await getUserGradeInfo();
        serverDSec = Math.floor(
          Number((gradeRes as { data?: { d_sec?: unknown } })?.data?.d_sec) || 0,
        );
      } catch {
        // 对账失败不阻断上报
      }
      // 查询成功时以服务端为基准（丢弃幽灵增量，保证记账）；查询失败时回退本地累计兜底
      const base = serverDSec > 0 ? serverDSec : Math.floor(report.dSec);

      // ② 上报
      try {
        const res = await reportListenTime({ dSec: base, diffSec: reportedDiff });
        const body = res as { status?: number | string; error_code?: number | string } | null;
        if (body && (Number(body.status ?? 1) !== 1 || Number(body.error_code ?? 0) !== 0)) {
          // 上游业务失败（含 20006），按普通失败处理，退避后重试
          throw new Error(`report rejected error_code=${body.error_code}`);
        }

        // ③ logout/切号竞态：账号已变化则放弃写入，避免串号污染
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
