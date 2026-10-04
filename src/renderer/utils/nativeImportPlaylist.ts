import {
  getImportTaskResult,
  getImportTaskStatuses,
  type NativeImportMissedTrack,
  type NativeImportTask,
  type NativeImportTaskResult,
} from '@/api/importPlaylist';

interface NativeImportCallbacks {
  shouldStop?: () => boolean;
  onProgress?: (task: NativeImportTask) => void;
  intervalMs?: number;
}

export interface NativeImportResult {
  task: NativeImportTask;
  missed: NativeImportMissedTrack[];
}

export class NativeImportUnsupportedError extends Error {
  constructor() {
    super('酷狗云端暂不支持该歌单链接');
    this.name = 'NativeImportUnsupportedError';
  }
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const responseData = <T>(response: unknown): T | null => {
  if (!response || typeof response !== 'object') return null;
  return ((response as { data?: T }).data ?? null) as T | null;
};

const fetchMissedTracks = async (
  task: NativeImportTask,
  shouldStop: () => boolean,
): Promise<NativeImportMissedTrack[] | null> => {
  if (shouldStop()) return null;
  if (!task.listid || !task.missed_num) return [];
  const pageSize = 100;
  const pageCount = Math.ceil(Number(task.missed_num) / pageSize);
  const missed: NativeImportMissedTrack[] = [];
  for (let page = 1; page <= pageCount; page++) {
    if (shouldStop()) return null;
    const response = await getImportTaskResult(task.listid, page, pageSize);
    if (shouldStop()) return null;
    const result = responseData<NativeImportTaskResult>(response);
    if (!result?.missed?.length) break;
    missed.push(...result.missed);
    if (result.missed.length < pageSize) break;
  }
  return missed;
};

export const waitForNativeImport = async (
  taskId: string | number,
  callbacks: NativeImportCallbacks = {},
): Promise<NativeImportResult | null> => {
  const intervalMs = Number.isFinite(callbacks.intervalMs)
    ? Math.max(500, callbacks.intervalMs!)
    : 1500;
  const shouldStop = () => Boolean(callbacks.shouldStop?.());

  while (!shouldStop()) {
    let response: unknown;
    try {
      response = await getImportTaskStatuses([taskId]);
    } catch (error) {
      if (shouldStop()) return null;
      throw error;
    }
    if (shouldStop()) return null;
    const data = responseData<NativeImportTask[] | NativeImportTask>(response);
    const task = Array.isArray(data) ? data[0] : data;
    if (!task) throw new Error('未查询到导入任务');
    const status = Number(task.status);
    callbacks.onProgress?.(task);
    if (shouldStop()) return null;

    if (status === 3) {
      try {
        const missed = await fetchMissedTracks(task, shouldStop);
        if (shouldStop() || missed === null) return null;
        return { task, missed };
      } catch (error) {
        if (shouldStop()) return null;
        throw error;
      }
    }
    if (status >= 10) {
      const taskType = Number(task.task_type ?? task.type ?? 0);
      if (status === 10 && taskType === 0 && Number(task.songs_num || 0) === 0) {
        throw new NativeImportUnsupportedError();
      }
      throw new Error(task.msg || `导入任务失败（状态 ${status}）`);
    }
    await sleep(intervalMs);
  }

  return null;
};
