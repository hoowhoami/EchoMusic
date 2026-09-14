import type { PlaylistMeta } from '@/models/playlist';
import { toRecord } from '../../shared/object';
import { mapPlaylistSong } from './mappers/song';
import { resolveOwnedPlaylistListId } from './playlistTrackSource';

export interface PlaylistCoverEntry {
  listVer: number;
  coverUrl: string;
  selection?: 'sort';
}

export function manualPlaylistCoverKey(playlist: PlaylistMeta, userId: number | undefined) {
  const listid = Number(playlist.listid);
  const type = playlist.type ?? 0;
  if (
    !userId ||
    !Number.isSafeInteger(listid) ||
    listid <= 0 ||
    playlist.source === 2 ||
    (type !== 0 && type !== 1) ||
    (type === 0 && !playlistCoverKey(playlist, userId))
  )
    return null;
  return `manual:${userId}:${type}:${listid}`;
}

export const readPlaylistVersion = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const version = Number(value);
  return Number.isSafeInteger(version) && version >= 0 ? version : undefined;
};

export const readPlaylistPageVersion = (response: unknown) => {
  const body = toRecord(response);
  const data = toRecord(body.data ?? body);
  return readPlaylistVersion(data.list_ver ?? toRecord(data.list_info).list_ver ?? body.list_ver);
};

export function playlistCoverKey(playlist: PlaylistMeta, userId: number | undefined) {
  if (playlist.type === 1 || playlist.source === 2) return null;
  const listid = resolveOwnedPlaylistListId(playlist.id, { ...playlist, currentUserId: userId });
  return listid === null ? null : `${userId}:${listid}`;
}

/** 只在完整且版本一致的分页数据上选择封面，不改变歌曲排序。 */
export function buildPlaylistCoverEntry(pages: readonly unknown[]): PlaylistCoverEntry | null {
  const listVer = readPlaylistPageVersion(pages[0]);
  if (listVer === undefined) return null;
  let count: number | undefined;
  let received = 0;
  let coverUrl = '';
  let firstPosition = Infinity;
  for (const response of pages) {
    const body = toRecord(response);
    if (body.status != null ? Number(body.status) !== 1 : Number(body.error_code) !== 0)
      return null;
    const data = toRecord(body.data ?? body);
    const version = readPlaylistPageVersion(response);
    if (version !== undefined && version !== listVer) return null;
    if (Number(data.is_custom_pic ?? toRecord(data.list_info).is_custom_pic) === 1) return null;
    const pageCount = readPlaylistVersion(data.count ?? data.total ?? body.count);
    if (count !== undefined && pageCount !== undefined && count !== pageCount) return null;
    count ??= pageCount;
    const rows =
      [data.info, data.songs, data.list, body.info].find(Array.isArray) ??
      (pageCount === 0 && data.info === null ? [] : undefined);
    if (!Array.isArray(rows)) return null;
    received += rows.length;
    for (const row of rows) {
      const song = mapPlaylistSong(row);
      const url = (song.coverUrl || song.cover || '').trim();
      if (!/^https?:\/\//i.test(url)) continue;
      const position = song.playlistSort ?? Infinity;
      // 与歌曲列表的 sort 升序一致；相同或缺失位置时保留接口分页顺序。
      if (!coverUrl || position < firstPosition) {
        firstPosition = position;
        coverUrl = url;
      }
    }
  }
  if (count === undefined || received !== count) return null;
  return { listVer, coverUrl };
}
