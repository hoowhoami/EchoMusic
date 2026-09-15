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
// 保持 0.7s 的最小间距，避免切歌时 end→start 连发触发 1203 导致事件被丢弃。
const CSCC_EVENT_MIN_GAP_MS = 700;
let lastSessionEventAt = 0;
const waitForSessionEventGap = async () => {
  const wait = CSCC_EVENT_MIN_GAP_MS - (Date.now() - lastSessionEventAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
};
// grade 与 CSCC 完全解耦：CSCC end 只上报听歌时长事件，d_sec 累计由周期任务独立写入，
// 避免同段时长被 end 连带上报与周期上报重复计入；单曲循环长时间播放也会周期入账。
const GRADE_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const GRADE_SYNC_MIN_DIFF_SEC = 10;

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
  const syncGradePeriodic = async () => {
    const accountKey = account();
    if (!accountKey || syncingGrade) return;
    const diffSec = Math.floor(pendingPlayedMs / 1000);
    if (diffSec < GRADE_SYNC_MIN_DIFF_SEC) return;
    syncingGrade = true;
    try {
      const grade = await getUserGradeInfo();
      assertSuccess(grade);
      const base = Number(grade?.data?.d_sec);
      if (!Number.isSafeInteger(base) || base < 0) return;
      if (!active(accountKey)) return;
      const result = await reportGradeProgress({ d_sec: base, diff_sec: diffSec });
      assertSuccess(result);
      if (!active(accountKey)) return;
      pendingPlayedMs -= diffSec * 1000;
      report.dSec = base;
      report.lastReportAt = Date.now();
      logger.info('ListenTime', 'Grade synced periodically', {
        baselineDSec: base,
        diffSec,
        pendingMsLeft: pendingPlayedMs,
      });
    } catch (error) {
      logger.warn(
        'ListenTime',
        'Periodic grade sync failed; keeping pending seconds for retry',
        error,
      );
    } finally {
      syncingGrade = false;
    }
  };
  window.setInterval(() => void syncGradePeriodic(), GRADE_SYNC_INTERVAL_MS);
  watch(
    account,
    () => {
      pendingPlayedMs = 0;
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
  };
  return { tick, flush: session.flush, resetPosition: session.resetPosition };
};
