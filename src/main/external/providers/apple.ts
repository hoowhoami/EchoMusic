import type { ExternalPlaylist, ExternalTrack } from '../../../shared/external';
import type { ExternalProvider, ProviderContext } from '../types';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 从用户输入中提取 Apple Music playlist ID 和 storefront
 * 支持格式：
 * - https://music.apple.com/cn/playlist/xxx/pl.xxxx
 * - https://music.apple.com/us/playlist/name/pl.xxxx
 * - https://music.apple.com/playlist/pl.xxxx
 * - pl.xxxx（纯 ID）
 */
const extractPlaylistInfo = (input: string): { id: string; storefront: string } => {
  const trimmed = input.trim();

  // 纯 ID
  if (/^pl\.[a-f0-9]+$/i.test(trimmed)) {
    return { id: trimmed, storefront: 'us' };
  }

  // URL 格式：提取 storefront 和 playlist ID
  const urlMatch = trimmed.match(
    /music\.apple\.com\/([a-z]{2})\/playlist\/[^/]*\/(pl\.[a-f0-9]+)/i,
  );
  if (urlMatch) {
    return { id: urlMatch[2], storefront: urlMatch[1] };
  }

  // 无 storefront 的 URL
  const noSfMatch = trimmed.match(/music\.apple\.com\/playlist\/[^/]*\/(pl\.[a-f0-9]+)/i);
  if (noSfMatch) {
    return { id: noSfMatch[1], storefront: 'us' };
  }

  // URL 中 ID 在最后一段
  const lastSegMatch = trimmed.match(/(pl\.[a-f0-9]+)/i);
  if (lastSegMatch) {
    // 尝试从 URL 中提取 storefront
    const sfMatch = trimmed.match(/music\.apple\.com\/([a-z]{2})\//i);
    return { id: lastSegMatch[1], storefront: sfMatch ? sfMatch[1] : 'us' };
  }

  throw new Error('未能从输入中识别 Apple Music 歌单 ID');
};

/** 从 Apple Music 主页 JS bundle 中动态获取 developer token */
let cachedToken: { token: string; expiresAt: number } | null = null;

const fetchDeveloperToken = async (ctx: ProviderContext): Promise<string> => {
  // 缓存未过期则直接返回
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  // 获取主页 HTML，提取 JS bundle URL
  const html = await ctx.fetchText('https://music.apple.com', { 'User-Agent': UA });
  const jsMatch = html.match(/src="(\/assets\/index[^"]+\.js)"/);
  if (!jsMatch) {
    throw new Error('无法从 Apple Music 页面获取 JS 资源路径');
  }

  // 下载 JS bundle，提取 JWT token
  const jsUrl = `https://music.apple.com${jsMatch[1]}`;
  const jsContent = await ctx.fetchText(jsUrl, { 'User-Agent': UA });

  // JWT token 格式：eyJ...（三段 base64url 用 . 分隔）
  const tokenMatches = jsContent.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g);
  if (!tokenMatches || tokenMatches.length === 0) {
    throw new Error('无法从 Apple Music JS 中提取 developer token');
  }

  // 找到 iss 为 "AMPWebPlay" 的 token（Web Player 专用）
  let token: string | null = null;
  for (const t of tokenMatches) {
    try {
      const payload = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf-8'));
      if (payload.iss === 'AMPWebPlay' && payload.exp) {
        token = t;
        // 提前 1 小时过期缓存
        cachedToken = { token: t, expiresAt: payload.exp * 1000 - 3600_000 };
        break;
      }
    } catch {
      continue;
    }
  }

  if (!token) {
    // 退而求其次，用第一个有 exp 的 token
    for (const t of tokenMatches) {
      try {
        const payload = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf-8'));
        if (payload.exp) {
          token = t;
          cachedToken = { token: t, expiresAt: payload.exp * 1000 - 3600_000 };
          break;
        }
      } catch {
        continue;
      }
    }
  }

  if (!token) {
    throw new Error('未找到有效的 Apple Music developer token');
  }

  return token;
};

