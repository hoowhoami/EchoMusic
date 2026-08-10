import { reactive, computed, ref } from 'vue';
import type {
  PluginTaskPatch,
  PluginTaskRegistration,
  TaskAction,
  TaskStatus,
} from '../../shared/tasks';
import logger from '@/utils/logger';

export type {
  PluginTaskApi,
  PluginTaskPatch,
  PluginTaskRegistration,
  TaskAction,
  TaskActionVariant,
  TaskProgress,
  TaskStatus,
} from '../../shared/tasks';

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  running: '进行中',
  completed: '已完成',
  error: '失败',
  aborted: '已中止',
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

export const createTaskDismissAction = (onClick: TaskAction['onClick']): TaskAction => ({
  id: 'dismiss',
  label: '关闭',
  variant: 'ghost',
  onClick,
});

export interface TaskLifecycleActionOptions {
  status: TaskStatus;
  onDetail?: TaskAction['onClick'];
  onAbort?: TaskAction['onClick'];
  onDismiss?: TaskAction['onClick'];
}

export const createTaskLifecycleActions = ({
  status,
  onDetail,
  onAbort,
  onDismiss,
}: TaskLifecycleActionOptions): TaskAction[] => {
  if (status === 'running') {
    return [
      ...(onDetail ? [createTaskDetailAction(onDetail)] : []),
      ...(onAbort ? [createTaskAbortAction(onAbort)] : []),
    ];
  }
  if (status === 'completed') {
    return [
      ...(onDetail ? [createTaskDetailAction(onDetail, '查看结果')] : []),
      ...(onDismiss ? [createTaskDismissAction(onDismiss)] : []),
    ];
  }
  if (status === 'aborted') {
    return onDismiss ? [createTaskDismissAction(onDismiss)] : [];
  }
  return [];
};

export interface TaskEntry extends PluginTaskRegistration {
  pluginId: string;
  createdAt: number;
}

export type TaskRegistration = PluginTaskRegistration & { pluginId: string };

export interface TaskActionRuntime {
  runAction?: (action: TaskAction, invoke: () => void | Promise<void>) => void | Promise<void>;
}

/** Plugin id used by built-in tasks (update / import). */
export const BUILTIN_PLUGIN_ID = 'echo:main';

/**
 * Shared task-panel open state: TitleBar renders the dialog and toggles it,
 * task actions can close it by setting closePanel.
 */
export const taskPanelOpen = ref(false);

/** Master reactive registry of all task panel entries. Any consumer can push / patch / remove. */
export const taskPanelState = reactive<{ entries: Record<string, TaskEntry> }>({
  entries: {},
});

const taskRegistrationTokens = new Map<string, symbol>();

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
    if (action.closePanel) {
      taskPanelOpen.value = false;
    }
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

const normalizeTaskRegistration = <T extends { actions?: TaskAction[] }>(
  task: T,
  runtime?: TaskActionRuntime,
): T => ({
  ...task,
  ...('actions' in task ? { actions: normalizeTaskActions(task.actions, runtime) } : {}),
});

/**
 * Panel entries sorted by priority (higher first), then by creation time
 * descending so newer tasks appear on top.
 */
export const taskPanelEntries = computed(() =>
  Object.values(taskPanelState.entries).sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || b.createdAt - a.createdAt,
  ),
);

/**
 * Upsert a task entry. When the id already exists the existing reactive entry is
 * merged in-place (createdAt is preserved).  Returns a disposer.
 */
export const registerTask = (task: TaskRegistration, runtime?: TaskActionRuntime): (() => void) => {
  const existing = taskPanelState.entries[task.id];
  const normalizedTask = normalizeTaskRegistration(task, runtime);
  const registrationToken = Symbol(task.id);
  taskRegistrationTokens.set(task.id, registrationToken);
  if (existing) {
    Object.assign(existing, normalizedTask, { createdAt: existing.createdAt });
  } else {
    taskPanelState.entries[task.id] = { ...normalizedTask, createdAt: Date.now() };
  }
  return () => {
    if (taskRegistrationTokens.get(task.id) === registrationToken) {
      dismissTask(task.id);
    }
  };
};

/**
 * Partial update – only the supplied fields are touched.
 */
export const updateTask = (
  id: string,
  patch: PluginTaskPatch,
  runtime?: TaskActionRuntime,
): void => {
  const entry = taskPanelState.entries[id];
  if (!entry) return;
  Object.assign(entry, normalizeTaskRegistration(patch, runtime));
};

/** Remove a single task entry. */
export const dismissTask = (id: string): void => {
  taskRegistrationTokens.delete(id);
  delete taskPanelState.entries[id];
};

/** Bulk-dismiss all entries belonging to a plugin (called on plugin deactivation). */
export const dismissTasksByPlugin = (pluginId: string): void => {
  for (const id of Object.keys(taskPanelState.entries)) {
    if (taskPanelState.entries[id].pluginId === pluginId) {
      dismissTask(id);
    }
  }
};

/**
 * Per-task handle so feature modules can self-register without touching the panel UI.
 * set() upserts via registerTask (preserving createdAt); update()/dismiss() delegate to
 * updateTask/dismissTask. The handle owns the entry id and pluginId.
 *
 * Intended for built-in feature modules only (used solely by the self-registration
 * bridges); plugins cannot access this module. Callers are responsible for keeping
 * the id/pluginId namespace safe.
 */
export interface TaskHandle {
  set: (registration: Omit<PluginTaskRegistration, 'id'>) => void;
  update: (patch: PluginTaskPatch) => void;
  dismiss: () => void;
}

export const createTaskHandle = (
  id: string,
  pluginId: string,
  runtime?: TaskActionRuntime,
): TaskHandle => ({
  set: (registration) => {
    registerTask({ ...registration, id, pluginId }, runtime);
  },
  update: (patch) => {
    updateTask(id, patch, runtime);
  },
  dismiss: () => {
    dismissTask(id);
  },
});
