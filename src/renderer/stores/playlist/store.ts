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
import { findLikedPlaylist, resolveFavoriteSongKey } from './helpers';
import { favoritesActions } from './favoritesActions';
import { personalFmActions } from './personalFmActions';
import { queueActions } from './queueActions';
import { userActions } from './userActions';
import type { PersonalFmMode, PersonalFmSongPoolId, PlaybackQueueState } from './types';

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
    defaultList: [] as Song[],
    favorites: shallowRef<Song[]>([]),
    userPlaylists: [] as PlaylistMeta[],
    queueFilteredInvalidCount: 0,
    queuedNextTrackIds: [] as string[],
    playbackQueues: [] as PlaybackQueueState[],
    activeQueueId: DEFAULT_PLAYBACK_QUEUE_ID,
    lastNonFmQueueId: DEFAULT_PLAYBACK_QUEUE_ID,
    personalFmMode: PERSONAL_FM_MODE as PersonalFmMode,
    personalFmSongPoolId: 0 as PersonalFmSongPoolId,
    personalFmBuffer: [] as Song[],
  }),
  getters: {
    likedPlaylist(state) {
      return findLikedPlaylist(state.userPlaylists);
    },
    activeQueue(state): PlaybackQueueState | null {
      return state.playbackQueues.find((queue) => queue.id === state.activeQueueId) ?? null;
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
          queue.songs.length > 0,
      );
    },
    recentPlaybackQueues(): PlaybackQueueState[] {
      return this.playbackQueueList.filter(
        (queue) =>
          queue.id !== this.activeQueueId &&
          queue.id !== MANUAL_PLAYBACK_QUEUE_ID &&
          queue.id !== PERSONAL_FM_QUEUE_ID &&
          queue.songs.length > 0,
      );
    },
    customPlaybackQueue(): PlaybackQueueState | null {
      return (
        this.playbackQueues.find(
          (queue) => queue.id === MANUAL_PLAYBACK_QUEUE_ID && queue.songs.length > 0,
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
  persist: true,
});
