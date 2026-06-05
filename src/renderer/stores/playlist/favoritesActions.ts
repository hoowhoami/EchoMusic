import { addPlaylistTrack, deletePlaylistTrack, getPlaylistTracks } from '@/api/playlist';
import type { PlaylistMeta } from '@/models/playlist';
import type { Song } from '@/models/song';
import { parsePlaylistTracks } from '@/utils/mappers';
import { PagedSongLoader } from '@/utils/PagedSongLoader';
import { isSameSong } from '@/utils/song';
import logger from '@/utils/logger';
import { FAVORITES_PAGE_SIZE } from './constants';
import {
  buildPlaylistTrackPayload,
  dedupeSongs,
  includesPlaylistIdentity,
  removeSongsFromKnownList,
  resolveFavoriteSongKey,
  resolveSongQueueKey,
} from './helpers';

let favoritesLoader: PagedSongLoader<Song> | null = null;
const localPlaylistSongsCache = new Map<string, Song[]>();
const localPlaylistSongsComplete = new Map<string, boolean>();

export type AddToPlaylistResult = 'added' | 'exists' | 'failed';

const DUPLICATE_CHECK_PAGE_SIZE = 200;
const DUPLICATE_CHECK_MAX_PAGES = 50;

const loadPlaylistSongsForDuplicateCheck = async (targetId: string): Promise<Song[] | null> => {
  const songs: Song[] = [];
  try {
    for (let page = 1; page <= DUPLICATE_CHECK_MAX_PAGES; page += 1) {
      const res = await getPlaylistTracks(targetId, page, DUPLICATE_CHECK_PAGE_SIZE);
      if (!res || typeof res !== 'object') return songs.length > 0 ? songs : null;
      const hasStatus = 'status' in res;
      const statusOk = hasStatus && (res as { status?: number }).status === 1;
      const hasPayload = 'data' in res || 'info' in res;
      if (!statusOk && !hasPayload) return songs.length > 0 ? songs : null;

      const payload =
        'data' in res
          ? (res as { data?: unknown }).data
          : 'info' in res
            ? (res as { info?: unknown }).info
            : res;
      const { songs: pageSongs, filteredCount } = parsePlaylistTracks(payload ?? res);
      songs.push(...pageSongs);
      if (pageSongs.length + filteredCount < DUPLICATE_CHECK_PAGE_SIZE) break;
    }
    return dedupeSongs(songs);
  } catch (e) {
    logger.error('PlaylistStore', 'Load playlist songs for duplicate check error:', e);
    return null;
  }
};

type FavoritesStoreShape = {
  ensureLikedPlaylistReady: () => Promise<{
    queryId: string | number | null;
    listId: number | null;
  }>;
  favoriteSongKeySet: Set<string>;
  favorites: Song[];
  favoritesLoaded: boolean;
  favoritesLoading: boolean;
  fetchUserPlaylists: () => Promise<void>;
  forgetPlaylistSongs: (
    listId: string | number | null | undefined,
    songs?: readonly Song[],
  ) => void;
  getKnownPlaylistSongs: (listId: string | number | null | undefined) => Song[];
  isFavoriteSong: (song: Song) => boolean;
  likedPlaylist: PlaylistMeta | undefined;
  likedPlaylistListId: number | null;
  likedPlaylistQueryId: string | number | null;
  rememberPlaylistSongs: (
    listId: string | number | null | undefined,
    songs: readonly Song[],
    complete?: boolean,
  ) => void;
  hasCompleteKnownPlaylistSongs: (listId: string | number | null | undefined) => boolean;
  markPlaylistContentChanged: (
    listId: string | number | null | undefined,
    action: 'add' | 'remove' | 'refresh',
    songs?: readonly Song[],
  ) => void;
  userPlaylists: PlaylistMeta[];
};

