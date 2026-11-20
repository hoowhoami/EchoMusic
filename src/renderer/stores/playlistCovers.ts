import { defineStore } from 'pinia';
import { shallowRef } from 'vue';
import type { PlaylistMeta } from '@/models/playlist';
import type { Song } from '@/models/song';
import {
  buildPlaylistCoverEntry,
  playlistCoverKey,
  manualPlaylistCoverKey,
  readPlaylistPageVersion,
  readPlaylistVersion,
  type PlaylistCoverEntry,
} from '@/utils/playlistCover';
import { toRecord } from '../../shared/object';
import logger from '@/utils/logger';

const STORAGE_KEY = 'playlist:auto-covers:v1';
// 单账号下最多保留的封面缓存条数；超出后按最近使用顺序淘汰最旧条目。
const MAX_COVER_ENTRIES = 200;

export const usePlaylistCoversStore = defineStore('playlist-covers', () => {
  const entries = shallowRef<Record<string, PlaylistCoverEntry>>({});
  let hydration: Promise<void> | undefined;
  let writes = Promise.resolve();
  // 最近使用序号（仅内存态，不持久化）：读取和写入都会刷新；
  // 重启后按 KV 中的键顺序重新建立，保证淘汰顺序稳定。
  const touchOrder = new Map<string, number>();
  let touchClock = 0;

  const touch = (key: string) => {
    touchOrder.set(key, ++touchClock);
  };

  // 按最近使用序号淘汰最旧条目，返回裁剪后的新对象。
  const pruneEntries = (next: Record<string, PlaylistCoverEntry>) => {
    const keys = Object.keys(next);
    const overflow = keys.length - MAX_COVER_ENTRIES;
    if (overflow <= 0) return next;
    const evict = keys
      .slice()
      .sort((left, right) => (touchOrder.get(left) ?? 0) - (touchOrder.get(right) ?? 0))
      .slice(0, overflow);
    for (const key of evict) {
      delete next[key];
      touchOrder.delete(key);
    }
    return next;
  };

  const commitEntries = (next: Record<string, PlaylistCoverEntry>, touchedKey?: string) => {
    if (touchedKey) touch(touchedKey);
    entries.value = pruneEntries(next);
  };

  function hydrate() {
    return (hydration ??= (async () => {
      try {
        const saved = toRecord(await window.electron?.storage?.getKv(STORAGE_KEY));
        const valid: Record<string, PlaylistCoverEntry> = {};
        for (const [key, raw] of Object.entries(saved)) {
          const entry = toRecord(raw);
          const listVer = readPlaylistVersion(entry.listVer);
          if (
            /^(?:\d+:\d+|manual:\d+:[01]:\d+)$/.test(key) &&
            listVer !== undefined &&
            typeof entry.coverUrl === 'string'
          ) {
            valid[key] = {
              listVer,
              coverUrl: entry.coverUrl,
              ...(entry.selection === 'sort' ? { selection: 'sort' as const } : {}),
            };
            // 以持久化顺序作为初始最近使用顺序（越靠后越新）。
            touch(key);
          }
        }
        entries.value = pruneEntries({ ...valid, ...entries.value });
      } catch (error) {
        logger.warn('PlaylistCovers', 'Read cover cache failed', error);
      }
    })());
  }

  function coverFor(playlist: PlaylistMeta, userId: number | undefined) {
    if (playlist.hasCustomCover) return playlist.pic;
    const manualKey = manualPlaylistCoverKey(playlist, userId);
    if (manualKey && entries.value[manualKey]) {
      touch(manualKey);
      return entries.value[manualKey].coverUrl;
    }
    const key = playlistCoverKey(playlist, userId);
    if (!key) return playlist.pic;
    // 版本变化时暂时沿用旧封面，完整加载后再替换。空字符串是已确认无图的结果。
    const cached = entries.value[key];
    if (!cached) return playlist.pic;
    touch(key);
    return cached.coverUrl;
  }

  async function updateFromPages(
    playlist: PlaylistMeta,
    userId: number | undefined,
    pages: readonly unknown[],
    isCurrent: () => boolean,
    enrichedSongs?: readonly Song[],
  ) {
    const key = playlistCoverKey(playlist, userId);
    if (!key || playlist.hasCustomCover) return;
    await hydrate();
    if (!isCurrent()) return;
    const manualKey = manualPlaylistCoverKey(playlist, userId);
    if (manualKey && entries.value[manualKey]) return;
    const version = readPlaylistPageVersion(pages[0]);
    const cached = entries.value[key];
    if (
      version === undefined ||
      (cached && cached.listVer > version) ||
      (!enrichedSongs && cached?.listVer === version && cached.selection === 'sort')
    )
      return;
    const entry = buildPlaylistCoverEntry(pages, enrichedSongs);
    if (!entry || !isCurrent()) return;
    if (
      cached?.listVer === entry.listVer &&
      cached.coverUrl === entry.coverUrl &&
      cached.selection === 'sort'
    )
      return;
    commitEntries({ ...entries.value, [key]: { ...entry, selection: 'sort' } }, key);
    await persist();
  }

  async function setManualCover(
    playlist: PlaylistMeta,
    userId: number | undefined,
    isCurrent: () => boolean,
  ) {
    const key = manualPlaylistCoverKey(playlist, userId);
    if (!key) return;
    await hydrate();
    if (!isCurrent()) return;
    commitEntries(
      {
        ...entries.value,
        [key]: { listVer: playlist.listVer ?? 0, coverUrl: playlist.pic },
      },
      key,
    );
    await persist();
  }

  async function persist() {
    // entries 内条目均整体替换、从不原地修改，浅拷贝顶层即可得到稳定快照，
    // 避免每次写入都做全量 JSON 深拷贝。
    const snapshot = { ...entries.value };
    // 串行写入，避免不同歌单先后完成时旧快照覆盖新快照。
    writes = writes.then(async () => {
      try {
        await window.electron?.storage?.setKv(STORAGE_KEY, snapshot);
      } catch (error) {
        logger.warn('PlaylistCovers', 'Save cover cache failed', error);
      }
    });
    await writes;
  }

  return { entries, hydrate, coverFor, updateFromPages, setManualCover };
});
