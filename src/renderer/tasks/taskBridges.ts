import { setupUpdateTaskBridge } from './updateTaskBridge';

let activeInstallation: symbol | null = null;

/**
 * 一次性安装所有内置任务面板自注册桥接（更新 / 导入 / 云盘上传）。
 * 幂等：重复调用返回 no-op，防止 HMR / 重复初始化导致重复注册。
 * 返回合并的 dispose；dispose 后可再次 setup。
 */
export const setupTaskBridges = (): (() => void) => {
  if (activeInstallation) return () => {};
  const installation = Symbol('task-bridges');
  activeInstallation = installation;
  const disposers: Array<() => void> = [setupUpdateTaskBridge()];
  return () => {
    if (activeInstallation !== installation) return;
    activeInstallation = null;
    for (const dispose of disposers) dispose();
  };
};
