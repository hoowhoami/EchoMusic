import type { PiniaPluginContext, StateTree } from 'pinia';

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

export const waitForSqlitePersistHydration = async () => {
  await Promise.all(Array.from(hydrationPromises));
};

const clone = <T>(value: T): T => {
  return JSON.parse(JSON.stringify(value)) as T;
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

export const sqlitePersistPlugin = ({ store, options }: PiniaPluginContext) => {
  if (store.$id === 'playlist') return;
  const persist = getPersistOptions(options);
  if (!persist || !window.electron?.storage) return;

  const storageKey = `pinia:${store.$id}`;
  let hydrated = false;
  let pendingSave = 0;
  let lastPersistedJson = '';

  const hydration = window.electron.storage
    .getKv<StateTree>(storageKey)
    .then((saved) => {
      if (saved && typeof saved === 'object') {
        store.$patch(saved);
      }
      lastPersistedJson = JSON.stringify(buildPersistedState(store.$state, persist));
      hydrated = true;
    })
    .finally(() => {
      hydrationPromises.delete(hydration);
    });
  hydrationPromises.add(hydration);

  store.$subscribe(
    (_mutation, state) => {
      if (!hydrated || !window.electron?.storage) return;
      if (pendingSave) return;
      pendingSave = window.setTimeout(() => {
        pendingSave = 0;
        const payload = buildPersistedState(state, persist);
        const nextPersistedJson = JSON.stringify(payload);
        if (nextPersistedJson === lastPersistedJson) return;
        lastPersistedJson = nextPersistedJson;
        void window.electron?.storage?.setKv(storageKey, payload);
      }, 120);
    },
    { detached: true },
  );
};
