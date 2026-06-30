import { reactive } from 'vue';
import type { LyricCharacterPayload, LyricLinePayload } from '../../shared/lyrics';

export type PluginLyricEffectScope = 'page';
export type PluginLyricEffectLayer = 'style' | 'decorator';

export type PluginLyricEffectLine = LyricLinePayload & {
  romanizedCharacters?: LyricCharacterPayload[];
  translatedCharacters?: LyricCharacterPayload[];
};

export type PluginLyricEffectSnapshot = {
  scope: PluginLyricEffectScope;
  lines: PluginLyricEffectLine[];
  currentIndex: number;
  scrollIndex: number;
  currentLine: PluginLyricEffectLine | null;
  currentTime: number;
  duration: number;
  playbackRate: number;
  isPlaying: boolean;
  timelineMs: number;
  lyricOffsetMs: number;
  lyricsMode: 'none' | 'translation' | 'romanization' | 'both';
  collapsed: boolean;
  hasLyrics: boolean;
  reducedMotion: boolean;
};

export type PluginLyricEffectAutoScrollRequest = {
  scope: PluginLyricEffectScope;
  index: number;
  targetTop: number;
  smooth: boolean;
  collapsed: boolean;
  snapshot: PluginLyricEffectSnapshot;
};

export interface PluginLyricEffectHost {
  scope: PluginLyricEffectScope;
  root: HTMLElement;
  scroller: HTMLElement;
  overlay: HTMLElement;
  getSnapshot: () => PluginLyricEffectSnapshot;
  subscribe: (handler: (snapshot: PluginLyricEffectSnapshot) => void) => () => void;
  setAutoScrollHandler: (
    handler: (request: PluginLyricEffectAutoScrollRequest) => boolean | void,
  ) => () => void;
  requestUpdate: () => void;
}

export interface PluginLyricEffectContribution {
  id?: string;
  title?: string;
  scope?: PluginLyricEffectScope | PluginLyricEffectScope[];
  layer?: PluginLyricEffectLayer;
  order?: number;
  className?: string;
  css?: string;
  mount?: (host: PluginLyricEffectHost) => void | (() => void);
}

type RegisteredPluginLyricEffect = {
  pluginId: string;
  id: string;
  key: string;
  title: string;
  scopes: PluginLyricEffectScope[];
  layer: PluginLyricEffectLayer;
  order: number;
  classNames: string[];
  css: string;
  mount?: PluginLyricEffectContribution['mount'];
  onError?: (source: string, error: unknown) => void;
  disposeStyle?: () => void;
  hostDisposers: Map<number, () => void>;
};

type RegisteredPluginLyricEffectHostSubscriber = {
  effectKey: string;
  handler: (snapshot: PluginLyricEffectSnapshot) => void;
};

type RegisteredPluginLyricEffectAutoScrollHandler = {
  effectKey: string;
  order: number;
  handler: (request: PluginLyricEffectAutoScrollRequest) => boolean | void;
};

type RegisteredPluginLyricEffectHost = {
  id: number;
  scope: PluginLyricEffectScope;
  root: HTMLElement;
  scroller: HTMLElement;
  overlay: HTMLElement;
  getSnapshot: () => PluginLyricEffectSnapshot;
  subscribers: Set<RegisteredPluginLyricEffectHostSubscriber>;
  autoScrollHandlers: Set<RegisteredPluginLyricEffectAutoScrollHandler>;
};

export const pluginLyricEffectState = reactive({
  revision: 0,
});

const lyricEffects: RegisteredPluginLyricEffect[] = [];
const lyricEffectHosts = new Map<number, RegisteredPluginLyricEffectHost>();
let nextLyricEffectHostId = 1;

const validScopes = new Set<PluginLyricEffectScope>(['page']);
const validLayers = new Set<PluginLyricEffectLayer>(['style', 'decorator']);

const bumpLyricEffectRevision = () => {
  pluginLyricEffectState.revision += 1;
};

const normalizeEffectId = (value: unknown) =>
  String(value ?? 'default')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .slice(0, 80) || 'default';

const normalizeEffectScopes = (
  value: PluginLyricEffectContribution['scope'],
): PluginLyricEffectScope[] => {
  const input = Array.isArray(value) ? value : [value ?? 'page'];
  const scopes = input.filter((scope): scope is PluginLyricEffectScope => validScopes.has(scope));
  return Array.from(new Set(scopes.length > 0 ? scopes : ['page']));
};

const normalizeEffectLayer = (value: unknown): PluginLyricEffectLayer =>
  validLayers.has(value as PluginLyricEffectLayer) ? (value as PluginLyricEffectLayer) : 'style';

const normalizeClassNames = (value: unknown) =>
  String(value ?? '')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => /^-?[_a-zA-Z]+[_a-zA-Z0-9-]*$/.test(item))
    .slice(0, 12);

