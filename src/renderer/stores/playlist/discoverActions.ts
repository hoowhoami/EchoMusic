import type { Song } from '@/models/song';
import { fetchDiscoverItems } from '@/services/discover';
import { isPlayableSong } from '@/utils/song';
import logger from '@/utils/logger';
import { DISCOVER_QUEUE_ID } from './constants';
import type { PlaybackQueueState, SetPlaybackQueueOptions } from './types';

type DiscoverStore = {
  activeQueueId: string;
  getQueueById: (id: string) => PlaybackQueueState | null;
  appendToPlaybackQueue: (songs: Song[], options: SetPlaybackQueueOptions) => number;
};

const requests = new WeakMap<PlaybackQueueState, { songs: Song[]; promise: Promise<number> }>();

export const discoverActions = {
  replenishDiscoverQueue(this: DiscoverStore, trackId?: string | null): Promise<number> {
    const queue = this.getQueueById(DISCOVER_QUEUE_ID);
    if (!queue || this.activeQueueId !== DISCOVER_QUEUE_ID) return Promise.resolve(0);
    const songs = queue.songs;
    const index = songs.findIndex(
      (song) => String(song.id) === String(trackId ?? queue.currentTrackId),
    );
    if (index < 0 || songs.slice(index + 1).filter(isPlayableSong).length > 2)
      return Promise.resolve(0);
    const pending = requests.get(queue);
    if (pending?.songs === songs) return pending.promise;
    const isCurrent = () =>
      this.activeQueueId === DISCOVER_QUEUE_ID &&
      this.getQueueById(DISCOVER_QUEUE_ID) === queue &&
      queue.songs === songs;
    const promise = (async () => {
      try {
        // A recommendation batch can contain previously served songs. Retry a bounded number.
        for (let attempt = 0; attempt < 3; attempt++) {
          const items = await fetchDiscoverItems();
          if (!isCurrent()) return 0;
          const added = this.appendToPlaybackQueue(
            items.map((item) => item.song).filter(isPlayableSong),
            {
              queueId: DISCOVER_QUEUE_ID,
              activate: false,
            },
          );
          if (added > 0) return added;
        }
      } catch (error) {
        logger.warn('Discover', 'Recommendation replenishment failed:', error);
      }
      return 0;
    })();
    requests.set(queue, { songs, promise });
    void promise.finally(() => {
      if (requests.get(queue)?.promise === promise) requests.delete(queue);
    });
    return promise;
  },
};
