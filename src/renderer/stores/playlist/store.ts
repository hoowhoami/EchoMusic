import { defineStore } from 'pinia';
import { shallowRef } from 'vue';
import type { PlaylistMeta } from '@/models/playlist';
import type { Song } from '@/models/song';
import {
  DEFAULT_PLAYBACK_QUEUE_ID,
  MANUAL_PLAYBACK_QUEUE_ID,
  PERSONAL_FM_MODE,
  PERSONAL_FM_QUEUE_ID,
} from './constants';
import {
  findLikedPlaylist,
  normalizePlaybackQueueRuntime,
  normalizePlaybackQueuesRuntime,
  resolveFavoriteSongKey,
  toRawSongList,
} from './helpers';
import { favoritesActions } from './favoritesActions';
import { personalFmActions } from './personalFmActions';
import { queueActions } from './queueActions';
import { userActions } from './userActions';
import type { PersonalFmMode, PersonalFmSongPoolId, PlaybackQueueState } from './types';

const toPlain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const toStorageQueueMeta = (queue: PlaybackQueueState): Omit<PlaybackQueueState, 'songs'> => ({
  id: queue.id,
  title: queue.title,
  subtitle: queue.subtitle,
  coverUrl: queue.coverUrl,
  type: queue.type,
  songCount: queue.songCount,
  filteredInvalidCount: queue.filteredInvalidCount,
  queuedNextTrackIds: queue.queuedNextTrackIds,
  currentTrackId: queue.currentTrackId,
  createdAt: queue.createdAt,
  updatedAt: queue.updatedAt,
  dynamic: queue.dynamic,
  meta: queue.meta,
});

export type { Song, SongRelateGood, SongArtist } from '@/models/song';
export type { PlaylistInfo } from '@/models/playlist';
export type {
  PersonalFmMode,
  PersonalFmSongPoolId,
  PlaybackQueueMetaValueMap,
  PlaybackQueueState,
  PlaylistSortOrder,
  SetPlaybackQueueOptions,
} from './types';
export {
  DEFAULT_PLAYBACK_QUEUE_ID,
  FAVORITES_PAGE_SIZE,
  MANUAL_PLAYBACK_QUEUE_ID,
  MAX_PLAYBACK_QUEUE_COUNT,
  PERSONAL_FM_MODE,
  PERSONAL_FM_QUEUE_ID,
} from './constants';
export {
  getPersonalFmModePresentation,
  getPersonalFmSongPoolPresentation,
  sortPlaylists,
} from './helpers';

