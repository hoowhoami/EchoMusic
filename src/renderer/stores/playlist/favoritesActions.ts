import { addPlaylistTrack, deletePlaylistTrack, getPlaylistTracksNew } from '@/api/playlist';
import { orderByPlaylistPosition } from '@/utils/playlistOrder';
import type { PlaylistMeta } from '@/models/playlist';
import type { Song } from '@/models/song';
import { parsePlaylistTracks } from '@/utils/mappers';
import { PagedSongLoader } from '@/utils/PagedSongLoader';
import { useUserStore } from '@/stores/user';
import { usePlaylistCoversStore } from '@/stores/playlistCovers';
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

const DUPLICATE_CHECK_PAGE_SIZE = 300;
const DUPLICATE_CHECK_MAX_PAGES = 50;

const waitForStableFavorites = async (
  loader: PagedSongLoader<Song>,
  fallback: () => readonly Song[],
): Promise<readonly Song[]> => {
  await loader.waitForAll();
  // 强制刷新可能替换正在等待的加载器；最终以合并本地操作后的 Store 为准。
  while (favoritesLoader?.loading) {
    await favoritesLoader.waitForAll();
  }
  return fallback();
};

const loadPlaylistSongsForDuplicateCheck = async (targetId: string): Promise<Song[] | null> => {
  const songs: Song[] = [];
  try {
    for (let page = 1; page <= DUPLICATE_CHECK_MAX_PAGES; page += 1) {
      const res = await getPlaylistTracksNew(targetId, page, DUPLICATE_CHECK_PAGE_SIZE);
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
  reportPersonalFmFeedback?: (
    action: 'click_red' | 'cancel_red',
    track?: Song | null,
  ) => Promise<number>;
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
  userCollectionsGeneration: number;
  userPlaylists: PlaylistMeta[];
};

type FavoriteChange = { action: 'add' | 'remove'; songs: readonly Song[] };
type FavoritesRuntime = {
  base?: Song[];
  pending: Set<FavoriteChange>;
  refresh?: FavoriteChange[];
};

const favoritesRuntimes = new WeakMap<FavoritesStoreShape, FavoritesRuntime>();
const getFavoritesRuntime = (store: FavoritesStoreShape): FavoritesRuntime => {
  let runtime = favoritesRuntimes.get(store);
  if (!runtime) {
    runtime = { pending: new Set() };
    favoritesRuntimes.set(store, runtime);
  }
  return runtime;
};

const applyFavoriteChange = (songs: Song[], change: FavoriteChange): Song[] => {
  if (change.action === 'remove') {
    return removeSongsFromKnownList(songs, Array.from(change.songs));
  }
  const added = change.songs.filter(
    (song) => !songs.some((item) => isSameSong(item, song) || String(item.id) === String(song.id)),
  );
  return dedupeSongs([...added, ...songs]);
};

const publishFavorites = (store: FavoritesStoreShape, songs: Song[]) => {
  const runtime = getFavoritesRuntime(store);
  // 待完成操作只覆盖展示状态，不混入服务端快照，失败时可按歌曲撤回。
  runtime.base = runtime.pending.size > 0 ? songs : undefined;
  store.favorites = Array.from(runtime.pending).reduce(applyFavoriteChange, songs);
};

const commitFavoriteChange = (store: FavoritesStoreShape, change: FavoriteChange) => {
  const runtime = getFavoritesRuntime(store);
  runtime.refresh?.push(change);
  publishFavorites(store, applyFavoriteChange(runtime.base ?? store.favorites, change));
};

const syncPlaylistFavorites = (
  store: FavoritesStoreShape,
  listId: string | number,
  action: FavoriteChange['action'],
  songs: readonly Song[],
) => {
  if (
    songs.length > 0 &&
    store.likedPlaylist &&
    includesPlaylistIdentity(store.likedPlaylist, String(listId))
  ) {
    commitFavoriteChange(store, { action, songs });
  }
};

const beginFavoriteChange = (store: FavoritesStoreShape, change: FavoriteChange) => {
  const runtime = getFavoritesRuntime(store);
  const generation = store.userCollectionsGeneration;
  const listId = store.likedPlaylistListId;
  const base = runtime.base ?? store.favorites;
  runtime.pending.add(change);
  publishFavorites(store, base);
  return (success: boolean): boolean => {
    if (
      favoritesRuntimes.get(store) !== runtime ||
      store.userCollectionsGeneration !== generation ||
      store.likedPlaylistListId !== listId
    )
      return false;
    const current = runtime.base ?? store.favorites;
    runtime.pending.delete(change);
    if (success) {
      runtime.refresh?.push(change);
      publishFavorites(store, applyFavoriteChange(current, change));
    } else {
      publishFavorites(store, current);
    }
    return true;
  };
};

export const favoritesActions = {
  resetUserCollections(this: FavoritesStoreShape) {
    this.userCollectionsGeneration += 1;
    favoritesRuntimes.delete(this);
    favoritesLoader?.abort();
    favoritesLoader = null;
    localPlaylistSongsCache.clear();
    localPlaylistSongsComplete.clear();
    this.favorites = [];
    this.favoritesLoaded = false;
    this.favoritesLoading = false;
    this.userPlaylists = [];
  },
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
    favoritesLoader?.abort();
    favoritesLoader = null;
    getFavoritesRuntime(this).refresh = undefined;
    publishFavorites(this, dedupeSongs(songs));
    this.favoritesLoaded = true;
    this.favoritesLoading = false;
  },
  async fetchLikedPlaylistSongs(this: FavoritesStoreShape, force = false) {
    // 页面热重载可能保留 loading 状态，只有仍在运行的加载器可以复用。
    if (!force && this.favoritesLoading && favoritesLoader?.loading) {
      return (await waitForStableFavorites(favoritesLoader, () => this.favorites)).length > 0;
    }

    const likedPlaylist = this.likedPlaylist;
    const likedListId = this.likedPlaylistListId;
    if (!likedPlaylist || !likedListId) {
      this.favorites = [];
      this.favoritesLoaded = true;
      this.favoritesLoading = false;
      return false;
    }

    if (favoritesLoader) {
      favoritesLoader.abort();
    }

    const requestGeneration = this.userCollectionsGeneration;
    const user = useUserStore();
    const accountId = user.info?.userid;
    const covers = usePlaylistCoversStore();
    const coverPages = new Map<number, unknown>();
    let coverUpdate: Promise<void> | undefined;
    const runtime = getFavoritesRuntime(this);
    const changes: FavoriteChange[] = [];
    runtime.refresh = changes;
    const previousFavorites = (runtime.base ?? this.favorites).slice();
    const previousFavoritesLoaded = this.favoritesLoaded;
    this.favoritesLoaded = false;
    this.favoritesLoading = true;
    const loader = new PagedSongLoader<Song>(
      async (page, pageSize) => {
        const response = await getPlaylistTracksNew(likedListId, page, pageSize);
        if (isCurrentLoader()) coverPages.set(page, response);
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
        onPageLoaded: (allItems) => {
          // 初次加载逐页展示；刷新已有完整列表时保留旧列表，避免缩回第一页。
          if (!previousFavoritesLoaded) updateFavorites(allItems, false);
        },
        onComplete: (allItems) => {
          if (!isCurrentLoader()) return;
          updateFavorites(allItems, true);
          coverUpdate = covers.updateFromPages(
            this.likedPlaylist ?? likedPlaylist,
            accountId,
            Array.from(coverPages)
              // 不让并发预取的越界页（info:null）使有效快照失效。
              .filter(([page]) => page <= loader.loadedPages)
              .sort(([left], [right]) => left - right)
              .map(([, response]) => response),
            isCurrentLoader,
          );
          coverPages.clear();
        },
        onError: () => {
          coverPages.clear();
          if (!isCurrentLoader()) return;
          if (previousFavoritesLoaded) {
            publishFavorites(this, changes.reduce(applyFavoriteChange, previousFavorites));
          }
          this.favoritesLoaded = previousFavoritesLoaded;
          this.favoritesLoading = false;
        },
      },
    );

    const isCurrentLoader = () =>
      favoritesLoader === loader &&
      this.userCollectionsGeneration === requestGeneration &&
      user.info?.userid === accountId &&
      this.likedPlaylistListId === likedListId;

    const updateFavorites = (items: readonly Song[], complete: boolean) => {
      if (!isCurrentLoader()) return;
      const ordered = dedupeSongs(orderByPlaylistPosition(items, (song) => song.playlistSort));
      publishFavorites(this, changes.reduce(applyFavoriteChange, ordered));
      this.favoritesLoaded = complete;
      if (complete) this.favoritesLoading = false;
    };

    favoritesLoader = loader;

    try {
      await loader.loadAll();
      await coverUpdate;
      return this.favorites.length > 0;
    } finally {
      coverPages.clear();
      if (runtime.refresh === changes) runtime.refresh = undefined;
      // 即使数据因账号/歌单变化而被丢弃，也要结束本次加载状态。
      // 新请求和账号重置后的状态由其各自的请求负责。
      if (favoritesLoader === loader && this.userCollectionsGeneration === requestGeneration) {
        this.favoritesLoading = false;
      }
    }
  },
  async waitForFavoritesLoaded(this: FavoritesStoreShape): Promise<readonly Song[]> {
    if (favoritesLoader) {
      return waitForStableFavorites(favoritesLoader, () => this.favorites);
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
        syncPlaylistFavorites(
          this,
          targetId,
          'add',
          existingSongs.filter((item) => isSameSong(item, song)),
        );
        logger.info('PlaylistStore', `Song ${song.name} already exists in playlist ${targetId}`);
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
              syncPlaylistFavorites(
                this,
                targetId,
                'add',
                existingSongs.filter((item) => isSameSong(item, song)),
              );
              logger.info(
                'PlaylistStore',
                `Song ${song.name} already exists in playlist ${targetId}`,
              );
              return 'exists';
            }
          }
        }
      }

      const res = await addPlaylistTrack(targetId, buildPlaylistTrackPayload(song));
      if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
        syncPlaylistFavorites(this, targetId, 'add', [song]);
        if (this.hasCompleteKnownPlaylistSongs(targetId)) {
          this.rememberPlaylistSongs(targetId, [...existingSongs, song], true);
        }
        this.markPlaylistContentChanged(targetId, 'add', [song]);
        logger.info('PlaylistStore', `Song ${song.name} added to playlist ${targetId}`);
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
        syncPlaylistFavorites(this, targetId, 'remove', [song]);
        this.forgetPlaylistSongs(targetId, [song]);
        this.markPlaylistContentChanged(targetId, 'remove', [song]);
        logger.info('PlaylistStore', `Song ${song.name} removed from playlist ${targetId}`);
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
    syncPlaylistFavorites(
      this,
      targetId,
      'add',
      existingSongs.filter((item) => songs.some((song) => isSameSong(item, song))),
    );
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
          syncPlaylistFavorites(this, targetId, 'add', batch);
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
          syncPlaylistFavorites(this, targetId, 'remove', batch);
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
    if (!listId) return false;
    const finish = beginFavoriteChange(this, { action: 'add', songs: [song] });

    try {
      const songData = `${song.name}|${song.hash}|${song.albumId || 0}|${song.mixSongId}`;
      const res = await addPlaylistTrack(listId, songData);
      if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
        if (!finish(true)) return false;
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
        logger.info('PlaylistStore', `Song ${song.name} added to favorites on cloud`);
        if (!alreadyFavorited) void this.reportPersonalFmFeedback?.('click_red', song);
        return true;
      }
      finish(false);
      logger.warn('PlaylistStore', 'Add to favorites sync failed:', res);
      return false;
    } catch (e) {
      finish(false);
      logger.error('PlaylistStore', 'Add to favorites sync error:', e);
      return false;
    }
  },
  async removeFromFavorites(this: FavoritesStoreShape, id: string) {
    const song = this.favorites.find((item) => String(item.id) === String(id));
    if (!song) return;

    return favoritesActions.removeFavoriteSong.call(this, song);
  },
  async removeFavoriteSong(this: FavoritesStoreShape, song: Song) {
    const matched = this.favorites.find(
      (item) => isSameSong(item, song) || String(item.id) === String(song.id),
    );

    const effectiveFileId = String(
      song.fileId ?? matched?.fileId ?? song.mixSongId ?? matched?.mixSongId ?? '',
    );

    const likedPlaylist = await this.ensureLikedPlaylistReady();
    const listId = likedPlaylist.listId;
    if (!listId) return false;
    const removedSong = matched ?? song;
    const finish = beginFavoriteChange(this, { action: 'remove', songs: [removedSong] });

    try {
      const res = await deletePlaylistTrack(listId, effectiveFileId);
      if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
        if (!finish(true)) return false;
        this.forgetPlaylistSongs(listId, [removedSong]);
        this.markPlaylistContentChanged(listId, 'remove', [removedSong]);
        logger.info('PlaylistStore', `Song ${song.name} removed from favorites on cloud`);
        void this.reportPersonalFmFeedback?.('cancel_red', removedSong);
        return true;
      }
      finish(false);
      logger.warn('PlaylistStore', 'Remove from favorites sync failed:', res);
      return false;
    } catch (e) {
      finish(false);
      logger.error('PlaylistStore', 'Remove from favorites sync error:', e);
      return false;
    }
  },
};
