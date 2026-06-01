import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  StoragePlaybackQueueMetaValueMap,
  StoragePlaybackQueueState,
  StoragePlaybackQueueType,
  StoragePlaybackSnapshot,
  StorageAppendQueueItemsPayload,
  StorageQueueIdPayload,
  StorageReplaceQueuePayload,
  StorageRemoveQueueItemPayload,
  StorageReorderQueueItemsPayload,
  StorageResetResult,
  StorageSetQueueCurrentTrackPayload,
  StorageSong,
  StorageUpdateQueueMetaPayload,
} from '../../shared/storage';
import { getDatabase, runInTransaction } from '../db/connection';
import { ensureStorageSchema } from '../db/schema';

const DEFAULT_PLAYBACK_QUEUE_ID = 'queue:default';

type QueueRow = {
  id: string;
  title: string;
  subtitle: string;
  cover_url: string;
  type: string;
  active: number;
  last_non_fm: number;
  current_track_id: string | null;
  filtered_invalid_count: number;
  queued_next_track_ids_json: string;
  dynamic: number;
  meta_json: string;
  created_at: number;
  updated_at: number;
};

type SongRow = {
  payload_json: string;
};

type QueueCountRow = {
  count: number;
};

const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const normalizeSongKey = (song: StorageSong): string => {
  const mixSongId = String(song.mixSongId ?? '');
  if (mixSongId && mixSongId !== '0') return `mx:${mixSongId}`;
  if (song.hash) return `hash:${song.hash.toLowerCase()}`;
  if (song.fileId) return `file:${String(song.fileId)}`;
  return `id:${String(song.id)}`;
};

const normalizeQueue = (queue: StoragePlaybackQueueState): StoragePlaybackQueueState => ({
  id: String(queue.id || DEFAULT_PLAYBACK_QUEUE_ID),
  title: String(queue.title || '播放列表'),
  subtitle: String(queue.subtitle || ''),
  coverUrl: String(queue.coverUrl || ''),
  type: (queue.type || 'default') as StoragePlaybackQueueType,
  songs: Array.isArray(queue.songs) ? queue.songs : [],
  filteredInvalidCount: Math.max(0, Math.floor(Number(queue.filteredInvalidCount || 0))),
  queuedNextTrackIds: Array.isArray(queue.queuedNextTrackIds)
    ? queue.queuedNextTrackIds.map((id) => String(id)).filter(Boolean)
    : [],
  currentTrackId:
    queue.currentTrackId === undefined || queue.currentTrackId === null
      ? null
      : String(queue.currentTrackId),
  createdAt: Math.floor(Number(queue.createdAt || Date.now())),
  updatedAt: Math.floor(Number(queue.updatedAt || Date.now())),
  dynamic: Boolean(queue.dynamic),
  meta: { ...(queue.meta ?? {}) },
});

const normalizeQueueMeta = (
  queue: Omit<StoragePlaybackQueueState, 'songs'> & { songs?: StorageSong[] },
): StoragePlaybackQueueState => normalizeQueue({ ...queue, songs: queue.songs ?? [] });

export class PlaybackQueueStorage {
  private db: DatabaseSync;

  private upsertQueueStmt: StatementSync;
  private upsertSongStmt: StatementSync;
  private insertQueueItemStmt: StatementSync;
  private deleteQueueItemsStmt: StatementSync;
  private clearActiveStmt: StatementSync;
  private markActiveStmt: StatementSync;
  private clearLastNonFmStmt: StatementSync;
  private markLastNonFmStmt: StatementSync;
  private setCurrentTrackStmt: StatementSync;
  private deleteQueueStmt: StatementSync;
  private updateQueueFlagsStmt: StatementSync;

