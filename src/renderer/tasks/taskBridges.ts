import { setupUpdateTaskBridge } from './updateTaskBridge';
import { setupImportTaskBridge } from './importTaskBridge';
import { setupCloudTaskBridge } from './cloudTaskBridge';

let installed = false;

/**
 * 一次性安装所有内置任务面板自注册桥接（更新 / 导入 / 云盘上传）。
 * 幂等：重复调用返回 no-op，防止 HMR / 重复初始化导致重复注册。
 * 返回合并的 dispose；dispose 后可再次 setup。
 */
export const setupTaskBridges = (): (() => void) => {
  if (installed) return () => {};
  installed = true;
  const disposers: Array<() => void> = [
    setupUpdateTaskBridge(),
    setupImportTaskBridge(),
    setupCloudTaskBridge(),
  ];
  return () => {
    for (const dispose of disposers) dispose();
    installed = false;
  };
};