export const favoritesActions = {
  async ensureLikedPlaylistReady(this: FavoritesStoreShape) {
    if (this.likedPlaylistQueryId || this.likedPlaylistListId) {
      return {
        queryId: this.likedPlaylistQueryId,
        listId: this.likedPlaylistListId,
      };
    }
    if (this.userPlaylists.length === 0) {
      await this.fetchUserPlaylists();
    }
    return {
      queryId: this.likedPlaylistQueryId,
      listId: this.likedPlaylistListId,
    };
  },
  isFavoriteSong(this: FavoritesStoreShape, song: Song) {
    const key = resolveFavoriteSongKey(song);
    return key ? this.favoriteSongKeySet.has(key) : false;
  },
  rememberPlaylistSongs(
    this: FavoritesStoreShape,
    listId: string | number | null | undefined,
    songs: readonly Song[],
    complete = true,
  ) {
    if (listId === undefined || listId === null || String(listId) === '') return;
    const key = String(listId);
    localPlaylistSongsCache.set(key, dedupeSongs(Array.from(songs) as Song[]));
    localPlaylistSongsComplete.set(key, complete);
  },
  forgetPlaylistSongs(
    this: FavoritesStoreShape,
    listId: string | number | null | undefined,
    songs?: readonly Song[],
  ) {
    if (listId === undefined || listId === null || String(listId) === '') return;
    const key = String(listId);
    if (!songs || songs.length === 0) {
      localPlaylistSongsCache.delete(key);
      localPlaylistSongsComplete.delete(key);
      return;
    }
    const current = localPlaylistSongsCache.get(key) ?? [];
    localPlaylistSongsCache.set(
      key,
      removeSongsFromKnownList(current, Array.from(songs) as Song[]),
    );
  },
  hasCompleteKnownPlaylistSongs(
    this: FavoritesStoreShape,
    listId: string | number | null | undefined,
  ): boolean {
    if (listId === undefined || listId === null || String(listId) === '') return false;
    return (
      localPlaylistSongsCache.has(String(listId)) &&
      localPlaylistSongsComplete.get(String(listId)) === true
    );
  },
  getKnownPlaylistSongs(
    this: FavoritesStoreShape,
    listId: string | number | null | undefined,
  ): Song[] {
    if (listId === undefined || listId === null || String(listId) === '') return [];
    return localPlaylistSongsCache.get(String(listId)) ?? [];
  },
  syncCloudFavorites(this: FavoritesStoreShape, songs: Song[]) {
    this.favorites = dedupeSongs(songs);
    this.favoritesLoaded = true;
    this.favoritesLoading = false;
  },
  async fetchLikedPlaylistSongs(this: FavoritesStoreShape) {
    const likedPlaylist = this.likedPlaylist;
    const likedQueryId = this.likedPlaylistQueryId;
    if (!likedPlaylist || !likedQueryId) {
      this.favorites = [];
      this.favoritesLoaded = true;
      this.favoritesLoading = false;
      return false;
    }

    if (favoritesLoader) {
      favoritesLoader.abort();
    }

    const queryId = String(likedQueryId);
    this.favoritesLoaded = false;
    this.favoritesLoading = true;

    const updateFavorites = (items: readonly Song[], loaded = false) => {
      this.favorites = dedupeSongs(items.slice());
      if (loaded) {
        this.favoritesLoaded = true;
        this.favoritesLoading = false;
      }
    };

    const loader = new PagedSongLoader<Song>(
      async (page, pageSize) => {
        const response = await getPlaylistTracks(queryId, page, pageSize);
        const { songs: pageSongs, filteredCount } = parsePlaylistTracks(response);
        const hasMore = pageSongs.length + filteredCount >= pageSize;
        return { items: pageSongs, hasMore };
      },
      {
        pageSize: FAVORITES_PAGE_SIZE,
        concurrency: 3,
        dedupeKey: (song) => String(song.id),
        logTag: 'FavoritesLoader',
        maxPages: 50,
        onPageLoaded: (allItems) => updateFavorites(allItems),
        onComplete: (allItems) => updateFavorites(allItems, true),
      },
    );

    favoritesLoader = loader;

    await loader.loadFirstPage();
    if (!loader.fullyLoaded) {
      void loader.loadRemaining();
    }

    return loader.count > 0;
  },
  async waitForFavoritesLoaded(this: FavoritesStoreShape): Promise<readonly Song[]> {
    if (favoritesLoader) {
      return favoritesLoader.waitForAll();
    }
    return this.favorites;
  },
  async addToPlaylist(
    this: FavoritesStoreShape,
    listId: string | number,
    song: Song,
  ): Promise<AddToPlaylistResult> {
    const targetId = String(listId ?? '');
    if (!targetId) return 'failed';

    try {
      let existingSongs = this.getKnownPlaylistSongs(targetId);
      if (existingSongs.some((item) => isSameSong(item, song))) {
        logger.info('PlaylistStore', `Song ${song.title} already exists in playlist ${targetId}`);
        return 'exists';
      }

      if (!this.hasCompleteKnownPlaylistSongs(targetId)) {
        const targetPlaylist = this.userPlaylists.find((playlist) =>
          includesPlaylistIdentity(playlist, targetId),
        );
        if ((targetPlaylist?.count ?? 0) <= 0) {
          this.rememberPlaylistSongs(targetId, [], true);
          existingSongs = [];
        } else {
          const loadedSongs = await loadPlaylistSongsForDuplicateCheck(targetId);
          if (loadedSongs) {
            this.rememberPlaylistSongs(targetId, loadedSongs, true);
            existingSongs = loadedSongs;
            if (existingSongs.some((item) => isSameSong(item, song))) {
              logger.info(
                'PlaylistStore',
                `Song ${song.title} already exists in playlist ${targetId}`,
              );
              return 'exists';
            }
          }
        }
      }

      const res = await addPlaylistTrack(targetId, buildPlaylistTrackPayload(song));
      if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
        if (this.hasCompleteKnownPlaylistSongs(targetId)) {
          this.rememberPlaylistSongs(targetId, [...existingSongs, song], true);
        }
        this.markPlaylistContentChanged(targetId, 'add', [song]);
        logger.info('PlaylistStore', `Song ${song.title} added to playlist ${targetId}`);
        return 'added';
      }
    } catch (e) {
      logger.error('PlaylistStore', 'Add to playlist error:', e);
    }
    return 'failed';
  },
  async removeFromPlaylist(this: FavoritesStoreShape, listId: string | number, song: Song) {
    const targetId = String(listId ?? '');
    if (!targetId) return false;

    try {
      const fileId = String(song.fileId ?? song.mixSongId ?? '');
      const res = await deletePlaylistTrack(targetId, fileId);
      if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
        this.forgetPlaylistSongs(targetId, [song]);
        this.markPlaylistContentChanged(targetId, 'remove', [song]);
        logger.info('PlaylistStore', `Song ${song.title} removed from playlist ${targetId}`);
        return true;
      }
    } catch (e) {
      logger.error('PlaylistStore', 'Remove from playlist error:', e);
    }
    return false;
  },
  async addSongsToPlaylist(
    this: FavoritesStoreShape,
    listId: string | number,
    songs: Song[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ successCount: number; failedCount: number }> {
    const targetId = String(listId ?? '');
    const total = songs.length;
    if (!targetId || total === 0) return { successCount: 0, failedCount: total };

    const existingSongs = this.getKnownPlaylistSongs(targetId);
    const dedupedSongs: Song[] = [];
    const seenIncoming = new Set<string>();
    songs.forEach((song) => {
      const key = resolveSongQueueKey(song);
      if (seenIncoming.has(key)) return;
      seenIncoming.add(key);
      if (existingSongs.some((item) => isSameSong(item, song))) return;
      dedupedSongs.push(song);
    });

    if (dedupedSongs.length === 0) {
      onProgress?.(total, total);
      logger.info('PlaylistStore', `Skip adding songs to playlist ${targetId}: all already exist`);
      return { successCount: 0, failedCount: 0 };
    }

    const MAX_PARAM_LEN = 4000;
    const encode = (value: string) => encodeURIComponent(value).length;
    const payloads = dedupedSongs.map((song) => buildPlaylistTrackPayload(song));

    const batches: Song[][] = [];
    let current: Song[] = [];
    let currentLen = 0;
    for (let index = 0; index < payloads.length; index += 1) {
      const payload = payloads[index];
      const payloadLen = encode(payload);
      const extra = current.length > 0 ? 1 + payloadLen : payloadLen;
      if (current.length > 0 && currentLen + extra > MAX_PARAM_LEN) {
        batches.push(current);
        current = [];
        currentLen = 0;
      }
      current.push(dedupedSongs[index]);
      currentLen += current.length === 1 ? payloadLen : extra;
    }
    if (current.length > 0) batches.push(current);

    let successCount = 0;
    let failedCount = 0;
    let done = 0;
    const addedSongs: Song[] = [];
    const skippedCount = total - dedupedSongs.length;
    onProgress?.(skippedCount, total);
    done = skippedCount;

    for (const batch of batches) {
      try {
        const res = await addPlaylistTrack(
          targetId,
          batch.map((song) => buildPlaylistTrackPayload(song)).join(','),
        );
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          successCount += batch.length;
          addedSongs.push(...batch);
        } else {
          failedCount += batch.length;
          logger.warn('PlaylistStore', 'Batch add partial failure:', res);
        }
      } catch (e) {
        failedCount += batch.length;
        logger.error('PlaylistStore', 'Batch add error:', e);
      }
      done += batch.length;
      onProgress?.(done, total);
    }

    if (addedSongs.length > 0) {
      if (this.hasCompleteKnownPlaylistSongs(targetId)) {
        this.rememberPlaylistSongs(targetId, [...existingSongs, ...addedSongs], true);
      }
      this.markPlaylistContentChanged(targetId, 'add', addedSongs);
    }

    return { successCount, failedCount };
  },
  async removeSongsFromPlaylist(
    this: FavoritesStoreShape,
    listId: string | number,
    songs: Song[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ successCount: number; failedCount: number }> {
    const targetId = String(listId ?? '');
    const total = songs.length;
    if (!targetId || total === 0) return { successCount: 0, failedCount: total };

    const MAX_PARAM_LEN = 4000;
    const fileIds = songs
      .map((song) => String(song.fileId ?? song.mixSongId ?? ''))
      .filter((id) => id && id !== '0');

    const removableSongs = songs.filter((song) => {
      const id = String(song.fileId ?? song.mixSongId ?? '');
      return id && id !== '0';
    });
    const batches: Song[][] = [];
    let current: string[] = [];
    let currentSongs: Song[] = [];
    let currentLen = 0;
    for (let index = 0; index < fileIds.length; index += 1) {
      const id = fileIds[index];
      const extra = current.length > 0 ? 1 + id.length : id.length;
      if (current.length > 0 && currentLen + extra > MAX_PARAM_LEN) {
        batches.push(currentSongs);
        current = [];
        currentSongs = [];
        currentLen = 0;
      }
      current.push(id);
      currentSongs.push(removableSongs[index]);
      currentLen += current.length === 1 ? id.length : extra;
    }
    if (current.length > 0) batches.push(currentSongs);

    let successCount = 0;
    let failedCount = 0;
    let done = 0;
    const removedSongs: Song[] = [];
    onProgress?.(0, total);

    for (const batch of batches) {
      try {
        const res = await deletePlaylistTrack(
          targetId,
          batch.map((song) => String(song.fileId ?? song.mixSongId ?? '')).join(','),
        );
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          successCount += batch.length;
          removedSongs.push(...batch);
        } else {
          failedCount += batch.length;
          logger.warn('PlaylistStore', 'Batch remove partial failure:', res);
        }
      } catch (e) {
        failedCount += batch.length;
        logger.error('PlaylistStore', 'Batch remove error:', e);
      }
      done += batch.length;
      onProgress?.(done, total);
    }

    if (removedSongs.length > 0) {
      this.forgetPlaylistSongs(targetId, removedSongs);
      this.markPlaylistContentChanged(targetId, 'remove', removedSongs);
    }

    return { successCount, failedCount };
  },
  async addToFavorites(this: FavoritesStoreShape, song: Song) {
    const likedPlaylist = await this.ensureLikedPlaylistReady();
    const listId = likedPlaylist.listId;
    const alreadyFavorited = this.isFavoriteSong(song);
    if (!alreadyFavorited) {
      this.favorites = [song, ...this.favorites];
    }

    if (listId) {
      try {
        const songData = `${song.title}|${song.hash}|${song.albumId || 0}|${song.mixSongId}`;
        const res = await addPlaylistTrack(listId, songData);
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          if (!alreadyFavorited) {
            const existingSongs = this.getKnownPlaylistSongs(listId);
            if (
              this.hasCompleteKnownPlaylistSongs(listId) &&
              !existingSongs.some((item) => isSameSong(item, song))
            ) {
              this.rememberPlaylistSongs(listId, [...existingSongs, song], true);
            }
            this.markPlaylistContentChanged(listId, 'add', [song]);
          }
          logger.info('PlaylistStore', `Song ${song.title} added to favorites on cloud`);
          return true;
        }
        if (!alreadyFavorited) {
          this.favorites = this.favorites.filter((item) => !isSameSong(item, song));
        }
        logger.warn('PlaylistStore', 'Add to favorites sync failed:', res);
        return false;
      } catch (e) {
        if (!alreadyFavorited) {
          this.favorites = this.favorites.filter((item) => !isSameSong(item, song));
        }
        logger.error('PlaylistStore', 'Add to favorites sync error:', e);
        return false;
      }
    }

    if (!alreadyFavorited) {
      this.favorites = this.favorites.filter((item) => !isSameSong(item, song));
    }
    return false;
  },
  async removeFromFavorites(this: FavoritesStoreShape, id: string) {
    const song = this.favorites.find((item) => String(item.id) === String(id));
    if (!song) return;

    const previousFavorites = this.favorites.slice();
    this.favorites = this.favorites.filter(
      (item) => !isSameSong(item, song) && String(item.id) !== String(id),
    );

    const likedPlaylist = await this.ensureLikedPlaylistReady();
    const listId = likedPlaylist.listId;
    if (listId) {
      try {
        const fileId = String(song.fileId ?? song.mixSongId ?? '');
        const res = await deletePlaylistTrack(listId, fileId);
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          this.forgetPlaylistSongs(listId, [song]);
          this.markPlaylistContentChanged(listId, 'remove', [song]);
          logger.info('PlaylistStore', `Song ${song.title} removed from favorites on cloud`);
          return true;
        }
        this.favorites = previousFavorites;
        logger.warn('PlaylistStore', 'Remove from favorites sync failed:', res);
        return false;
      } catch (e) {
        this.favorites = previousFavorites;
        logger.error('PlaylistStore', 'Remove from favorites sync error:', e);
        return false;
      }
    }
    this.favorites = previousFavorites;
    return false;
  },
  async removeFavoriteSong(this: FavoritesStoreShape, song: Song) {
    const matched = this.favorites.find(
      (item) => isSameSong(item, song) || String(item.id) === String(song.id),
    );

    const effectiveFileId = String(
      song.fileId ?? matched?.fileId ?? song.mixSongId ?? matched?.mixSongId ?? '',
    );

    const previousFavorites = this.favorites.slice();
    if (matched) {
      this.favorites = this.favorites.filter(
        (item) => !isSameSong(item, matched) && String(item.id) !== String(matched.id),
      );
    } else {
      this.favorites = this.favorites.filter(
        (item) => !isSameSong(item, song) && String(item.id) !== String(song.id),
      );
    }

    const likedPlaylist = await this.ensureLikedPlaylistReady();
    const listId = likedPlaylist.listId;
    if (!listId) {
      this.favorites = previousFavorites;
      return false;
    }

    try {
      const res = await deletePlaylistTrack(listId, effectiveFileId);
      if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
        const removedSong = matched ?? song;
        this.forgetPlaylistSongs(listId, [removedSong]);
        this.markPlaylistContentChanged(listId, 'remove', [removedSong]);
        logger.info('PlaylistStore', `Song ${song.title} removed from favorites on cloud`);
        return true;
      }
      this.favorites = previousFavorites;
      logger.warn('PlaylistStore', 'Remove from favorites sync failed:', res);
      return false;
    } catch (e) {
      this.favorites = previousFavorites;
      logger.error('PlaylistStore', 'Remove from favorites sync error:', e);
      return false;
    }
  },
};
