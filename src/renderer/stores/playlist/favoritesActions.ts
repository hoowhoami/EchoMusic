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
  removeSongsFromKnownList,
  resolveFavoriteSongKey,
  resolveSongQueueKey,
} from './helpers';

let favoritesLoader: PagedSongLoader<Song> | null = null;
const localPlaylistSongsCache = new Map<string, Song[]>();

type FavoritesStoreShape = {
  ensureLikedPlaylistReady: () => Promise<{
    queryId: string | number | null;
    listId: number | null;
  }>;
  favoriteSongKeySet: Set<string>;
  favorites: Song[];
  fetchUserPlaylists: () => Promise<void>;
  getKnownPlaylistSongs: (listId: string | number | null | undefined) => Song[];
  isFavoriteSong: (song: Song) => boolean;
  likedPlaylist: PlaylistMeta | undefined;
  likedPlaylistListId: number | null;
  likedPlaylistQueryId: string | number | null;
  rememberPlaylistSongs: (
    listId: string | number | null | undefined,
    songs: readonly Song[],
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
  ) {
    if (listId === undefined || listId === null || String(listId) === '') return;
    localPlaylistSongsCache.set(String(listId), dedupeSongs(Array.from(songs) as Song[]));
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
      return;
    }
    const current = localPlaylistSongsCache.get(key) ?? [];
    localPlaylistSongsCache.set(
      key,
      removeSongsFromKnownList(current, Array.from(songs) as Song[]),
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
  },
  async fetchLikedPlaylistSongs(this: FavoritesStoreShape) {
    const likedPlaylist = this.likedPlaylist;
    const likedQueryId = this.likedPlaylistQueryId;
    if (!likedPlaylist || !likedQueryId) {
      this.favorites = [];
      return false;
    }

    if (favoritesLoader) {
      favoritesLoader.abort();
    }

    const queryId = String(likedQueryId);
    const updateFavorites = (items: readonly Song[]) => {
      this.favorites = dedupeSongs(items.slice());
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
        onComplete: (allItems) => updateFavorites(allItems),
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
  async addToPlaylist(this: FavoritesStoreShape, listId: string | number, song: Song) {
    const targetId = String(listId ?? '');
    if (!targetId) return false;

    try {
      const existingSongs = this.getKnownPlaylistSongs(targetId);
      if (existingSongs.some((item) => isSameSong(item, song))) {
        logger.info('PlaylistStore', `Song ${song.title} already exists in playlist ${targetId}`);
        return true;
      }
      const res = await addPlaylistTrack(targetId, buildPlaylistTrackPayload(song));
      if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
        if (existingSongs.length > 0) {
          this.rememberPlaylistSongs(targetId, [...existingSongs, song]);
        }
        logger.info('PlaylistStore', `Song ${song.title} added to playlist ${targetId}`);
        return true;
      }
    } catch (e) {
      logger.error('PlaylistStore', 'Add to playlist error:', e);
    }
    return false;
  },
  async removeFromPlaylist(this: FavoritesStoreShape, listId: string | number, song: Song) {
    const targetId = String(listId ?? '');
    if (!targetId) return false;

    try {
      const fileId = String(song.fileId ?? song.mixSongId ?? '');
      const res = await deletePlaylistTrack(targetId, fileId);
      if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
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

    const batches: string[][] = [];
    let current: string[] = [];
    let currentLen = 0;
    for (const payload of payloads) {
      const payloadLen = encode(payload);
      const extra = current.length > 0 ? 1 + payloadLen : payloadLen;
      if (current.length > 0 && currentLen + extra > MAX_PARAM_LEN) {
        batches.push(current);
        current = [];
        currentLen = 0;
      }
      current.push(payload);
      currentLen += current.length === 1 ? payloadLen : extra;
    }
    if (current.length > 0) batches.push(current);

    let successCount = 0;
    let failedCount = 0;
    let done = 0;
    const skippedCount = total - dedupedSongs.length;
    onProgress?.(skippedCount, total);
    done = skippedCount;

    for (const batch of batches) {
      try {
        const res = await addPlaylistTrack(targetId, batch.join(','));
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          successCount += batch.length;
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

    if (successCount > 0 && existingSongs.length > 0) {
      this.rememberPlaylistSongs(targetId, [...existingSongs, ...dedupedSongs]);
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

    const batches: string[][] = [];
    let current: string[] = [];
    let currentLen = 0;
    for (const id of fileIds) {
      const extra = current.length > 0 ? 1 + id.length : id.length;
      if (current.length > 0 && currentLen + extra > MAX_PARAM_LEN) {
        batches.push(current);
        current = [];
        currentLen = 0;
      }
      current.push(id);
      currentLen += current.length === 1 ? id.length : extra;
    }
    if (current.length > 0) batches.push(current);

    let successCount = 0;
    let failedCount = 0;
    let done = 0;
    onProgress?.(0, total);

    for (const batch of batches) {
      try {
        const res = await deletePlaylistTrack(targetId, batch.join(','));
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          successCount += batch.length;
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