  constructor(database = getDatabase()) {
    ensureStorageSchema(database);
    this.db = database;
    this.upsertQueueStmt = this.db.prepare(`
      INSERT INTO playback_queues (
        id, title, subtitle, cover_url, type, active, last_non_fm, current_track_id,
        filtered_invalid_count, queued_next_track_ids_json, dynamic, meta_json, created_at, updated_at
      )
      VALUES (
        @id, @title, @subtitle, @coverUrl, @type, @active, @lastNonFm, @currentTrackId,
        @filteredInvalidCount, @queuedNextTrackIdsJson, @dynamic, @metaJson, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        subtitle = excluded.subtitle,
        cover_url = excluded.cover_url,
        type = excluded.type,
        active = excluded.active,
        last_non_fm = excluded.last_non_fm,
        current_track_id = excluded.current_track_id,
        filtered_invalid_count = excluded.filtered_invalid_count,
        queued_next_track_ids_json = excluded.queued_next_track_ids_json,
        dynamic = excluded.dynamic,
        meta_json = excluded.meta_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `);
    this.upsertSongStmt = this.db.prepare(`
      INSERT INTO songs (
        song_key, source_id, hash, title, artist, album, cover_url, duration, payload_json, updated_at
      )
      VALUES (@songKey, @sourceId, @hash, @title, @artist, @album, @coverUrl, @duration, @payloadJson, @updatedAt)
      ON CONFLICT(song_key) DO UPDATE SET
        source_id = excluded.source_id,
        hash = excluded.hash,
        title = excluded.title,
        artist = excluded.artist,
        album = excluded.album,
        cover_url = excluded.cover_url,
        duration = excluded.duration,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `);
    this.insertQueueItemStmt = this.db.prepare(`
      INSERT INTO queue_items (queue_id, song_key, position, added_at)
      VALUES (?, ?, ?, ?)
    `);
    this.deleteQueueItemsStmt = this.db.prepare('DELETE FROM queue_items WHERE queue_id = ?');
    this.clearActiveStmt = this.db.prepare('UPDATE playback_queues SET active = 0');
    this.markActiveStmt = this.db.prepare('UPDATE playback_queues SET active = 1 WHERE id = ?');
    this.clearLastNonFmStmt = this.db.prepare('UPDATE playback_queues SET last_non_fm = 0');
    this.markLastNonFmStmt = this.db.prepare(
      'UPDATE playback_queues SET last_non_fm = 1 WHERE id = ?',
    );
    this.setCurrentTrackStmt = this.db.prepare(`
      UPDATE playback_queues
      SET current_track_id = ?, updated_at = ?
      WHERE id = ?
    `);
    this.deleteQueueStmt = this.db.prepare('DELETE FROM playback_queues WHERE id = ?');
    this.updateQueueFlagsStmt = this.db.prepare(`
      UPDATE playback_queues
      SET active = CASE WHEN id = @activeQueueId THEN 1 ELSE 0 END,
          last_non_fm = CASE WHEN id = @lastNonFmQueueId THEN 1 ELSE 0 END
    `);
  }

  getSnapshot(options?: { hydrateAllSongs?: boolean }): StoragePlaybackSnapshot {
    const rows = this.db
      .prepare('SELECT * FROM playback_queues ORDER BY updated_at DESC, created_at DESC')
      .all() as QueueRow[];
    const activeQueueId =
      rows.find((row) => row.active === 1)?.id ?? rows[0]?.id ?? DEFAULT_PLAYBACK_QUEUE_ID;
    const queues = rows.map((row) =>
      this.hydrateQueue(row, {
        includeSongs: options?.hydrateAllSongs === true || row.id === activeQueueId,
      }),
    );

    return {
      queues,
      activeQueueId,
      lastNonFmQueueId:
        rows.find((row) => row.last_non_fm === 1)?.id ??
        rows.find((row) => row.type !== 'fm')?.id ??
        DEFAULT_PLAYBACK_QUEUE_ID,
    };
  }

  getQueue(payload: StorageQueueIdPayload): StoragePlaybackQueueState | null {
    const queueId = String(payload.queueId || '');
    if (!queueId) return null;
    const row = this.db.prepare('SELECT * FROM playback_queues WHERE id = ?').get(queueId) as
      | QueueRow
      | undefined;
    return row ? this.hydrateQueue(row, { includeSongs: true }) : null;
  }

  replaceQueue(payload: StorageReplaceQueuePayload): StorageResetResult {
    const queue = normalizeQueue(payload.queue);
    runInTransaction(this.db, () => {
      this.upsertQueue(queue, {
        active: queue.id === payload.activeQueueId,
        lastNonFm: queue.id === payload.lastNonFmQueueId,
      });
      this.replaceQueueItems(queue.id, queue.songs);
      this.updateQueueFlags(payload.activeQueueId, payload.lastNonFmQueueId);
    });
    return { ok: true };
  }

  appendQueueItems(payload: StorageAppendQueueItemsPayload): StorageResetResult {
    const queue = normalizeQueueMeta(payload.queue);
    const incoming = Array.isArray(payload.songs) ? payload.songs : [];
    runInTransaction(this.db, () => {
      this.upsertQueue(queue, {
        active: queue.id === payload.activeQueueId,
        lastNonFm: queue.id === payload.lastNonFmQueueId,
      });
      this.appendQueueItemsInternal(queue.id, incoming);
      this.updateQueueFlags(payload.activeQueueId, payload.lastNonFmQueueId);
    });
    return { ok: true };
  }

  updateQueueMeta(payload: StorageUpdateQueueMetaPayload): StorageResetResult {
    const queue = normalizeQueueMeta(payload.queue);
    runInTransaction(this.db, () => {
      this.upsertQueue(queue, {
        active: queue.id === payload.activeQueueId,
        lastNonFm: queue.id === payload.lastNonFmQueueId,
      });
      this.updateQueueFlags(payload.activeQueueId, payload.lastNonFmQueueId);
    });
    return { ok: true };
  }

