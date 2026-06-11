import { ipcRegistry } from './registry';
import { resolvePlaylist } from '../external';
import type { ResolvePlaylistRequest, ResolvePlaylistResponse } from '../../shared/external';

export const registerExternalHandlers = () => {
  ipcRegistry.registerHandler(
    'external:resolve-playlist',
    async (_event, req: ResolvePlaylistRequest): Promise<ResolvePlaylistResponse> => {
      return resolvePlaylist(req);
    },
  );
};
