export const ABORTED_TASK_KEEP_MS = 3000;

export interface TaskControlState<OpenMode extends string = 'detail'> {
  abortRequested: boolean;
  onAbort: (() => void) | null;
  openRequested: number;
  openHandled: number;
  openRequestMode: OpenMode;
}

export interface TaskAbortTimer {
  clear: () => void;
  schedule: (callback: () => void, keepMs?: number) => void;
}

export const createTaskControlState = <OpenMode extends string>(
  openRequestMode: OpenMode,
): TaskControlState<OpenMode> => ({
  abortRequested: false,
  onAbort: null,
  openRequested: 0,
  openHandled: 0,
  openRequestMode,
});

export const createTaskAbortTimer = (): TaskAbortTimer => {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  return {
    clear,
    schedule: (callback, keepMs = ABORTED_TASK_KEEP_MS) => {
      clear();
      timer = setTimeout(() => {
        timer = null;
        callback();
      }, keepMs);
    },
  };
};

export const activateTaskControl = (
  state: TaskControlState<string>,
  abortHandler: () => void,
): void => {
  state.abortRequested = false;
  state.onAbort = abortHandler;
};

export const clearTaskControl = (
  state: TaskControlState<string>,
  abortTimer: TaskAbortTimer,
): void => {
  abortTimer.clear();
  state.abortRequested = false;
  state.onAbort = null;
};

export const finishTaskControl = (
  state: TaskControlState<string>,
  abortTimer: TaskAbortTimer,
): void => {
  abortTimer.clear();
  state.onAbort = null;
};

export const requestTaskOpen = <OpenMode extends string>(
  state: TaskControlState<OpenMode>,
  mode: OpenMode,
): void => {
  state.openRequestMode = mode;
  state.openRequested++;
};

export const consumeTaskOpen = (state: TaskControlState<string>): boolean => {
  if (state.openRequested <= state.openHandled) return false;
  state.openHandled = state.openRequested;
  return true;
};

export interface RequestTaskAbortOptions {
  canAbort: () => boolean;
  /** 是否在任务面板保留 aborted 反馈；任务中心中止默认保留，弹窗内取消可关闭。 */
  feedback?: boolean;
  markAborted?: () => void;
  onRequested?: () => void;
  onTimeoutDismiss?: () => void;
}

export const requestTaskAbort = (
  state: TaskControlState<string>,
  abortTimer: TaskAbortTimer,
  options: RequestTaskAbortOptions,
): boolean => {
  if (!options.canAbort()) return false;
  abortTimer.clear();
  state.abortRequested = true;
  options.onRequested?.();
  state.onAbort?.();
  if (options.feedback ?? true) {
    options.markAborted?.();
    if (options.onTimeoutDismiss) {
      abortTimer.schedule(options.onTimeoutDismiss);
    }
  }
  return true;
};
