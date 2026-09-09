import type { IconifyIcon } from '@iconify/types';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'error' | 'aborted';
export type TerminalTaskStatus = Exclude<TaskStatus, 'pending' | 'running'>;

export type TaskRetention = { mode: 'auto'; delayMs: number } | { mode: 'manual' };

export interface TaskTerminalPolicy {
  completed: TaskRetention;
  error: TaskRetention;
  aborted: TaskRetention;
}

export type TaskRetentionPolicy = 'transient' | 'action-required' | TaskTerminalPolicy;

export interface TaskProgress {
  done?: number;
  total?: number;
  percent?: number;
  label?: string;
}

export type TaskActionVariant = 'ghost' | 'primary' | 'danger';

export interface TaskAction {
  id: string;
  label: string;
  variant?: TaskActionVariant;
  closePanel?: boolean;
  disabled?: boolean;
  onClick: () => void | Promise<void>;
}

/** Display-only details; rows do not own separate task lifecycles. */
export interface TaskItem {
  id: string;
  name: string;
  description?: string;
  statusLabel?: string;
  error?: string;
  actions?: TaskAction[];
}

export interface PluginTaskRegistration {
  id: string;
  name: string;
  icon?: IconifyIcon;
  status: TaskStatus;
  /** Explicit preset or per-status policy. UI styling never changes lifecycle. */
  retention: TaskRetentionPolicy;
  /** Higher value shows earlier in the panel. Defaults to 0. */
  priority?: number;
  progress?: TaskProgress;
  error?: string;
  actions?: TaskAction[];
  items?: TaskItem[];
}

export type PluginTaskPatch = Partial<Omit<PluginTaskRegistration, 'id' | 'status' | 'retention'>>;

export interface PluginTaskHandle {
  /** A handle owns exactly one task run. All methods return false after replacement or removal. */
  readonly active: boolean;
  readonly signal: AbortSignal;
  /** Abort the run's work without removing its task entry. */
  cancel: () => boolean;
  /** Transition pending to running; false for canceled, stale or non-pending handles. */
  start: (patch?: PluginTaskPatch) => boolean;
  update: (patch: PluginTaskPatch) => boolean;
  /** The only valid transition from pending/running to a terminal state. */
  finish: (status: TerminalTaskStatus, patch?: PluginTaskPatch) => boolean;
  dismiss: () => boolean;
}

export interface PluginTaskApi {
  register: (task: PluginTaskRegistration) => PluginTaskHandle;
}
