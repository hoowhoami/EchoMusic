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

const fetchMissedTracks = async (task: NativeImportTask): Promise<NativeImportMissedTrack[]> => {
  if (!task.listid || !task.missed_num) return [];
  const pageSize = 100;
  const pageCount = Math.ceil(Number(task.missed_num) / pageSize);
  const missed: NativeImportMissedTrack[] = [];
  for (let page = 1; page <= pageCount; page++) {
    const response = await getImportTaskResult(task.listid, page, pageSize);
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
  const intervalMs = Math.max(500, callbacks.intervalMs ?? 1500);

  while (!callbacks.shouldStop?.()) {
    const response = await getImportTaskStatuses([taskId]);
    const data = responseData<NativeImportTask[] | NativeImportTask>(response);
    const task = Array.isArray(data) ? data[0] : data;
    if (!task) throw new Error('未查询到导入任务');
    callbacks.onProgress?.(task);

    const status = Number(task.status);
    if (status === 3) {
      return { task, missed: await fetchMissedTracks(task) };
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
