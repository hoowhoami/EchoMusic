import { computed, reactive, ref } from 'vue';
import type {
  PluginTaskHandle,
  PluginTaskRegistration,
  TaskAction,
  TaskRetentionPolicy,
  TaskStatus,
  TaskTerminalPolicy,
  TerminalTaskStatus,
} from '../../shared/tasks';
import logger from '@/utils/logger';

export type {
  PluginTaskApi,
  PluginTaskHandle,
  PluginTaskPatch,
  PluginTaskRegistration,
  TaskAction,
  TaskActionVariant,
  TaskProgress,
  TaskRetention,
  TaskRetentionPolicy,
  TaskStatus,
  TaskTerminalPolicy,
  TerminalTaskStatus,
} from '../../shared/tasks';

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  running: '进行中',
  completed: '已完成',
  error: '失败',
  aborted: '已中止',
};

const TRANSIENT_TASK_POLICY: TaskTerminalPolicy = {
  completed: { mode: 'auto', delayMs: 5000 },
  error: { mode: 'manual' },
  aborted: { mode: 'auto', delayMs: 3000 },
};

const ACTION_REQUIRED_TASK_POLICY: TaskTerminalPolicy = {
  completed: { mode: 'manual' },
  error: { mode: 'manual' },
  aborted: { mode: 'auto', delayMs: 3000 },
};

export const getTaskStatusLabel = (status: TaskStatus): string =>
  TASK_STATUS_LABELS[status] ?? status;

export const createTaskDetailAction = (
  onClick: TaskAction['onClick'],
  label = '查看详情',
): TaskAction => ({
  id: 'detail',
  label,
  variant: 'ghost',
  closePanel: true,
  onClick,
});

export const createTaskAbortAction = (
  onClick: TaskAction['onClick'],
  id = 'abort',
): TaskAction => ({
  id,
  label: '中止',
  variant: 'ghost',
  onClick,
});

export interface TaskLifecycleActionOptions {
  status: TaskStatus;
  onDetail?: TaskAction['onClick'];
  onAbort?: TaskAction['onClick'];
}

export const createTaskLifecycleActions = ({
  status,
  onDetail,
  onAbort,
}: TaskLifecycleActionOptions): TaskAction[] => {
  if (status === 'running') {
    return [
      ...(onDetail ? [createTaskDetailAction(onDetail)] : []),
      ...(onAbort ? [createTaskAbortAction(onAbort)] : []),
    ];
  }
  if (status === 'completed' && onDetail) {
    return [createTaskDetailAction(onDetail, '查看结果')];
  }
  return [];
};

export interface TaskOwner {
  id: string;
  session: symbol;
  active: boolean;
}

export interface TaskEntry extends Omit<PluginTaskRegistration, 'retention'> {
  terminalPolicy: TaskTerminalPolicy;
  ownerId: string;
  ownerSession: symbol;
  generation: symbol;
  createdAt: number;
  terminalEnteredAt?: number;
  expiresAt?: number;
}

export interface TaskActionRuntime {
  runAction?: (action: TaskAction, invoke: () => void | Promise<void>) => void | Promise<void>;
}

export const BUILTIN_PLUGIN_ID = 'echo:main';

export const taskPanelOpen = ref(false);

export const taskPanelState = reactive<{ entries: Record<string, TaskEntry> }>({
  entries: {},
});

const taskExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const taskAbortControllers = new Map<string, { generation: symbol; controller: AbortController }>();

const isPromiseLike = (value: unknown): value is Promise<unknown> =>
  Boolean(value && typeof (value as Promise<unknown>).then === 'function');

const runTaskAction = (action: TaskAction, runtime?: TaskActionRuntime): void => {
  const invoke = () => action.onClick();
  try {
    const result = runtime?.runAction ? runtime.runAction(action, invoke) : invoke();
    if (isPromiseLike(result)) {
      result.catch((error) => {
        logger.error('TaskPanel', 'Task action failed', {
          actionId: action.id,
          label: action.label,
          error,
        });
      });
    }
  } catch (error) {
    logger.error('TaskPanel', 'Task action failed', {
      actionId: action.id,
      label: action.label,
      error,
    });
  } finally {
    if (action.closePanel) taskPanelOpen.value = false;
  }
};

const normalizeTaskActions = (
  actions: TaskAction[] | undefined,
  runtime?: TaskActionRuntime,
): TaskAction[] | undefined =>
  actions?.map((action) => ({
    ...action,
    onClick: () => runTaskAction(action, runtime),
  }));

const normalizeTaskData = <T extends { actions?: TaskAction[] }>(
  data: T,
  runtime?: TaskActionRuntime,
): T => ({
  ...data,
  ...('actions' in data ? { actions: normalizeTaskActions(data.actions, runtime) } : {}),
});

const clearTaskExpiry = (id: string): void => {
  const timer = taskExpiryTimers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  taskExpiryTimers.delete(id);
};

