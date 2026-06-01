import { addPlaylist, deletePlaylist, getUserPlaylists } from '@/api/playlist';
import type { PlaylistMeta } from '@/models/playlist';
import logger from '@/utils/logger';
import { mapPlaylistMeta } from '@/utils/mappers';
import { includesPlaylistIdentity } from './helpers';

type UserActionsStoreShape = {
  fetchLikedPlaylistSongs: () => Promise<boolean>;
  fetchUserPlaylists: () => Promise<void>;
  findPlaylistByIdentity: (id: string | number | null | undefined) => PlaylistMeta | undefined;
  resolveNumericListId: (id: string | number | null | undefined) => string | number | null;
  userPlaylists: PlaylistMeta[];
};

export const userActions = {
  findPlaylistByIdentity(this: UserActionsStoreShape, id: string | number | null | undefined) {
    if (id === undefined || id === null || String(id) === '') return undefined;
    const target = String(id);
    return this.userPlaylists.find((playlist) => includesPlaylistIdentity(playlist, target));
  },
  isFavoriteAlbum(this: UserActionsStoreShape, albumId: string | number | null | undefined) {
    if (albumId === undefined || albumId === null || String(albumId) === '') return false;
    const target = String(albumId);
    return this.userPlaylists.some(
      (playlist) => playlist.source === 2 && includesPlaylistIdentity(playlist, target),
    );
  },
  isOwnedPlaylist(
    this: UserActionsStoreShape,
    listId: string | number | null | undefined,
    currentUserId?: number,
  ) {
    if (!currentUserId) return false;
    const matched = this.findPlaylistByIdentity(listId);
    return !!matched && matched.listCreateUserid === currentUserId && matched.source !== 2;
  },
  getCreatedPlaylists(this: UserActionsStoreShape, currentUserId?: number) {
    if (!currentUserId) return [] as PlaylistMeta[];
    return this.userPlaylists.filter(
      (playlist) => playlist.listCreateUserid === currentUserId && playlist.source !== 2,
    );
  },
  resolveNumericListId(
    this: UserActionsStoreShape,
    id: string | number | null | undefined,
  ): string | number | null {
    if (id === undefined || id === null || String(id) === '') return null;
    const target = String(id);
    const matched = this.findPlaylistByIdentity(target);
    if (!matched) return id;
    return matched.listid || matched.id || id;
  },
  async fetchUserPlaylists(this: UserActionsStoreShape) {
    try {
      const PAGE_SIZE = 30;
      let page = 1;
      let allPlaylists: PlaylistMeta[] = [];
      while (true) {
        const res = await getUserPlaylists(page, PAGE_SIZE);
        if (!res || typeof res !== 'object' || !('status' in res) || res.status !== 1) break;
        const data = 'data' in res ? (res as { data?: { info?: unknown } }).data : undefined;
        const info = 'info' in res ? (res as { info?: unknown }).info : undefined;
        const raw = data?.info ?? info ?? [];
        if (!Array.isArray(raw) || raw.length === 0) break;
        allPlaylists = allPlaylists.concat(raw.map((item) => mapPlaylistMeta(item)));
        if (raw.length < PAGE_SIZE) break;
        page++;
      }
      this.userPlaylists = allPlaylists;
      await this.fetchLikedPlaylistSongs();
    } catch (e) {
      logger.error('PlaylistStore', 'Fetch user playlists error:', e);
    }
  },
  async createPlaylist(
    this: UserActionsStoreShape,
    name: string,
    isPrivate = false,
    currentUserId?: number,
  ) {
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
  async createPlaylistAndReturnId(
    this: UserActionsStoreShape,
    name: string,
    isPrivate = false,
    currentUserId?: number,
  ): Promise<number | null> {
    if (!currentUserId) return null;
    try {
      const res = await addPlaylist(name, {
        is_pri: isPrivate ? 1 : 0,
        type: 0,
        list_create_userid: currentUserId,
        source: 1,
      });
      if (!res || typeof res !== 'object' || !('status' in res) || res.status !== 1) {
        return null;
      }
      const data = (res as { data?: unknown }).data;
      const directId =
        data && typeof data === 'object' && 'listid' in data
          ? Number((data as { listid?: unknown }).listid)
          : NaN;
      await this.fetchUserPlaylists();
      if (Number.isFinite(directId) && directId > 0) {
        return directId;
      }
      const candidates = this.userPlaylists.filter(
        (playlist) =>
          playlist.name === name &&
          (playlist.listCreateUserid === currentUserId ||
            playlist.listCreateUserid === undefined) &&
          playlist.source !== 2,
      );
      if (candidates.length === 0) return null;
      candidates.sort((left, right) => (right.createTime ?? 0) - (left.createTime ?? 0));
      const found = candidates[0];
      return found.listid ?? (typeof found.id === 'number' ? found.id : null);
    } catch (e) {
      logger.error('PlaylistStore', 'Create playlist (returnId) error:', e);
      return null;
    }
  },
  async deleteOwnedPlaylist(
    this: UserActionsStoreShape,
    listId: string | number | null | undefined,
  ) {
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
  async favoritePlaylist(this: UserActionsStoreShape, meta: PlaylistMeta, currentUserId?: number) {
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
  async favoriteAlbum(
    this: UserActionsStoreShape,
    meta: { id: string | number; name: string; singerId?: number },
  ) {
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
  async unfavoriteAlbum(this: UserActionsStoreShape, albumId: string | number) {
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
  async unfavoritePlaylist(
    this: UserActionsStoreShape,
    meta: PlaylistMeta,
    currentUserId?: number,
  ) {
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
};
