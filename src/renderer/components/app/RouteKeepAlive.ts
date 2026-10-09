/**
 * RouteKeepAlive — EchoMusic's locally maintained route-page cache.
 *
 * Adapted from the npm-published yzs-keep-alive-v3@0.1.4 ES build by
 * hnwangzhenwei (MIT), not the older public GitHub source:
 * https://registry.npmjs.org/yzs-keep-alive-v3/-/yzs-keep-alive-v3-0.1.4.tgz
 * License/attribution: LICENSES/yzs-keep-alive-v3-MIT.txt.
 * The unused upstream lifecycle/cache-manager composables are not included.
 *
 * Local fixes: recognize synchronous scope.stop to prevent duplicate unmount;
 * keep a cleared active page invalidated across same-key renders; destroy all
 * inactive instances on teardown (including same-type/different-key pages);
 * patch props/slots on reactivation; schedule effects with Vue/Suspense.
 *
 * MainLayout owns resource identity and refresh keys. Clearing an active entry
 * invalidates its cache without forcibly removing the displayed DOM; changing
 * its key refreshes it. include/exclude support arrays, RegExp and comma lists.
 * pruneCache retains names accepted by its predicate; max applies LRU eviction.
 *
 * Maintenance: __isKeepAlive, ctx.renderer, component scope and a/da hooks are
 * private Vue contracts. Keep this dependency isolated here. After Vue upgrades,
 * run route-refresh-lifecycle and related cache tests, type/build checks, and
 * desktop acceptance with Fragment/Teleport pages and page transitions.
 */
import {
  callWithAsyncErrorHandling,
  cloneVNode,
  defineComponent,
  ErrorCodes,
  getCurrentInstance,
  isVNode,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  queuePostFlushCb,
  setTransitionHooks,
  watch,
  type ComponentInternalInstance,
  type ElementNamespace,
  type PropType,
  type RendererElement,
  type RendererNode,
  type SuspenseBoundary,
  type VNode,
} from 'vue';

type MatchPattern = string | RegExp | (string | RegExp)[];
export type RouteCacheKey = NonNullable<VNode['key']> | VNode['type'];
export interface RouteKeepAliveController {
  clearCache(): void;
  clearCacheByKey(key: RouteCacheKey): void;
  pruneCache(filter: (name: string) => boolean): void;
  pruneCacheEntry(key: RouteCacheKey): void;
  getCachedKeys(): RouteCacheKey[];
  getCacheSize(): number;
}

// Vue only injects this context for components marked __isKeepAlive. Keep its
// private renderer contract isolated here; recheck it when upgrading Vue.
interface CacheInstance extends ComponentInternalInstance {
  scope: { active: boolean };
  a?: (() => void)[];
  da?: (() => void)[];
  suspense: SuspenseBoundary | null;
  ctx: {
    renderer?: {
      p(
        previous: VNode,
        next: VNode,
        container: RendererElement,
        anchor: RendererNode | null,
        parent: ComponentInternalInstance,
        suspense: SuspenseBoundary | null,
        namespace: ElementNamespace,
        slotScopeIds: string[] | null,
        optimized: boolean,
      ): void;
      m(
        vnode: VNode,
        container: RendererElement,
        anchor: RendererNode | null,
        mode: number,
        suspense: SuspenseBoundary | null,
      ): void;
      um(
        vnode: VNode,
        parent: ComponentInternalInstance,
        suspense: SuspenseBoundary | null,
        remove: boolean,
      ): void;
      o: { createElement(tag: string): RendererElement };
    };
    activate?: (
      vnode: VNode,
      container: RendererElement,
      anchor: RendererNode | null,
      namespace: ElementNamespace,
      optimized: boolean,
    ) => void;
    deactivate?: (vnode: VNode) => void;
  };
}

const STATEFUL_COMPONENT = 4;
const SUSPENSE = 128;
const SHOULD_KEEP_ALIVE = 256;
const KEPT_ALIVE = 512;
const getInnerChild = (vnode: VNode): VNode =>
  vnode.shapeFlag & SUSPENSE ? (vnode as VNode & { ssContent: VNode }).ssContent : vnode;