const normalizeOrder = (value: unknown) => {
  const order = Number(value);
  return Number.isFinite(order) ? order : 1000;
};

const compareLyricEffects = (
  left: RegisteredPluginLyricEffect,
  right: RegisteredPluginLyricEffect,
) =>
  left.order - right.order ||
  left.pluginId.localeCompare(right.pluginId, 'zh-Hans-CN') ||
  left.id.localeCompare(right.id, 'zh-Hans-CN');

const getLyricEffectStyleId = (effect: Pick<RegisteredPluginLyricEffect, 'pluginId' | 'id'>) =>
  `echo-plugin-lyric-effect-style-${effect.pluginId}-${effect.id}`;

const createLyricEffectStyle = (effect: RegisteredPluginLyricEffect) => {
  if (!effect.css || typeof document === 'undefined') return undefined;
  const elementId = getLyricEffectStyleId(effect);
  document.getElementById(elementId)?.remove();
  const style = document.createElement('style');
  style.id = elementId;
  style.dataset.pluginId = effect.pluginId;
  style.dataset.lyricEffectId = effect.id;
  style.textContent = effect.css;
  document.head.appendChild(style);
  return () => style.remove();
};

const createHostFacade = (
  effect: RegisteredPluginLyricEffect,
  host: RegisteredPluginLyricEffectHost,
): PluginLyricEffectHost => ({
  scope: host.scope,
  root: host.root,
  scroller: host.scroller,
  overlay: host.overlay,
  getSnapshot: host.getSnapshot,
  subscribe: (handler) => {
    const subscriber: RegisteredPluginLyricEffectHostSubscriber = {
      effectKey: effect.key,
      handler: (snapshot) => {
        try {
          handler(snapshot);
        } catch (error) {
          effect.onError?.(`歌词动效订阅: ${effect.title}`, error);
        }
      },
    };
    host.subscribers.add(subscriber);
    subscriber.handler(host.getSnapshot());
    return () => host.subscribers.delete(subscriber);
  },
  setAutoScrollHandler: (handler) => {
    const scrollHandler: RegisteredPluginLyricEffectAutoScrollHandler = {
      effectKey: effect.key,
      order: effect.order,
      handler: (request) => {
        try {
          return handler(request);
        } catch (error) {
          effect.onError?.(`歌词动效滚动: ${effect.title}`, error);
          return false;
        }
      },
    };
    host.autoScrollHandlers.add(scrollHandler);
    return () => host.autoScrollHandlers.delete(scrollHandler);
  },
  requestUpdate: () => notifyLyricEffectHost(host),
});

const mountEffectToHost = (
  effect: RegisteredPluginLyricEffect,
  host: RegisteredPluginLyricEffectHost,
) => {
  if (!effect.scopes.includes(host.scope) || effect.hostDisposers.has(host.id)) return;
  if (!effect.mount) {
    effect.hostDisposers.set(host.id, () => undefined);
    return;
  }

  try {
    const dispose = effect.mount(createHostFacade(effect, host));
    effect.hostDisposers.set(host.id, typeof dispose === 'function' ? dispose : () => undefined);
  } catch (error) {
    effect.onError?.(`歌词动效挂载: ${effect.title}`, error);
    effect.hostDisposers.set(host.id, () => undefined);
  }
};

const unmountEffectFromHost = (
  effect: RegisteredPluginLyricEffect,
  hostId: number,
  source = `歌词动效卸载: ${effect.title}`,
) => {
  const dispose = effect.hostDisposers.get(hostId);
  if (!dispose) return;
  effect.hostDisposers.delete(hostId);
  try {
    dispose();
  } catch (error) {
    effect.onError?.(source, error);
  }
  const host = lyricEffectHosts.get(hostId);
  if (!host) return;
  for (const subscriber of Array.from(host.subscribers)) {
    if (subscriber.effectKey === effect.key) host.subscribers.delete(subscriber);
  }
  for (const handler of Array.from(host.autoScrollHandlers)) {
    if (handler.effectKey === effect.key) host.autoScrollHandlers.delete(handler);
  }
};

const mountEffectToExistingHosts = (effect: RegisteredPluginLyricEffect) => {
  Array.from(lyricEffectHosts.values()).forEach((host) => mountEffectToHost(effect, host));
};

const findEffectIndex = (pluginId: string, effectId: string) =>
  lyricEffects.findIndex((effect) => effect.pluginId === pluginId && effect.id === effectId);

const disposeEffect = (effect: RegisteredPluginLyricEffect) => {
  Array.from(effect.hostDisposers.keys()).forEach((hostId) =>
    unmountEffectFromHost(effect, hostId),
  );
  effect.disposeStyle?.();
};

