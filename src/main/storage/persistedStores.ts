import { getStorePersistenceKey } from '../../shared/storePersistence';
import { getKvStorage } from './kv';

const DEVICE_STORE_ID = 'device';
const SETTING_STORE_ID = 'setting';

type PersistedState = Record<string, unknown>;

export interface PersistedDeviceInfo extends PersistedState {
  guid?: string;
  mac?: string;
  mid?: string;
  serverDev?: string;
}

const isPersistedState = (value: unknown): value is PersistedState =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readPersistedStore = (storeId: string): PersistedState => {
  const value = getKvStorage().get<unknown>(getStorePersistenceKey(storeId));
  return isPersistedState(value) ? value : {};
};

export const getPersistedRendererSettings = (): PersistedState =>
  readPersistedStore(SETTING_STORE_ID);

export const getPersistedDeviceInfo = (): PersistedDeviceInfo | null => {
  const info = readPersistedStore(DEVICE_STORE_ID).info;
  return isPersistedState(info) ? (info as PersistedDeviceInfo) : null;
};

export const mergePersistedDeviceInfo = (info: PersistedDeviceInfo): void => {
  const storage = getKvStorage();
  const key = getStorePersistenceKey(DEVICE_STORE_ID);
  const state = readPersistedStore(DEVICE_STORE_ID);
  const currentInfo = isPersistedState(state.info) ? state.info : {};

  storage.set(key, {
    ...state,
    info: {
      ...currentInfo,
      ...info,
    },
  });
};
