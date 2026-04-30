import type { ExternalPlaylist } from '../../../shared/external';
import type { ExternalProvider } from '../types';

const extractId = (input: string): string => {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const patterns = [
    /playlist_detail\/(\d+)/,
    /play_detail\/(\d+)/,
    /playlist\/(\d+)/,
    /[?&]pid=(\d+)/,
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m) return m[1];
  }
  return '';
};

const normalizeArtist = (raw: unknown): string => {
  if (!raw) return '';
  return String(raw).replace(/&/g, '/').trim();
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface KuwoTrack {
  rid?: number | string;
  id?: number | string;
  name?: string;
  songName?: string;
  artist?: string;
  singer?: string;
  album?: string;
  duration?: number;
}

interface KuwoPlaylistData {
  title?: string;
  name?: string;
  info?: string;
  img?: string;
  pic?: string;
  userName?: string;
  total?: number;
  musicList?: KuwoTrack[];
}

export const kuwoProvider: ExternalProvider = {
  id: 'kuwo',
  canHandle: (input: string) => /kuwo\.cn|kuwo\.com/.test(input),
  resolve: async (req, ctx): Promise<ExternalPlaylist> => {
    const id = extractId(req.input);
    if (!id) throw new Error('未能从输入中识别酷我音乐歌单 ID');

    const headers = { 'User-Agent': UA };

    // 分页获取，避免大歌单被截断
    const rn = 100;
    const maxPages = 50;
    const collected: KuwoTrack[] = [];
    let total = 0;
    let meta: KuwoPlaylistData | null = null;
    for (let pn = 1; pn <= maxPages; pn++) {
      // wapi 子域名无需 csrf 校验
      const url = `http://wapi.kuwo.cn/api/www/playlist/playListInfo?pid=${id}&pn=${pn}&rn=${rn}`;
      const body = (await ctx.fetchJson(url, headers)) as {
        code?: number;
        msg?: string;
        data?: KuwoPlaylistData;
      };
      if (body?.code !== 200) {
        throw new Error(body?.msg || '酷我音乐返回失败，可能歌单不存在或为私密歌单');
      }
      const data = body.data ?? {};
      if (pn === 1) {
        meta = data;
        total = Number(data.total ?? 0);
      }
      const list = Array.isArray(data.musicList) ? data.musicList : [];
      if (list.length === 0) break;
      collected.push(...list);
      if (total > 0 && collected.length >= total) break;
      if (list.length < rn) break;
    }

    if (!meta) throw new Error('酷我音乐返回数据为空');

    const tracks = collected
      .map((t) => ({
        externalId: String(t?.rid ?? t?.id ?? ''),
        title: String(t?.name ?? t?.songName ?? '').trim(),
        artist: normalizeArtist(t?.artist ?? t?.singer),
        album: t?.album ? String(t.album) : undefined,
        duration: typeof t?.duration === 'number' && t.duration > 0 ? t.duration : undefined,
      }))
      .filter((t) => t.title);

    return {
      provider: 'kuwo',
      externalId: id,
      name: String(meta.title ?? meta.name ?? '未命名歌单'),
      description: meta.info ? String(meta.info) : undefined,
      coverUrl: meta.img ? String(meta.img) : meta.pic ? String(meta.pic) : undefined,
      creator: meta.userName ? String(meta.userName) : undefined,
      tracks,
    };
  },
};