export const registerPluginLyricEffect = (
  pluginId: string,
  contribution: PluginLyricEffectContribution,
  onError?: (source: string, error: unknown) => void,
) => {
  const id = normalizeEffectId(contribution.id);
  const existingIndex = findEffectIndex(pluginId, id);
  if (existingIndex >= 0) {
    const existing = lyricEffects.splice(existingIndex, 1)[0];
    disposeEffect(existing);
  }

  const effect: RegisteredPluginLyricEffect = {
    pluginId,
    id,
    key: `${pluginId}:${id}`,
    title: String(contribution.title || id).trim() || id,
    scopes: normalizeEffectScopes(contribution.scope),
    layer: normalizeEffectLayer(contribution.layer),
    order: normalizeOrder(contribution.order),
    classNames: normalizeClassNames(contribution.className),
    css: String(contribution.css ?? ''),
    mount: contribution.mount,
    onError,
    hostDisposers: new Map(),
  };

  effect.disposeStyle = createLyricEffectStyle(effect);
  lyricEffects.push(effect);
  lyricEffects.sort(compareLyricEffects);
  mountEffectToExistingHosts(effect);
  bumpLyricEffectRevision();

  return () => {
    const index = findEffectIndex(pluginId, id);
    if (index < 0) return;
    const [current] = lyricEffects.splice(index, 1);
    disposeEffect(current);
    bumpLyricEffectRevision();
  };
};

export const removeLyricEffectsByPlugin = (pluginId: string) => {
  for (let index = lyricEffects.length - 1; index >= 0; index -= 1) {
    if (lyricEffects[index].pluginId !== pluginId) continue;
    const [effect] = lyricEffects.splice(index, 1);
    disposeEffect(effect);
  }
  bumpLyricEffectRevision();
};

export const getPluginLyricEffectClassNames = (scope: PluginLyricEffectScope) => {
  void pluginLyricEffectState.revision;
  return lyricEffects
    .filter((effect) => effect.scopes.includes(scope))
    .sort(compareLyricEffects)
    .flatMap((effect) => effect.classNames);
};

export const getPluginLyricEffectSummary = (scope: PluginLyricEffectScope) => {
  void pluginLyricEffectState.revision;
  const effects = lyricEffects
    .filter((effect) => effect.scopes.includes(scope))
    .sort(compareLyricEffects);
  return {
    count: effects.length,
    titles: effects.map((effect) => effect.title),
    hasDecorator: effects.some((effect) => effect.layer === 'decorator'),
  };
};

const notifyLyricEffectHost = (host: RegisteredPluginLyricEffectHost) => {
  if (host.subscribers.size === 0) return;
  const snapshot = host.getSnapshot();
  for (const subscriber of Array.from(host.subscribers)) {
    try {
      subscriber.handler(snapshot);
    } catch {
      host.subscribers.delete(subscriber);
    }
  }
};

export const registerPluginLyricEffectHost = (options: {
  scope: PluginLyricEffectScope;
  root: HTMLElement;
  scroller: HTMLElement;
  overlay: HTMLElement;
  getSnapshot: () => PluginLyricEffectSnapshot;
}) => {
  const host: RegisteredPluginLyricEffectHost = {
    id: nextLyricEffectHostId++,
    scope: options.scope,
    root: options.root,
    scroller: options.scroller,
    overlay: options.overlay,
    getSnapshot: options.getSnapshot,
    subscribers: new Set(),
    autoScrollHandlers: new Set(),
  };

  lyricEffectHosts.set(host.id, host);
  lyricEffects.forEach((effect) => mountEffectToHost(effect, host));
  notifyLyricEffectHost(host);

  return {
    notify: () => notifyLyricEffectHost(host),
    dispose: () => {
      lyricEffects.forEach((effect) => unmountEffectFromHost(effect, host.id));
      host.subscribers.clear();
      host.autoScrollHandlers.clear();
      lyricEffectHosts.delete(host.id);
    },
  };
};

export const requestPluginLyricAutoScroll = (
  scope: PluginLyricEffectScope,
  request: Omit<PluginLyricEffectAutoScrollRequest, 'scope' | 'snapshot'>,
) => {
  let handled = false;
  const hosts = Array.from(lyricEffectHosts.values()).filter((host) => host.scope === scope);

  for (const host of hosts) {
    const snapshot = host.getSnapshot();
    const fullRequest: PluginLyricEffectAutoScrollRequest = {
      ...request,
      scope,
      snapshot,
    };
    const handlers = Array.from(host.autoScrollHandlers).sort(
      (left, right) =>
        left.order - right.order || left.effectKey.localeCompare(right.effectKey, 'zh-Hans-CN'),
    );

    for (const entry of handlers) {
      try {
        if (entry.handler(fullRequest) === true) handled = true;
      } catch {
        host.autoScrollHandlers.delete(entry);
      }
    }
  }

  return handled;
};
