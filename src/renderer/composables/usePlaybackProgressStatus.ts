import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import type { PlaybackProgressBusyReason } from '../../shared/playback';

const getAriaLabel = (reason: PlaybackProgressBusyReason) => {
  if (reason === 'seek') return '播放进度，定位中';
  if (reason === 'buffering') return '播放进度，缓冲中';
  return '播放进度';
};

export const usePlaybackProgressStatus = (
  source: MaybeRefOrGetter<PlaybackProgressBusyReason | undefined>,
) => {
  const busyReason = computed<PlaybackProgressBusyReason>(() => toValue(source) ?? null);
  const isBusy = computed(() => busyReason.value !== null);
  const ariaLabel = computed(() => getAriaLabel(busyReason.value));

  return {
    busyReason,
    isBusy,
    ariaLabel,
  };
};
