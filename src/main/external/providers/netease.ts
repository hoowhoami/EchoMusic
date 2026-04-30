import type { ExternalPlaylist, ExternalTrack } from '../../../shared/external';
import type { ExternalProvider, ProviderContext } from '../types';

const ID_PATTERNS: RegExp[] = [
  /music\.163\.com\/[^\s]*?[?#&]id=(\d+)/i,
  /music\.163\.com\/[^\s]*?playlist[\/]?(\d+)/i,
  /playlist[\/=](\d+)/i,
];

const extractId = (input: string): string | null => {
  const trimmed = input.trim();
  // 纯数字 ID
  if (/^\d{6,}$/.test(trimmed)) return trimmed;
  for (const p of ID_PATTERNS) {
    const m = trimmed.match(p);
    if (m && m[1]) return m[1];
  }
  return null;
};

const normalizeArtist = (ar: unknown): string => {
  if (!Array.isArray(ar)) return '';
  return ar
    .map((a) => (a && typeof a === 'object' ? String((a as any).name ?? '') : ''))
    .filter(Boolean)
    .join(' / ');
};

const mapTrack = (t: any): ExternalTrack | null => {
  const title = String(t?.name ?? '').trim();
  if (!title) return null;
  return {
    externalId: String(t?.id ?? ''),
    title,
    artist: normalizeArtist(t?.ar),
    album: t?.al?.name ? String(t.al.name) : undefined,
    duration:
      typeof t?.dt === 'number' && t.dt > 0
        ? Math.round(t.dt / 1000)
        : typeof t?.duration === 'number' && t.duration > 0
          ? Math.round(t.duration / 1000)
          : undefined,
  };
};

// 批量拉取曲目详情，绕开 playlist/detail 只返回前若干完整曲目的限制
const fetchTrackDetailsByIds = async (
  ctx: ProviderContext,
  ids: string[],
  headers: Record<string, string>,
): Promise<Map<string, ExternalTrack>> => {
  const map = new Map<string, ExternalTrack>();
  const BATCH = 500;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const c = JSON.stringify(slice.map((id) => ({ id })));
    try {
      const body = await ctx.postForm('https://music.163.com/api/v3/song/detail', { c }, headers);
      const songs: any[] = Array.isArray(body?.songs) ? body.songs : [];
      for (const s of songs) {
        const mapped = mapTrack(s);
        if (mapped && mapped.externalId) map.set(mapped.externalId, mapped);
      }
    } catch {
      // 单批失败不阻塞其余批次
    }
  }
  return map;
};

export const neteaseProvider: ExternalProvider = {
  id: 'netease',
  canHandle: (input: string) => {
    return /163\.com|163cn\.tv/.test(input) || extractId(input) !== null;
  },
  resolve: async (req, ctx): Promise<ExternalPlaylist> => {
    let input = req.input;
    // 短链解析
    const shortMatch = input.match(/https?:\/\/163cn\.tv\/[A-Za-z0-9]+/);
    if (shortMatch) {
      try {
        const text = await ctx.fetchText(shortMatch[0]);
        // 短链页通常是一段 JS 重定向，含目标 URL
        const target = text.match(/https?:\/\/[^\s"']*music\.163\.com[^\s"']*/);
        if (target) input = target[0];
      } catch {
        // 忽略短链解析失败，继续用原输入 regex
      }
    }

    const id = extractId(input);
    if (!id) throw new Error('未能从输入中识别网易云歌单 ID');

    const url = `https://music.163.com/api/v6/playlist/detail?id=${id}&n=100000`;
    const headers = {
      Referer: 'https://music.163.com/',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    };

    const body = await ctx.fetchJson(url, headers);
    const playlist = body?.playlist;
    if (!playlist) {
      throw new Error('网易云返回数据为空，可能歌单不存在或为私密歌单');
    }

    const rawTracks: any[] = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    const initialMap = new Map<string, ExternalTrack>();
    for (const t of rawTracks) {
      const mapped = mapTrack(t);
      if (mapped && mapped.externalId) initialMap.set(mapped.externalId, mapped);
    }

    // playlist/detail 仅完整返回前若干首，需要按 trackIds 顺序补齐其余
    const orderedIds: string[] = Array.isArray(playlist.trackIds)
      ? (playlist.trackIds as any[])
          .map((x) => (x && typeof x === 'object' ? String(x.id ?? '') : String(x ?? '')))
          .filter(Boolean)
      : [];

    const missingIds = orderedIds.filter((id) => !initialMap.has(id));
    if (missingIds.length > 0) {
      const fetched = await fetchTrackDetailsByIds(ctx, missingIds, headers);
      for (const [id, tr] of fetched) initialMap.set(id, tr);
    }

    const tracks: ExternalTrack[] =
      orderedIds.length > 0
        ? orderedIds.map((id) => initialMap.get(id)).filter((t): t is ExternalTrack => !!t)
        : Array.from(initialMap.values());

    return {
      provider: 'netease',
      externalId: id,
      name: String(playlist.name ?? '未命名歌单'),
      description: playlist.description ? String(playlist.description) : undefined,
      coverUrl: playlist.coverImgUrl ? String(playlist.coverImgUrl) : undefined,
      creator: playlist.creator?.nickname ? String(playlist.creator.nickname) : undefined,
      tracks,
    };
  },
};
