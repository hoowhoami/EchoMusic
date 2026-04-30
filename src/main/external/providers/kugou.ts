import axios from 'axios';
import log from 'electron-log';
import type {
  ExternalPlaylist,
  ExternalTrack,
  ResolvePlaylistRequest,
} from '../../../shared/external';
import type { ExternalProvider, ProviderContext } from '../types';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

/**
 * 从 URL 中提取歌单 global_collection_id（仅限有效的 collection_xxx 格式）
 */
const extractCollectionId = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    const gid =
      parsed.searchParams.get('global_specialid') ||
      parsed.searchParams.get('global_collection_id');
    if (gid && gid.startsWith('collection_')) return gid;

    // kugou.com/yy/special/single/{id}.html
    const specialMatch = parsed.pathname.match(/\/special\/single\/(\d+)\.html/);
    if (specialMatch) return specialMatch[1];
  } catch {
    // 非 URL 格式
  }
  return null;
};

/**
 * 从移动端歌单页面 HTML 中提取 window.$output 数据
 */
const parseMobilePageOutput = (
  html: string,
): { listinfo: Record<string, unknown>; songs: Record<string, unknown>[] } | null => {
  const match = html.match(/window\.\$output\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (!match) return null;

  try {
    const data = JSON.parse(match[1]) as Record<string, unknown>;
    const info = data.info as Record<string, unknown> | undefined;
    if (!info) return null;

    const listinfo = (info.listinfo as Record<string, unknown>) || {};
    const songs = Array.isArray(info.songs) ? (info.songs as Record<string, unknown>[]) : [];
    return { listinfo, songs };
  } catch {
    return null;
  }
};

/**
 * 从移动端歌单数据构建 ExternalPlaylist
 */
const buildFromMobilePage = (output: {
  listinfo: Record<string, unknown>;
  songs: Record<string, unknown>[];
}): ExternalPlaylist | null => {
  const { listinfo, songs } = output;
  if (songs.length === 0) return null;

  const tracks: ExternalTrack[] = songs
    .filter((s) => s.name || s.audio_name)
    .map((s) => {
      const rawName = String(s.name || s.audio_name || '');
      // name 格式通常是 "歌手 - 歌名"
      const sepIdx = rawName.indexOf(' - ');
      let title = rawName;
      let artist = '';
      if (sepIdx > 0) {
        artist = rawName.substring(0, sepIdx);
        title = rawName.substring(sepIdx + 3);
      }
      const duration = typeof s.timelen === 'number' ? Math.round(s.timelen / 1000) : undefined;
      return { title, artist, duration };
    });

  if (tracks.length === 0) return null;

  const name = String(listinfo.name || '酷狗歌单');
  const coverUrl = String(listinfo.pic || '').replace('{size}', '480');
  const creator = String(listinfo.list_create_username || '');

  // 检查是否有有效的 global_collection_id
  const gid = String(listinfo.global_collection_id || '');
  const externalId = gid.startsWith('collection_') ? gid : undefined;

  return {
    provider: 'kugou',
    externalId,
    name,
    coverUrl: coverUrl || undefined,
    creator: creator || undefined,
    tracks,
  };
};

/**
 * 从 PC 分享页面 HTML 中提取 dataFromSmarty 歌曲数据
 */
const parseSharePageTracks = (html: string): ExternalTrack[] => {
  // 数据格式: var dataFromSmarty = [...],//当前页面歌曲信息
  const match = html.match(/var\s+dataFromSmarty\s*=\s*(\[[\s\S]*?\])\s*[,;]/);
  if (!match) return [];

  try {
    const data = JSON.parse(match[1]) as Array<Record<string, unknown>>;
    return data
      .filter((item) => item.song_name || item.audio_name)
      .map((item) => {
        const title = String(item.song_name || '').replace(/&amp;/g, '&');
        const artist = String(item.author_name || '').replace(/&amp;/g, '&');
        const duration =
          typeof item.timelength === 'number' ? Math.round(item.timelength / 1000) : undefined;
        return { title, artist, duration };
      });
  } catch {
    return [];
  }
};

/**
 * 跟踪短链接重定向，获取 Location header
 */
const followRedirect = async (url: string): Promise<string | null> => {
  try {
    const res = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: () => true,
      timeout: 10000,
    });
    // 302/301 时从 headers 取 location
    if (res.status >= 300 && res.status < 400) {
      return res.headers?.location || null;
    }
    return null;
  } catch (e: any) {
    return e?.response?.headers?.location || null;
  }
};

