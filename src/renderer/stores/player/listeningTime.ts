import { watch } from 'vue';
import { getUserGradeInfo, reportGradeProgress, reportListeningEvent } from '@/api/user';
import { useListenReportStore } from '@/stores/listenReport';
import { useUserStore } from '@/stores/user';
import logger from '@/utils/logger';
import { createListeningSession } from '../../../shared/listeningSession';
import type { PlayerState } from './state';
import { getPlaybackIsLoading, getPlaybackIsPlaying } from './stateMachine';

/** CSCC segments use wall time gated by advancing audio, never seek distance. */
// CSCC 同一会话相邻事件间隔小于约 0.5s 会被上游按 1203 节流拒绝（且不计入）。
// 实测 ~0.7s 仍卡在阈值边缘（715/735ms 成功、705ms 一次失败），放大到 3s 留足裕量，
// 避免切歌时 end→start 连发触发 1203 导致事件被丢弃。
const CSCC_EVENT_MIN_GAP_MS = 3000;
let lastSessionEventAt = 0;
const waitForSessionEventGap = async () => {
  const wait = CSCC_EVENT_MIN_GAP_MS - (Date.now() - lastSessionEventAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
};
// grade 与 CSCC 完全解耦：CSCC end 只上报听歌时长事件，d_sec 累计由周期任务独立写入，
// 避免同段时长被 end 连带上报与周期上报重复计入；单曲循环长时间播放也会周期入账。
// 周期 60s、每次固定上报 60s：连续播放时每整分钟入账 60s；暂停/恢复导致累积不足 60s 时
// 顺延到下次满整分钟再报，避免上报零碎秒数。
const GRADE_SYNC_INTERVAL_MS = 60 * 1000;
const GRADE_SYNC_DIFF_SEC = 60;

export const createListeningTimeManager = (state: PlayerState) => {
  const user = useUserStore();
  const report = useListenReportStore();
  const account = () => (user.isLoggedIn ? `${user.info?.userid}:${user.info?.token}` : '');
  const active = (key: string) => Boolean(key) && account() === key;
  const assertSuccess = (body: any) => {
    if (
      !body ||
      Number(body.status ?? 1) === 0 ||
      Number(body.error_code ?? body.errcode ?? 0) !== 0
    ) {
      throw new Error('Listening report rejected');
    }
  };
  // 本地已实听、尚未整秒写入 grade 的毫秒数；周期任务上报成功后按其整秒数冲减。
  let pendingPlayedMs = 0;
  // Legacy pending increments lack track/session information and must not be replayed.
  report.pendingDiff = 0;
  const session = createListeningSession({
    now: () => performance.now(),
    onAccumulate: (milliseconds) => {
      if (Number.isFinite(milliseconds) && milliseconds > 0) pendingPlayedMs += milliseconds;
    },
    start: async (identity) => {
      if (!active(identity.account)) return false;
      await waitForSessionEventGap();
      lastSessionEventAt = Date.now();
      assertSuccess(await reportListeningEvent({ event: 'start', mixsongid: identity.mixsongid }));
      if (!active(identity.account)) return false;
      logger.info('ListenTime', 'Playback start accepted', { mixsongid: identity.mixsongid });
      return true;
    },
    end: async (identity, duration, endState) => {
      if (!active(identity.account)) return;
      await waitForSessionEventGap();
      lastSessionEventAt = Date.now();
      const result = await reportListeningEvent({
        event: 'end',
        mixsongid: identity.mixsongid,
        duration,
        state: endState,
      });
      assertSuccess(result);
      if (!active(identity.account)) return;
      logger.info('ListenTime', 'Listening report completed', {
        mixsongid: identity.mixsongid,
        durationMs: duration,
        state: endState,
      });
    },
    onError: (error) =>
      logger.warn('ListenTime', 'Playback reporting failed; no automatic replay', error),
  });
  let syncingGrade = false;
  // 周期 grade 同步的上次触发时间；仅在播放中的 tick 里按间隔检查，非播放期不发起上报。
  let lastAutoSyncAt = Date.now();
  // 单调递增的本地上报基线：结算有延迟时回读的 GET 值会滞后，若直接用做 d_sec 基线，
  // 多次上报携带同一旧基线下一次会覆盖上一次（服务端按“客户端基线+diff”记账时越报越少）。
  // 故维护 gradeLedger = 已成功上报秒数的累积基线，只随成功上报增加，绝不下调；
  // GET 仅用于发现外部（其他端/已结算）带来的增长：比账本大才对齐，否则保持原值。
  let gradeLedger = 0;
  const syncGradePeriodic = async () => {
    const accountKey = account();
    if (!accountKey || syncingGrade) return;
    // 每轮固定上报 60s：仅当本地已累积满 60s 才发起，防止零碎/重复时段入账。
    if (pendingPlayedMs < GRADE_SYNC_DIFF_SEC * 1000) return;
    const diffSec = GRADE_SYNC_DIFF_SEC;
    syncingGrade = true;
    try {
      // 基线查询失败时 POST 未发生，仅跳过本轮，不冲减 pending。
      let latest: number | undefined;
      try {
        const grade = await getUserGradeInfo();
        assertSuccess(grade);
        const value = Number(grade?.data?.d_sec);
        if (Number.isSafeInteger(value) && value >= 0) latest = value;
      } catch (error) {
        logger.warn('ListenTime', 'Grade baseline query failed; will retry next window', error);
        return;
      }
      if (!active(accountKey)) return;
      // 结算可能滞后：以本地产总账为准，仅当服务端已确认超过账本时对齐（只升不降）。
      if (latest !== undefined && latest > gradeLedger) gradeLedger = latest;
      let result: any;
      try {
        result = await reportGradeProgress({ d_sec: gradeLedger, diff_sec: diffSec });
      } catch (error) {
        // 网络/超时，POST 可能已记账：冲减防双计，不重试。
        logger.warn(
          'ListenTime',
          'Grade sync network-uncertain; dropping window to avoid duplicate',
          error,
        );
        pendingPlayedMs -= diffSec * 1000;
        return;
      }
      // request 直接解析返回响应 body（status=1 成功 / 502 业务拒绝）。
      const body = result;
      const accepted =
        Number(body?.status ?? 1) < 400 &&
        body &&
        Number(body.status ?? 1) !== 0 &&
        Number(body.error_code ?? body.errcode ?? 0) === 0;
      if (!active(accountKey)) return;
      if (!accepted) {
        // 上游明确拒绝（未记账）：保留 pending，下个周期原样重试，避免丢失。
        logger.warn('ListenTime', 'Periodic grade sync rejected; will retry next window', {
          d_sec: gradeLedger,
          diffSec,
          response: body,
        });
        return;
      }
      gradeLedger += diffSec;
      pendingPlayedMs -= diffSec * 1000;
      report.dSec = gradeLedger;
      report.lastReportAt = Date.now();
      logger.info('ListenTime', 'Grade synced periodically', {
        baselineDSec: gradeLedger - diffSec,
        diffSec,
        pendingMsLeft: pendingPlayedMs,
        ledgerDSec: gradeLedger,
      });
    } finally {
      syncingGrade = false;
    }
  };
  watch(
    account,
    () => {
      pendingPlayedMs = 0;
      gradeLedger = 0;
      report.pendingDiff = 0;
      void session.flush();
    },
    { flush: 'sync' },
  );
  const tick = () => {
    const track = state.currentTrackSnapshot;
    const mixsongid = Number(track?.mixSongId);
    const eligible =
      account() &&
      track &&
      Number.isSafeInteger(mixsongid) &&
      mixsongid > 0 &&
      state.currentResolvedSourceKind === 'catalog';
    if (!eligible) {
      void session.flush();
      return;
    }
    if (
      !getPlaybackIsPlaying(state) ||
      getPlaybackIsLoading(state) ||
      state.awaitingTrackLoad ||
      state.stallRecovering ||
      state.nativeSeekActive ||
      state.seekTargetTime !== null
    ) {
      session.resetPosition();
      return;
    }
    session.tick(
      { account: account(), track: String(state.currentTrackId), mixsongid },
      state.currentTime,
      state.playbackRate,
    );
    // 周期 grade 同步仅在实际播放时触发（tick 只在播放中调用），无需独立定时器；
    // 未播放时残留 pending 将在下一次播放的 tick 中补报。
    if (Date.now() - lastAutoSyncAt >= GRADE_SYNC_INTERVAL_MS) {
      lastAutoSyncAt = Date.now();
      void syncGradePeriodic();
    }
  };
  return { tick, flush: session.flush, resetPosition: session.resetPosition };
};
