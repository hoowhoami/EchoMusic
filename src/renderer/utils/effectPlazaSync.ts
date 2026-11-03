import { reactive } from 'vue';
import {
  BUILTIN_PLUGIN_ID,
  createTaskLifecycleActions,
  createTaskOwner,
  registerTask,
} from '@/plugins/taskPanel';
import { getCommunityAudioEffects, getCommunityImpulseResponseUrls } from '@/api/audioEffect';
import type { CommunityAudioEffectSort } from '@/api/audioEffect';
import type { PluginTaskHandle } from '../../shared/tasks';
import {
  effectPlazaCacheFresh,
  effectPlazaCacheState,
  flushPlazaCacheRevision,
  hydrateEffectPlazaCache,
  markMarketSynced,
  mergeMarketEffects,
  runPlazaCacheBatch,
  setEffectDuration,
} from '@/stores/audioEffectPlazaCache';
import logger from '@/utils/logger';
import { iconMusic } from '@/icons';

// 音效市场后台同步器：模块级单例，不挂在任何组件上。
// 一旦开始即持续运行——用户关闭音效广场/切换布局都不会中断；
// 进度在任务中心展示，可从中止。

const TASK_ID = 'echo:plaza-sync';
const SORTS: CommunityAudioEffectSort[] = [2, 3, 4];
const SYNC_PAGE_SIZE = 50;
const DURATION_CONCURRENCY = 3;
// 时长阶段按固定间隔刷新任务进度，避免上千条逐条触发面板重渲染。
const DURATION_PROGRESS_STEP = 20;
// 时长回填的 revision 主动刷新间隔：候选多、网络慢时避免市场列表长时间显示空时长。
const DURATION_REVISION_FLUSH_STEP = 10;
const DURATION_REVISION_FLUSH_MS = 250;

const taskOwner = createTaskOwner(BUILTIN_PLUGIN_ID);

// 供音效广场 UI 展示的同步进度（列表同步与时长解析合并计数）。
export const plazaSyncState = reactive({
  active: false,
  done: 0,
  total: 0,
  label: '空闲',
});

let syncPromise: Promise<void> | null = null;

const collectDurationCandidates = () =>
  Object.values(effectPlazaCacheState.effects)
    // 纯 VPF 音效没有 IR 文件，永远解析不出时长，不进入候选。
    .filter(
      (entry) => entry.duration === undefined && getCommunityImpulseResponseUrls(entry).length > 0,
    )
    // 按推荐位次优先，先解析用户最常看到的音效。
    .sort(
      (a, b) => (a.ranks[2] ?? Number.MAX_SAFE_INTEGER) - (b.ranks[2] ?? Number.MAX_SAFE_INTEGER),
    );

const syncLists = async (task: PluginTaskHandle, signal: AbortSignal) => {
  let received = 0;
  let estimated = 0;
  let failedSort: CommunityAudioEffectSort | null = null;
  const abortGuard = () => {
    if (signal.aborted) throw new Error('音效广场同步已中止');
  };

  for (const sort of SORTS) {
    abortGuard();
    // 首页响应携带全集 total；三个排序都是同一全集的不同排序，据此估算总条目量。
    let total = 0;
    let page = 1;
    try {
      for (;;) {
        abortGuard();
        const result = await getCommunityAudioEffects(page, SYNC_PAGE_SIZE, sort);
        mergeMarketEffects(result.items, sort, (page - 1) * SYNC_PAGE_SIZE);
        received += result.items.length;
        if (page === 1) {
          total = Math.max(result.total, result.items.length);
          estimated += total;
        }
        const hasMore = result.items.length > 0 && page * SYNC_PAGE_SIZE < total;
        if (!hasMore) break;
        page += 1;
      }
    } catch (error) {
      // 单个排序失败不阻塞其余排序；但不视为同步完成（下次打开会重试）。
      logger.warn('EffectPlazaSync', `Sync sort ${sort} failed`, error);
      if (failedSort === null) failedSort = sort;
    }
    task.update({
      progress: {
        done: received,
        total: estimated,
        percent: estimated > 0 ? Math.min(100, (received / estimated) * 100) : 0,
        label: `同步音效列表 ${received}/${estimated || '…'}`,
      },
    });
  }
  plazaSyncState.done = received;
  plazaSyncState.total = estimated;

  if (failedSort !== null) {
    throw new Error(`音效列表同步失败（排序 ${failedSort}），已保留部分数据`);
  }
  markMarketSynced();
};

