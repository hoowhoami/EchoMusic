import {
  getPlaylistTracksNew,
  getUserPlaylists,
  savePlaylistOrder,
  savePlaylistTrackOrder,
} from '@/api/playlist';
import { toRecord } from '../../shared/object';

export interface PlaylistOrderItem {
  id: string;
  title: string;
  subtitle: string;
  type: number;
  hidden: boolean;
}
export type PlaylistOrderTarget =
  | { kind: 'tracks'; listid: number; queryId: string | number; title: string }
  | { kind: 'playlists'; type: 0 | 1; fixedIds: string[] };
export interface PlaylistOrderSnapshot {
  target: PlaylistOrderTarget;
  version: number;
  items: PlaylistOrderItem[];
}

const integer = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};
const requiredId = (value: unknown) => {
  const id = integer(value);
  if (id === null || id === 0) throw new Error('列表缺少有效的排序标识，请刷新后重试');
  return String(id);
};

export function readOrderPage(
  response: unknown,
  kind: PlaylistOrderTarget['kind'],
  requireVersion = true,
) {
  const body = toRecord(response);
  const succeeded =
    body.status != null
      ? Number(body.status) === 1
      : kind === 'tracks' && integer(body.error_code) === 0;
  if (!succeeded) throw new Error('读取排序失败，请稍后重试');
  const data = toRecord(body.data ?? body);
  const candidates = [data.info, data.songs, data.list, body.info];
  const raw = candidates.find(Array.isArray) as unknown[] | undefined;
  const versionKey = kind === 'tracks' ? 'list_ver' : 'total_ver';
  // 旧歌曲接口将版本号放在 list_info 中，加载与保存前校验共用此解析。
  const version = integer(
    (kind === 'tracks' ? toRecord(data.list_info).list_ver : undefined) ??
      data[versionKey] ??
      body[versionKey],
  );
  if (requireVersion && version === null) throw new Error('无法读取列表版本，请刷新后重试');
  if (!raw) throw new Error('列表数据不完整，请刷新后重试');
  const count = integer(data.count ?? data.total ?? body.count ?? body.total);
  return { raw: raw.map(toRecord), version, count };
}

/** 全量读取并校验版本；不走可播放歌曲过滤，保留失效歌曲的位置和真实 fileid。 */
export async function loadPlaylistOrder(
  target: PlaylistOrderTarget,
  isCurrent = () => true,
): Promise<PlaylistOrderSnapshot> {
  const pageSize = 200;
  const rows: Record<string, unknown>[] = [];
  let version: number | null = null;
  let total: number | null = null;
  for (let page = 1; ; page++) {
    if (!isCurrent()) throw new Error('排序操作已取消');
    const response =
      target.kind === 'tracks'
        ? await getPlaylistTracksNew(target.listid, page, pageSize)
        : await getUserPlaylists(page, pageSize);
    if (!isCurrent()) throw new Error('排序操作已取消');
    // 旧歌曲接口仅首页带 list_info；后续页沿用首页版本，有返回版本时仍校验。
    const result = readOrderPage(response, target.kind, target.kind !== 'tracks' || page === 1);
    if (version !== null && result.version !== null && version !== result.version) {
      throw new Error('列表在加载期间发生变化，请重新加载');
    }
    if (result.version !== null) version = result.version;
    if (result.count !== null) {
      if (total !== null && total !== result.count) throw new Error('列表已变化，请重新加载');
      total = result.count;
    }
    rows.push(...result.raw);
    if (total !== null && rows.length >= total) {
      if (rows.length !== total) throw new Error('列表数量不一致，请重新加载');
      break;
    }
    if (result.raw.length < pageSize) {
      if (total !== null && rows.length !== total) throw new Error('列表尚未完整加载，请重试');
      break;
    }
    if (page >= 500) throw new Error('列表过大，暂时无法调整顺序');
  }

  // 全部分页加载后，按云端 sort 升序排列；歌曲不按收藏时间重排。
  const orderedRows = rows.sort((a, b) => {
    if (target.kind === 'playlists' && Number(a.type) !== Number(b.type))
      return Number(a.type) - Number(b.type);
    const left = integer(a.sort);
    const right = integer(b.sort);
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return left - right;
  });
  const items = orderedRows.map((row): PlaylistOrderItem => {
    const type = target.kind === 'tracks' ? 0 : integer(row.type);
    if (type !== 0 && type !== 1) throw new Error('未知歌单类型，暂时无法保存排序');
    const id = requiredId(target.kind === 'tracks' ? row.fileid : row.listid);
    const title =
      [row.name, row.filename, row.specialname]
        .find((value) => typeof value === 'string' && value.trim())
        ?.toString()
        .trim()
        .replace(/\.(mp3|flac|wav|aac|m4a|ogg|wma|ape)$/i, '')
        .trim() ?? '';
    return {
      id,
      type,
      title: title || '未命名',
      subtitle:
        target.kind === 'tracks'
          ? String(row.author_name ?? row.singername ?? '')
          : `${Number(row.count ?? row.song_count ?? 0)} 首歌曲`,
      hidden:
        target.kind === 'tracks'
          ? !title || /^(?:.* - )?(未知歌曲|未命名)$/.test(title)
          : type !== target.type || Number(row.source) === 2 || target.fixedIds.includes(id),
    };
  });
  const keys = items.map((item) => `${item.type}:${item.id}`);
  if (new Set(keys).size !== keys.length) throw new Error('列表包含重复数据，请重新加载');
  return { target, version: version!, items };
}