const normalizeTerminalPolicy = (policy: TaskRetentionPolicy): TaskTerminalPolicy => {
  if (policy === 'transient') return structuredClone(TRANSIENT_TASK_POLICY);
  if (policy === 'action-required') return structuredClone(ACTION_REQUIRED_TASK_POLICY);
  const normalizeRetention = (
    status: TerminalTaskStatus,
  ): TaskTerminalPolicy[TerminalTaskStatus] => {
    const retention = policy?.[status];
    if (retention?.mode === 'manual') return { mode: 'manual' };
    if (
      retention?.mode !== 'auto' ||
      !Number.isFinite(retention.delayMs) ||
      retention.delayMs < 0 ||
      retention.delayMs > 2_147_483_647
    ) {
      throw new TypeError(`任务 ${status} 保留策略无效`);
    }
    return { mode: 'auto', delayMs: retention.delayMs };
  };

  return {
    completed: normalizeRetention('completed'),
    error: normalizeRetention('error'),
    aborted: normalizeRetention('aborted'),
  };
};

const removeTask = (id: string, generation?: symbol): boolean => {
  const entry = taskPanelState.entries[id];
  if (!entry || (generation && entry.generation !== generation)) return false;
  clearTaskExpiry(id);
  const abortState = taskAbortControllers.get(id);
  if (abortState?.generation === entry.generation) {
    abortState.controller.abort();
    taskAbortControllers.delete(id);
  }
  delete taskPanelState.entries[id];
  return true;
};

const scheduleTaskExpiry = (entry: TaskEntry): void => {
  clearTaskExpiry(entry.id);
  if (entry.status === 'running') return;
  const retention = entry.terminalPolicy[entry.status];
  if (retention.mode === 'manual') return;

  const now = Date.now();
  entry.expiresAt ??= now + Math.max(0, retention.delayMs);
  const generation = entry.generation;
  const expiresAt = entry.expiresAt;
  const timer = setTimeout(
    () => {
      taskExpiryTimers.delete(entry.id);
      const current = taskPanelState.entries[entry.id];
      if (current?.generation === generation && current.expiresAt === expiresAt) {
        removeTask(entry.id, generation);
      }
    },
    Math.max(0, expiresAt - now),
  );
  taskExpiryTimers.set(entry.id, timer);
};

const getCurrentEntry = (owner: TaskOwner, id: string, generation: symbol): TaskEntry | null => {
  if (!owner.active) return null;
  const entry = taskPanelState.entries[id];
  if (!entry || entry.ownerSession !== owner.session || entry.generation !== generation) {
    return null;
  }
  return entry;
};

export const taskPanelEntries = computed(() =>
  Object.values(taskPanelState.entries).sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || b.createdAt - a.createdAt,
  ),
);

export const createTaskOwner = (id: string): TaskOwner => ({
  id,
  session: Symbol(id),
  active: true,
});

export const registerTask = (
  owner: TaskOwner,
  task: PluginTaskRegistration,
  runtime?: TaskActionRuntime,
): PluginTaskHandle => {
  if (!owner.active) throw new Error(`任务所有者已失效: ${owner.id}`);
  const existing = taskPanelState.entries[task.id];
  if (existing && existing.ownerSession !== owner.session) {
    throw new Error(`任务 ID 已被占用: ${task.id}`);
  }

  const { retention, ...taskData } = task;
  const normalizedTask = normalizeTaskData(taskData, runtime);
  const terminalPolicy = normalizeTerminalPolicy(retention);
  removeTask(task.id);
  const generation = Symbol(task.id);
  const abortController = new AbortController();
  const now = Date.now();
  const entry: TaskEntry = {
    ...normalizedTask,
    terminalPolicy,
    ownerId: owner.id,
    ownerSession: owner.session,
    generation,
    createdAt: now,
    ...(task.status === 'running' ? {} : { terminalEnteredAt: now }),
  };
  taskPanelState.entries[task.id] = entry;
  taskAbortControllers.set(task.id, { generation, controller: abortController });
  scheduleTaskExpiry(entry);

  return {
    get active() {
      return getCurrentEntry(owner, task.id, generation) !== null;
    },
    signal: abortController.signal,
    cancel: () => {
      if (!getCurrentEntry(owner, task.id, generation)) return false;
      abortController.abort();
      return true;
    },
    update: (patch) => {
      const current = getCurrentEntry(owner, task.id, generation);
      if (!current) return false;
      Object.assign(current, normalizeTaskData(patch, runtime));
      return true;
    },
    finish: (status, patch = {}) => {
      const current = getCurrentEntry(owner, task.id, generation);
      if (!current || current.status !== 'running') return false;
      Object.assign(current, normalizeTaskData(patch, runtime), {
        status,
        terminalEnteredAt: Date.now(),
        expiresAt: undefined,
      });
      if (status === 'aborted') abortController.abort();
      scheduleTaskExpiry(current);
      return true;
    },
    dismiss: () => removeTask(task.id, generation),
  };
};

export const invalidateTaskOwner = (owner: TaskOwner): void => {
  if (!owner.active) return;
  owner.active = false;
  for (const entry of Object.values(taskPanelState.entries)) {
    if (entry.ownerSession === owner.session) removeTask(entry.id, entry.generation);
  }
};

export const dismissTaskEntry = (id: string, generation: symbol): boolean =>
  removeTask(id, generation);

export const isManuallyDismissibleTask = (entry: TaskEntry): boolean =>
  entry.status !== 'running' && entry.terminalPolicy[entry.status].mode === 'manual';
