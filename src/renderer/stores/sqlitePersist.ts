import type { PiniaPluginContext, StateTree } from 'pinia';
import { effectScope, watch } from 'vue';
import { getStorePersistenceKey } from '../../shared/storePersistence';
import logger from '@/utils/logger';

type PersistOptions =
  | boolean
  | {
      pick?: string[];
      omit?: string[];
    };

type PersistConfig = Exclude<PersistOptions, boolean>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hydrationPromises = new Set<Promise<void>>();

// 持久化订阅的长期宿主:随应用整个生命周期存在,永不 stop。
// 独立 scope 可避免 watch 绑定到「首次创建该 store 时所处的组件 scope」
// ——若该 store 恰好首次在会卸载的组件(如插件迷你 app)内被访问,
// 组件卸载时订阅会被一并摘除,导致此后静默不再存盘。
const persistScope = effectScope(true);

export const waitForSqlitePersistHydration = async () => {
  await Promise.all(Array.from(hydrationPromises));
};

const clone = <T>(value: T): T => {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Some reactive proxies and platform objects cannot be cloned structurally.
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
};

const isSamePersistedValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => isSamePersistedValue(value, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      isSamePersistedValue(left[key], right[key]),
  );
};

const getPersistOptions = (options: unknown): PersistOptions => {
  if (!isObject(options) || !('persist' in options)) return false;
  const persist = Reflect.get(options, 'persist');
  if (persist === true) return true;
  if (!isObject(persist)) return false;
  return {
    pick: Array.isArray(persist.pick) ? persist.pick.map(String) : undefined,
    omit: Array.isArray(persist.omit) ? persist.omit.map(String) : undefined,
  };
};

const buildPersistedState = (state: StateTree, options: true | PersistConfig): StateTree => {
  if (options === true) return clone(state);

  if (options.pick?.length) {
    const picked = Object.fromEntries(
      options.pick
        .filter((key) => Object.prototype.hasOwnProperty.call(state, key))
        .map((key) => [key, state[key]]),
    );
    return clone(picked);
  }

  const source = clone(state);
  if (options.omit?.length) {
    const omitted = new Set(options.omit);
    return Object.fromEntries(Object.entries(source).filter(([key]) => !omitted.has(key)));
  }

  return source;
};

const pickDeclaredState = (saved: StateTree, current: StateTree): StateTree => {
  const declaredKeys = new Set(Object.keys(current));
  return Object.fromEntries(Object.entries(saved).filter(([key]) => declaredKeys.has(key)));
};

export const sqlitePersistPlugin = ({ store, options }: PiniaPluginContext) => {
  const persist = getPersistOptions(options);
  if (store.$id === 'playlist' || !persist || !window.electron?.storage) {
    return {
      $clearPersistedState: async () => {},
    };
  }

  const storageKey = getStorePersistenceKey(store.$id);
  let hydrated = false;
  let pendingSave = 0;
  let lastPersistedState: StateTree | null = null;
  let writes = Promise.resolve();

  const hydration = window.electron.storage
    .getKv<StateTree>(storageKey)
    .then((saved) => {
      if (saved && typeof saved === 'object') {
        store.$patch(buildPersistedState(pickDeclaredState(saved, store.$state), persist));
      }
      lastPersistedState = buildPersistedState(store.$state, persist);
      hydrated = true;
    })
    .catch((error) => {
      logger.warn('SqlitePersist', `Read store ${store.$id} failed`, error);
      // Let startup continue and allow later mutations to persist again.
      hydrated = true;
    })
    .finally(() => {
      hydrationPromises.delete(hydration);
    });
  hydrationPromises.add(hydration);

  const clearPersistedState = async () => {
    await hydration;
    if (pendingSave) {
      window.clearTimeout(pendingSave);
      pendingSave = 0;
    }
    const deletion = writes.then(async () => {
      await window.electron?.storage?.deleteKv(storageKey);
      lastPersistedState = null;
    });
    writes = deletion.catch((error) => {
      logger.warn('SqlitePersist', `Clear store ${store.$id} failed`, error);
    });
    await deletion;
  };

  // 订阅范围限定为待持久化的顶层字段:Pinia 的 $subscribe 是对整个 $state 的
  // deep watch,每次突变都会全量 traverse(歌词 store 的候选缓存曾因此把单次
  // 行切换拖到 100ms 级阻塞);显式 watch 把 deep 遍历限制在持久化相关字段内。
  const stateKeys = Object.keys(store.$state);
  const watchedKeys =
    persist === true
      ? stateKeys
      : persist.pick?.length
        ? persist.pick.filter((key) => stateKeys.includes(key))
        : stateKeys.filter((key) => !persist.omit?.includes(key));
  persistScope.run(() => {
    watch(
      () => watchedKeys.map((key) => store.$state[key]),
      () => {
        if (!hydrated || !window.electron?.storage) return;
        if (pendingSave) return;
        pendingSave = window.setTimeout(() => {
          pendingSave = 0;
          const payload = buildPersistedState(store.$state, persist);
          writes = writes
            .then(async () => {
              if (lastPersistedState && isSamePersistedValue(payload, lastPersistedState)) return;
              await window.electron?.storage?.setKv(storageKey, payload);
              lastPersistedState = payload;
            })
            .catch((error) => {
              logger.warn('SqlitePersist', `Save store ${store.$id} failed`, error);
            });
        }, 120);
      },
      { deep: true },
    );
  });

  return {
    $clearPersistedState: clearPersistedState,
  };
};
