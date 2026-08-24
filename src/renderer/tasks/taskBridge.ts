import type {
  PluginTaskHandle,
  PluginTaskPatch,
  PluginTaskRegistration,
  TaskRetentionPolicy,
  TaskStatus,
} from '../../shared/tasks';
import {
  BUILTIN_PLUGIN_ID,
  createTaskOwner,
  invalidateTaskOwner,
  registerTask,
} from '@/plugins/taskPanel';

type TaskBridgeRegistration = Omit<PluginTaskRegistration, 'id' | 'retention'>;

export interface TaskBridge {
  set: (registration: TaskBridgeRegistration) => void;
  dismiss: () => void;
  dispose: () => void;
}

export const createTaskBridge = (id: string, retention: TaskRetentionPolicy): TaskBridge => {
  const owner = createTaskOwner(BUILTIN_PLUGIN_ID);
  let handle: PluginTaskHandle | null = null;
  let status: TaskStatus | null = null;

  const register = (registration: TaskBridgeRegistration) => {
    handle = registerTask(owner, { ...registration, id, retention });
    status = registration.status;
  };

  return {
    set: (registration) => {
      if (!handle) {
        register(registration);
        return;
      }

      const { status: nextStatus, ...patch } = registration;
      if (status !== nextStatus && status !== 'running') {
        register(registration);
        return;
      }

      let updated: boolean;
      if (nextStatus !== 'running' && status === 'running') {
        updated = handle.finish(nextStatus, patch);
      } else {
        updated = handle.update(patch as PluginTaskPatch);
      }

      if (!updated) {
        if (nextStatus !== 'running' && status === nextStatus) {
          return;
        }
        register(registration);
      } else {
        status = nextStatus;
      }
    },
    dismiss: () => {
      handle?.dismiss();
      handle = null;
      status = null;
    },
    dispose: () => {
      invalidateTaskOwner(owner);
      handle = null;
      status = null;
    },
  };
};
