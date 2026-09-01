import * as Vue from 'vue';
import type { App as VueApp } from 'vue';
import type { Pinia } from 'pinia';
import type { Router } from 'vue-router';
import { Icon } from '@iconify/vue';
import type { Component } from 'vue';
import { logger } from '@/utils/logger';
import {
  createObservedElementRegistry,
  createObservedRootConnectionMonitor,
  observeRootConnectionChanges,
} from '../../../shared/observed-element-registry';
import { createPluginUiApi } from '../registry';

export interface PluginScrollContainerState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceToBottom: number;
  canScroll: boolean;
  atTop: boolean;
  atBottom: boolean;
}

export interface PluginScrollContainerQueryOptions {
  role?: string;
  visible?: boolean;
}

export interface PluginRuntimeUiHost {
  app: VueApp;
  router: Router;
  pinia: Pinia;
}

type PluginCallbackRunner = <T>(
  pluginId: string,
  source: string,
  callback: () => T,
  fallback: T,
) => T;

type PluginRuntimeErrorReporter = (
  pluginId: string,
  error: unknown,
  source?: string,
  fallback?: string,
) => unknown;

type HostComponentLoader = () => Promise<Component>;

/**
 * 自动收集宿主可复用组件，暴露给插件按需异步加载。
 * 覆盖 ui（基础控件）、music（音乐业务组件）、player（播放器弹层）三类目录，
 * 新增组件无需手动登记即可出现在 `ctx.ui.components` 中；app/ 目录为应用级业务弹窗，故不暴露。
 * 文件名（去除 .vue 后缀）作为组件键，`{ import: 'default' }` 让 loader 直接返回组件实例，
 * 保持 `() => Promise<Component>` 的调用签名不变。
 */
const HOST_COMPONENT_DIR_PRIORITY = ['/ui/', '/music/', '/player/'];

const hostComponentLoaders = Object.entries(
  import.meta.glob<Component>(
    ['../../components/ui/*.vue', '../../components/music/*.vue', '../../components/player/*.vue'],
    { import: 'default' },
  ),
)
  // 按目录优先级排序：同名时以更通用的 ui 控件为准（先到先得）
  .sort(([leftPath], [rightPath]) => {
    const weight = (path: string) =>
      HOST_COMPONENT_DIR_PRIORITY.findIndex((segment) => path.includes(segment));
    return weight(leftPath) - weight(rightPath) || leftPath.localeCompare(rightPath);
  })
  .reduce<Record<string, HostComponentLoader>>((loaders, [path, loader]) => {
    const name = path.match(/\/([^/]+)\.vue$/)?.[1];
    if (name && !(name in loaders)) loaders[name] = loader as HostComponentLoader;
    return loaders;
  }, {});

const resolveMountTarget = (target: string | Element): Element | null => {
  if (typeof target !== 'string') return target;
  return document.querySelector(target);
};

const insertMountContainer = (
  target: Element,
  container: HTMLElement,
  position: 'append' | 'prepend' | 'before' | 'after' | 'replace',
) => {
  if (position === 'prepend') {
    target.prepend(container);
    return;
  }
  if (position === 'before') {
    target.parentElement?.insertBefore(container, target);
    return;
  }
  if (position === 'after') {
    target.parentElement?.insertBefore(container, target.nextSibling);
    return;
  }
  if (position === 'replace') {
    target.replaceWith(container);
    container.appendChild(target);
    target.setAttribute('data-echo-plugin-replaced', 'true');
    return;
  }
  target.appendChild(container);
};

