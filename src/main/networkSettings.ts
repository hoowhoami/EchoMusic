import path from 'path';
import log from './logger';
import { getKvStorage } from './storage/kv';
import {
  DEFAULT_NETWORK_SETTINGS,
  normalizeNetworkSettings,
  type NetworkSettings,
} from '../shared/network';
import { createElectronAxiosAdapter } from './electronAxiosAdapter';

const PINIA_SETTING_KEY = 'pinia:setting';

let currentNetworkSettings = DEFAULT_NETWORK_SETTINGS;
let apiServerPath: string | undefined;

const loadPersistedNetworkSettings = (): NetworkSettings => {
  const saved = getKvStorage().get<Record<string, unknown>>(PINIA_SETTING_KEY);
  return normalizeNetworkSettings(saved);
};

export const getNetworkSettings = (): NetworkSettings => currentNetworkSettings;

export const refreshNetworkSettingsFromStorage = (): NetworkSettings => {
  currentNetworkSettings = loadPersistedNetworkSettings();
  applyKugouApiNetworkSettings(currentNetworkSettings);
  return currentNetworkSettings;
};

export const updateNetworkSettings = (settings: Partial<NetworkSettings>): NetworkSettings => {
  currentNetworkSettings = normalizeNetworkSettings({
    ...currentNetworkSettings,
    ...settings,
  });
  applyKugouApiNetworkSettings(currentNetworkSettings);
  return currentNetworkSettings;
};

export const applyKugouApiNetworkSettings = (
  settings = currentNetworkSettings,
  serverPath?: string,
) => {
  if (serverPath) apiServerPath = serverPath;
  const proxyUrl = settings.kugouApiProxyUrl.trim();
  if (proxyUrl) process.env.KUGOU_API_PROXY = proxyUrl;
  else delete process.env.KUGOU_API_PROXY;

  const targetServerPath = serverPath ?? apiServerPath;
  if (!targetServerPath) return;

  try {
    // Keep this outside server/ so the submodule stays untouched while its axios instance
    // still receives app-level network defaults.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const axios = require(path.join(targetServerPath, 'node_modules', 'axios'));
    axios.defaults.timeout = Math.max(0, Math.round(settings.kugouApiTimeoutSecs * 1000));
    axios.defaults.adapter = createElectronAxiosAdapter(
      axios,
      () => currentNetworkSettings.kugouApiProxyUrl,
    );
    log.info('[Network] Applied Kugou API network settings', {
      proxy: proxyUrl ? 'configured' : 'system',
      timeoutSecs: settings.kugouApiTimeoutSecs,
      transport: 'chromium',
    });
  } catch (error) {
    log.warn('[Network] Failed to apply Kugou API axios defaults:', error);
  }
};
