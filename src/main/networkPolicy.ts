import { app, session, type ClientRequest, type Session } from 'electron';
import log from './logger';
import {
  addProxyCredentialsToUrl,
  DEFAULT_NETWORK_SETTINGS,
  parseElectronResolvedProxy,
  type NetworkSettings,
} from '../shared/network';

export const APP_NETWORK_SESSION_PARTITION = 'echo-app-network';
export const KUGOU_API_SESSION_PARTITION = 'echo-kugou-api';
export const COMMUNITY_AUDIO_SESSION_PARTITION = 'echo-community-audio';
export const DESKTOP_LYRIC_SESSION_PARTITION = 'persist:desktop-lyric';
export const UPDATER_SESSION_PARTITION = 'electron-updater';

interface ProxyCredentials {
  username: string;
  password: string;
}

let currentSettings = DEFAULT_NETWORK_SETTINGS;
let currentProxyPassword = '';
let credentialRevision = 0;
let lifecycleInstalled = false;
let applyQueue: Promise<void> = Promise.resolve();
const registeredSessions = new Set<Session>();
const appliedKeys = new WeakMap<Session, string>();

const getProxyConfig = (settings: NetworkSettings): Electron.ProxyConfig => {
  if (settings.proxyMode === 'pac_script') {
    return { mode: 'pac_script', pacScript: settings.proxyPacScript };
  }
  if (settings.proxyMode === 'fixed_servers') {
    return {
      mode: 'fixed_servers',
      proxyRules: settings.proxyRules,
      proxyBypassRules: settings.proxyBypassRules,
    };
  }
  return { mode: settings.proxyMode };
};

const getProxyKey = (settings: NetworkSettings) =>
  [
    settings.proxyMode,
    settings.proxyPacScript,
    settings.proxyRules,
    settings.proxyUsername,
    settings.proxyBypassRules,
    credentialRevision,
  ].join('\0');

const applyToSession = async (networkSession: Session, closeExistingConnections: boolean) => {
  const desiredKey = getProxyKey(currentSettings);
  const previousKey = appliedKeys.get(networkSession);
  if (previousKey === desiredKey) return;

  await networkSession.setProxy(getProxyConfig(currentSettings));
  appliedKeys.set(networkSession, desiredKey);
  if (closeExistingConnections && previousKey !== undefined) {
    await networkSession.closeAllConnections();
  }
};

export const getProxyCredentials = (): ProxyCredentials | undefined => {
  if (currentSettings.proxyMode === 'direct') return undefined;
  if (!currentSettings.proxyUsername && !currentProxyPassword) return undefined;
  return {
    username: currentSettings.proxyUsername,
    password: currentProxyPassword,
  };
};

export const hasProxyPassword = () => Boolean(currentProxyPassword);

export const registerNetworkSession = async (networkSession: Session): Promise<Session> => {
  registeredSessions.add(networkSession);
  const task = applyQueue.then(() => applyToSession(networkSession, false));
  applyQueue = task.catch(() => undefined);
  await task;
  return networkSession;
};

export const getManagedNetworkSession = async (partition = APP_NETWORK_SESSION_PARTITION) => {
  return registerNetworkSession(session.fromPartition(partition));
};

export const initializeNetworkPolicy = async (settings: NetworkSettings, proxyPassword = '') => {
  currentSettings = settings;
  currentProxyPassword = proxyPassword;

  const initialSessions = [
    session.defaultSession,
    session.fromPartition(APP_NETWORK_SESSION_PARTITION),
    session.fromPartition(KUGOU_API_SESSION_PARTITION),
    session.fromPartition(COMMUNITY_AUDIO_SESSION_PARTITION),
    session.fromPartition(DESKTOP_LYRIC_SESSION_PARTITION),
    session.fromPartition(UPDATER_SESSION_PARTITION, { cache: false }),
  ];
  await Promise.all(
    initialSessions.map((networkSession) => registerNetworkSession(networkSession)),
  );
};

export const updateNetworkPolicy = async (
  settings: NetworkSettings,
  proxyPassword = currentProxyPassword,
) => {
  if (
    settings.proxyUsername !== currentSettings.proxyUsername ||
    proxyPassword !== currentProxyPassword
  ) {
    credentialRevision += 1;
  }
  currentSettings = settings;
  currentProxyPassword = proxyPassword;
  const task = applyQueue.then(async () => {
    await Promise.all(
      [...registeredSessions].map((networkSession) => applyToSession(networkSession, true)),
    );
  });
  applyQueue = task.catch(() => undefined);
  await task;
};

export const attachProxyLoginHandler = (request: ClientRequest) => {
  const credentials = getProxyCredentials();
  if (!credentials) return;
  request.on('login', (authInfo, callback) => {
    if (authInfo.isProxy) {
      callback(credentials.username, credentials.password);
      return;
    }
    callback();
  });
};

export const installNetworkPolicyLifecycle = () => {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;

  app.on('session-created', (networkSession) => {
    void registerNetworkSession(networkSession).catch((error) => {
      log.warn('[Network] Failed to apply proxy to a new Electron session:', error);
    });
  });
  app.on('login', (event, _webContents, _details, authInfo, callback) => {
    const credentials = getProxyCredentials();
    if (!authInfo.isProxy || !credentials) return;
    event.preventDefault();
    callback(credentials.username, credentials.password);
  });
};

export const networkFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const networkSession = await getManagedNetworkSession();
  return networkSession.fetch(input instanceof URL ? input.toString() : input, init);
};

export const resolveNativeProxyUrls = async (targetUrl: string): Promise<string[]> => {
  if (!/^https?:\/\//i.test(targetUrl) || currentSettings.proxyMode === 'direct') return [''];

  const networkSession = await getManagedNetworkSession();
  const resolved = await networkSession.resolveProxy(targetUrl);
  const credentials = getProxyCredentials();
  const candidates = parseElectronResolvedProxy(resolved).map((proxyUrl) =>
    addProxyCredentialsToUrl(proxyUrl, credentials),
  );
  if (candidates.length === 0) {
    throw new Error(`Electron 返回了原生播放器无法使用的代理结果：${resolved}`);
  }
  return candidates;
};