const createMountedComponentDisposer = (
  pluginId: string,
  host: PluginRuntimeUiHost,
  target: string | Element,
  component: Component,
  reportPluginRuntimeError: PluginRuntimeErrorReporter,
  options: {
    props?: Record<string, unknown>;
    position?: 'append' | 'prepend' | 'before' | 'after' | 'replace';
    className?: string;
    id?: string;
  } = {},
) => {
  const targetElement = resolveMountTarget(target);
  if (!targetElement) throw new Error(`插件挂载目标不存在: ${String(target)}`);

  const container = document.createElement('div');
  container.className = ['echo-plugin-mount', options.className].filter(Boolean).join(' ');
  container.dataset.pluginId = pluginId;
  if (options.id) container.dataset.pluginMount = options.id;
  const position = options.position ?? 'append';
  insertMountContainer(targetElement, container, position);

  const mountedApp = Vue.createApp(component, options.props ?? {});
  mountedApp.use(host.pinia);
  mountedApp.use(host.router);
  mountedApp.component('Icon', Icon);
  mountedApp.config.globalProperties.$echo = host.app.config.globalProperties.$echo;
  mountedApp.config.errorHandler = (error, _instance, info) => {
    logger.error('PluginRuntime', 'Plugin mounted component failed', {
      pluginId,
      info,
      error,
    });
    void reportPluginRuntimeError(pluginId, error, `Vue 组件: ${info || '未知位置'}`);
  };
  mountedApp.mount(container);

  return () => {
    // 卸载应用。迷你 app 与主应用共享同一个 pinia 实例，
    // 这里只能卸载自身组件树（unmount 会清理该子树的 watcher/effect），
    // 绝不能去 $dispose 共享的全局 store，否则会连带销毁主应用的
    // player/lyric/settings 等 store，导致页面响应式失效、卡死。
    try {
      mountedApp.unmount();
    } catch (error) {
      logger.warn('PluginRuntime', 'Component unmount failed', { pluginId, error });
    }

    // 清理 DOM
    if (position === 'replace') {
      const replaced = container.querySelector<HTMLElement>('[data-echo-plugin-replaced="true"]');
      if (replaced) {
        replaced.removeAttribute('data-echo-plugin-replaced');
        container.replaceWith(replaced);
        return;
      }
    }
    container.remove();
  };
};

const SCROLL_CONTAINER_SELECTOR = '[data-echo-scroll-container]';

const isVisibleScrollContainer = (element: HTMLElement) =>
  element.clientHeight > 0 && element.getClientRects().length > 0;

const getScrollContainerState = (element: HTMLElement): PluginScrollContainerState => {
  const scrollTop = Math.max(0, element.scrollTop || 0);
  const scrollHeight = Math.max(0, element.scrollHeight || 0);
  const clientHeight = Math.max(0, element.clientHeight || 0);
  const distanceToBottom = Math.max(0, scrollHeight - clientHeight - scrollTop);
  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    distanceToBottom,
    canScroll: scrollHeight - clientHeight > 1,
    atTop: scrollTop <= 1,
    atBottom: distanceToBottom <= 1,
  };
};

export const createScrollApi = (
  pluginId: string,
  addDisposable: (dispose: () => void) => () => void,
  runPluginCallback: PluginCallbackRunner,
) => {
  const queryContainers = (options: PluginScrollContainerQueryOptions = {}) => {
    const containers = Array.from(
      document.querySelectorAll<HTMLElement>(SCROLL_CONTAINER_SELECTOR),
    );
    return containers.filter((element) => {
      if (options.role && element.dataset.echoScrollRole !== options.role) return false;
      if (options.visible !== false && !isVisibleScrollContainer(element)) return false;
      return true;
    });
  };

  const getCurrentContainer = () => queryContainers({ visible: true })[0] ?? null;

  const scrollTo = (
    element: HTMLElement | null | undefined,
    target: 'top' | 'bottom' | number,
    options?: ScrollToOptions,
  ) => {
    if (!element) return;
    const top =
      target === 'top'
        ? 0
        : target === 'bottom'
          ? Math.max(0, element.scrollHeight - element.clientHeight)
          : Math.max(0, Number(target) || 0);
    element.scrollTo({
      ...options,
      top,
      behavior: options?.behavior ?? 'smooth',
    });
  };

  const observeContainers = (
    handler: (element: HTMLElement, state: PluginScrollContainerState) => void | (() => void),
    options: PluginScrollContainerQueryOptions = {},
  ) => {
    const seen = new WeakSet<HTMLElement>();
    const disposers: Array<() => void> = [];
    let stopped = false;

    const visit = (element: HTMLElement) => {
      if (stopped || seen.has(element)) return;
      seen.add(element);
      const dispose = runPluginCallback(
        pluginId,
        '滚动容器监听',
        () => handler(element, getScrollContainerState(element)),
        undefined,
      );
      if (typeof dispose === 'function') disposers.push(dispose);
    };

    const scan = () => {
      if (stopped) return;
      queryContainers(options).forEach(visit);
    };

    const observer = new MutationObserver(scan);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      disposers
        .splice(0)
        .reverse()
        .forEach((dispose) => runPluginCallback(pluginId, '滚动容器监听清理', dispose, undefined));
    };

    scan();
    observer.observe(document.body, { childList: true, subtree: true });
    return addDisposable(stop);
  };

  return {
    selector: SCROLL_CONTAINER_SELECTOR,
    queryContainers,
    getCurrentContainer,
    getState: getScrollContainerState,
    scrollTo,
    scrollToTop: (element?: HTMLElement | null, options?: ScrollToOptions) =>
      scrollTo(element ?? getCurrentContainer(), 'top', options),
    scrollToBottom: (element?: HTMLElement | null, options?: ScrollToOptions) =>
      scrollTo(element ?? getCurrentContainer(), 'bottom', options),
    observeContainers,
  };
};

