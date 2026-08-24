export interface TaskControlState<OpenMode extends string = 'detail'> {
  abortRequested: boolean;
  onAbort: (() => void) | null;
  openRequested: number;
  openHandled: number;
  openRequestMode: OpenMode;
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

export const activateTaskControl = (
  state: TaskControlState<string>,
  abortHandler: () => void,
): void => {
  state.abortRequested = false;
  state.onAbort = abortHandler;
};

export const clearTaskControl = (state: TaskControlState<string>): void => {
  state.abortRequested = false;
  state.onAbort = null;
};

export const finishTaskControl = (state: TaskControlState<string>): void => {
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
}

export const requestTaskAbort = (
  state: TaskControlState<string>,
  options: RequestTaskAbortOptions,
): boolean => {
  if (!options.canAbort()) return false;
  state.abortRequested = true;
  options.onRequested?.();
  try {
    state.onAbort?.();
  } finally {
    if (options.feedback ?? true) options.markAborted?.();
  }
  return true;
};
