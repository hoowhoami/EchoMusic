import { getSongMetadata } from '@/api/music';
import type { Song } from '@/models/song';
import { applyMissingSongMetadata, needsSongMetadata } from '@/utils/mappers/songMetadata';
import { getArray, getRecord, isRecord, readPositiveId, readString } from '@/utils/mappers/shared';
import logger from '@/utils/logger';

const BATCH_SIZE = 100;
const MAX_CONCURRENT_REQUESTS = 3;
const SUCCESS_TTL_MS = 24 * 60 * 60_000;
const EMPTY_TTL_MS = 30 * 60_000;
const MAX_CACHE_ENTRIES = 2_000;
const FAILURE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

type MetadataRecord = Record<string, unknown>;
type CacheEntry = { record: MetadataRecord | null; expiresAt: number };
type PendingEntry = {
  promise: Promise<MetadataRecord | null>;
  resolve: (record: MetadataRecord | null) => void;
  consumers: Set<() => boolean>;
};

type MetadataRuntime = {
  fetch: (ids: string[]) => Promise<unknown>;
  now: () => number;
};

/** 全局并发控制、逐歌曲去重和有界缓存；元数据为公开信息，不缓存账号或授权。 */
export const createSongMetadataCompleter = ({ fetch, now }: MetadataRuntime) => {
  const cache = new Map<string, CacheEntry>();
  const pending = new Map<string, PendingEntry>();
  const queue = new Set<string>();
  let running = 0;
  let cooldownUntil = 0;
  let failures = 0;

  const readCache = (id: string): CacheEntry | undefined => {
    const entry = cache.get(id);
    if (!entry) return;
    cache.delete(id);
    if (entry.expiresAt <= now()) return;
    cache.set(id, entry);
    return entry;
  };
  const remember = (id: string, record: MetadataRecord | null) => {
    cache.delete(id);
    cache.set(id, { record, expiresAt: now() + (record ? SUCCESS_TTL_MS : EMPTY_TTL_MS) });
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  };
  const finish = (id: string, record: MetadataRecord | null) => {
    const entry = pending.get(id);
    pending.delete(id);
    queue.delete(id);
    entry?.resolve(record);
  };
  const active = (id: string) => {
    const consumers = pending.get(id)?.consumers;
    if (!consumers) return false;
    for (const isCurrent of consumers) {
      if (isCurrent()) return true;
      consumers.delete(isCurrent);
    }
    return false;
  };

  const fetchBatch = async (ids: string[]) => {
    try {
      const payload = await fetch(ids);
      if (isRecord(payload) && payload.status === 0) {
        throw Object.assign(new Error('Song metadata request failed'), {
          metadataRejected: true,
        });
      }
      const records = new Map<string, MetadataRecord>();
      const data = isRecord(payload) ? (getArray(payload.data) ?? []) : [];
      for (const record of data.filter(isRecord)) {
        const base = getRecord(record, 'base');
        const id = readPositiveId(base?.album_audio_id);
        if (!id || record.__status === 0) continue;
        const album = getRecord(record, 'album_info');
        // 仅保留补全所需字段，避免把大块响应和无关内容留在内存中。
        records.set(id, {
          base: { album_audio_id: id, album_id: readPositiveId(base?.album_id) },
          album_info: {
            album_id: readPositiveId(album?.album_id),
            album_name: readString(album?.album_name || base?.album_name),
            cover: readString(album?.cover),
          },
          authors: (getArray(record.authors) ?? []).filter(isRecord).map((author) => {
            const data = getRecord(author, 'base');
            return {
              base: {
                author_id: readPositiveId(data?.author_id),
                author_name: readString(data?.author_name),
                avatar: readString(data?.avatar),
              },
            };
          }),
        });
      }
      if (now() >= cooldownUntil) failures = 0;
      for (const id of ids) {
        const record = records.get(id) ?? null;
        remember(id, record);
        finish(id, record);
      }
    } catch (error) {
      const wasCooling = now() < cooldownUntil;
      if (!wasCooling) failures += 1;
      const response = isRecord(error) ? getRecord(error, 'response') : undefined;
      const status = response?.status;
      const baseBackoff =
        status === 403 || status === 429 || (isRecord(error) && error.metadataRejected === true)
          ? MAX_BACKOFF_MS
          : Math.min(FAILURE_BACKOFF_MS * 2 ** Math.min(failures - 1, 5), MAX_BACKOFF_MS);
      const retryAfter = getRecord(response ?? {}, 'headers')?.['retry-after'];
      const retryValue =
        typeof retryAfter === 'string' || typeof retryAfter === 'number'
          ? String(retryAfter).trim()
          : '';
      const retryDelay = retryValue
        ? /^\d+(?:\.\d+)?$/.test(retryValue)
          ? Number(retryValue) * 1000
          : Date.parse(retryValue) - now()
        : 0;
      const backoff = Math.max(baseBackoff, Number.isFinite(retryDelay) ? retryDelay : 0);
      cooldownUntil = Math.max(cooldownUntil, now() + backoff);
      if (!wasCooling)
        logger.warn(
          'SongMetadata',
          `Metadata requests paused for ${backoff / 1000}s after a failed request`,
        );
      for (const id of ids) finish(id, null);
    }
  };

  const drain = () => {
    if (now() < cooldownUntil) {
      for (const id of queue) finish(id, null);
      return;
    }
    for (const id of queue) if (!active(id)) finish(id, null);
    while (queue.size && running < MAX_CONCURRENT_REQUESTS) {
      const ids = Array.from(queue).slice(0, BATCH_SIZE);
      for (const id of ids) queue.delete(id);
      running += 1;
      void fetchBatch(ids).finally(() => {
        running -= 1;
        drain();
      });
    }
  };

  return async (songs: readonly Song[], isCurrent: () => boolean = () => true): Promise<Song[]> => {
    if (!isCurrent()) return Array.from(songs);
    const ids = [
      ...new Set(songs.filter(needsSongMetadata).map((song) => readPositiveId(song.albumAudioId))),
    ];
    const tasks = ids.map((id) => {
      const cached = readCache(id);
      if (cached) return Promise.resolve(cached.record);
      let entry = pending.get(id);
      if (entry) {
        entry.consumers.add(isCurrent);
        return entry.promise;
      }
      if (now() < cooldownUntil) return Promise.resolve(null);
      let resolve!: PendingEntry['resolve'];
      const promise = new Promise<MetadataRecord | null>((done) => {
        resolve = done;
      });
      entry = { promise, resolve, consumers: new Set([isCurrent]) };
      pending.set(id, entry);
      queue.add(id);
      return promise;
    });
    // 同一轮分页请求先合并 ID，再按并发上限发送。
    if (queue.size) void Promise.resolve().then(drain);
    const records = await Promise.all(tasks);
    if (!isCurrent()) return Array.from(songs);
    return applyMissingSongMetadata(songs, { data: records.filter((record) => record !== null) });
  };
};

export const completeSongMetadata = createSongMetadataCompleter({
  fetch: getSongMetadata,
  now: Date.now,
});
