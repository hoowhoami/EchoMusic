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
let wakeRecovery: Promise<void> | null = null;
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

/** Reset transient transport state after sleep without touching cookies or stored settings. */
export const recoverNetworkAfterWake = (): Promise<void> => {
  if (wakeRecovery) return wakeRecovery;

  const task = applyQueue.then(async () => {
    const sessions = [...registeredSessions];
    log.info('[Network] Wake recovery started', { sessionCount: sessions.length });
    const results = await Promise.allSettled(
      sessions.map(async (networkSession, sessionIndex) => {
        const operations = [
          ['connections', () => networkSession.closeAllConnections()],
          ['dns', () => networkSession.clearHostResolverCache()],
          ['proxy', () => networkSession.forceReloadProxyConfig()],
        ] as const;
        const outcomes = await Promise.allSettled(
          operations.map(([, run]) => Promise.resolve().then(run)),
        );
        let failed = false;
        outcomes.forEach((outcome, index) => {
          if (outcome.status !== 'rejected') return;
          failed = true;
          log.warn('[Network] Wake recovery operation failed', {
            sessionIndex,
            operation: operations[index][0],
            error: String(outcome.reason),
          });
        });
        if (failed) throw new Error('Network session recovery failed');
      }),
    );
    const failedSessions = results.filter((result) => result.status === 'rejected').length;
    log.info('[Network] Wake recovery finished', {
      sessionCount: sessions.length,
      failedSessions,
    });
    if (failedSessions > 0)
      throw new Error(`Network wake recovery failed for ${failedSessions} sessions`);
  });
  // New managed requests and proxy updates wait until recovery settles. Do not retry requests:
  // closing old connections can fail in-flight writes which are unsafe to replay automatically.
  applyQueue = task.catch(() => undefined);
  wakeRecovery = task;
  const finish = () => {
    if (wakeRecovery === task) wakeRecovery = null;
  };
  void task.then(finish, finish);
  return task;
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
