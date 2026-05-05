import { getServerNow, uploadPlayHistory } from '@/api/user';
import type { Song } from '@/models/song';
import logger from '@/utils/logger';
import type { PlayerState } from './state';
import { resolveServerTimestamp, resolveTrackMxid, summarizeSong, trimPlayCountMap } from './utils';

const HISTORY_UPLOAD_MIN_SECONDS = 15;
const HISTORY_UPLOAD_PROGRESS_RATIO = 0.5;

export const createHistoryManager = (state: PlayerState) => {
  const getTrackedPlayCount = (track?: Song | null): number => {
    const mxid = resolveTrackMxid(track);
    if (!mxid) return Math.max(0, track?.playCount ?? 0);
    return Math.max(0, state.historyPlayCountMap[String(mxid)] ?? track?.playCount ?? 0);
  };

  const syncTrackedPlayCount = (track: Song, playCount: number) => {
    const mxid = resolveTrackMxid(track);
    if (!mxid || playCount <= 0) return;
    state.historyPlayCountMap = trimPlayCountMap({
      ...state.historyPlayCountMap,
      [String(mxid)]: Math.max(playCount, state.historyPlayCountMap[String(mxid)] ?? 0),
    });
  };

  const hydrateHistoryPlayCounts = (tracks: Song[]) => {
    if (tracks.length === 0) return;
    const nextMap = { ...state.historyPlayCountMap };
    let changed = false;
    tracks.forEach((track) => {
      const mxid = resolveTrackMxid(track);
      const playCount = Math.max(0, track.playCount ?? 0);
      if (!mxid || playCount <= 0) return;
      const key = String(mxid);
      if (playCount > (nextMap[key] ?? 0)) {
        nextMap[key] = playCount;
        changed = true;
      }
    });
    if (changed) {
      state.historyPlayCountMap = trimPlayCountMap(nextMap);
    }
  };

  const resetHistoryUploadState = (track?: Song | null) => {
    state.historyUploadCommitted = false;
    state.historyUploadTrackId = track ? String(track.id) : null;
    state.historyUploadPlayCount = Math.max(1, getTrackedPlayCount(track) + 1);
  };

  const commitListeningHistory = async (track?: Song | null) => {
    const target = track ?? state.currentTrackSnapshot;
    if (!target || !state.currentTrackId) return;
    const activeTrackId = String(state.currentTrackId);
    if (String(target.id) !== activeTrackId) return;
    if (state.historyUploadCommitted && state.historyUploadTrackId === activeTrackId) return;

    const mxid = resolveTrackMxid(target);
    if (!mxid) return;

    const effectiveDuration = Number(target.duration || state.duration || 0);
    const effectiveProgress = Number(state.currentTime || 0);
    const requiredProgress =
      effectiveDuration > 0
        ? Math.min(
            Math.max(effectiveDuration * HISTORY_UPLOAD_PROGRESS_RATIO, HISTORY_UPLOAD_MIN_SECONDS),
            effectiveDuration,
          )
        : HISTORY_UPLOAD_MIN_SECONDS;

    if (effectiveProgress < requiredProgress) return;

    let timestamp = Math.floor(Date.now() / 1000);
    try {
      const nowRes = await getServerNow();
      timestamp = resolveServerTimestamp(nowRes) ?? timestamp;
    } catch (error) {
      logger.warn('PlayerHistory', 'Fetch server time failed, fallback to local timestamp', error);
    }

    try {
      const playCount = Math.max(
        1,
        state.historyUploadPlayCount || getTrackedPlayCount(target) + 1,
      );
      const res = await uploadPlayHistory(mxid, { time: timestamp, pc: playCount });
      if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
        state.historyUploadCommitted = true;
        state.historyUploadTrackId = activeTrackId;
        state.historyUploadPlayCount = playCount;
        syncTrackedPlayCount(target, playCount);
        if (state.currentTrackSnapshot && String(state.currentTrackSnapshot.id) === activeTrackId) {
          state.currentTrackSnapshot = {
            ...state.currentTrackSnapshot,
            playCount,
            lastPlayedAt: timestamp,
          };
        }
        logger.info('PlayerHistory', 'Play history uploaded', {
          track: summarizeSong(target),
          mxid,
          playCount,
          timestamp,
        });
      }
    } catch (error) {
      logger.error('PlayerHistory', 'Upload history sync error:', error);
    }
  };

  return {
    getTrackedPlayCount,
    syncTrackedPlayCount,
    hydrateHistoryPlayCounts,
    resetHistoryUploadState,
    commitListeningHistory,
  };
};