const resetKeepAliveFlags = (vnode: VNode) => {
  vnode.shapeFlag &= ~(SHOULD_KEEP_ALIVE | KEPT_ALIVE);
};
const getName = (type: VNode['type']): string => {
  if (typeof type === 'string') return type;
  const component = type as {
    name?: string;
    __name?: string;
    displayName?: string;
    __asyncResolved?: VNode['type'];
  };
  if (component.__asyncResolved) return getName(component.__asyncResolved);
  return component.name || component.__name || component.displayName || '';
};
const matches = (pattern: MatchPattern, name: string): boolean => {
  if (Array.isArray(pattern)) return pattern.some((entry) => matches(entry, name));
  if (typeof pattern === 'string') return pattern.split(',').includes(name);
  pattern.lastIndex = 0;
  return pattern.test(name);
};
const isSamePage = (a: VNode, b: VNode | null): boolean =>
  !!b && a.type === b.type && a.key === b.key;

const RouteKeepAlive = defineComponent({
  name: 'RouteKeepAlive',
  __isKeepAlive: true,
  inheritAttrs: false,
  props: {
    include: [String, RegExp, Array] as PropType<MatchPattern>,
    exclude: [String, RegExp, Array] as PropType<MatchPattern>,
    max: [String, Number],
  },
  setup(props, { slots, expose }) {
    const instance = getCurrentInstance() as CacheInstance;
    const context = instance.ctx;
    if (!context.renderer) return () => slots.default?.();

    const {
      p: patch,
      m: move,
      um: rendererUnmount,
      o: { createElement },
    } = context.renderer;
    const suspense = instance.suspense;
    const storage = createElement('div');
    const cache = new Map<RouteCacheKey, VNode>();
    const keys = new Set<RouteCacheKey>();
    const pendingPrune = new Map<RouteCacheKey, VNode>();
    const destroyed = new WeakSet<ComponentInternalInstance>();
    let current: VNode | null = null;
    let pendingCacheKey: RouteCacheKey | null = null;
    let disposed = false;

    const queueEffect = (effect: () => void, boundary = suspense) => {
      if (boundary?.pendingBranch) boundary.effects.push(effect);
      else queuePostFlushCb(effect);
    };
    const isAlive = (child: CacheInstance) =>
      !child.isUnmounted && child.scope.active && !destroyed.has(child);
    const invokeVNodeHook = (vnode: VNode, hook: 'onVnodeMounted' | 'onVnodeUnmounted') => {
      const callback = vnode.props?.[hook];
      if (callback)
        callWithAsyncErrorHandling(
          callback,
          vnode.component?.parent ?? null,
          ErrorCodes.VNODE_HOOK,
          [vnode],
        );
    };
    const unmount = (vnode: VNode) => {
      resetKeepAliveFlags(vnode);
      const child = vnode.component as CacheInstance | null;
      // Vue stops the scope synchronously, but sets isUnmounted later. Both
      // native unmount and our own prune must be recognized before touching DOM.
      if (child && !isAlive(child)) return;
      if (child) destroyed.add(child);
      rendererUnmount(vnode, instance, suspense, true);
    };
    const flushPendingPrune = () => {
      for (const [key, vnode] of pendingPrune) {
        if (isSamePage(vnode, current)) continue;
        pendingPrune.delete(key);
        unmount(vnode);
      }
    };

    context.activate = (vnode, container, anchor, namespace, optimized) => {
      const child = vnode.component as CacheInstance;
      move(vnode, container, anchor, 0, suspense);
      patch(
        child.vnode,
        vnode,
        container,
        anchor,
        child,
        suspense,
        namespace,
        (vnode as VNode & { slotScopeIds: string[] | null }).slotScopeIds,
        optimized,
      );
      queueEffect(() => {
        if (disposed || !isAlive(child)) return;
        child.isDeactivated = false;
        child.a?.forEach((hook) => hook());
        invokeVNodeHook(vnode, 'onVnodeMounted');
      });
    };
    context.deactivate = (vnode) => {
      const child = vnode.component as CacheInstance;
      move(vnode, storage, null, 1, suspense);
      queueEffect(() => {
        if (disposed || !isAlive(child)) return;
        child.da?.forEach((hook) => hook());
        invokeVNodeHook(vnode, 'onVnodeUnmounted');
        child.isDeactivated = true;
        flushPendingPrune();
      });
    };

    const pruneCacheEntry = (key: RouteCacheKey) => {
      const cached = cache.get(key);
      if (cached) {
        if (isSamePage(cached, current)) {
          resetKeepAliveFlags(cached);
          resetKeepAliveFlags(current!);
          pendingPrune.set(key, cached);
        } else unmount(cached);
      }
      cache.delete(key);
      keys.delete(key);
    };
    const pruneCache = (filter: (name: string) => boolean) => {
      for (const [key, vnode] of cache) {
        const name = getName(vnode.type);
        if (!name || !filter(name)) pruneCacheEntry(key);
      }
    };
    const controller: RouteKeepAliveController = {
      clearCache: () => {
        for (const key of cache.keys()) pruneCacheEntry(key);
      },
      clearCacheByKey: pruneCacheEntry,
      pruneCache,
      pruneCacheEntry,
      getCachedKeys: () => Array.from(keys),
      getCacheSize: () => keys.size,
    };
    expose(controller);
    watch(
      () => [props.include, props.exclude],
      ([include, exclude]) => {
        pruneCache(
          (name) => (!include || matches(include, name)) && (!exclude || !matches(exclude, name)),
        );
      },
      { flush: 'post', deep: true },
    );

    const cacheSubtree = () => {
      flushPendingPrune();
      const key = pendingCacheKey;
      const record = () => {
        if (disposed || key === null || key !== pendingCacheKey || pendingPrune.has(key)) return;
        const vnode = getInnerChild(instance.subTree);
        if (vnode.component) cache.set(key, vnode);
      };
      if (instance.subTree.shapeFlag & SUSPENSE) queueEffect(record, instance.subTree.suspense);
      else record();
    };
    onMounted(cacheSubtree);
    onUpdated(cacheSubtree);
    onBeforeUnmount(() => {
      disposed = true;
      const active = getInnerChild(instance.subTree);
      for (const vnode of [...cache.values(), ...pendingPrune.values()]) {
        if (vnode.component && vnode.component === active.component) continue;
        unmount(vnode);
      }
      // The renderer owns unmounting the active subtree. Never prune it again.
      const wasCached =
        !!(active.shapeFlag & SHOULD_KEEP_ALIVE) ||
        [...pendingPrune.values()].some((vnode) => vnode.component === active.component);
      resetKeepAliveFlags(active);
      if (wasCached)
        queueEffect(() =>
          (active.component as CacheInstance | null)?.da?.forEach((hook) => hook()),
        );
      cache.clear();
      keys.clear();
      pendingPrune.clear();
      current = null;
    });

    return () => {
      pendingCacheKey = null;
      const children = slots.default?.();
      if (!children?.length) return (current = null);
      const rawVNode = children[0];
      if (children.length !== 1) {
        if (import.meta.env.DEV) console.warn('RouteKeepAlive expects one component child.');
        current = null;
        return children;
      }
      if (!isVNode(rawVNode) || !(rawVNode.shapeFlag & (STATEFUL_COMPONENT | SUSPENSE))) {
        current = null;
        return rawVNode;
      }
      let vnode = getInnerChild(rawVNode);
      const name = getName(vnode.type);
      if (
        (props.include && (!name || !matches(props.include, name))) ||
        (props.exclude && name && matches(props.exclude, name))
      ) {
        resetKeepAliveFlags(vnode);
        current = vnode;
        return rawVNode;
      }
      if (vnode.el) {
        vnode = cloneVNode(vnode);
        if (rawVNode.shapeFlag & SUSPENSE)
          (rawVNode as VNode & { ssContent: VNode }).ssContent = vnode;
      }
      const key = vnode.key ?? vnode.type;
      // Clearing the current page invalidates it until it leaves. An unrelated
      // render with the same key must not silently put that instance back.
      if (pendingPrune.has(key) && isSamePage(pendingPrune.get(key)!, vnode)) {
        resetKeepAliveFlags(vnode);
        current = vnode;
        return rawVNode.shapeFlag & SUSPENSE ? rawVNode : vnode;
      }
      let cached = cache.get(key);
      if (cached && cached.type !== vnode.type) {
        pruneCacheEntry(key);
        cached = undefined;
      }
      pendingCacheKey = key;
      if (cached) {
        vnode.el = cached.el;
        vnode.component = cached.component;
        if (vnode.transition) setTransitionHooks(vnode, vnode.transition);
        vnode.shapeFlag |= KEPT_ALIVE;
        keys.delete(key);
      }
      keys.add(key);
      const max = Number.parseInt(String(props.max), 10);
      while (max > 0 && keys.size > max) pruneCacheEntry(keys.values().next().value!);
      vnode.shapeFlag |= SHOULD_KEEP_ALIVE;
      current = vnode;
      return rawVNode.shapeFlag & SUSPENSE ? rawVNode : vnode;
    };
  },
});

export default RouteKeepAlive;
