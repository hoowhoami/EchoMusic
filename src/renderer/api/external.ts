import type { ResolvePlaylistRequest, ResolvePlaylistResponse } from '../../shared/external';

/**
 * 调用主进程解析外部歌单链接/文本，返回归一化后的歌单数据
 */
export const resolveExternalPlaylist = (
  req: ResolvePlaylistRequest,
): Promise<ResolvePlaylistResponse> => {
  return window.electron.external.resolvePlaylist(req);
};
