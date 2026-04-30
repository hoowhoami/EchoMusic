/** 外部歌单导入 IPC 注册 */

import { ipcMain } from 'electron';
import { resolvePlaylist } from '../external';
import type { ResolvePlaylistRequest, ResolvePlaylistResponse } from '../../shared/external';

export const registerExternalHandlers = () => {
  ipcMain.handle(
    'external:resolve-playlist',
    async (_event, req: ResolvePlaylistRequest): Promise<ResolvePlaylistResponse> => {
      return resolvePlaylist(req);
    },
  );
};
