import { basename, extname } from 'path';
import { parseFile } from 'music-metadata';
import type { LocalAudioMetadata } from '../../shared/local-music';

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
