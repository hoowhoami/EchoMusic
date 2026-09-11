export interface AlbumDynamicCover {
  albumId: string;
  urls: string[];
}

export interface AlbumCoverResource {
  albumAudioId: string;
  albumId: string;
}

export function normalizeAlbumCoverId(value: unknown): string {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  const id = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(id) && id > 0 ? String(id) : '';
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function mapAlbumDynamicCover(payload: unknown, albumId = ''): AlbumDynamicCover | null {
  const body = record(payload);
  if (Number(body.status) !== 1) throw new Error('Dynamic album cover request failed');
  const entries = Array.isArray(body.data) ? body.data.map(record) : [];
  // Single-song requests have no album_audio_id in the response. Match the album
  // when supplied; never display artwork from another edition in a mixed response.
  const entry = albumId
    ? entries.find((item) => normalizeAlbumCoverId(record(item.base).album_id) === albumId)
    : entries.length === 1
      ? entries[0]
      : undefined;
  if (!entry) return null;
  const cover = record(entry.dycover);
  const candidates = [
    cover.h264_url,
    ...(Array.isArray(cover.h264_backup_url) ? cover.h264_backup_url : []),
  ];
  const urls = [
    ...new Set(
      candidates.flatMap((value) => {
        if (typeof value !== 'string' || !value.trim()) return [];
        try {
          const url = new URL(value.trim());
          return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
            ? [url.href]
            : [];
        } catch {
          return [];
        }
      }),
    ),
  ];
  return urls.length ? { albumId: normalizeAlbumCoverId(record(entry.base).album_id), urls } : null;
}

/** Signed video URLs stay in memory briefly; failures may be retried on the next visit. */
export function createAlbumDynamicCoverLoader(
  fetch: (resource: AlbumCoverResource) => Promise<unknown>,
  now = Date.now,
) {
  const cache = new Map<string, { expires: number; value: AlbumDynamicCover | null }>();
  const pending = new Map<string, Promise<AlbumDynamicCover | null>>();
  return (audioId: unknown, albumId?: unknown): Promise<AlbumDynamicCover | null> => {
    const resource = {
      albumAudioId: normalizeAlbumCoverId(audioId),
      albumId: normalizeAlbumCoverId(albumId),
    };
    if (!resource.albumAudioId) return Promise.resolve(null);
    const key = `${resource.albumAudioId}:${resource.albumId}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) {
      cache.delete(key);
      cache.set(key, cached);
      return Promise.resolve(cached.value);
    }
    cache.delete(key);
    const existing = pending.get(key);
    if (existing) return existing;
    const request = Promise.resolve()
      .then(() => fetch(resource))
      .then((payload) => {
        const value = mapAlbumDynamicCover(payload, resource.albumId);
        cache.set(key, { value, expires: now() + 5 * 60_000 });
        while (cache.size > 64) cache.delete(cache.keys().next().value!);
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
}
