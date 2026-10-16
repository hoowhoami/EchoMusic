/** Display metadata from the reader that opened the current playback source. */
export interface EmbeddedTrackMetadata {
  title?: string;
  artist?: string;
  album?: string;
  lyric?: string;
  coverUrl?: string;
}

export interface EmbeddedMetadataRequest {
  seq: number;
  includeCover: boolean;
}

/** Reader snapshots belong to the active playback, never to retained song collections. */
export function withoutEmbeddedMetadata<T extends { embeddedMetadata?: unknown }>(song: T): T {
  if (song.embeddedMetadata === undefined) return song;
  const result = { ...song };
  delete result.embeddedMetadata;
  return result;
}

/** Replace a fully masked name only when a usable embedded name is available. */
export function resolveMaskedMetadata(value?: string, embedded?: string): string | undefined {
  const replacement = embedded?.trim();
  return /^\*+$/.test(value?.trim() ?? '') && replacement && !/^\*+$/.test(replacement)
    ? replacement
    : value;
}
