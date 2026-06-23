import type { Router } from 'vue-router';
import type { PlaylistMeta } from '@/models/playlist';
import type { Song } from '@/models/song';
import { useUserStore } from '@/stores/user';
import {
  buildShareText,
  isSongShareId,
  type ShareResourceType,
  type ShareTarget,
} from '../../shared/share';

export const SHARE_COPIED_EVENT = 'echomusic:share-copied';
export const SHARE_RESOLVE_ROUTE_NAME = 'share-resolve';
export const SHARE_DETAIL_QUERY_PREFIX = 'q.';

export interface ShareCopiedEventDetail {
  target: ShareTarget;
  text: string;
}

const cleanId = (value: unknown) => String(value ?? '').trim();

export const isSongHashId = isSongShareId;

const readNestedText = (record: Record<string, unknown> | undefined, key: string) => {
  const value = record?.[key];
  return typeof value === 'string' ? value.trim() : '';
};

export const getCurrentSharerName = () => {
  const userStore = useUserStore();
  const info = userStore.info;
  if (!info) return 'EchoMusic';

  const detail =
    info.detail && typeof info.detail === 'object'
      ? (info.detail as Record<string, unknown>)
      : undefined;
  const extendsDetail =
    info.extendsInfo?.detail && typeof info.extendsInfo.detail === 'object'
      ? (info.extendsInfo.detail as Record<string, unknown>)
      : undefined;

  return (
    info.nickname?.trim() ||
    info.username?.trim() ||
    info.userName?.trim() ||
    readNestedText(detail, 'nickname') ||
    readNestedText(detail, 'username') ||
    readNestedText(extendsDetail, 'nickname') ||
    readNestedText(extendsDetail, 'username') ||
    'EchoMusic'
  );
};

const normalizeShareQuery = (query: Record<string, unknown> | undefined) => {
  const result: Record<string, string> = {};
  if (!query) return result;
  Object.entries(query).forEach(([key, value]) => {
    const name = cleanId(key);
    const text = cleanId(value);
    if (name && text) result[name] = text;
  });
  return result;
};

export const createShareTarget = (
  type: ShareResourceType,
  id: string | number | null | undefined,
  title?: string,
  query?: Record<string, unknown>,
): ShareTarget | null => {
  const resolvedId = cleanId(id);
  if (!resolvedId) return null;
  const resolvedQuery = normalizeShareQuery(query);
  return {
    type,
    id: resolvedId,
    ...(title?.trim() ? { title: title.trim() } : {}),
    ...(Object.keys(resolvedQuery).length > 0 ? { query: resolvedQuery } : {}),
  };
};

export const createSongShareTarget = (song: Song): ShareTarget | null => {
  const title = song.name || '';
  const hash = cleanId(song.hash);
  if (!isSongHashId(hash)) return null;
  return createShareTarget('song', hash, title);
};

export const resolvePlaylistShareId = (
  meta: PlaylistMeta,
  fallbackId?: string | number | null,
): string | number | null => {
  if (meta.globalCollectionId?.startsWith('collection_')) return meta.globalCollectionId;
  if (meta.listCreateGid?.startsWith('collection_')) return meta.listCreateGid;
  if (meta.listCreateUserid && meta.listCreateListid) {
    return `collection_3_${meta.listCreateUserid}_${meta.listCreateListid}_0`;
  }
  if (meta.globalCollectionId) return meta.globalCollectionId;
  if (meta.listCreateGid) return meta.listCreateGid;
  return meta.listid ?? meta.id ?? fallbackId ?? null;
};

export const createPlaylistShareTarget = (
  meta: PlaylistMeta,
  fallbackId?: string | number | null,
): ShareTarget | null =>
  createShareTarget('playlist', resolvePlaylistShareId(meta, fallbackId), meta.name);

export const copyShareTarget = async (target: ShareTarget): Promise<boolean> => {
  const text = buildShareText({
    ...target,
    sharer: target.sharer || getCurrentSharerName(),
  });
  let copied = false;
  if (window.electron?.share?.copy) {
    copied = await window.electron.share.copy(text);
  } else {
    await navigator.clipboard.writeText(text);
    copied = true;
  }
  if (copied) {
    window.dispatchEvent(
      new CustomEvent<ShareCopiedEventDetail>(SHARE_COPIED_EVENT, {
        detail: { target, text },
      }),
    );
  }
  return copied;
};

export const buildShareResolveRoute = (target: ShareTarget) => {
  const id = cleanId(target.id);
  if (!id) return null;
  if (target.type === 'song' && !isSongHashId(id)) return null;

  const title = cleanId(target.title);
  const query: Record<string, string> = {
    type: target.type,
    id,
    ...(title ? { title } : {}),
  };

  Object.entries(normalizeShareQuery(target.query)).forEach(([key, value]) => {
    query[`${SHARE_DETAIL_QUERY_PREFIX}${key}`] = value;
  });

  return {
    name: SHARE_RESOLVE_ROUTE_NAME,
    query,
  };
};

export const readShareDetailQuery = (query: Record<string, unknown>) => {
  const result: Record<string, string> = {};
  Object.entries(query).forEach(([key, value]) => {
    if (!key.startsWith(SHARE_DETAIL_QUERY_PREFIX)) return;
    const name = key.slice(SHARE_DETAIL_QUERY_PREFIX.length).trim();
    const text = Array.isArray(value) ? cleanId(value[0]) : cleanId(value);
    if (name && text) result[name] = text;
  });
  return result;
};

export const navigateToShareTarget = (router: Router, target: ShareTarget) => {
  const route = buildShareResolveRoute(target);
  if (!route) return false;
  void router.push(route);
  return true;
};
