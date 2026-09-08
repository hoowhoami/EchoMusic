import { watch } from 'vue';
import { getUserGradeInfo, reportListeningEvent } from '@/api/user';
import { useListenReportStore } from '@/stores/listenReport';
import { useUserStore } from '@/stores/user';
import logger from '@/utils/logger';
import { createListeningSession } from '../../../shared/listening-session';
import type { PlayerState } from './state';
import { getPlaybackIsLoading, getPlaybackIsPlaying } from './stateMachine';

/** CSCC segments use wall time gated by advancing audio, never seek distance. */
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
  // Legacy pending increments lack track/session information and must not be replayed.
  report.pendingDiff = 0;
  const session = createListeningSession({
    now: () => performance.now(),
    start: async (identity) => {
      if (!active(identity.account)) return false;
      assertSuccess(await reportListeningEvent({ event: 'start', mixsongid: identity.mixsongid }));
      if (!active(identity.account)) return false;
      logger.info('ListenTime', 'Playback start accepted', { mixsongid: identity.mixsongid });
      return true;
    },
    end: async (identity, duration, endState) => {
      if (!active(identity.account)) return;
      let base: number | undefined;
      try {
        const grade = await getUserGradeInfo();
        assertSuccess(grade);
        const value = Number(grade?.data?.d_sec);
        if (Number.isSafeInteger(value) && value >= 0) base = value;
      } catch (error) {
        logger.warn('ListenTime', 'Grade baseline unavailable; reporting playback only', error);
      }
      if (!active(identity.account)) return;
      const syncGrade = base !== undefined && duration >= 1000;
      const result = await reportListeningEvent({
        event: 'end',
        mixsongid: identity.mixsongid,
        duration,
        state: endState,
        ...(syncGrade ? { d_sec: base, diff_sec: Math.floor(duration / 1000) } : {}),
      });
      assertSuccess(result);
      const data = syncGrade ? result?.data : null;
      const playbackAccepted = syncGrade ? data?.playback_accepted === true : true;
      const gradeAccepted = data?.grade_synced === true;
      const value = Number(data?.grade?.data?.d_sec);
      const confirmed = gradeAccepted && Number.isSafeInteger(value) && value >= 0 ? value : null;
      if (!active(identity.account)) return;
      if (!playbackAccepted || (syncGrade && !gradeAccepted)) {
        logger.warn('ListenTime', 'Listening report partially accepted; no automatic replay', {
          mixsongid: identity.mixsongid,
          playbackAccepted,
          gradeRequestAccepted: gradeAccepted,
          playbackError: playbackAccepted ? undefined : data?.report,
          gradeError: gradeAccepted ? undefined : data?.grade,
        });
      }
      if (!active(identity.account)) return;
      if (confirmed !== null) report.dSec = confirmed;
      if (gradeAccepted) report.lastReportAt = Date.now();
      logger.info('ListenTime', 'Listening report completed', {
        mixsongid: identity.mixsongid,
        durationMs: duration,
        state: endState,
        playbackAccepted,
        gradeRequestAccepted: gradeAccepted,
        baselineDSec: base ?? null,
        serverDSec: confirmed,
        observedDeltaSec: base !== undefined && confirmed !== null ? confirmed - base : null,
      });
    },
    onError: (error) =>
      logger.warn('ListenTime', 'Playback reporting failed; no automatic replay', error),
  });
  watch(
    account,
    () => {
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