/**
 * 检查 URL 是否为移动端歌单页面（m.kugou.com/songlist/gcid_xxx）
 */
const isMobileSonglistUrl = (url: string): boolean => {
  return /kugou\.com\/songlist\/gcid_/.test(url);
};

/**
 * 构建移动端歌单页面 URL（确保使用 m3ws.kugou.com 以获取 SSR 数据）
 */
const buildMobileSonglistUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    // 移动端页面会重定向到 m3ws.kugou.com，直接用 https
    parsed.protocol = 'https:';
    if (parsed.hostname === 'm.kugou.com') {
      parsed.hostname = 'm3ws.kugou.com';
    }
    return parsed.toString();
  } catch {
    return url;
  }
};

export const kugouProvider: ExternalProvider = {
  id: 'kugou',
  canHandle: (input: string) => /kugou\.com/.test(input),
  resolve: async (req: ResolvePlaylistRequest, ctx: ProviderContext): Promise<ExternalPlaylist> => {
    const input = req.input.trim();
    const urlMatch = input.match(/https?:\/\/[^\s]+/);
    const url = urlMatch ? urlMatch[0] : input;
    log.info('[Kugou] Resolving URL:', url);

    // 1. 直接从 URL 提取 collection_xxx 格式的歌单 ID
    let collectionId = extractCollectionId(url);
    if (collectionId) {
      return {
        provider: 'kugou',
        externalId: collectionId,
        name: '',
        tracks: [],
      };
    }

    // 2. 移动端歌单页面（m.kugou.com/songlist/gcid_xxx）
    if (isMobileSonglistUrl(url)) {
      const mobileUrl = buildMobileSonglistUrl(url);
      try {
        const html = await ctx.fetchText(mobileUrl, { 'User-Agent': MOBILE_UA });
        const output = parseMobilePageOutput(html);
        if (output) {
          const playlist = buildFromMobilePage(output);
          if (playlist) return playlist;
        }
      } catch {
        // 继续尝试其他方式
      }
    }

    // 3. 短链接（t1.kugou.com）：先尝试提取重定向 URL 中的歌单 ID，再从最终页面提取歌曲
    if (/t1\.kugou\.com/.test(url)) {
      // 3a. 获取重定向 URL，检查是否包含 collection ID
      const redirectUrl = await followRedirect(url);
      log.info('[Kugou] Short link redirect:', redirectUrl);

      if (redirectUrl) {
        collectionId = extractCollectionId(redirectUrl);
        if (collectionId) {
          return {
            provider: 'kugou',
            externalId: collectionId,
            name: '',
            tracks: [],
          };
        }

        // 3b. 重定向到移动端歌单页面
        if (isMobileSonglistUrl(redirectUrl)) {
          const mobileUrl = buildMobileSonglistUrl(redirectUrl);
          try {
            const html = await ctx.fetchText(mobileUrl, { 'User-Agent': MOBILE_UA });
            const output = parseMobilePageOutput(html);
            if (output) {
              const playlist = buildFromMobilePage(output);
              if (playlist) return playlist;
            }
          } catch (e) {
            log.warn('[Kugou] Mobile page fetch failed:', e);
          }
        }
      }

      // 3c. 直接请求短链接（axios 自动跟踪重定向），从最终页面 HTML 提取歌曲
      try {
        const html = await ctx.fetchText(url);
        log.info(
          '[Kugou] Share page HTML length:',
          html.length,
          'has dataFromSmarty:',
          html.includes('dataFromSmarty'),
        );
        const tracks = parseSharePageTracks(html);
        log.info('[Kugou] Parsed tracks:', tracks.length);
        if (tracks.length > 0) {
          return {
            provider: 'kugou',
            name: '酷狗分享歌单',
            tracks,
          };
        }
      } catch (e) {
        log.warn('[Kugou] Share page fetch failed:', e);
      }
    }

    // 4. 其他 kugou.com 页面：尝试从 HTML 提取
    try {
      const html = await ctx.fetchText(url);
      // 先尝试移动端格式
      const output = parseMobilePageOutput(html);
      if (output) {
        const playlist = buildFromMobilePage(output);
        if (playlist) return playlist;
      }
      // 再尝试 PC 分享页面格式
      const tracks = parseSharePageTracks(html);
      if (tracks.length > 0) {
        return {
          provider: 'kugou',
          name: '酷狗分享歌单',
          tracks,
        };
      }
    } catch {
      // 忽略
    }

    throw new Error('无法从该酷狗链接中提取歌单信息，请检查链接是否正确。');
  },
};
