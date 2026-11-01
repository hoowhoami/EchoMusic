import { basename, extname } from 'path';
import type { LocalAudioMetadata } from '../../shared/localMusic';

// music-metadata 依赖树较重（strtok3/token-types/file-type 等），仅扫描本地音乐/云盘上传时需要，
// 惰性加载避免拖慢主进程冷启动。
let parseFileImpl: typeof import('music-metadata').parseFile | null = null;
const loadParseFile = async () => {
  if (!parseFileImpl) {
    ({ parseFile: parseFileImpl } = await import('music-metadata'));
  }
  return parseFileImpl;
};

export const resolveAudioTitleAndArtist = (
  fileName: string,
  metadata?: Pick<LocalAudioMetadata, 'title' | 'artist'>,
): { title: string; artist?: string } => {
  const tagTitle = metadata?.title?.trim();
  const tagArtist = metadata?.artist?.trim();
  const baseName = basename(fileName, extname(fileName)).trim();

  if (tagTitle) {
    return { title: tagTitle, artist: tagArtist || undefined };
  }

  if (tagArtist) {
    return { title: baseName, artist: tagArtist };
  }

  const splitIndex = baseName.indexOf(' - ');
  if (splitIndex > 0 && splitIndex < baseName.length - 3) {
    return {
      title: baseName.slice(splitIndex + 3).trim(),
      artist: baseName.slice(0, splitIndex).trim(),
    };
  }

  return { title: baseName };
};

export const readAudioMetadata = async (filePath: string): Promise<LocalAudioMetadata> => {
  const parseFile = await loadParseFile();
  const parsed = await parseFile(filePath, {
    duration: true,
    skipCovers: true,
  });
  const track = parsed.common.track.no ?? undefined;
  const disk = parsed.common.disk.no ?? undefined;
  return {
    title: parsed.common.title || undefined,
    artist: parsed.common.artist || undefined,
    album: parsed.common.album || undefined,
    duration: parsed.format.duration || undefined,
    year: parsed.common.year || undefined,
    track,
    disk,
    genre: parsed.common.genre || undefined,
  };
};
