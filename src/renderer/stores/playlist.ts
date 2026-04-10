import { defineStore } from 'pinia';
import {
  getUserPlaylists,
  getPlaylistTracks,
  addPlaylistTrack,
  deletePlaylistTrack,
  addPlaylist,
  deletePlaylist,
} from '@/api/playlist';
import logger from '@/utils/logger';
import { mapPlaylistMeta } from '@/utils/mappers';
import { parsePlaylistTracks } from '@/utils/mappers';
import type { PlaylistMeta } from '@/models/playlist';
import type { Song } from '@/models/song';
import { isSameSong } from '@/utils/song';

export type { Song, SongRelateGood, SongArtist } from '@/models/song';
export type { PlaylistInfo } from '@/models/playlist';

const normalizePlaylistName = (value: string | undefined): string => String(value ?? '').trim();

const getPlaylistIdentityValues = (playlist: PlaylistMeta): string[] => {
  return [
    playlist.id,
    playlist.listid,
    playlist.listCreateGid,
    playlist.globalCollectionId,
    playlist.listCreateListid,
  ]
    .filter((value) => value !== undefined && value !== null && String(value) !== '')
    .map((value) => String(value));
};

const findLikedPlaylist = (playlists: PlaylistMeta[]): PlaylistMeta | undefined => {
  let index = playlists.findIndex((playlist) => {
    const name = normalizePlaylistName(playlist.name);
    return name === '我喜欢的音乐';
  });

  if (index === -1) {
    index = playlists.findIndex((playlist) =>
      normalizePlaylistName(playlist.name).includes('喜欢'),
    );
  }

  if (index === -1) {
    index = playlists.findIndex((playlist) => playlist.type === 1 || playlist.isDefault === true);
  }

  if (index === -1) {
    index = playlists.findIndex((playlist) => normalizePlaylistName(playlist.name) === '默认收藏');
  }

  return index === -1 ? undefined : playlists[index];
};

