import type { ExternalPlaylist, ExternalTrack } from '../../../shared/external';
import type { ExternalProvider, ProviderContext } from '../types';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 从用户输入中提取歌单页面 URL
 * 支持格式：
 * - 短链：https://qishui.douyin.com/s/xxxxx（axios 会自动跟随重定向）
 * - 完整链接：https://music.douyin.com/qishui/share/playlist?playlist_id=xxx
 * - 纯数字 ID
 */
const resolvePageUrl = (input: string): string => {
  const trimmed = input.trim();

  // 纯数字 ID
  if (/^\d{10,}$/.test(trimmed)) {
    return `https://music.douyin.com/qishui/share/playlist?playlist_id=${trimmed}`;
  }

  // 完整链接中直接提取 playlist_id
  const idMatch = trimmed.match(/[?&]playlist_id=(\d+)/);
  if (idMatch) {
    return `https://music.douyin.com/qishui/share/playlist?playlist_id=${idMatch[1]}`;
  }

  // 短链 - 直接返回短链 URL，axios 会跟随重定向到最终页面
  const shortLinkMatch = trimmed.match(/https?:\/\/qishui\.douyin\.com\/s\/[A-Za-z0-9]+/);
  if (shortLinkMatch) {
    return shortLinkMatch[0];
  }

  // 尝试匹配 music.douyin.com 的完整 URL
  const fullUrlMatch = trimmed.match(
    /https?:\/\/music\.douyin\.com\/qishui\/share\/playlist[^\s]*/,
  );
  if (fullUrlMatch) {
    return fullUrlMatch[0];
  }

  throw new Error('未能从输入中识别汽水音乐歌单链接或 ID');
};

interface QishuiArtist {
  id?: string;
  name?: string;
  simple_display_name?: string;
}

interface QishuiTrack {
  id?: string;
  name?: string;
  duration?: number;
  artists?: QishuiArtist[];
  album?: {
    id?: string;
    name?: string;
  };
}

interface QishuiMedia {
  id?: string;
  type?: string;
  entity?: {
    track?: QishuiTrack;
  };
}

interface QishuiPlaylistInfo {
  id?: string;
  title?: string;
  count_tracks?: number;
  url_cover?: {
    uri?: string;
    urls?: string[];
  };
  owner?: {
    nickname?: string;
    public_name?: string;
  };
}

interface QishuiPageData {
  medias?: QishuiMedia[];
  playlistInfo?: QishuiPlaylistInfo;
}

const normalizeArtist = (artists?: QishuiArtist[]): string => {
  if (!Array.isArray(artists) || artists.length === 0) return '';
  return artists
    .map((a) => a?.name || a?.simple_display_name || '')
    .filter(Boolean)
    .join(' / ');
};

const buildCoverUrl = (urlCover?: QishuiPlaylistInfo['url_cover']): string | undefined => {
  if (!urlCover?.urls?.length || !urlCover.uri) return undefined;
  return `${urlCover.urls[0]}${urlCover.uri}~tplv-b829550vbb-crop-center:720:720.jpg`;
};

const mapTrack = (media: QishuiMedia): ExternalTrack | null => {
  const track = media?.entity?.track;
  if (!track?.name) return null;
  return {
    externalId: track.id || media.id || undefined,
    title: track.name.trim(),
    artist: normalizeArtist(track.artists),
    album: track.album?.name || undefined,
    // 汽水的 duration 单位是毫秒，转为秒
    duration:
      typeof track.duration === 'number' && track.duration > 0
        ? Math.round(track.duration / 1000)
        : undefined,
  };
};

/**
 * 从 HTML 中解析 _ROUTER_DATA 嵌入的歌单数据
 */
const parsePageData = (html: string): QishuiPageData => {
  const startMarker = '_ROUTER_DATA';
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error('无法从汽水音乐页面中提取数据，可能页面结构已变更');
  }
  const jsonStart = html.indexOf('{', startIdx);
  if (jsonStart === -1) {
    throw new Error('无法从汽水音乐页面中定位数据起始位置');
  }
  // JSON 后紧跟 ";\n" + 其他脚本代码
  const endMarkers = [';\nfunction', ';\n</script>', ';\n'];
  let jsonStr = '';
  for (const marker of endMarkers) {
    const endIdx = html.indexOf(marker, jsonStart);
    if (endIdx !== -1) {
      jsonStr = html.slice(jsonStart, endIdx);
      break;
    }
  }
  if (!jsonStr) {
    throw new Error('无法从汽水音乐页面中提取完整数据');
  }

  try {
    const routerData = JSON.parse(jsonStr);
    return routerData?.loaderData?.playlist_page ?? {};
  } catch {
    throw new Error('解析汽水音乐页面数据失败');
  }
};

export const qishuiProvider: ExternalProvider = {
  id: 'qishui',
  canHandle: (input: string) => /qishui\.douyin\.com|music\.douyin\.com\/qishui/.test(input),
  resolve: async (req, ctx): Promise<ExternalPlaylist> => {
    const pageUrl = resolvePageUrl(req.input);

    // 请求歌单分享页面（短链会自动跟随重定向），从嵌入的 SSR 数据中提取歌曲列表
    const html = await ctx.fetchText(pageUrl, { 'User-Agent': UA });
    const pageData = parsePageData(html);

    const playlistInfo = pageData.playlistInfo;
    if (!playlistInfo) {
      throw new Error('汽水音乐返回数据中无歌单信息，可能歌单不存在或为私密歌单');
    }

    const medias = pageData.medias ?? [];
    if (medias.length === 0) {
      throw new Error('该歌单没有歌曲或为私密歌单');
    }

    const tracks = medias.map(mapTrack).filter((t): t is ExternalTrack => t !== null);

    return {
      provider: 'qishui',
      externalId: playlistInfo.id || undefined,
      name: playlistInfo.title || '未命名歌单',
      coverUrl: buildCoverUrl(playlistInfo.url_cover),
      creator: playlistInfo.owner?.nickname || playlistInfo.owner?.public_name || undefined,
      tracks,
    };
  },
};