interface AppleSongAttributes {
  name?: string;
  artistName?: string;
  albumName?: string;
  durationInMillis?: number;
}

interface AppleTrackData {
  id?: string;
  type?: string;
  attributes?: AppleSongAttributes;
}

interface ApplePlaylistAttributes {
  name?: string;
  description?: { standard?: string; short?: string };
  curatorName?: string;
  artwork?: { url?: string };
  lastModifiedDate?: string;
}

interface ApplePlaylistData {
  id?: string;
  attributes?: ApplePlaylistAttributes;
  relationships?: {
    tracks?: {
      data?: AppleTrackData[];
      next?: string;
    };
  };
}

const mapTrack = (t: AppleTrackData): ExternalTrack | null => {
  const attrs = t.attributes;
  if (!attrs?.name) return null;
  return {
    externalId: t.id || undefined,
    title: attrs.name.trim(),
    artist: attrs.artistName?.trim() || '',
    album: attrs.albumName || undefined,
    duration:
      typeof attrs.durationInMillis === 'number' && attrs.durationInMillis > 0
        ? Math.round(attrs.durationInMillis / 1000)
        : undefined,
  };
};

const buildCoverUrl = (artwork?: ApplePlaylistAttributes['artwork']): string | undefined => {
  if (!artwork?.url) return undefined;
  // Apple artwork URL 模板：{w}x{h}bb.jpg
  return artwork.url.replace('{w}', '600').replace('{h}', '600');
};

export const appleProvider: ExternalProvider = {
  id: 'apple',
  canHandle: (input: string) => /music\.apple\.com/.test(input),
  resolve: async (req, ctx): Promise<ExternalPlaylist> => {
    const { id, storefront } = extractPlaylistInfo(req.input);
    const token = await fetchDeveloperToken(ctx);

    const headers = {
      Authorization: `Bearer ${token}`,
      Origin: 'https://music.apple.com',
      'User-Agent': UA,
    };

    // 获取歌单详情（含歌曲，默认返回前 100 首）
    const apiUrl = `https://amp-api.music.apple.com/v1/catalog/${storefront}/playlists/${id}?include=tracks&l=zh-Hans-CN`;
    const body = (await ctx.fetchJson(apiUrl, headers)) as {
      data?: ApplePlaylistData[];
      errors?: { detail?: string }[];
    };

    if (body.errors?.length) {
      const msg = body.errors[0]?.detail || 'Apple Music 返回错误';
      throw new Error(msg);
    }

    const playlist = body.data?.[0];
    if (!playlist) {
      throw new Error('Apple Music 返回数据为空，可能歌单不存在或地区限制');
    }

    // 收集所有歌曲（分页获取）
    const allTracks: AppleTrackData[] = [...(playlist.relationships?.tracks?.data ?? [])];

    let nextUrl = playlist.relationships?.tracks?.next;
    const MAX_PAGES = 10; // 最多拉取 10 页（约 1000 首）
    let page = 0;
    while (nextUrl && page < MAX_PAGES) {
      page++;
      const pageUrl = `https://amp-api.music.apple.com${nextUrl}`;
      const pageBody = (await ctx.fetchJson(pageUrl, headers)) as {
        data?: AppleTrackData[];
        next?: string;
      };
      if (pageBody.data?.length) {
        allTracks.push(...pageBody.data);
      }
      nextUrl = pageBody.next;
      if (!pageBody.data?.length) break;
    }

    const tracks = allTracks.map(mapTrack).filter((t): t is ExternalTrack => t !== null);

    if (tracks.length === 0) {
      throw new Error('该 Apple Music 歌单没有歌曲或为私密歌单');
    }

    const attrs = playlist.attributes;
    return {
      provider: 'apple',
      externalId: id,
      name: attrs?.name || '未命名歌单',
      description: attrs?.description?.standard || attrs?.description?.short || undefined,
      coverUrl: buildCoverUrl(attrs?.artwork),
      creator: attrs?.curatorName || undefined,
      tracks,
    };
  },
};
