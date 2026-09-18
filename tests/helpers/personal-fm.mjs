import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const noop = () => {};
function load(path, dependencies = {}, timers = { setTimeout, clearTimeout }) {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'setTimeout', 'clearTimeout', code)(
    (id) => {
      assert.ok(id in dependencies, `unexpected dependency: ${id}`);
      return dependencies[id];
    },
    module,
    timers.setTimeout,
    timers.clearTimeout,
  );
  return module.exports;
}

export const constants = load('../../src/renderer/stores/playlist/constants.ts');
export const songUtils = load('../../src/renderer/utils/song.ts');
export const helpers = load('../../src/renderer/stores/playlist/helpers.ts', {
  vue,
  '@/utils/song': songUtils,
  './constants': constants,
});
export const queuePolicy = load('../../src/renderer/stores/player/queueAdvancePolicy.ts', {
  '../../../shared/playbackQueueDecision':
    await import('../../src/shared/playbackQueueDecision.ts'),
  '../playlist/constants': constants,
});

export function createFmStore({ queue, buffer, fetch, timers } = {}) {
  const requests = [];
  const persisted = [];
  const actions = load(
    '../../src/renderer/stores/playlist/personalFmActions.ts',
    {
      '@/api/music': {
        getPersonalFm: (params) => {
          requests.push(params);
          return fetch ? fetch(params) : Promise.resolve([]);
        },
      },
      '@/utils/extractors': { extractList: (result) => result },
      '@/utils/mappers': { mapTopSong: (song) => song },
      '@/utils/logger': { warn: noop },
      '@/utils/song': songUtils,
      './constants': constants,
      './helpers': helpers,
    },
    timers,
  );
  const store = vue.reactive({
    personalFmSessionEpoch: 0,
    personalFmMode: 'normal',
    personalFmSongPoolId: 0,
    personalFmBuffer: buffer ?? [
      { id: 'b', hash: 'b', duration: 100 },
      { id: 'c', hash: 'c', duration: 100 },
    ],
    playbackQueues: [
      queue ?? {
        id: constants.PERSONAL_FM_QUEUE_ID,
        songs: [{ id: 'a', hash: 'a', duration: 100 }],
        currentTrackId: 'a',
        queuedNextTrackIds: [],
        playbackRevision: 0,
        meta: {},
      },
    ],
    activeQueueId: constants.PERSONAL_FM_QUEUE_ID,
    get activeQueue() {
      return this.getQueueById(this.activeQueueId);
    },
    getQueueById(id) {
      return this.playbackQueues.find((queue) => queue.id === id);
    },
    ensurePlaybackQueue(id, options) {
      const existing = this.getQueueById(id);
      if (existing) return existing;
      this.playbackQueues.push({
        id,
        songs: [],
        queuedNextTrackIds: [],
        playbackRevision: 0,
        meta: options?.meta ?? {},
      });
      return this.getQueueById(id);
    },
    setActiveQueue(id) {
      this.activeQueueId = id;
    },
    ensurePlaybackQueueSongsLoaded: async () => {},
    syncLegacyPlaybackState: noop,
    syncQueuedNextTrackIds: noop,
    consumeQueuedNextTrackIds(ids, queueId) {
      const queue = this.getQueueById(queueId);
      queue.queuedNextTrackIds = queue.queuedNextTrackIds.filter((id) => !ids.includes(id));
    },
    consumeQueuedNextTrackId(id, queueId) {
      this.consumeQueuedNextTrackIds([id], queueId);
    },
    updateQueueCurrentTrack(id, queueId) {
      const queue = this.getQueueById(queueId);
      if (queue) queue.currentTrackId = id;
    },
    removeFromQueue(id, queueId) {
      const queue = this.getQueueById(queueId);
      queue.songs = queue.songs.filter((song) => song.id !== id);
    },
    persistPersonalFmPreferences: noop,
    persistQueueAppendToStorage: (_queue, songs) => persisted.push(...songs),
    ...actions.personalFmActions,
  });
  return { store, requests, persisted, helpers };
}