export const createDomApi = (
  pluginId: string,
  addDisposable: (dispose: () => void) => () => void,
  runPluginCallback: PluginCallbackRunner,
) => ({
  query: <T extends Element = Element>(selector: string) => document.querySelector<T>(selector),
  queryAll: <T extends Element = Element>(selector: string) =>
    Array.from(document.querySelectorAll<T>(selector)),
  observe: (
    selector: string,
    handler: (element: Element) => void | (() => void),
    options?: { root?: Element | Document; once?: boolean },
  ) => {
    const root = options?.root ?? document.body;
    const customElementRoot = options?.root instanceof Element ? options.root : null;
    let stopped = false;
    const activeElements = createObservedElementRegistry<Element>((dispose) =>
      runPluginCallback(pluginId, `DOM 监听清理: ${selector}`, dispose, undefined),
    );

    const isWithinRoot = (element: Element) =>
      element.isConnected &&
      (root instanceof Document
        ? Boolean(root.documentElement?.contains(element))
        : root.isConnected && root.contains(element));

    const isCustomRootConnected = () =>
      Boolean(
        customElementRoot?.isConnected &&
        customElementRoot.ownerDocument.documentElement?.contains(customElementRoot),
      );

    const visit = (element: Element) => {
      if (stopped || activeElements.has(element)) return;
      const dispose = runPluginCallback(
        pluginId,
        `DOM 监听: ${selector}`,
        () => handler(element),
        undefined,
      );
      activeElements.add(element, typeof dispose === 'function' ? dispose : null);
      if (options?.once) stop();
    };

    const scan = () => {
      if (stopped) return;
      if (customElementRoot && !isCustomRootConnected()) {
        activeElements.clear();
        return;
      }
      activeElements.prune(isWithinRoot);
      if (root instanceof Element && root.matches(selector)) visit(root);
      const queryRoot = root instanceof Document ? root : root.ownerDocument;
      const scope = root instanceof Document ? root : root;
      if (!queryRoot) return;
      Array.from(scope.querySelectorAll(selector)).forEach(visit);
    };

    const observer = new MutationObserver(scan);
    const rootConnection = customElementRoot
      ? createObservedRootConnectionMonitor(
          isCustomRootConnected,
          () => activeElements.clear(),
          scan,
        )
      : null;
    const stopRootLifecycleObserver =
      customElementRoot && rootConnection
        ? observeRootConnectionChanges(
            customElementRoot.ownerDocument,
            (callback) => new MutationObserver(callback),
            rootConnection,
          )
        : null;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      stopRootLifecycleObserver?.();
      activeElements.clear();
    };

    scan();
    if (!stopped) observer.observe(root, { childList: true, subtree: true });
    return addDisposable(stop);
  },
});

export const createRuntimeUiApi = (
  pluginId: string,
  host: PluginRuntimeUiHost,
  addDisposable: (dispose: () => void) => () => void,
  runPluginCallback: PluginCallbackRunner,
  reportPluginRuntimeError: PluginRuntimeErrorReporter,
) => {
  const baseUi = createPluginUiApi(pluginId, addDisposable, (source, error) => {
    void reportPluginRuntimeError(pluginId, error, source);
  });
  return {
    ...baseUi,
    components: hostComponentLoaders,
    mount: (
      target: string | Element,
      component: Component,
      options?: {
        props?: Record<string, unknown>;
        position?: 'append' | 'prepend' | 'before' | 'after' | 'replace';
        className?: string;
        id?: string;
      },
    ) =>
      runPluginCallback(
        pluginId,
        '挂载插件组件',
        () =>
          addDisposable(
            createMountedComponentDisposer(
              pluginId,
              host,
              target,
              component,
              reportPluginRuntimeError,
              options,
            ),
          ),
        () => undefined,
      ),
    teleport: (
      component: Component,
      options?: { props?: Record<string, unknown>; className?: string; id?: string },
    ) =>
      runPluginCallback(
        pluginId,
        '挂载插件浮层',
        () =>
          addDisposable(
            createMountedComponentDisposer(
              pluginId,
              host,
              document.body,
              component,
              reportPluginRuntimeError,
              {
                ...options,
                position: 'append',
                className: ['echo-plugin-teleport', options?.className].filter(Boolean).join(' '),
              },
            ),
          ),
        () => undefined,
      ),
  };
};