const dedupeSongs = (songs: Song[]): Song[] => {
  const seen = new Set<string>();
  return songs.filter((song) => {
    const key =
      String(song.mixSongId ?? '0') !== '0'
        ? `mx:${String(song.mixSongId)}`
        : song.hash
          ? `hash:${song.hash.toLowerCase()}`
          : `id:${String(song.id)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const includesPlaylistIdentity = (playlist: PlaylistMeta, id: string): boolean => {
  return getPlaylistIdentityValues(playlist).includes(id);
};

const FAVORITES_PAGE_SIZE = 200;

export const usePlaylistStore = defineStore('playlist', {
  state: () => ({
    defaultList: [] as Song[],
    favorites: [] as Song[],
    userPlaylists: [] as PlaylistMeta[],
    queueFilteredInvalidCount: 0,
    queuedNextTrackIds: [] as string[],
  }),
  getters: {
    likedPlaylist(state) {
      return findLikedPlaylist(state.userPlaylists);
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
  },
  actions: {
    async ensureLikedPlaylistReady() {
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
    isFavoriteSong(song: Song) {
      return this.favorites.some(
        (item) => isSameSong(item, song) || String(item.id) === String(song.id),
      );
    },
    findPlaylistByIdentity(id: string | number | null | undefined) {
      if (id === undefined || id === null || String(id) === '') return undefined;
      const target = String(id);
      return this.userPlaylists.find((playlist) => includesPlaylistIdentity(playlist, target));
    },
    isFavoriteAlbum(albumId: string | number | null | undefined) {
      if (albumId === undefined || albumId === null || String(albumId) === '') return false;
      const target = String(albumId);
      return this.userPlaylists.some(
        (playlist) => playlist.source === 2 && includesPlaylistIdentity(playlist, target),
      );
    },
    isOwnedPlaylist(listId: string | number | null | undefined, currentUserId?: number) {
      if (!currentUserId) return false;
      const matched = this.findPlaylistByIdentity(listId);
      return !!matched && matched.listCreateUserid === currentUserId && matched.source !== 2;
    },
    getCreatedPlaylists(currentUserId?: number) {
      if (!currentUserId) return [] as PlaylistMeta[];
      return this.userPlaylists.filter(
        (playlist) => playlist.listCreateUserid === currentUserId && playlist.source !== 2,
      );
    },
    resolveNumericListId(id: string | number | null | undefined): string | number | null {
      if (id === undefined || id === null || String(id) === '') return null;
      const target = String(id);
      const matched = this.findPlaylistByIdentity(target);
      if (!matched) return id;
      return matched.listid || matched.id || id;
    },
    syncCloudFavorites(songs: Song[]) {
      this.favorites = dedupeSongs(songs);
    },
    async fetchLikedPlaylistSongs() {
      const likedPlaylist = this.likedPlaylist;
      const likedQueryId = this.likedPlaylistQueryId;
      if (!likedPlaylist || !likedQueryId) {
        this.favorites = [];
        return false;
      }

      const songs: Song[] = [];

      try {
        let page = 1;
        const seenIds = new Set<string>();

        while (true) {
          const response = await getPlaylistTracks(String(likedQueryId), page, FAVORITES_PAGE_SIZE);
          const { songs: pageSongs, filteredCount } = parsePlaylistTracks(response);

          if (pageSongs.length === 0 && filteredCount === 0) break;

          const nextSongs = pageSongs.filter((song) => {
            const sid = String(song.id);
            if (seenIds.has(sid)) return false;
            seenIds.add(sid);
            return true;
          });

          songs.push(...nextSongs);

          if (pageSongs.length + filteredCount < FAVORITES_PAGE_SIZE) break;

          if (page >= 50) break;
          page += 1;
        }
      } catch (error) {
        logger.warn('PlaylistStore', 'Fetch liked playlist songs failed:', error);
      }

      this.syncCloudFavorites(songs);
      return songs.length > 0;
    },
    setPlaybackQueue(songs: Song[], filteredInvalidCount = 0) {
      this.defaultList = songs.slice();
      this.queueFilteredInvalidCount = Math.max(0, filteredInvalidCount);
      this.queuedNextTrackIds = [];
    },
    clearPlaybackQueue() {
      this.defaultList = [];
      this.queueFilteredInvalidCount = 0;
      this.queuedNextTrackIds = [];
    },
    enqueuePlayNext(songId: string | number) {
      const id = String(songId ?? '');
      if (!id) return;
      this.queuedNextTrackIds = this.queuedNextTrackIds.filter((item) => item !== id);
      this.queuedNextTrackIds.unshift(id);
    },
    consumeQueuedNextTrackId(songId: string | number) {
      const id = String(songId ?? '');
      if (!id || this.queuedNextTrackIds.length === 0) return;
      this.queuedNextTrackIds = this.queuedNextTrackIds.filter((item) => item !== id);
    },
    peekQueuedNextTrackId(): string | null {
      return this.queuedNextTrackIds[0] ?? null;
    },
    syncQueuedNextTrackIds() {
      if (this.queuedNextTrackIds.length === 0) return;
      const validIds = new Set(this.defaultList.map((song) => String(song.id)));
      this.queuedNextTrackIds = this.queuedNextTrackIds.filter((id) => validIds.has(id));
    },
    removeFromQueue(songId: string | number) {
      const id = String(songId ?? '');
      this.defaultList = this.defaultList.filter((song) => String(song.id) !== id);
      this.consumeQueuedNextTrackId(id);
    },
    reorderPlaybackQueue(fromIndex: number, toIndex: number) {
      if (fromIndex === toIndex) return;
      if (fromIndex < 0 || fromIndex >= this.defaultList.length) return;

      const nextList = this.defaultList.slice();
      const [movedSong] = nextList.splice(fromIndex, 1);
      if (!movedSong) return;

      const normalizedTarget = Math.max(0, Math.min(toIndex, nextList.length));
      nextList.splice(normalizedTarget, 0, movedSong);
      this.defaultList = nextList;
    },
    async addToPlaylist(listId: string | number, song: Song) {
      const targetId = String(listId ?? '');
      if (!targetId) return false;

      try {
        const songData = `${song.title}|${song.hash}|${song.albumId || 0}|${song.mixSongId}`;
        const res = await addPlaylistTrack(targetId, songData);
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          logger.info('PlaylistStore', `Song ${song.title} added to playlist ${targetId}`);
          return true;
        }
      } catch (e) {
        logger.error('PlaylistStore', 'Add to playlist error:', e);
      }
      return false;
    },
    async removeFromPlaylist(listId: string | number, song: Song) {
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
    async addToFavorites(song: Song) {
      const likedPlaylist = await this.ensureLikedPlaylistReady();
      const listId = likedPlaylist.listId;
      const alreadyFavorited = this.isFavoriteSong(song);
      if (!alreadyFavorited) {
        this.favorites.unshift(song);
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
    async removeFromFavorites(id: string) {
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
    async removeFavoriteSong(song: Song) {
      const matched = this.favorites.find(
        (item) => isSameSong(item, song) || String(item.id) === String(song.id),
      );
      if (!matched) return;
      return this.removeFromFavorites(String(matched.id));
    },
    async fetchUserPlaylists() {
      try {
        const PAGE_SIZE = 30;
        let page = 1;
        let allPlaylists: PlaylistMeta[] = [];
        // 分页获取所有歌单
        while (true) {
          const res = await getUserPlaylists(page, PAGE_SIZE);
          if (!res || typeof res !== 'object' || !('status' in res) || res.status !== 1) break;
          const data = 'data' in res ? (res as { data?: { info?: unknown } }).data : undefined;
          const info = 'info' in res ? (res as { info?: unknown }).info : undefined;
          const raw = data?.info ?? info ?? [];
          if (!Array.isArray(raw) || raw.length === 0) break;
          allPlaylists = allPlaylists.concat(raw.map((item) => mapPlaylistMeta(item)));
          // 不足一页说明已经是最后一页
          if (raw.length < PAGE_SIZE) break;
          page++;
        }
        this.userPlaylists = allPlaylists;
        await this.fetchLikedPlaylistSongs();
      } catch (e) {
        logger.error('PlaylistStore', 'Fetch user playlists error:', e);
      }
    },
    async createPlaylist(name: string, isPrivate = false, currentUserId?: number) {
      if (!currentUserId) return false;
      try {
        const res = await addPlaylist(name, {
          is_pri: isPrivate ? 1 : 0,
          type: 0,
          list_create_userid: currentUserId,
          source: 1,
        });
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          await this.fetchUserPlaylists();
          return true;
        }
      } catch (e) {
        logger.error('PlaylistStore', 'Create playlist error:', e);
      }
      return false;
    },
    async deleteOwnedPlaylist(listId: string | number | null | undefined) {
      if (listId === undefined || listId === null || String(listId) === '') return false;
      try {
        const targetId = this.resolveNumericListId(listId);
        if (targetId === null) return false;
        const res = await deletePlaylist(targetId);
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          await this.fetchUserPlaylists();
          return true;
        }
      } catch (e) {
        logger.error('PlaylistStore', 'Delete owned playlist error:', e);
      }
      return false;
    },
    async favoritePlaylist(meta: PlaylistMeta, currentUserId?: number) {
      if (currentUserId && meta.listCreateUserid === currentUserId) return false;
      try {
        const res = await addPlaylist(meta.name, {
          type: 1,
          list_create_userid: meta.listCreateUserid,
          list_create_listid: meta.listCreateListid ?? meta.id,
          list_create_gid: meta.listCreateGid ?? meta.globalCollectionId,
          source: meta.source ?? 1,
        });
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          await this.fetchUserPlaylists();
          return true;
        }
      } catch (e) {
        logger.error('PlaylistStore', 'Favorite playlist error:', e);
      }
      return false;
    },
    async favoriteAlbum(meta: { id: string | number; name: string; singerId?: number }) {
      try {
        const res = await addPlaylist(meta.name, {
          type: 1,
          list_create_userid: meta.singerId,
          list_create_listid: Number(meta.id),
          source: 2,
        });
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          await this.fetchUserPlaylists();
          return true;
        }
      } catch (e) {
        logger.error('PlaylistStore', 'Favorite album error:', e);
      }
      return false;
    },
    async unfavoriteAlbum(albumId: string | number) {
      try {
        const targetId = String(albumId);
        const target = this.userPlaylists.find(
          (playlist) => playlist.source === 2 && includesPlaylistIdentity(playlist, targetId),
        );
        const listId = target?.listid ?? target?.id;
        if (!listId) return false;
        const res = await deletePlaylist(listId);
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          await this.fetchUserPlaylists();
          return true;
        }
      } catch (e) {
        logger.error('PlaylistStore', 'Unfavorite album error:', e);
      }
      return false;
    },
    async unfavoritePlaylist(meta: PlaylistMeta, currentUserId?: number) {
      try {
        const target = this.userPlaylists.find((playlist) => {
          if (playlist.source === 2) return false;
          if (currentUserId && playlist.listCreateUserid === currentUserId) return false;
          const localId = String(playlist.listid ?? playlist.id);
          const originalId = String(playlist.listCreateGid ?? playlist.globalCollectionId ?? '');
          const originalListId = String(playlist.listCreateListid ?? '');
          const currentIds = [
            String(meta.id),
            String(meta.listid ?? ''),
            String(meta.listCreateListid ?? ''),
            String(meta.listCreateGid ?? ''),
            String(meta.globalCollectionId ?? ''),
          ];
          return (
            currentIds.includes(localId) ||
            (originalId && currentIds.includes(originalId)) ||
            (originalListId && currentIds.includes(originalListId))
          );
        });

        const listId = target?.listid ?? target?.id;
        if (!listId) return false;
        const res = await deletePlaylist(listId);
        if (res && typeof res === 'object' && 'status' in res && res.status === 1) {
          await this.fetchUserPlaylists();
          return true;
        }
      } catch (e) {
        logger.error('PlaylistStore', 'Unfavorite playlist error:', e);
      }
      return false;
    },
  },
  persist: true,
});
