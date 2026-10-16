import type { Song } from '@/models/song';
import type { EmbeddedTrackMetadata } from '../../../shared/embeddedMetadata';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const known = (value: unknown, placeholders: readonly string[]) => {
  const name = text(value);
  return !!name && !placeholders.includes(name.toLowerCase());
};
const hasTitle = (value: unknown) => known(value, ['未知歌曲', 'unknown title', 'unknown']);
const hasArtist = (value: unknown) =>
  known(value, ['未知歌手', '未知艺术家', 'unknown artist', 'unknown']);
const hasAlbum = (value: unknown) => known(value, ['未知专辑', 'unknown album', 'unknown']);
const hasArtists = (song: Song) =>
  [song.artists, song.singers].some((artists) => artists?.some((artist) => hasArtist(artist.name)));

export const missingEmbeddedMetadata = (song: Song, hasLoadedLyric = false) => ({
  title: !hasTitle(song.title) && !hasTitle(song.name),
  artist: !hasArtist(song.artist) && !hasArtists(song),
  album: !hasAlbum(song.albumName) && !hasAlbum(song.album),
  // An embedded URL can outlive its bounded disk-cache entry in a queue/history.
  // Refresh it from the active reader once per playback, without another IPC or audio request.
  cover:
    !(text(song.coverUrl) || text(song.cover)) ||
    (text(song.coverUrl) || text(song.cover)).startsWith('echo-player-cover:'),
  lyric: !hasLoadedLyric,
});

/** Tags may fill display fields; they never supply catalog IDs or playback identity. */
export function applyEmbeddedMetadata(
  song: Song,
  metadata: EmbeddedTrackMetadata,
  hasLoadedLyric = false,
): Song {
  const missing = missingEmbeddedMetadata(song, hasLoadedLyric);
  const patch: Partial<Song> = {};
  const title = text(metadata.title) || song.embeddedMetadata?.title;
  const artist = text(metadata.artist) || song.embeddedMetadata?.artist;
  const lyric = text(metadata.lyric) || song.embeddedMetadata?.lyric;
  if (
    (title || artist || lyric) &&
    (title !== song.embeddedMetadata?.title ||
      artist !== song.embeddedMetadata?.artist ||
      lyric !== song.embeddedMetadata?.lyric)
  )
    patch.embeddedMetadata = { title, artist, lyric };
  if (missing.title && text(metadata.title)) patch.title = patch.name = text(metadata.title);
  if (missing.artist && text(metadata.artist)) {
    patch.artist = text(metadata.artist);
    patch.artists = patch.singers = [{ name: patch.artist }];
  }
  if (missing.album && text(metadata.album)) patch.albumName = patch.album = text(metadata.album);
  if (missing.cover && text(metadata.coverUrl))
    patch.coverUrl = patch.cover = text(metadata.coverUrl);
  return Object.keys(patch).length ? { ...song, ...patch } : song;
}

type Lyrics = {
  loadedHash?: string;
  rawLyric?: string;
  lines?: unknown[];
  detailResolved?: boolean;
  embeddedLyricSelectionMap?: Record<string, boolean>;
  currentCandidateKey?: string;
  fetchLyrics(
    hash: string,
    options: {
      track: Song;
      duration?: number;
      preserveCurrent?: boolean;
      isCurrent: () => boolean;
    },
  ): Promise<void>;
};

/** One optional task for the active file, independent of play success/failure. */
export function createEmbeddedMetadataCompleter(runtime: {
  read: (seq: number, includeCover: boolean) => Promise<EmbeddedTrackMetadata | null>;
  lyrics: Lyrics;
  current: () => { seq: number | null; requestSeq: number; song: Song | null; duration?: number };
  captureSession: () => () => boolean;
  commit: (previous: Song, next: Song) => void;
  onError: (error: unknown) => void;
}) {
  let attemptedKey = '';
  return async () => {
    const context = runtime.current();
    const { seq, requestSeq, song } = context;
    if (!seq || !song) return;
    const hash = String(song.hash || song.id || '');
    const hasManualEmbeddedChoice = () => Boolean(runtime.lyrics.embeddedLyricSelectionMap?.[hash]);
    const hasLoadedLyric = () =>
      runtime.lyrics.loadedHash === hash &&
      Boolean(runtime.lyrics.detailResolved) &&
      runtime.lyrics.currentCandidateKey !== 'embedded' &&
      (!!runtime.lyrics.lines?.length || !!text(runtime.lyrics.rawLyric));
    const missing = missingEmbeddedMetadata(song, hasLoadedLyric() && !hasManualEmbeddedChoice());
    // A replay must discover its own embedded lyric even if display fields/online lyrics exist.
    if (!Object.values(missing).some(Boolean) && song.embeddedMetadata !== undefined) return;
    const key = `${requestSeq}:${seq}:${song.id}`;
    if (attemptedKey === key) return;
    attemptedKey = key;
    const sessionCurrent = runtime.captureSession();
    const isCurrent = () => {
      const now = runtime.current();
      return (
        sessionCurrent() &&
        now.seq === seq &&
        now.requestSeq === requestSeq &&
        now.song?.id === song.id &&
        now.song?.hash === song.hash
      );
    };
    try {
      const metadata = await runtime.read(seq, missing.cover);
      if (!metadata || !isCurrent()) return;
      // Recheck live fields: an API/lyric result may have arrived while IPC was pending.
      const current = runtime.current().song!;
      const next = applyEmbeddedMetadata(current, metadata, hasLoadedLyric());
      if (next !== current) runtime.commit(current, next);
      if (hasLoadedLyric() && !hasManualEmbeddedChoice()) return;
      if (
        next.embeddedMetadata?.title ||
        next.embeddedMetadata?.artist ||
        next.embeddedMetadata?.lyric
      ) {
        const duration = runtime.current().duration || next.duration;
        await runtime.lyrics.fetchLyrics(hash, {
          track: next,
          preserveCurrent: true,
          duration: duration ? duration * 1000 : undefined,
          isCurrent,
        });
      }
    } catch (error) {
      if (isCurrent()) runtime.onError(error);
    }
  };
}