/** 将可编辑项放回原有位置，保留未知歌曲、固定歌单与收藏专辑的槽位。 */
export function buildPlaylistOrderPayload(snapshot: PlaylistOrderSnapshot, ids: readonly string[]) {
  const editable = snapshot.items.filter((item) => !item.hidden);
  const byId = new Map(editable.map((item) => [item.id, item]));
  if (
    ids.length !== editable.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !byId.has(id))
  ) {
    throw new Error('排序列表不完整，请重新加载');
  }
  let cursor = 0;
  const positions = new Map<number, number>();
  return snapshot.items
    .filter((item) => snapshot.target.kind === 'tracks' || item.type === snapshot.target.type)
    .map((original) => {
      const item = original.hidden ? original : byId.get(ids[cursor++])!;
      const sort = positions.get(item.type) ?? 0;
      positions.set(item.type, sort + 1);
      return snapshot.target.kind === 'tracks'
        ? `${item.id}|${sort}`
        : `${item.id}|${item.type}|${sort}`;
    })
    .join(',');
}

export async function persistPlaylistOrder(
  snapshot: PlaylistOrderSnapshot,
  ids: readonly string[],
  isCurrent = () => true,
) {
  const data = buildPlaylistOrderPayload(snapshot, ids);
  if (!isCurrent()) throw new Error('账号或页面已变化，请重新打开排序');
  if (!data) throw new Error('没有可保存的顺序');
  // 用最新版本检测编辑期间的收藏、删除或其他客户端排序，避免覆盖新的列表。
  const response =
    snapshot.target.kind === 'tracks'
      ? await getPlaylistTracksNew(snapshot.target.listid, 1, 1)
      : await getUserPlaylists(1, 1);
  if (!isCurrent()) throw new Error('账号或页面已变化，请重新打开排序');
  const latest = readOrderPage(response, snapshot.target.kind);
  if (
    latest.version !== snapshot.version ||
    (latest.count !== null && latest.count !== snapshot.items.length)
  )
    throw new Error('列表已在其他位置更新，请重新加载后排序');
  const result =
    snapshot.target.kind === 'tracks'
      ? await savePlaylistTrackOrder(snapshot.target.listid, snapshot.version, data)
      : await savePlaylistOrder(snapshot.version, data);
  if (Number(toRecord(result).status) !== 1) throw new Error('保存排序失败，请重新加载后重试');
}
