import { computed, watch } from 'vue';
import type { NowPlayingPlaybackPayload } from '../../shared/nowPlaying';
import { useDeferredSeek } from '../composables/useDeferredSeek';

// The standalone strip shares the main player's gesture lifecycle, not a second seek engine.
export function useTaskbarSeek(
  getPlayback: () => NowPlayingPlaybackPayload | null | undefined,
  seek: (time: number) => void,
) {
  const duration = computed(() => {
    const value = getPlayback()?.duration;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  });
  const deferred = useDeferredSeek({
    getCurrentTime: () => {
      const value = getPlayback()?.currentTime;
      return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.min(duration.value, value))
        : 0;
    },
    seek: (value) => {
      if (duration.value > 0 && Number.isFinite(value)) {
        seek(Math.max(0, Math.min(duration.value, value)));
      }
    },
  });
  watch(() => getPlayback()?.trackId, deferred.handleCancel, { flush: 'sync' });
  watch(
    duration,
    (value) => {
      if (!value) deferred.handleCancel();
    },
    { flush: 'sync' },
  );

  const handleStart = () => {
    if (duration.value > 0) deferred.handleStart();
  };
  const handleKeydown = (event: KeyboardEvent) => {
    if (
      [
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Home',
        'End',
        'PageUp',
        'PageDown',
      ].includes(event.key)
    ) {
      handleStart();
    }
  };
  const handleCommit = (value: number[] | undefined) => {
    // A canceled gesture (including a song change) must not seek the new song.
    if (deferred.isDragging.value) deferred.handleCommit(value);
  };
  return { ...deferred, duration, handleStart, handleKeydown, handleCommit };
}
