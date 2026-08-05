import { reactive, computed } from 'vue'
import type { IconifyIcon } from '@iconify/types'

export type TaskStatus = 'running' | 'completed' | 'error' | 'aborted'

export interface TaskProgress {
  done?: number
  total?: number
  percent?: number
  label?: string
}

export interface TaskAction {
  id: string
  label: string
  variant?: 'ghost' | 'primary' | 'danger'
  onClick: () => void
}

export interface TaskEntry {
  id: string
  pluginId: string
  name: string
  icon?: IconifyIcon
  status: TaskStatus
  progress?: TaskProgress
  error?: string
  actions?: TaskAction[]
  createdAt: number
}

export interface TaskRegistration extends Omit<TaskEntry, 'createdAt'> {}

/** Master reactive registry of all task panel entries. Any consumer can push / patch / remove. */
export const taskPanelState = reactive<{ entries: Record<string, TaskEntry> }>({
  entries: {},
})

export const taskPanelEntries = computed(() =>
  Object.values(taskPanelState.entries).sort((a, b) => a.createdAt - b.createdAt),
)

export const hasActiveTask = computed(() => taskPanelEntries.value.length > 0)

/**
 * Upsert a task entry. When the id already exists the existing reactive entry is
 * merged in-place (createdAt is preserved).  Returns a disposer.
 */
export const registerTask = (task: TaskRegistration): (() => void) => {
  const existing = taskPanelState.entries[task.id]
  if (existing) {
    Object.assign(existing, task, { createdAt: existing.createdAt })
  } else {
    taskPanelState.entries[task.id] = { ...task, createdAt: Date.now() }
  }
  return () => dismissTask(task.id)
}

/**
 * Partial update – only the supplied fields are touched.
 */
export const updateTask = (
  id: string,
  patch: Partial<Omit<TaskEntry, 'id' | 'pluginId' | 'createdAt'>>,
): void => {
  const entry = taskPanelState.entries[id]
  if (!entry) return
  Object.assign(entry, patch)
}

/** Remove a single task entry. */
export const dismissTask = (id: string): void => {
  delete taskPanelState.entries[id]
}

/** Bulk-dismiss all entries belonging to a plugin (called on plugin deactivation). */
export const dismissTasksByPlugin = (pluginId: string): void => {
  for (const id of Object.keys(taskPanelState.entries)) {
    if (taskPanelState.entries[id].pluginId === pluginId) {
      delete taskPanelState.entries[id]
    }
  }
}
