import path from 'path';
import axios from 'axios';
import { safeStorage } from 'electron';
import log from './logger';
import { getKvStorage } from './storage/kv';
import { getPersistedRendererSettings } from './storage/persistedStores';
import {
  DEFAULT_NETWORK_SETTINGS,
  getNetworkSettingsValidationError,
  normalizeNetworkSettings,
  type NetworkSettings,
  type NetworkSettingsState,
  type NetworkSettingsUpdateRequest,
} from '../shared/network';
import { getStorePersistenceKey } from '../shared/storePersistence';
import { createElectronAxiosAdapter } from './electronAxiosAdapter';
import {
  APP_NETWORK_SESSION_PARTITION,
  KUGOU_API_SESSION_PARTITION,
  hasProxyPassword,
  initializeNetworkPolicy,
  updateNetworkPolicy,
} from './networkPolicy';

let currentNetworkSettings = DEFAULT_NETWORK_SETTINGS;
let apiServerPath: string | undefined;
let currentProxyPassword = '';
let initialized = false;
let settingsUpdateQueue: Promise<NetworkSettingsState> = Promise.resolve({
  settings: DEFAULT_NETWORK_SETTINGS,
  hasProxyPassword: false,
});
const PROXY_PASSWORD_STORAGE_KEY = 'network:proxy-password';

const decryptPersistedProxyPassword = (): string => {
  const encrypted = getKvStorage().get<string>(PROXY_PASSWORD_STORAGE_KEY);
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch (error) {
    log.warn('[Network] Failed to decrypt saved proxy password:', error);
    return '';
  }
};

const encryptProxyPassword = (password: string): string | null => {
  if (!password) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统无法安全保存代理密码');
  }
  return safeStorage.encryptString(password).toString('base64');
};

const persistNetworkState = (settings: NetworkSettings, proxyPassword: string) => {
  const encryptedProxyPassword = encryptProxyPassword(proxyPassword);
  const persistedSettings = getPersistedRendererSettings();
  getKvStorage().applyBatch([
    {
      key: getStorePersistenceKey('setting'),
      value: {
        ...persistedSettings,
        ...settings,
      },
    },
    encryptedProxyPassword
      ? { key: PROXY_PASSWORD_STORAGE_KEY, value: encryptedProxyPassword }
      : { key: PROXY_PASSWORD_STORAGE_KEY, delete: true },
  ]);
};

const loadPersistedNetworkSettings = (): NetworkSettings => {
  const persisted = getPersistedRendererSettings();
  const settings = normalizeNetworkSettings(persisted);
  currentProxyPassword = decryptPersistedProxyPassword();
  return settings;
};

export const getNetworkSettings = (): NetworkSettings => currentNetworkSettings;

export const refreshNetworkSettingsFromStorage = (): NetworkSettings => {
  if (initialized) return currentNetworkSettings;
  currentNetworkSettings = loadPersistedNetworkSettings();
  applyKugouApiNetworkSettings(currentNetworkSettings);
  return currentNetworkSettings;
};

export const getNetworkSettingsState = (): NetworkSettingsState => ({
  settings: { ...currentNetworkSettings },
  hasProxyPassword: hasProxyPassword(),
});

export const initializeNetworkSettings = async () => {
  currentNetworkSettings = loadPersistedNetworkSettings();
  const validationError = getNetworkSettingsValidationError(currentNetworkSettings);
  if (validationError) throw new Error(validationError);
  await initializeNetworkPolicy(currentNetworkSettings, currentProxyPassword);
  axios.defaults.adapter = createElectronAxiosAdapter(axios, APP_NETWORK_SESSION_PARTITION);
  initialized = true;
  applyKugouApiNetworkSettings(currentNetworkSettings);
  return getNetworkSettingsState();
};

const applyNetworkSettingsUpdate = async (
  request: NetworkSettingsUpdateRequest,
): Promise<NetworkSettingsState> => {
  const settings = request?.settings ?? {};
  const nextSettings = normalizeNetworkSettings({
    ...currentNetworkSettings,
    ...settings,
  });
  const validationError = getNetworkSettingsValidationError(nextSettings);
  if (validationError) throw new Error(validationError);
  let nextProxyPassword = currentProxyPassword;
  if (request?.proxyPassword !== undefined) {
    nextProxyPassword = request.proxyPassword;
  } else if (request?.clearProxyPassword) {
    nextProxyPassword = '';
  }
  const previousSettings = currentNetworkSettings;
  const previousProxyPassword = currentProxyPassword;
  try {
    await updateNetworkPolicy(nextSettings, nextProxyPassword);
    persistNetworkState(nextSettings, nextProxyPassword);
  } catch (error) {
    await updateNetworkPolicy(previousSettings, previousProxyPassword).catch((rollbackError) => {
      log.error('[Network] Failed to restore proxy policy after apply failure:', rollbackError);
    });
    throw error;
  }
  currentNetworkSettings = nextSettings;
  currentProxyPassword = nextProxyPassword;
  applyKugouApiNetworkSettings(currentNetworkSettings);
  return getNetworkSettingsState();
};

export const updateNetworkSettings = (
  request: NetworkSettingsUpdateRequest,
): Promise<NetworkSettingsState> => {
  const task = settingsUpdateQueue.then(() => applyNetworkSettingsUpdate(request));
  settingsUpdateQueue = task.catch(() => getNetworkSettingsState());
  return task;
};

export const applyKugouApiNetworkSettings = (
  settings = currentNetworkSettings,
  serverPath?: string,
) => {
  if (serverPath) apiServerPath = serverPath;
  // server 内所有 Axios 请求均使用 Chromium Session adapter。保留该环境变量会让
  // server 再解析一遍简化代理 URL，破坏 PAC、WPAD 和复杂 proxyRules 语义。
  delete process.env.KUGOU_API_PROXY;

  const targetServerPath = serverPath ?? apiServerPath;
  if (!targetServerPath) return;

  try {
    // Keep this outside server/ so the submodule stays untouched while its axios instance
    // still receives app-level network defaults.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const axios = require(path.join(targetServerPath, 'node_modules', 'axios'));
    axios.defaults.timeout = Math.max(0, Math.round(settings.kugouApiTimeoutSecs * 1000));
    axios.defaults.adapter = createElectronAxiosAdapter(axios, KUGOU_API_SESSION_PARTITION);
    log.info('[Network] Applied Kugou API network settings', {
      proxyMode: settings.proxyMode,
      timeoutSecs: settings.kugouApiTimeoutSecs,
      transport: 'chromium',
    });
  } catch (error) {
    log.warn('[Network] Failed to apply Kugou API axios defaults:', error);
  }
};
