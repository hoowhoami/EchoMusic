import axios from 'axios';
import log from 'electron-log';
import type {
  ExternalProviderId,
  ResolvePlaylistRequest,
  ResolvePlaylistResponse,
} from '../../shared/external';
import type { ExternalProvider, ProviderContext } from './types';
import { neteaseProvider } from './providers/netease';
import { qqmusicProvider } from './providers/qqmusic';
import { kuwoProvider } from './providers/kuwo';
import { kugouProvider } from './providers/kugou';
import { textProvider } from './providers/text';

const PROVIDERS: ExternalProvider[] = [
  neteaseProvider,
  qqmusicProvider,
  kuwoProvider,
  kugouProvider,
  textProvider,
];

const PROVIDER_MAP: Record<ExternalProviderId, ExternalProvider | undefined> = {
  netease: neteaseProvider,
  qqmusic: qqmusicProvider,
  kuwo: kuwoProvider,
  kugou: kugouProvider,
  text: textProvider,
  auto: undefined,
};

const buildContext = (): ProviderContext => ({
  fetchJson: async (url, headers) => {
    const res = await axios.get(url, {
      headers: headers ?? {},
      timeout: 15000,
      responseType: 'json',
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (res.status >= 400) {
      throw new Error(`远端返回 ${res.status}`);
    }
    return res.data;
  },
  fetchText: async (url, headers) => {
    const res = await axios.get(url, {
      headers: headers ?? {},
      timeout: 15000,
      responseType: 'text',
      transformResponse: [(d) => d],
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (res.status >= 400) {
      throw new Error(`远端返回 ${res.status}`);
    }
    return typeof res.data === 'string' ? res.data : String(res.data ?? '');
  },
  postForm: async (url, form, headers) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) params.append(k, v);
    const res = await axios.post(url, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(headers ?? {}),
      },
      timeout: 20000,
      responseType: 'json',
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (res.status >= 400) {
      throw new Error(`远端返回 ${res.status}`);
    }
    return res.data;
  },
});

const detectProvider = (input: string): ExternalProvider | null => {
  // 优先匹配 URL 类 provider
  for (const p of PROVIDERS) {
    if (p.id === 'text') continue;
    if (p.canHandle(input)) return p;
  }
  // 兜底文本
  if (textProvider.canHandle(input)) return textProvider;
  return null;
};

export const resolvePlaylist = async (
  req: ResolvePlaylistRequest,
): Promise<ResolvePlaylistResponse> => {
  const input = String(req?.input ?? '').trim();
  if (!input) {
    return { ok: false, error: '请输入歌单链接或文本', code: 'EMPTY_INPUT' };
  }

  let provider: ExternalProvider | null = null;
  if (req.provider && req.provider !== 'auto') {
    provider = PROVIDER_MAP[req.provider] ?? null;
    if (!provider) {
      return { ok: false, error: `不支持的来源: ${req.provider}`, code: 'UNKNOWN_PROVIDER' };
    }
  } else {
    provider = detectProvider(input);
    if (!provider) {
      return {
        ok: false,
        error: '无法识别输入来源，请检查链接是否正确',
        code: 'UNDETECTABLE',
      };
    }
  }

  try {
    const playlist = await provider.resolve({ input, provider: provider.id }, buildContext());
    return { ok: true, playlist };
  } catch (e: any) {
    log.error('[External] resolve failed:', e?.message || e);
    return {
      ok: false,
      error: e?.message ? String(e.message) : '解析歌单失败',
      code: 'RESOLVE_FAILED',
    };
  }
};
