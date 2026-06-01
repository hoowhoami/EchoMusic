import { uploadPlayHistory } from '@/api/user';
import type { Song } from '@/models/song';
import logger from '@/utils/logger';
import type { PlayerState } from './state';
import { resolveTrackMxid, summarizeSong } from './utils';

const HISTORY_UPLOAD_MIN_SECONDS = 15;
const HISTORY_UPLOAD_PROGRESS_RATIO = 0.5;

export const createHistoryManager = (state: PlayerState) => {
  const resetHistoryUploadState = (track?: Song | null) => {
    state.historyUploadCommitted = false;
    state.historyUploadTrackId = track ? String(track.id) : null;
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

    try {
      state.historyUploadCommitted = true;
      state.historyUploadTrackId = activeTrackId;
      const res = await uploadPlayHistory(mxid);
      if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
        logger.info('PlayerHistory', 'Play history uploaded', {
          track: summarizeSong(target),
          mxid,
        });
      }
    } catch (error) {
      logger.error('PlayerHistory', 'Upload history sync error:', error);
    }
  };

  return {
    resetHistoryUploadState,
    commitListeningHistory,
  };
};