const syncDurations = async (task: PluginTaskHandle, signal: AbortSignal) => {
  const candidates = collectDurationCandidates();
  if (!candidates.length) return;
  const abortGuard = () => {
    if (signal.aborted) throw new Error('音效广场同步已中止');
  };
  const total = candidates.length;
  let done = 0;
  const updateProgress = () => {
    task.update({
      progress: {
        done,
        total,
        percent: (done / total) * 100,
        label: `解析音效时长 ${done}/${total}`,
      },
    });
  };
  updateProgress();

  const queue = [...candidates];
  let lastRevisionFlushAt = Date.now();
  const worker = async () => {
    for (;;) {
      abortGuard();
      const entry = queue.shift();
      if (!entry) return;
      try {
        const result = await window.electron.audioEffects.resolveCommunityEffectDuration({
          urls: getCommunityImpulseResponseUrls(entry),
        });
        if (result.duration) setEffectDuration(entry.id, result.duration);
      } catch (error) {
        // 单条失败只跳过，不阻塞队列。
        logger.warn('EffectPlazaSync', 'Resolve effect duration failed', { id: entry.id, error });
      }
      done += 1;
      plazaSyncState.done = done;
      plazaSyncState.total = total;
      plazaSyncState.label = `解析音效时长 ${done}/${total}`;
      if (done % DURATION_PROGRESS_STEP === 0 || done === total) updateProgress();
      const now = Date.now();
      if (
        done % DURATION_REVISION_FLUSH_STEP === 0 ||
        done === total ||
        now - lastRevisionFlushAt >= DURATION_REVISION_FLUSH_MS
      ) {
        flushPlazaCacheRevision();
        lastRevisionFlushAt = now;
      }
    }
  };
  // 时长回填逐条写入缓存：包进批量作用域后失效只记脏，期间按条数/时间主动刷新，
  // 阶段结束（含中止）时再兜底 bump 一次，避免市场列表每回填一首就重跑全量 filter+sort。
  // Promise.all 为 fail-fast：中止时其他在途 worker 可能在批次结束后继续写入，
  // 其失效会各自立即 bump（量很小），不影响列表正确性。
  await runPlazaCacheBatch(() =>
    Promise.all(Array.from({ length: DURATION_CONCURRENCY }, () => worker())),
  );
  abortGuard();
};

const runSync = async (force: boolean) => {
  await hydrateEffectPlazaCache();
  const needListSync = force || !effectPlazaCacheFresh();
  const durationCandidates = needListSync ? [] : collectDurationCandidates();
  // 缓存新鲜且没有待解析时长时，本次打开无需任何后台任务。
  if (!needListSync && durationCandidates.length === 0) return;

  // handle 需先声明供 onAbort 闭包引用，注册完成后才可用。
  const handleRef: { current?: PluginTaskHandle } = {};
  const task = registerTask(taskOwner, {
    id: TASK_ID,
    name: '音效广场同步',
    icon: iconMusic,
    status: 'running',
    retention: 'transient',
    progress: { done: 0, total: 0, percent: 0, label: '正在同步音效列表…' },
    actions: createTaskLifecycleActions({
      status: 'running',
      // 任务中心的“中止”按钮；通过 handle 触发 AbortSignal，同步循环自行退出。
      onAbort: () => {
        handleRef.current?.cancel();
      },
    }),
  });
  handleRef.current = task;

  plazaSyncState.active = true;
  plazaSyncState.done = 0;
  plazaSyncState.total = 0;
  plazaSyncState.label = '正在同步音效列表…';
  try {
    if (needListSync) await syncLists(task, task.signal);
    await syncDurations(task, task.signal);
    task.finish('completed', {
      progress: {
        label: `已同步 ${Object.keys(effectPlazaCacheState.effects).length} 个音效`,
      },
    });
  } catch (error) {
    const aborted = task.signal.aborted;
    logger.warn('EffectPlazaSync', 'Plaza sync failed', error);
    task.finish(aborted ? 'aborted' : 'error', {
      error: aborted ? undefined : error instanceof Error ? error.message : '音效广场同步失败',
    });
  } finally {
    plazaSyncState.active = false;
  }
};

// 幂等入口：已在运行则复用当前任务；force=true 时忽略缓存 TTL 重新全量同步。
export const ensureEffectPlazaSync = (force = false): Promise<void> => {
  if (syncPromise) return syncPromise;
  syncPromise = runSync(force).finally(() => {
    syncPromise = null;
  });
  return syncPromise;
};
