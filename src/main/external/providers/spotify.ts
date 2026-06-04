import type { ExternalPlaylist, ExternalTrack } from '../../../shared/external';
import type { ExternalProvider, ProviderContext } from '../types';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 从用户输入中提取 Spotify playlist ID
 * 支持格式：
 * - https://open.spotify.com/playlist/7DJRuPbeSjLolZCM3fCBjT
 * - https://open.spotify.com/playlist/7DJRuPbeSjLolZCM3fCBjT?si=xxx
 * - spotify:playlist:7DJRuPbeSjLolZCM3fCBjT
 * - 纯 ID（22 位 base62）
 */
const extractPlaylistId = (input: string): string => {
  const trimmed = input.trim();

  // 纯 ID（Spotify ID 为 22 位 base62 字符）
  if (/^[A-Za-z0-9]{22}$/.test(trimmed)) return trimmed;

  // URL 格式
  const urlMatch = trimmed.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]{22})/);
  if (urlMatch) return urlMatch[1];

  // URI 格式
  const uriMatch = trimmed.match(/spotify:playlist:([A-Za-z0-9]{22})/);
  if (uriMatch) return uriMatch[1];

  throw new Error('未能从输入中识别 Spotify 歌单 ID');
};

interface SpotifyTrackItem {
  uri?: string;
  uid?: string;
  title?: string;
  subtitle?: string;
  duration?: number;
  isPlayable?: boolean;
}

interface SpotifyEntity {
  type?: string;
  name?: string;
  id?: string;
  subtitle?: string;
  coverArt?: {
    sources?: { url?: string; width?: number; height?: number }[];
  };
  trackList?: SpotifyTrackItem[];
}

const mapTrack = (item: SpotifyTrackItem): ExternalTrack | null => {
  const title = item.title?.trim();
  if (!title) return null;
  return {
    externalId: item.uri || item.uid || undefined,
    title,
    artist: item.subtitle?.trim() || '',
    // Spotify embed duration 单位是毫秒
    duration:
      typeof item.duration === 'number' && item.duration > 0
        ? Math.round(item.duration / 1000)
        : undefined,
  };
};

const pickCover = (coverArt?: SpotifyEntity['coverArt']): string | undefined => {
  if (!coverArt?.sources?.length) return undefined;
  // 优先选 300px 左右的中等尺寸
  const sorted = [...coverArt.sources].sort(
    (a, b) => Math.abs((a.width ?? 0) - 300) - Math.abs((b.width ?? 0) - 300),
  );
  return sorted[0]?.url || coverArt.sources[0]?.url;
};

export const spotifyProvider: ExternalProvider = {
  id: 'spotify',
  canHandle: (input: string) => /open\.spotify\.com\/playlist|spotify:playlist:/.test(input),
  resolve: async (req, ctx): Promise<ExternalPlaylist> => {
    const id = extractPlaylistId(req.input);

    // 通过 embed 端点获取歌单数据（无需认证，返回 __NEXT_DATA__）
    const url = `https://open.spotify.com/embed/playlist/${id}`;
    const html = await ctx.fetchText(url, { 'User-Agent': UA });

    // 解析 __NEXT_DATA__
    const dataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!dataMatch) {
      throw new Error('无法从 Spotify 页面中提取数据，可能页面结构已变更');
    }

    let entity: SpotifyEntity;
    try {
      const nextData = JSON.parse(dataMatch[1]);
      entity = nextData?.props?.pageProps?.state?.data?.entity ?? {};
    } catch {
      throw new Error('解析 Spotify 页面数据失败');
    }

    if (entity.type !== 'playlist') {
      throw new Error('该链接不是 Spotify 歌单，请检查链接是否正确');
    }

    const trackList = entity.trackList ?? [];
    if (trackList.length === 0) {
      throw new Error('该 Spotify 歌单没有歌曲或为私密歌单');
    }

    const tracks = trackList.map(mapTrack).filter((t): t is ExternalTrack => t !== null);

    return {
      provider: 'spotify',
      externalId: id,
      name: entity.name || '未命名歌单',
      coverUrl: pickCover(entity.coverArt),
      creator: entity.subtitle || undefined,
      tracks,
    };
  },
};
