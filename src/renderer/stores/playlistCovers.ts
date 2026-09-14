import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { PlaylistMeta } from '@/models/playlist';
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

export const usePlaylistCoversStore = defineStore('playlist-covers', () => {
  const entries = ref<Record<string, PlaylistCoverEntry>>({});
  let hydration: Promise<void> | undefined;
  let writes = Promise.resolve();

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
          }
        }
        entries.value = { ...valid, ...entries.value };
      } catch (error) {
        logger.warn('PlaylistCovers', 'Read cover cache failed', error);
      }
    })());
  }

  function coverFor(playlist: PlaylistMeta, userId: number | undefined) {
    if (playlist.hasCustomCover) return playlist.pic;
    const manualKey = manualPlaylistCoverKey(playlist, userId);
    if (manualKey && entries.value[manualKey]) return entries.value[manualKey].coverUrl;
    const key = playlistCoverKey(playlist, userId);
    // 版本变化时暂时沿用旧封面，完整加载后再替换。空字符串是已确认无图的结果。
    return key ? (entries.value[key]?.coverUrl ?? playlist.pic) : playlist.pic;
  }

  async function updateFromPages(
    playlist: PlaylistMeta,
    userId: number | undefined,
    pages: readonly unknown[],
    isCurrent: () => boolean,
  ) {
    const key = playlistCoverKey(playlist, userId);
    if (!key || playlist.hasCustomCover) return;
    await hydrate();
    if (!isCurrent()) return;
    const manualKey = manualPlaylistCoverKey(playlist, userId);
    if (manualKey && entries.value[manualKey]) return;
    const version = readPlaylistPageVersion(pages[0]);
    const cached = entries.value[key];
    if (version === undefined || (cached?.listVer === version && cached.selection === 'sort'))
      return;
    const entry = buildPlaylistCoverEntry(pages);
    if (!entry || !isCurrent()) return;
    entries.value = { ...entries.value, [key]: { ...entry, selection: 'sort' } };
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
    entries.value = {
      ...entries.value,
      [key]: { listVer: playlist.listVer ?? 0, coverUrl: playlist.pic },
    };
    await persist();
  }

  async function persist() {
    const snapshot = JSON.parse(JSON.stringify(entries.value));
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
