import type {
  ExternalPlaylist,
  ExternalProviderId,
  ResolvePlaylistRequest,
} from '../../shared/external';

export interface ProviderContext {
  fetchJson: (url: string, headers?: Record<string, string>) => Promise<any>;
  fetchText: (url: string, headers?: Record<string, string>) => Promise<string>;
  postForm: (
    url: string,
    form: Record<string, string>,
    headers?: Record<string, string>,
  ) => Promise<any>;
}

export interface ExternalProvider {
  id: ExternalProviderId;
  /** 是否能处理这条输入（用于 auto 嗅探） */
  canHandle: (input: string) => boolean;
  /** 拉取并归一化为 ExternalPlaylist */
  resolve: (req: ResolvePlaylistRequest, ctx: ProviderContext) => Promise<ExternalPlaylist>;
}
