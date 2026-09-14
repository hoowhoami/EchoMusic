import {
  getPlaylistDetail,
  getUserPlaylists,
  uploadPlaylistCover,
  updatePlaylistInfo,
} from '@/api/playlist';
import type { PlaylistMeta } from '@/models/playlist';
import { mapPlaylistMeta } from '@/utils/mappers';
import { readOrderPage } from './playlistOrdering';
import { toRecord } from '../../shared/object';
import { serializePlaylistTags } from '@/utils/playlistTags';

export interface PlaylistEditSnapshot {
  playlist: PlaylistMeta;
  listid: number;
  type: 0 | 1;
  totalVer: number;
  sort: number;
}
export interface PlaylistInfoDraft {
  name: string;
  tags: string;
  intro: string;
}

const assertCurrent = (isCurrent: () => boolean) => {
  if (!isCurrent()) throw new Error('账号或歌单已变化，请重新打开');
};

export function canEditPlaylist(target: PlaylistMeta): boolean {
  const listid = Number(target.listid ?? target.id);
  const type = target.type ?? 0;
  return (
    Number.isSafeInteger(listid) &&
    listid > 0 &&
    (type === 0 || type === 1) &&
    target.source !== 2 &&
    target.isDefault !== true
  );
}

const assertEditable = (target: PlaylistMeta) => {
  if (!canEditPlaylist(target)) throw new Error('该歌单不支持修改信息或封面');
};

export async function loadPlaylistEdit(
  target: PlaylistMeta,
  isCurrent: () => boolean,
): Promise<PlaylistEditSnapshot> {
  assertEditable(target);
  const listid = Number(target.listid ?? target.id);
  const type = target.type === 1 ? 1 : 0;
  let totalVer: number | null = null;
  for (let page = 1; page <= 500; page++) {
    assertCurrent(isCurrent);
    const result = readOrderPage(await getUserPlaylists(page, 200), 'playlists');
    assertCurrent(isCurrent);
    if (totalVer !== null && totalVer !== result.version)
      throw new Error('歌单列表已变化，请重新加载');
    totalVer = result.version;
    const raw = result.raw.find(
      (row) => Number(row.listid) === listid && Number(row.type ?? 0) === type,
    );
    if (raw) {
      assertEditable(mapPlaylistMeta(raw));
      if (
        raw.sort == null ||
        raw.sort === '' ||
        !Number.isSafeInteger(Number(raw.sort)) ||
        Number(raw.sort) < 0
      ) {
        throw new Error('无法读取歌单顺序，请重新加载');
      }
      // 信息接口会同时写入 sort/tags/intro，缺失字段从详情补齐，避免改名时清空。
      let detail: Record<string, unknown> = {};
      if (raw.tags == null || raw.intro == null) {
        const queryId = target.listCreateGid || target.globalCollectionId || target.id;
        const response = toRecord(await getPlaylistDetail(String(queryId)));
        assertCurrent(isCurrent);
        if (Number(response.status) !== 1 || !Array.isArray(response.data) || !response.data[0]) {
          throw new Error('无法读取完整歌单信息，请重试');
        }
        detail = toRecord(response.data[0]);
      }
      const tags = raw.tags ?? detail.tags ?? '';
      const playlist = mapPlaylistMeta({
        ...detail,
        ...raw,
        tags: serializePlaylistTags(tags),
        intro: raw.intro ?? detail.intro ?? '',
      });
      assertEditable(playlist);
      return { playlist, listid, type, totalVer: totalVer!, sort: Number(raw.sort) };
    }
    if (result.raw.length < 200 || (result.count !== null && page * 200 >= result.count)) break;
  }
  throw new Error('歌单已不存在或不在当前账号中');
}

export interface PlaylistCoverFile {
  data: ArrayBuffer;
}

export function validatePlaylistCoverFile(file: Pick<File, 'name' | 'type' | 'size'>) {
  const mime = file.type.toLowerCase();
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (
    mime
      ? !['image/jpeg', 'image/png', 'image/webp'].includes(mime)
      : !['jpg', 'jpeg', 'png', 'webp'].includes(extension)
  ) {
    throw new Error('请选择 JPG、PNG 或 WebP 图片');
  }
  if (file.size <= 0) throw new Error('图片文件为空，请重新选择');
  if (file.size > 8 * 1024 * 1024) throw new Error('封面图片不能超过 8 MB');
}

export async function savePlaylistEdit(
  snapshot: PlaylistEditSnapshot,
  change: { draft: PlaylistInfoDraft; cover?: PlaylistCoverFile },
  isCurrent: () => boolean,
) {
  assertCurrent(isCurrent);
  assertEditable(snapshot.playlist);
  const name = change.draft.name.trim();
  if (!name) throw new Error('歌单名称不能为空');
  let pic = '';
  let fileName = '';
  if (
    change.cover !== undefined &&
    (!change.cover?.data?.byteLength || change.cover.data.byteLength > 8 * 1024 * 1024)
  ) {
    throw new Error('请重新选择封面图片');
  }
  const tags = serializePlaylistTags(change.draft.tags);
  const latest = readOrderPage(await getUserPlaylists(1, 1), 'playlists');
  assertCurrent(isCurrent);
  if (latest.version !== snapshot.totalVer) throw new Error('歌单列表已变化，请重新加载后修改');
  // 只有明确选择了新图片才上传；未选择时省略 pic，保留服务端封面。
  if (change.cover) {
    const upload = toRecord(await uploadPlaylistCover(change.cover.data));
    assertCurrent(isCurrent);
    fileName = typeof upload.FileName === 'string' ? upload.FileName : '';
    if (Number(upload.status) !== 1 || !/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png)$/i.test(fileName)) {
      throw new Error('图片上传失败，请重试或重新选择图片');
    }
    pic = `custom/${fileName}`;
    // 上传期间其他客户端可能修改了歌单列表，再检查版本，避免覆盖新信息。
    const afterUpload = readOrderPage(await getUserPlaylists(1, 1), 'playlists');
    assertCurrent(isCurrent);
    if (afterUpload.version !== snapshot.totalVer)
      throw new Error('歌单列表已变化，请重新加载后修改');
  }
  const response = await updatePlaylistInfo({
    listid: snapshot.listid,
    type: snapshot.type,
    total_ver: snapshot.totalVer,
    sort: snapshot.sort,
    tags,
    intro: change.draft.intro,
    ...(name !== snapshot.playlist.name ? { name } : {}),
    ...(pic ? { pic } : {}),
  });
  if (Number(toRecord(response).status) !== 1)
    throw new Error('保存失败，修改内容已保留，请稍后重试');
  assertCurrent(isCurrent);
  return {
    ...snapshot.playlist,
    name,
    tags,
    intro: change.draft.intro,
    ...(pic ? { pic: `https://imge.kugou.com/custom/400/${fileName}`, hasCustomCover: true } : {}),
  };
}
