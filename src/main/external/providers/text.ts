import type { ExternalPlaylist, ExternalTrack } from '../../../shared/external';
import type { ExternalProvider } from '../types';

const SEPARATOR_PATTERN = /\s+[-—–]\s+|\s*[\t,]\s*/;

const parseLine = (line: string): ExternalTrack | null => {
  const cleaned = line.replace(/^\s*\d+[\.、)）]\s*/, '').trim();
  if (!cleaned) return null;

  const albumMatch = cleaned.match(/[\[【](.+?)[\]】]\s*$/);
  const album = albumMatch ? albumMatch[1].trim() : undefined;
  const withoutAlbum = albumMatch ? cleaned.slice(0, albumMatch.index).trim() : cleaned;

  const parts = withoutAlbum.split(SEPARATOR_PATTERN).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) {
    return { title: parts[0].trim(), artist: '', album };
  }

  // 启发：若第一段较短（< 30）且第二段更长，认为是 "Artist - Title"
  const [first, ...rest] = parts;
  const second = rest.join(' - ').trim();
  return {
    title: second || first.trim(),
    artist: second ? first.trim() : '',
    album,
  };
};

export const textProvider: ExternalProvider = {
  id: 'text',
  canHandle: (input: string) => {
    if (/https?:\/\//i.test(input)) return false;
    return input.split(/\r?\n/).filter((l) => l.trim()).length > 0;
  },
  resolve: async (req): Promise<ExternalPlaylist> => {
    const lines = req.input.split(/\r?\n/);
    const tracks = lines
      .map((line) => parseLine(line))
      .filter((track): track is ExternalTrack => track !== null && track.title.length > 0);

    if (tracks.length === 0) {
      throw new Error('未解析到任何歌曲，请检查格式（每行一首，支持「歌名 - 歌手」）');
    }

    return {
      provider: 'text',
      name: '导入的歌单',
      tracks,
    };
  },
};
