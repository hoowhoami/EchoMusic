import type { ExternalPlaylist } from '../../../shared/external';
import type { ExternalProvider } from '../types';

const ID_PATTERNS: RegExp[] = [
  /y\.qq\.com\/n\/ryqq\/playlist\/(\d+)/i,
  /[?&]id=(\d+)/i,
  /[?&]disstid=(\d+)/i,
];

const extractId = (input: string): string | null => {
  const trimmed = input.trim();
  if (/^\d{6,}$/.test(trimmed)) return trimmed;
  for (const p of ID_PATTERNS) {
    const m = trimmed.match(p);
    if (m && m[1]) return m[1];
  }
  return null;
};

const normalizeArtist = (singers: unknown): string => {
  if (!Array.isArray(singers)) return '';
  return singers
    .map((s) => (s && typeof s === 'object' ? String((s as any).name ?? '') : ''))
    .filter(Boolean)
    .join(' / ');
};

export const qqmusicProvider: ExternalProvider = {
  id: 'qqmusic',
  canHandle: (input: string) => {
    return /y\.qq\.com|qq\.com\/n\/ryqq/.test(input);
  },
  resolve: async (_req, ctx): Promise<ExternalPlaylist> => {
    const id = extractId(_req.input);
    if (!id) throw new Error('未能从输入中识别 QQ 音乐歌单 ID');

    const url =
      `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg` +
      `?type=1&disstid=${id}&format=json&utf8=1&outCharset=utf-8`;
    const headers = {
      Referer: 'https://y.qq.com/',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    };

    const body = await ctx.fetchJson(url, headers);
    const cd = Array.isArray(body?.cdlist) ? body.cdlist[0] : null;
    if (!cd) {
      throw new Error('QQ 音乐返回数据为空，可能歌单不存在或为私密歌单');
    }

    const rawTracks: any[] = Array.isArray(cd.songlist) ? cd.songlist : [];
    const tracks = rawTracks
      .map((t) => ({
        externalId: String(t?.songmid ?? t?.songid ?? ''),
        title: String(t?.songname ?? t?.title ?? '').trim(),
        artist: normalizeArtist(t?.singer),
        album: t?.albumname ? String(t.albumname) : undefined,
        duration: typeof t?.interval === 'number' && t.interval > 0 ? t.interval : undefined,
      }))
      .filter((t) => t.title);

    return {
      provider: 'qqmusic',
      externalId: id,
      name: String(cd.dissname ?? '未命名歌单'),
      description: cd.desc ? String(cd.desc) : undefined,
      coverUrl: cd.logo ? String(cd.logo) : undefined,
      creator: cd.nickname ? String(cd.nickname) : undefined,
      tracks,
    };
  },
};
