import type { PersonalFmMode } from './types';

export const DEFAULT_PLAYBACK_QUEUE_ID = 'queue:default';
export const MANUAL_PLAYBACK_QUEUE_ID = 'queue:manual';
export const PERSONAL_FM_QUEUE_ID = 'queue:personal-fm';
export const DISCOVER_QUEUE_ID = 'queue:home-discover';
export const LISTEN_TOGETHER_QUEUE_ID = 'queue:listen-together';
export const isTransientPlaybackQueue = (queueId: string | number | null | undefined) => {
  const id = String(queueId ?? '');
  return id === PERSONAL_FM_QUEUE_ID || id === DISCOVER_QUEUE_ID || id === LISTEN_TOGETHER_QUEUE_ID;
};
export const FAVORITES_PAGE_SIZE = 300;
export const MAX_PLAYBACK_QUEUE_COUNT = 4;
export const PERSONAL_FM_MODE: PersonalFmMode = 'normal';