export const usePlaylistStore = defineStore('playlist', {
  state: () => ({
    defaultList: toRawSongList([]),
    favorites: shallowRef<Song[]>([]),
    userPlaylists: [] as PlaylistMeta[],
    queueFilteredInvalidCount: 0,
    queuedNextTrackIds: [] as string[],
    playbackQueues: [] as PlaybackQueueState[],
    activeQueueId: DEFAULT_PLAYBACK_QUEUE_ID,
    lastNonFmQueueId: DEFAULT_PLAYBACK_QUEUE_ID,
    playbackStorageReady: false,
    personalFmMode: PERSONAL_FM_MODE as PersonalFmMode,
    personalFmSongPoolId: 0 as PersonalFmSongPoolId,
    personalFmBuffer: toRawSongList([]),
  }),
  getters: {
    likedPlaylist(state) {
      return findLikedPlaylist(state.userPlaylists);
    },
    activeQueue(state): PlaybackQueueState | null {
      return state.playbackQueues.find((queue) => queue.id === state.activeQueueId) ?? null;
    },
    getQueueSongCount() {
      return (queue: PlaybackQueueState | null | undefined) =>
        Math.max(0, queue?.songCount ?? queue?.songs.length ?? 0);
    },
    playbackQueueList(state): PlaybackQueueState[] {
      return state.playbackQueues
        .slice()
        .sort(
          (left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt,
        );
    },
    historyPlaybackQueues(): PlaybackQueueState[] {
      return this.playbackQueueList.filter(
        (queue) =>
          queue.id !== this.activeQueueId &&
          queue.id !== MANUAL_PLAYBACK_QUEUE_ID &&
          queue.id !== PERSONAL_FM_QUEUE_ID &&
          this.getQueueSongCount(queue) > 0,
      );
    },
    recentPlaybackQueues(): PlaybackQueueState[] {
      return this.playbackQueueList.filter(
        (queue) =>
          queue.id !== this.activeQueueId &&
          queue.id !== MANUAL_PLAYBACK_QUEUE_ID &&
          queue.id !== PERSONAL_FM_QUEUE_ID &&
          this.getQueueSongCount(queue) > 0,
      );
    },
    customPlaybackQueue(): PlaybackQueueState | null {
      return (
        this.playbackQueues.find(
          (queue) => queue.id === MANUAL_PLAYBACK_QUEUE_ID && this.getQueueSongCount(queue) > 0,
        ) ?? null
      );
    },
    likedPlaylistQueryId(): string | number | null {
      const playlist = this.likedPlaylist;
      if (!playlist) return null;
      return (
        playlist.listCreateGid || playlist.globalCollectionId || playlist.listid || playlist.id
      );
    },
    likedPlaylistListId(): number | null {
      const playlist = this.likedPlaylist;
      if (!playlist?.listid) return null;
      return playlist.listid;
    },
    favoriteSongKeySet(state): Set<string> {
      return new Set(state.favorites.map((song) => resolveFavoriteSongKey(song)).filter(Boolean));
    },
  },
  actions: {
    applyPlaybackSnapshot(snapshot: {
      queues: PlaybackQueueState[];
      activeQueueId: string;
      lastNonFmQueueId: string;
    }) {
      this.playbackQueues = normalizePlaybackQueuesRuntime(
        (snapshot.queues ?? []) as PlaybackQueueState[],
      );
      this.activeQueueId = snapshot.activeQueueId || DEFAULT_PLAYBACK_QUEUE_ID;
      this.lastNonFmQueueId = snapshot.lastNonFmQueueId || this.activeQueueId;
      this.syncLegacyPlaybackState();
    },
    upsertPlaybackQueueInMemory(queue: PlaybackQueueState) {
      normalizePlaybackQueueRuntime(queue);
      const index = this.playbackQueues.findIndex((item) => item.id === queue.id);
      if (index === -1) this.playbackQueues.unshift(queue);
      else this.playbackQueues.splice(index, 1, queue);
      if (queue.id === this.activeQueueId) this.syncLegacyPlaybackState();
    },
    async loadPlaybackQueueFromStorage(queueId: string | number) {
      if (!window.electron?.storage) return this.getQueueById(queueId);
      const queue = await window.electron.storage.getPlaybackQueue({ queueId: String(queueId) });
      if (!queue) return null;
      this.upsertPlaybackQueueInMemory(queue as PlaybackQueueState);
      return this.getQueueById(queueId);
    },
    async ensurePlaybackQueueSongsLoaded(queueId: string | number) {
      const queue = this.getQueueById(queueId);
      if (!queue) return null;
      if (queue.songs.length > 0 || (queue.songCount ?? 0) === 0) return queue;
      return this.loadPlaybackQueueFromStorage(queue.id);
    },
    markLastNonFmQueue(queueId: string | number | null | undefined) {
      const resolvedId = String(queueId ?? '');
      if (
        !resolvedId ||
        resolvedId === PERSONAL_FM_QUEUE_ID ||
        resolvedId === MANUAL_PLAYBACK_QUEUE_ID
      )
        return;
      this.lastNonFmQueueId = resolvedId;
    },
    async hydratePlaybackStateFromStorage() {
      if (!window.electron?.storage) {
        this.playbackStorageReady = true;
        return;
      }
      const snapshot = await window.electron.storage.getPlaybackSnapshot();
      this.playbackStorageReady = true;
      this.applyPlaybackSnapshot(
        snapshot as {
          queues: PlaybackQueueState[];
          activeQueueId: string;
          lastNonFmQueueId: string;
        },
      );
    },
    persistQueueToStorage(queue: PlaybackQueueState) {
      if (!this.playbackStorageReady || !window.electron?.storage) return;
      void window.electron.storage.replacePlaybackQueue(
        toPlain({
          queue,
          activeQueueId: this.activeQueueId,
          lastNonFmQueueId: this.lastNonFmQueueId,
        }),
      );
    },
    persistQueueAppendToStorage(queue: PlaybackQueueState, songs: Song[]) {
      if (!this.playbackStorageReady || !window.electron?.storage || songs.length === 0) return;
      void window.electron.storage.appendPlaybackQueueItems(
        toPlain({
          queue: toStorageQueueMeta(queue),
          songs,
          activeQueueId: this.activeQueueId,
          lastNonFmQueueId: this.lastNonFmQueueId,
        }),
      );
    },
    persistQueueMetaToStorage(queue: PlaybackQueueState) {
      if (!this.playbackStorageReady || !window.electron?.storage) return;
      void window.electron.storage.updatePlaybackQueueMeta(
        toPlain({
          queue: toStorageQueueMeta(queue),
          activeQueueId: this.activeQueueId,
          lastNonFmQueueId: this.lastNonFmQueueId,
        }),
      );
    },
    persistQueueClearToStorage(queue: PlaybackQueueState) {
      if (!this.playbackStorageReady || !window.electron?.storage) return;
      void window.electron.storage.clearPlaybackQueue(
        toPlain({
          queue: toStorageQueueMeta(queue),
          activeQueueId: this.activeQueueId,
          lastNonFmQueueId: this.lastNonFmQueueId,
        }),
      );
    },
    persistQueueRemovalToStorage(queueId: string) {
      if (!this.playbackStorageReady || !window.electron?.storage) return;
      // 仅持久化删除，不要把返回的快照回灌内存：删除后调用方可能立即重建队列
      // （如私人 FM 首次播放的 recreate 流程），异步快照会用删除瞬间的过期状态覆盖
      // 刚建好的队列并改写 activeQueueId，导致首次播放队列被清空、需再点一次才生效。
      void window.electron.storage.removePlaybackQueue({ queueId });
    },
    persistQueueItemRemovalToStorage(queue: PlaybackQueueState, songId: string | number) {
      if (!this.playbackStorageReady || !window.electron?.storage) return;
      void window.electron.storage.removePlaybackQueueItem(
        toPlain({
          queueId: queue.id,
          songId,
          queuedNextTrackIds: queue.queuedNextTrackIds,
          currentTrackId: queue.currentTrackId,
          updatedAt: queue.updatedAt,
        }),
      );
    },
    persistQueueReorderToStorage(queue: PlaybackQueueState) {
      if (!this.playbackStorageReady || !window.electron?.storage) return;
      void window.electron.storage.reorderPlaybackQueueItems(
        toPlain({
          queueId: queue.id,
          songs: queue.songs,
          updatedAt: queue.updatedAt,
        }),
      );
    },
    persistQueueCurrentTrackToStorage(queueId: string, trackId: string | null) {
      if (!this.playbackStorageReady || !window.electron?.storage) return;
      void window.electron.storage.setQueueCurrentTrack(
        toPlain({
          queueId,
          trackId,
        }),
      );
    },
    getPreferredManualQueueOptions: queueActions.getPreferredManualQueueOptions,
    getPlaybackQueueSongs: queueActions.getPlaybackQueueSongs,
    syncLegacyPlaybackState: queueActions.syncLegacyPlaybackState,
    trimPlaybackQueues: queueActions.trimPlaybackQueues,
    hydratePlaybackQueues: queueActions.hydratePlaybackQueues,
    ensurePlaybackQueue: queueActions.ensurePlaybackQueue,
    setActiveQueue: queueActions.setActiveQueue,
    removePersonalFmQueue: queueActions.removePersonalFmQueue,
    getQueueById: queueActions.getQueueById,
    updateQueueCurrentTrack: queueActions.updateQueueCurrentTrack,
    getQueueRemainingSongCount: queueActions.getQueueRemainingSongCount,
    getPersonalFmPreviewTrack: personalFmActions.getPersonalFmPreviewTrack,
    getPersonalFmDisplayTracks: personalFmActions.getPersonalFmDisplayTracks,
    updatePersonalFmMode: personalFmActions.updatePersonalFmMode,
    updatePersonalFmSongPool: personalFmActions.updatePersonalFmSongPool,
    isPersonalFmSessionResetPending: personalFmActions.isPersonalFmSessionResetPending,
    resetPersonalFmPreview: personalFmActions.resetPersonalFmPreview,
    refreshPersonalFmPreview: personalFmActions.refreshPersonalFmPreview,
    fetchPersonalFmSongs: personalFmActions.fetchPersonalFmSongs,
    startPersonalFm: personalFmActions.startPersonalFm,
    activatePersonalFmTrack: personalFmActions.activatePersonalFmTrack,
    ensurePersonalFmQueue: personalFmActions.ensurePersonalFmQueue,
    consumeNextPersonalFmTrack: personalFmActions.consumeNextPersonalFmTrack,
    ensureLikedPlaylistReady: favoritesActions.ensureLikedPlaylistReady,
    isFavoriteSong: favoritesActions.isFavoriteSong,
    findPlaylistByIdentity: userActions.findPlaylistByIdentity,
    isFavoriteAlbum: userActions.isFavoriteAlbum,
    isOwnedPlaylist: userActions.isOwnedPlaylist,
    getCreatedPlaylists: userActions.getCreatedPlaylists,
    resolveNumericListId: userActions.resolveNumericListId,
    rememberPlaylistSongs: favoritesActions.rememberPlaylistSongs,
    forgetPlaylistSongs: favoritesActions.forgetPlaylistSongs,
    getKnownPlaylistSongs: favoritesActions.getKnownPlaylistSongs,
    syncCloudFavorites: favoritesActions.syncCloudFavorites,
    fetchLikedPlaylistSongs: favoritesActions.fetchLikedPlaylistSongs,
    waitForFavoritesLoaded: favoritesActions.waitForFavoritesLoaded,
    setPlaybackQueue: queueActions.setPlaybackQueue,
    setPlaybackQueueWithOptions: queueActions.setPlaybackQueueWithOptions,
    clearPlaybackQueue: queueActions.clearPlaybackQueue,
    appendToPlaybackQueue: queueActions.appendToPlaybackQueue,
    removePlaybackQueue: queueActions.removePlaybackQueue,
    enqueuePlayNext: queueActions.enqueuePlayNext,
    consumeQueuedNextTrackId: queueActions.consumeQueuedNextTrackId,
    peekQueuedNextTrackId: queueActions.peekQueuedNextTrackId,
    syncQueuedNextTrackIds: queueActions.syncQueuedNextTrackIds,
    removeFromQueue: queueActions.removeFromQueue,
    reorderPlaybackQueue: queueActions.reorderPlaybackQueue,
    addToPlaylist: favoritesActions.addToPlaylist,
    removeFromPlaylist: favoritesActions.removeFromPlaylist,
    addSongsToPlaylist: favoritesActions.addSongsToPlaylist,
    removeSongsFromPlaylist: favoritesActions.removeSongsFromPlaylist,
    addToFavorites: favoritesActions.addToFavorites,
    removeFromFavorites: favoritesActions.removeFromFavorites,
    removeFavoriteSong: favoritesActions.removeFavoriteSong,
    fetchUserPlaylists: userActions.fetchUserPlaylists,
    createPlaylist: userActions.createPlaylist,
    createPlaylistAndReturnId: userActions.createPlaylistAndReturnId,
    deleteOwnedPlaylist: userActions.deleteOwnedPlaylist,
    favoritePlaylist: userActions.favoritePlaylist,
    favoriteAlbum: userActions.favoriteAlbum,
    unfavoriteAlbum: userActions.unfavoriteAlbum,
    unfavoritePlaylist: userActions.unfavoritePlaylist,
  },
});
