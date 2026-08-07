import { reactive, computed, ref } from 'vue';
import type { IconifyIcon } from '@iconify/types';

export type TaskStatus = 'running' | 'completed' | 'error' | 'aborted';

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  running: '进行中',
  completed: '已完成',
  error: '失败',
  aborted: '已中止',
};

export const getTaskStatusLabel = (status: TaskStatus): string =>
  TASK_STATUS_LABELS[status] ?? status;

export interface TaskProgress {
  done?: number;
  total?: number;
  percent?: number;
  label?: string;
}

export interface TaskAction {
  id: string;
  label: string;
  variant?: 'ghost' | 'primary' | 'danger';
  onClick: () => void;
}

export interface TaskEntry {
  id: string;
  pluginId: string;
  name: string;
  icon?: IconifyIcon;
  status: TaskStatus;
  /** Higher value shows earlier in the panel. Defaults to 0. */
  priority?: number;
  progress?: TaskProgress;
  error?: string;
  actions?: TaskAction[];
  createdAt: number;
}

export type TaskRegistration = Omit<TaskEntry, 'createdAt'>;

/** Plugin id used by built-in tasks (update / import). */
export const BUILTIN_PLUGIN_ID = 'echo:main';

/**
 * Shared task-panel open state: TitleBar renders the dialog and toggles it,
 * self-registering bridges close it from their task actions.
 */
export const taskPanelOpen = ref(false);

/** Master reactive registry of all task panel entries. Any consumer can push / patch / remove. */
export const taskPanelState = reactive<{ entries: Record<string, TaskEntry> }>({
  entries: {},
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
export const registerTask = (task: TaskRegistration): (() => void) => {
  const existing = taskPanelState.entries[task.id];
  if (existing) {
    Object.assign(existing, task, { createdAt: existing.createdAt });
  } else {
    taskPanelState.entries[task.id] = { ...task, createdAt: Date.now() };
  }
  return () => dismissTask(task.id);
};

/**
 * Partial update – only the supplied fields are touched.
 */
export const updateTask = (
  id: string,
  patch: Partial<Omit<TaskEntry, 'id' | 'pluginId' | 'createdAt'>>,
): void => {
  const entry = taskPanelState.entries[id];
  if (!entry) return;
  Object.assign(entry, patch);
};

/** Remove a single task entry. */
export const dismissTask = (id: string): void => {
  delete taskPanelState.entries[id];
};

/** Bulk-dismiss all entries belonging to a plugin (called on plugin deactivation). */
export const dismissTasksByPlugin = (pluginId: string): void => {
  for (const id of Object.keys(taskPanelState.entries)) {
    if (taskPanelState.entries[id].pluginId === pluginId) {
      delete taskPanelState.entries[id];
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
  set: (registration: Omit<TaskRegistration, 'pluginId'>) => void;
  update: (patch: Partial<Omit<TaskEntry, 'id' | 'pluginId' | 'createdAt'>>) => void;
  dismiss: () => void;
}

export const createTaskHandle = (id: string, pluginId: string): TaskHandle => ({
  set: (registration) => {
    registerTask({ ...registration, id, pluginId });
  },
  update: (patch) => {
    updateTask(id, patch);
  },
  dismiss: () => {
    dismissTask(id);
  },
});
