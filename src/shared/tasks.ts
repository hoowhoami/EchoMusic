import type { IconifyIcon } from '@iconify/types';

export type TaskStatus = 'running' | 'completed' | 'error' | 'aborted';

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
  onClick: () => void | Promise<void>;
}

export interface PluginTaskRegistration {
  id: string;
  name: string;
  icon?: IconifyIcon;
  status: TaskStatus;
  /** Higher value shows earlier in the panel. Defaults to 0. */
  priority?: number;
  progress?: TaskProgress;
  error?: string;
  actions?: TaskAction[];
}

export type PluginTaskPatch = Partial<Omit<PluginTaskRegistration, 'id'>>;

export interface PluginTaskApi {
  register: (task: PluginTaskRegistration) => () => void;
  update: (id: string, patch: PluginTaskPatch) => void;
  dismiss: (id: string) => void;
}
