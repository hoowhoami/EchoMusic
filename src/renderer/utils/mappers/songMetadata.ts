import type { Song } from '@/models/song';
import {
  buildArtists,
  getArray,
  getRecord,
  isRecord,
  normalizeCoverUrl,
  readPositiveId,
  readString,
} from './shared';

export const needsSongMetadata = (song: Song): boolean =>
  !!readPositiveId(song.albumAudioId) &&
  (!song.coverUrl ||
    !readPositiveId(song.albumId) ||
    !song.albumName ||
    !song.artists?.length ||
    song.artists.some((artist) => !readPositiveId(artist.id)));

/** 只按专辑歌曲 ID 关联；补展示字段，不替换收藏、音源或版权身份。 */
export const applyMissingSongMetadata = (songs: readonly Song[], payload: unknown): Song[] => {
  if (!isRecord(payload)) return Array.from(songs);
  const records = new Map(
    (getArray(payload.data) ?? [])
      .filter(isRecord)
      .map((record) => [readPositiveId(getRecord(record, 'base')?.album_audio_id), record]),
  );
  return songs.map((song) => {
    if (!needsSongMetadata(song)) return song;
    const id = readPositiveId(song.albumAudioId);
    const record = id ? records.get(id) : undefined;
    if (!record || record.__status === 0) return song;
    const base = getRecord(record, 'base');
    const album = getRecord(record, 'album_info');
    const patch: Partial<Song> = {};
    const cover = normalizeCoverUrl(readString(album?.cover), 400);
    if (!song.coverUrl && cover) {
      patch.coverUrl = cover;
      if (!song.cover) patch.cover = cover;
    }
    const albumId = readPositiveId(album?.album_id, base?.album_id);
    if (!readPositiveId(song.albumId) && albumId) patch.albumId = albumId;
    const albumName = readString(album?.album_name || base?.album_name).trim();
    if (!song.albumName && albumName) patch.albumName = albumName;
    if (!song.album && albumName) patch.album = albumName;
    const authors = (getArray(record.authors) ?? [])
      .filter(isRecord)
      .map((author) => getRecord(author, 'base'))
      .filter(isRecord);
    const artists = buildArtists({ authors }, {});
    if (artists.length) {
      const current = song.artists?.length ? song.artists : song.singers;
      const hasKnownArtists = current?.some(
        (artist) => readPositiveId(artist.id) || (artist.name && artist.name !== '未知歌手'),
      );
      const merged =
        current?.length && hasKnownArtists
          ? current.map((artist) => {
              const match = artists.find((candidate) => candidate.name === artist.name);
              return match && !readPositiveId(artist.id) && readPositiveId(match.id)
                ? { ...artist, id: match.id, pic: artist.pic || match.pic }
                : artist;
            })
          : artists;
      if (!hasKnownArtists || merged.some((artist, index) => artist !== current?.[index])) {
        patch.artists = merged;
        patch.singers = merged;
        if (!song.artist || song.artist === '未知歌手')
          patch.artist = merged.map((artist) => artist.name).join(', ');
      }
    }
    return Object.keys(patch).length ? { ...song, ...patch } : song;
  });
};
