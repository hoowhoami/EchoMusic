import type { PlaylistMeta } from '@/models/playlist';

/** 歌单详情路由里用的 id：自建歌单用 globalCollectionId、收藏歌单用 listCreateGid，专辑收藏用 listCreateListid。 */
export const resolvePlaylistRouteId = (playlist: PlaylistMeta, currentUserId?: number): string => {
  if (playlist.source === 2) return String(playlist.listCreateListid ?? playlist.id);
  if (currentUserId && playlist.listCreateUserid === currentUserId) {
    return String(playlist.globalCollectionId ?? playlist.id);
  }
  return String(playlist.listCreateGid ?? playlist.globalCollectionId ?? playlist.id);
};

/** 详情页靠 type 决定用哪套接口取歌曲：自建 user、收藏 special、专辑收藏 album。 */
const resolvePlaylistRouteType = (
  playlist: PlaylistMeta,
  currentUserId?: number,
): 'user' | 'special' | 'album' => {
  if (playlist.source === 2) return 'album';
  if (currentUserId && playlist.listCreateUserid === currentUserId) return 'user';
  return 'special';
};

/** 用歌单桶里记的 id 反查路由信息；查不到就原样用这个 id（公开歌单的 id 本身就是路由 id）。 */
export const resolvePlaylistRoute = (
  id: string,
  playlists: PlaylistMeta[],
  currentUserId?: number,
): { id: string; type: string | null } => {
  const meta = playlists.find((item) =>
    [item.id, item.listid, item.listCreateListid].some(
      (value) => value !== undefined && value !== null && String(value) === id,
    ),
  );
  if (!meta) return { id, type: null };
  return {
    id: resolvePlaylistRouteId(meta, currentUserId),
    type: resolvePlaylistRouteType(meta, currentUserId),
  };
};
