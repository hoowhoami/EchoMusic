import { getCurrentInstance, onActivated, onDeactivated, onUnmounted } from 'vue';
import type { AudioSpectrumFrame, AudioSpectrumOptions } from '../../../shared/audioSpectrum';

type SpectrumSubscriptionHandle = (() => void) & {
  setPaused: (paused: boolean) => void;
};

type PluginSpectrumRuntimeDeps = {
  runPluginCallback: (
    pluginId: string,
    source: string,
    callback: () => void,
    fallback?: undefined,
  ) => unknown;
  addDisposable: (dispose: () => void) => () => void;
};

type ManagedSubscription = {
  handle: SpectrumSubscriptionHandle | null;
  /** 宿主文档不可见（窗口最小化/隐藏）。 */
  documentHidden: boolean;
  /** 宿主组件被 KeepAlive 缓存或卸载，处于非激活状态。 */
  componentInactive: boolean;
  disposed: boolean;
};

/**
 * 当前渲染进程中所有受管订阅。用于在整页不可见时统一暂停：
 * 主窗口最小化后 `document.hidden` 为真，此时任何订阅者都不可能被绘制。
 */
const managedSubscriptions = new Set<ManagedSubscription>();
let visibilityListenerInstalled = false;

const shouldDeliver = (subscription: ManagedSubscription) =>
  !subscription.disposed && !subscription.documentHidden && !subscription.componentInactive;

const syncSubscription = (subscription: ManagedSubscription) => {
  if (!subscription.handle) return;
  subscription.handle.setPaused(!shouldDeliver(subscription));
};

const installVisibilityListener = () => {
  if (visibilityListenerInstalled || typeof document === 'undefined') return;
  visibilityListenerInstalled = true;
  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    let changed = false;
    for (const subscription of managedSubscriptions) {
      if (subscription.documentHidden === hidden) continue;
      subscription.documentHidden = hidden;
      changed = true;
    }
    if (changed) {
      for (const subscription of managedSubscriptions) syncSubscription(subscription);
    }
  });
};

/**
 * 创建一个与宿主组件生命周期绑定的频谱订阅。
 *
 * 宿主组件卸载时彻底退订；被 KeepAlive 缓存（onDeactivated）时暂停投递、
 * 重新激活时恢复。这样「看不见的插件」不再持续占用 IPC 与频谱参数合并，
 * 同时插件自身的状态与重新激活后的连续性都不受影响。
 *
 * 若在组件 setup 之外调用（例如插件 activate 阶段的模块级订阅），
 * 则退化为插件停用时清理的普通订阅，行为与旧实现一致。
 */
export const createPluginSpectrumSubscription = (
  pluginId: string,
  options: AudioSpectrumOptions,
  handler: (frame: AudioSpectrumFrame) => void,
  deps: PluginSpectrumRuntimeDeps,
): (() => void) => {
  const handle =
    window.electron.audioSpectrum?.subscribe(
      options,
      (frame) => deps.runPluginCallback(pluginId, '音频频谱事件', () => handler(frame), undefined),
      { pluginId },
    ) ?? null;

  const subscription: ManagedSubscription = {
    handle,
    documentHidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
    componentInactive: false,
    disposed: false,
  };

  if (handle) {
    installVisibilityListener();
    managedSubscriptions.add(subscription);
    // 订阅可能诞生于文档已隐藏时（例如窗口最小化期间打开插件页），
    // 必须立即同步一次初始状态，否则会一直按「可见」投递直到下一次可见性变化。
    syncSubscription(subscription);
  }

  const dispose = () => {
    if (subscription.disposed) return;
    subscription.disposed = true;
    managedSubscriptions.delete(subscription);
    handle?.();
  };

  // 组件级生命周期：仅在确实处于组件上下文中注册，避免污染模块级订阅。
  if (getCurrentInstance()) {
    // 卸载 = 组件真的没了，必须彻底退订，否则主进程订阅表会永久残留条目。
    onUnmounted(dispose);
    // KeepAlive 缓存 ≠ 卸载：页面不可见时只暂停投递，重新激活时恢复。
    onDeactivated(() => {
      if (subscription.disposed) return;
      subscription.componentInactive = true;
      syncSubscription(subscription);
    });
    onActivated(() => {
      if (subscription.disposed) return;
      subscription.componentInactive = false;
      syncSubscription(subscription);
    });
  }

  return deps.addDisposable(dispose);
};
