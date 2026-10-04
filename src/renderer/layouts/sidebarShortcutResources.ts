import type { LocalHistoryEntry } from '@/stores/historyStore';
import type { PlaybackQueueState } from '@/stores/playlist/types';
import type { PlaylistMeta } from '@/models/playlist';

/** 保存导航身份和展示快照，已添加卡片不依赖历史记录继续存在。 */
export interface SidebarShortcutResource {
  kind: 'artist' | 'playlist';
  id: string;
  title: string;
  image?: string;
}

export const resourceShortcutKey = (resource: SidebarShortcutResource) =>
  JSON.stringify(['resource', resource.kind, resource.id]);

export const resourceShortcutPath = (resource: SidebarShortcutResource) =>
  `/main/${resource.kind}/${encodeURIComponent(resource.id)}`;

const findShortcutPlaylist = (id: string, playlists: readonly PlaylistMeta[]) =>
  playlists.find(
    (item) =>
      item.source !== 2 &&
      [item.id, item.listid, item.globalCollectionId, item.listCreateGid].some(
        (value) => value != null && String(value) === id,
      ),
  );

/** 已添加卡片也读取实时封面；历史队列消失后仅用快照保留导航。 */
export function resolvePlaylistShortcut(
  resource: SidebarShortcutResource,
  playlists: readonly PlaylistMeta[],
  coverFor: (playlist: PlaylistMeta) => string,
): SidebarShortcutResource {
  if (resource.kind !== 'playlist') return resource;
  const playlist = findShortcutPlaylist(resource.id, playlists);
  if (!playlist) return resource;
  return {
    ...resource,
    title: playlist.name || resource.title,
    // 空字符串代表已确认没有封面，不能回退到旧的快照或队列封面。
    image: coverFor(playlist),
  };
}

export function frequentArtistShortcuts(
  history: readonly LocalHistoryEntry[],
  limit = 6,
): SidebarShortcutResource[] {
  const artists = new Map<
    string,
    { resource: SidebarShortcutResource; plays: number; lastPlayedAt: number }
  >();
  for (const entry of history) {
    const seen = new Set<string>();
    for (const artist of [...(entry.song.artists ?? []), ...(entry.song.singers ?? [])]) {
      const id = String(artist.id ?? '').trim();
      if (!/^[1-9]\d*$/.test(id) || !artist.name.trim()) continue;
      const current = artists.get(id) ?? {
        resource: { kind: 'artist', id, title: artist.name.trim(), image: artist.pic },
        plays: 0,
        lastPlayedAt: 0,
      };
      if (!seen.has(id)) {
        current.plays += Number.isFinite(entry.playCount) ? Math.max(1, entry.playCount) : 1;
        current.lastPlayedAt = Math.max(current.lastPlayedAt, entry.lastPlayedAt || 0);
        seen.add(id);
      }
      if (!current.resource.image && artist.pic) current.resource.image = artist.pic;
      artists.set(id, current);
    }
  }
  return [...artists.values()]
    .sort((a, b) => b.plays - a.plays || b.lastPlayedAt - a.lastPlayedAt)
    .slice(0, limit)
    .map((entry) => entry.resource);
}

export function recentPlaylistShortcuts(
  queues: readonly PlaybackQueueState[],
  playlists: readonly PlaylistMeta[] = [],
  limit = 12,
): SidebarShortcutResource[] {
  const result = new Map<string, SidebarShortcutResource>();
  for (const queue of [...queues].sort((a, b) => b.updatedAt - a.updatedAt)) {
    // 仅详情页生成的歌单队列有可导航的歌单身份；不把 FM、专辑或临时队列当作歌单。
    if (queue.type !== 'playlist' || !queue.id.startsWith('queue:playlist:')) continue;
    const queueId = queue.id.slice('queue:playlist:'.length);
    if (!queueId || queueId === '0' || !queue.title.trim()) continue;
    if ((queue.songCount ?? queue.songs.length) <= 0) continue;
    const playlist = findShortcutPlaylist(queueId, playlists);
    const id = String(playlist?.listCreateGid || playlist?.globalCollectionId || queueId);
    if (!result.has(id))
      result.set(id, {
        kind: 'playlist',
        id,
        title: playlist?.name || queue.title,
        image: playlist?.pic || queue.coverUrl,
      });
    if (result.size >= limit) break;
  }
  return [...result.values()];
}

/** 移除/恢复默认时仅清理资源快照，不改变下方菜单配置或暂不可用的插件 key。 */
export function selectedShortcutResources(
  keys: readonly string[],
  saved: readonly SidebarShortcutResource[],
  added?: SidebarShortcutResource,
): SidebarShortcutResource[] {
  const resources = new Map(saved.map((resource) => [resourceShortcutKey(resource), resource]));
  if (added) resources.set(resourceShortcutKey(added), added);
  return keys.flatMap((key) => {
    const resource = resources.get(key);
    return resource ? [resource] : [];
  });
}