  removeQueue(payload: StorageQueueIdPayload): StoragePlaybackSnapshot {
    const queueId = String(payload.queueId || '');
    if (queueId) this.deleteQueueStmt.run(queueId);
    return this.getSnapshot();
  }

  clearQueue(payload: StorageUpdateQueueMetaPayload): StorageResetResult {
    const queue = normalizeQueueMeta(payload.queue);
    runInTransaction(this.db, () => {
      this.upsertQueue(queue, {
        active: queue.id === payload.activeQueueId,
        lastNonFm: queue.id === payload.lastNonFmQueueId,
      });
      this.deleteQueueItemsStmt.run(queue.id);
      this.updateQueueFlags(payload.activeQueueId, payload.lastNonFmQueueId);
    });
    return { ok: true };
  }

  removeQueueItem(payload: StorageRemoveQueueItemPayload): StorageResetResult {
    const queueId = String(payload.queueId || '');
    const songId = String(payload.songId ?? '');
    if (!queueId || !songId) return { ok: true };
    const queue = this.getQueue({ queueId });
    if (!queue) return { ok: true };
    const nextSongs = queue.songs.filter((song) => String(song.id) !== songId);
    const nextQueue: StoragePlaybackQueueState = {
      ...queue,
      songs: nextSongs,
      queuedNextTrackIds: payload.queuedNextTrackIds ?? queue.queuedNextTrackIds,
      currentTrackId:
        payload.currentTrackId === undefined ? queue.currentTrackId : payload.currentTrackId,
      updatedAt: payload.updatedAt ?? Date.now(),
    };
    this.replaceQueue({
      queue: nextQueue,
      ...this.getQueueSelection(),
    });
    return { ok: true };
  }

  reorderQueueItems(payload: StorageReorderQueueItemsPayload): StorageResetResult {
    const queueId = String(payload.queueId || '');
    if (!queueId) return { ok: true };
    const queue = this.getQueue({ queueId });
    if (!queue) return { ok: true };
    const nextQueue = {
      ...queue,
      songs: Array.isArray(payload.songs) ? payload.songs : queue.songs,
      updatedAt: payload.updatedAt ?? Date.now(),
    };
    this.replaceQueue({
      queue: nextQueue,
      ...this.getQueueSelection(),
    });
    return { ok: true };
  }

  setQueueCurrentTrack(payload: StorageSetQueueCurrentTrackPayload): StorageResetResult {
    const queueId = String(payload.queueId || '');
    if (!queueId) return { ok: true };
    const trackId =
      payload.trackId === undefined || payload.trackId === null || String(payload.trackId) === ''
        ? null
        : String(payload.trackId);
    this.setCurrentTrackStmt.run(trackId, Date.now(), queueId);
    return { ok: true };
  }

  setActiveQueue(queueId: string): StorageResetResult {
    const resolvedId = String(queueId || '');
    if (!resolvedId) return { ok: true };
    runInTransaction(this.db, () => {
      this.clearActiveStmt.run();
      this.markActiveStmt.run(resolvedId);
      this.clearLastNonFmStmt.run();
      this.markLastNonFmStmt.run(resolvedId);
    });
    return { ok: true };
  }

  resetAll(): void {
    runInTransaction(this.db, () => {
      this.db.prepare('DELETE FROM queue_items').run();
      this.db.prepare('DELETE FROM playback_queues').run();
      this.db.prepare('DELETE FROM songs').run();
      this.db.prepare('DELETE FROM app_kv').run();
    });
  }

  private upsertQueue(
    queue: StoragePlaybackQueueState,
    flags: { active: boolean; lastNonFm: boolean },
  ) {
    this.upsertQueueStmt.run({
      id: queue.id,
      title: queue.title,
      subtitle: queue.subtitle,
      coverUrl: queue.coverUrl,
      type: queue.type,
      active: flags.active ? 1 : 0,
      lastNonFm: flags.lastNonFm ? 1 : 0,
      currentTrackId: queue.currentTrackId,
      filteredInvalidCount: queue.filteredInvalidCount,
      queuedNextTrackIdsJson: JSON.stringify(queue.queuedNextTrackIds),
      dynamic: queue.dynamic ? 1 : 0,
      metaJson: JSON.stringify(queue.meta ?? {}),
      createdAt: queue.createdAt,
      updatedAt: queue.updatedAt,
    });
  }

  private updateQueueFlags(activeQueueId: string, lastNonFmQueueId: string) {
    this.updateQueueFlagsStmt.run({
      activeQueueId: String(activeQueueId || DEFAULT_PLAYBACK_QUEUE_ID),
      lastNonFmQueueId: String(lastNonFmQueueId || activeQueueId || DEFAULT_PLAYBACK_QUEUE_ID),
    });
  }

