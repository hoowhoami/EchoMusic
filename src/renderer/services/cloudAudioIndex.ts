import { getUserCloud } from '@/api/user';
import type { CloudAudioSource, Song } from '@/models/song';
import { useUserStore } from '@/stores/user';
import { mapCloudSong } from '@/utils/mappers';
import logger from '@/utils/logger';

const CLOUD_AUDIO_INDEX_PAGE_SIZE = 100;

interface CloudAudioIndex {
  byAlbumAudioId: Map<string, CloudAudioSource>;
  byAudioId: Map<string, CloudAudioSource>;
  byHashStd: Map<string, CloudAudioSource>;
  byHash: Map<string, CloudAudioSource>;
}

const createEmptyIndex = (): CloudAudioIndex => ({
  byAlbumAudioId: new Map(),
  byAudioId: new Map(),
  byHashStd: new Map(),
  byHash: new Map(),
});

let index = createEmptyIndex();
let indexedUserId = '';
let pendingRefresh: Promise<void> | null = null;

const normalizePositiveId = (value: unknown): string => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || /^0+$/.test(text)) return '';
  return text;
};

const normalizeHash = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();

const cloneSource = (
  source: CloudAudioSource,
  matchBy?: CloudAudioSource['matchBy'],
): CloudAudioSource => ({
  ...source,
  ...(matchBy ? { matchBy } : {}),
});

const putIfAbsent = (map: Map<string, CloudAudioSource>, key: string, source: CloudAudioSource) => {
  if (!key || map.has(key)) return;
  map.set(key, source);
};

const addCloudAudioSource = (target: CloudAudioIndex, source?: CloudAudioSource) => {
  if (!source?.hash) return;
  putIfAbsent(target.byAlbumAudioId, normalizePositiveId(source.albumAudioId), source);
  putIfAbsent(target.byAudioId, normalizePositiveId(source.audioId), source);
  putIfAbsent(target.byHashStd, normalizeHash(source.hashStd), source);
  putIfAbsent(target.byHash, normalizeHash(source.hash), source);
};

const getPayloadData = (payload: unknown): Record<string, unknown> | null => {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  return record.data && typeof record.data === 'object'
    ? (record.data as Record<string, unknown>)
    : record;
};

const getCloudPageSongs = (payload: unknown): { songs: Song[]; total: number } => {
  const data = getPayloadData(payload);
  const rawList = Array.isArray(data?.list) ? data.list : [];
  const songs = rawList
    .filter((item) => typeof item === 'object' && item !== null)
    .map((item) => mapCloudSong(item));
  const total = Number(data?.list_count ?? data?.count ?? songs.length) || songs.length;
  return { songs, total };
};

export const clearCloudAudioIndex = () => {
  index = createEmptyIndex();
  indexedUserId = '';
  pendingRefresh = null;
};

export const refreshCloudAudioIndex = async (force = false): Promise<void> => {
  const userStore = useUserStore();
  const userId = normalizePositiveId(userStore.info?.userid ?? userStore.info?.userId);
  if (!userStore.isLoggedIn || !userId) {
    clearCloudAudioIndex();
    return;
  }

  if (!force && indexedUserId === userId) return;
  if (pendingRefresh && !force) return pendingRefresh;

  pendingRefresh = (async () => {
    const nextIndex = createEmptyIndex();
    try {
      let page = 1;
      let total = 0;
      let loaded = 0;
      do {
        const res = await getUserCloud(page, CLOUD_AUDIO_INDEX_PAGE_SIZE);
        const parsed = getCloudPageSongs(res);
        if (page === 1) total = parsed.total;
        if (parsed.songs.length === 0) break;
        parsed.songs.forEach((song) => addCloudAudioSource(nextIndex, song.cloudAudioSource));
        loaded += parsed.songs.length;
        page += 1;
      } while (loaded < total);

      index = nextIndex;
      indexedUserId = userId;
    } catch (error) {
      logger.warn('CloudAudioIndex', 'Refresh cloud audio index failed:', error);
    } finally {
      pendingRefresh = null;
    }
  })();

  return pendingRefresh;
};

export const getCloudAudioSourceForSong = async (song: Song): Promise<CloudAudioSource | null> => {
  if (song.source === 'cloud' && song.cloudAudioSource?.hash) {
    return cloneSource(song.cloudAudioSource);
  }

  await refreshCloudAudioIndex(false);

  const albumAudioId = normalizePositiveId(song.albumAudioId ?? song.mixSongId);
  const byAlbumAudioId = index.byAlbumAudioId.get(albumAudioId);
  if (byAlbumAudioId) return cloneSource(byAlbumAudioId, 'albumAudioId');

  const audioId = normalizePositiveId(song.fileId ?? song.songId);
  const byAudioId = index.byAudioId.get(audioId);
  if (byAudioId) return cloneSource(byAudioId, 'audioId');

  const hashStd = normalizeHash((song as Song & { hashStd?: string }).hashStd);
  const byHashStd = index.byHashStd.get(hashStd);
  if (byHashStd) return cloneSource(byHashStd, 'hashStd');

  const hash = normalizeHash(song.hash);
  const byHash = index.byHash.get(hash);
  if (byHash) return cloneSource(byHash, 'hash');

  return null;
};
