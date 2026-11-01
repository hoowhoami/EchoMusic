import { reactive, shallowRef } from 'vue';
import { toRecord } from '../../shared/object';
import logger from '@/utils/logger';
import type { CommunityAudioEffect, CommunityAudioEffectSort } from '@/api/audioEffect';

// 音效市场的本地持久化缓存：模块级单例，不随任何组件/弹窗销毁。
// 网络层只负责写入缓存；渲染层（列表、排序、搜索）只读缓存。

export interface PlazaCacheEntry extends CommunityAudioEffect {
  // 同一音效在三种服务端排序（推荐/最热/最新）下的全局位次（1 起）；
  // 缺省表示该排序尚未同步到此条目。三种排序共用一份条目数据。
  ranks: Partial<Record<CommunityAudioEffectSort, number>>;
  // 音效时长（秒）；尚未解析或纯 VPF 音效（无 IR 文件）时缺省。
  duration?: number;
}

const STORAGE_KEY = 'audio-effect-plaza:v1';
// 缓存超过该时长后，下次打开音效广场自动重新全量同步。
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 时长逐条补齐会频繁变更条目，防抖合并写盘。
const PERSIST_DEBOUNCE_MS = 500;

const state = reactive({
  effects: {} as Record<string, PlazaCacheEntry>,
  syncedAt: 0,
  hydrated: false,
});

// 缓存内容变更的标量版本号：市场列表 computed 改为依赖本标量（配合 toRaw 快照），
// 时长逐条回填等高频写入不再逐条击穿全量 filter+sort，批量变更后统一失效一次。
export const plazaCacheRevision = shallowRef(0);

let hydration: Promise<void> | undefined;
let writes = Promise.resolve();
let persistTimer: ReturnType<typeof setTimeout> | undefined;

const normalizeRanks = (value: unknown): Partial<Record<CommunityAudioEffectSort, number>> => {
  const record = toRecord(value);
  const ranks: Partial<Record<CommunityAudioEffectSort, number>> = {};
  for (const sort of [2, 3, 4] as const) {
    const rank = record?.[sort];
    if (typeof rank === 'number' && Number.isSafeInteger(rank) && rank > 0) {
      ranks[sort] = rank;
    }
  }
  return ranks;
};

export const hydrateEffectPlazaCache = (): Promise<void> =>
  (hydration ??= (async () => {
    try {
      const saved = toRecord(await window.electron?.storage?.getKv(STORAGE_KEY));
      if (saved?.version !== 1) return;
      const effects: Record<string, PlazaCacheEntry> = {};
      for (const [key, raw] of Object.entries(toRecord(saved.effects) ?? {})) {
        const record = toRecord(raw);
        const id = Number(record?.id);
        const name = record?.name;
        // 仅校验条目主键与名称；其余字段均来自本应用的 normalize 输出。
        if (!Number.isSafeInteger(id) || id <= 0 || typeof name !== 'string' || !name) continue;
        const entry = record as unknown as PlazaCacheEntry;
        effects[key] = { ...entry, id, name, ranks: normalizeRanks(entry.ranks) };
      }
      state.effects = { ...effects, ...state.effects };
      state.syncedAt = typeof saved.syncedAt === 'number' ? saved.syncedAt : 0;
      state.hydrated = true;
      plazaCacheRevision.value += 1;
    } catch (error) {
      logger.warn('EffectPlazaCache', 'Read plaza cache failed', error);
      state.hydrated = true;
    }
  })());

const persist = () => {
  const snapshot = JSON.parse(
    JSON.stringify({ version: 1, effects: state.effects, syncedAt: state.syncedAt }),
  );
  // 串行写入，避免后完成的旧快照覆盖新快照。
  writes = writes
    .then(async () => {
      try {
        await window.electron?.storage?.setKv(STORAGE_KEY, snapshot);
      } catch (error) {
        logger.warn('EffectPlazaCache', 'Save plaza cache failed', error);
      }
    })
    .catch(() => undefined);
  return writes;
};

const schedulePersist = () => {
  if (persistTimer !== undefined) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void persist();
  }, PERSIST_DEBOUNCE_MS);
};

// 合并一批市场音效条目；position 为该条目在当前排序列表中的全局位次（1 起）。
export const mergeMarketEffects = (
  items: readonly CommunityAudioEffect[],
  sort: CommunityAudioEffectSort,
  startPosition: number,
) => {
  items.forEach((item, index) => {
    const key = String(item.id);
    const existing = state.effects[key];
    const ranks = { ...existing?.ranks, [sort]: startPosition + index };
    state.effects[key] = existing
      ? // 保留缓存中已有的时长；列表字段以最新响应为准。
        { ...existing, ...item, ranks }
      : { ...item, ranks };
  });
  plazaCacheRevision.value += 1;
  schedulePersist();
};

export const setEffectDuration = (id: number, seconds: number) => {
  const entry = state.effects[String(id)];
  if (!entry || !Number.isFinite(seconds) || seconds <= 0) return;
  entry.duration = seconds;
  plazaCacheRevision.value += 1;
  schedulePersist();
};

export const markMarketSynced = () => {
  state.syncedAt = Date.now();
  schedulePersist();
};

export const effectPlazaCacheFresh = () =>
  state.syncedAt > 0 && Date.now() - state.syncedAt < CACHE_TTL_MS;

export const effectPlazaCacheState = state;