  private getQueueSelection(): { activeQueueId: string; lastNonFmQueueId: string } {
    const rows = this.db
      .prepare('SELECT id, type, active, last_non_fm FROM playback_queues')
      .all() as Array<{ id: string; type: string; active: number; last_non_fm: number }>;
    const activeQueueId =
      rows.find((row) => row.active === 1)?.id ?? rows[0]?.id ?? DEFAULT_PLAYBACK_QUEUE_ID;
    return {
      activeQueueId,
      lastNonFmQueueId:
        rows.find((row) => row.last_non_fm === 1)?.id ??
        rows.find((row) => row.type !== 'fm')?.id ??
        activeQueueId,
    };
  }

  private replaceQueueItems(queueId: string, songs: StorageSong[]) {
    const now = Date.now();
    this.deleteQueueItemsStmt.run(queueId);
    songs.forEach((song, index) => {
      const songKey = normalizeSongKey(song);
      this.upsertSongStmt.run({
        songKey,
        sourceId: String(song.id ?? ''),
        hash: String(song.hash ?? ''),
        title: String(song.title || song.name || ''),
        artist: String(song.artist || ''),
        album: String(song.album || song.albumName || ''),
        coverUrl: String(song.coverUrl || song.cover || ''),
        duration: Math.max(0, Math.floor(Number(song.duration || 0))),
        payloadJson: JSON.stringify(song),
        updatedAt: now,
      });
      this.insertQueueItemStmt.run(queueId, songKey, index, now);
    });
  }

  private appendQueueItemsInternal(queueId: string, songs: StorageSong[]) {
    if (songs.length === 0) return;
    const now = Date.now();
    const maxPositionRow = this.db
      .prepare('SELECT MAX(position) as position FROM queue_items WHERE queue_id = ?')
      .get(queueId) as { position?: number | null } | undefined;
    let position = Number(maxPositionRow?.position ?? -1) + 1;
    songs.forEach((song) => {
      const songKey = normalizeSongKey(song);
      this.upsertSongStmt.run({
        songKey,
        sourceId: String(song.id ?? ''),
        hash: String(song.hash ?? ''),
        title: String(song.title || song.name || ''),
        artist: String(song.artist || ''),
        album: String(song.album || song.albumName || ''),
        coverUrl: String(song.coverUrl || song.cover || ''),
        duration: Math.max(0, Math.floor(Number(song.duration || 0))),
        payloadJson: JSON.stringify(song),
        updatedAt: now,
      });
      this.insertQueueItemStmt.run(queueId, songKey, position, now);
      position += 1;
    });
  }

  private getQueueSongCount(queueId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM queue_items WHERE queue_id = ?')
      .get(queueId) as QueueCountRow | undefined;
    return Math.max(0, Number(row?.count ?? 0));
  }

  private hydrateQueue(
    row: QueueRow,
    options: { includeSongs?: boolean } = {},
  ): StoragePlaybackQueueState {
    const songCount = this.getQueueSongCount(row.id);
    if (!options.includeSongs) {
      return {
        id: row.id,
        title: row.title,
        subtitle: row.subtitle,
        coverUrl: row.cover_url,
        type: row.type as StoragePlaybackQueueType,
        songs: [],
        songCount,
        filteredInvalidCount: row.filtered_invalid_count,
        queuedNextTrackIds: parseJson<string[]>(row.queued_next_track_ids_json, []),
        currentTrackId: row.current_track_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        dynamic: row.dynamic === 1,
        meta: parseJson<StoragePlaybackQueueMetaValueMap>(row.meta_json, {}),
      };
    }

    const songRows = this.db
      .prepare(
        `
          SELECT songs.payload_json
          FROM queue_items
          INNER JOIN songs ON songs.song_key = queue_items.song_key
          WHERE queue_items.queue_id = ?
          ORDER BY queue_items.position ASC
        `,
      )
      .all(row.id) as SongRow[];
    const songs = songRows
      .map((songRow) => parseJson<StorageSong | null>(songRow.payload_json, null))
      .filter((song): song is StorageSong => Boolean(song));

    return {
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      coverUrl: row.cover_url,
      type: row.type as StoragePlaybackQueueType,
      songs,
      songCount,
      filteredInvalidCount: row.filtered_invalid_count,
      queuedNextTrackIds: parseJson<string[]>(row.queued_next_track_ids_json, []),
      currentTrackId: row.current_track_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      dynamic: row.dynamic === 1,
      meta: parseJson<StoragePlaybackQueueMetaValueMap>(row.meta_json, {}),
    };
  }
}

let playbackQueueStorage: PlaybackQueueStorage | null = null;

export const getPlaybackQueueStorage = () => {
  if (!playbackQueueStorage) playbackQueueStorage = new PlaybackQueueStorage();
  return playbackQueueStorage;
};
