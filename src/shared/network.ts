export type NetworkProxyMode = 'system' | 'direct' | 'auto_detect' | 'pac_script' | 'fixed_servers';

export interface NetworkSettings {
  proxyMode: NetworkProxyMode;
  proxyPacScript: string;
  proxyRules: string;
  proxyUsername: string;
  proxyBypassRules: string;
  /** 全局自定义 User-Agent，作用于窗口/插件等全局网络栈；留空使用 Electron 默认值 */
  userAgent: string;
  /** 酷狗 API 专用 User-Agent，仅覆盖酷狗接口请求；留空保持上游默认行为 */
  kugouUserAgent: string;
  kugouApiTimeoutSecs: number;
  playerNetworkTimeoutSecs: number;
}

export interface NetworkSettingsUpdateRequest {
  settings: Partial<NetworkSettings>;
  proxyPassword?: string;
  clearProxyPassword?: boolean;
}

export interface NetworkSettingsState {
  settings: NetworkSettings;
  hasProxyPassword: boolean;
}

export interface NetworkProxyCredentials {
  username: string;
  password: string;
}

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  proxyMode: 'direct',
  proxyPacScript: '',
  proxyRules: '',
  proxyUsername: '',
  proxyBypassRules: '<local>',
  userAgent: '',
  kugouUserAgent: '',
  kugouApiTimeoutSecs: 0,
  playerNetworkTimeoutSecs: 60,
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

export const normalizeProxyPacScript = (value: unknown): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'file:'].includes(url.protocol)) return '';
    if (url.protocol !== 'file:' && !url.hostname) return '';
    if (url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
};

export const normalizeProxyRules = (value: unknown): string => {
  const rules = String(value ?? '').trim();
  if (!rules || rules.length > 4096 || /[\u0000-\u001f\u007f]/.test(rules)) return '';
  const validSchemes = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks5:']);
  const isValidProxy = (value: string) => {
    const candidate = value.trim();
    if (!candidate || /\s/.test(candidate)) return false;
    if (candidate.toLowerCase() === 'direct://') return true;
    try {
      const url = new URL(candidate.includes('://') ? candidate : `http://${candidate}`);
      return (
        validSchemes.has(url.protocol) &&
        Boolean(url.hostname) &&
        !url.username &&
        !url.password &&
        (!url.pathname || url.pathname === '/') &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  };
  const validMappings = new Set(['http', 'https', 'ftp', 'socks']);
  const isValidGroup = (group: string) => {
    const separator = group.indexOf('=');
    const mapping = separator >= 0 ? group.slice(0, separator).trim().toLowerCase() : '';
    const proxyList = separator >= 0 ? group.slice(separator + 1) : group;
    if (separator >= 0 && !validMappings.has(mapping)) return false;
    const proxies = proxyList.split(',');
    return proxies.length > 0 && proxies.every(isValidProxy);
  };
  return rules.split(';').every(isValidGroup) ? rules : '';
};

export const addProxyCredentialsToUrl = (
  proxyUrl: string,
  credentials: NetworkProxyCredentials | undefined,
): string => {
  if (!credentials) return proxyUrl;
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    return proxyUrl;
  }
  // Chromium only authenticates HTTP(S) proxies. reqwest additionally supports
  // username/password authentication for SOCKS5; SOCKS4 credentials are not
  // supported by either transport used by EchoMusic.
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) return proxyUrl;
  url.username = credentials.username;
  url.password = credentials.password;
  return url.toString();
};

const normalizeProxyMode = (value: unknown): NetworkProxyMode => {
  if (
    value === 'system' ||
    value === 'direct' ||
    value === 'auto_detect' ||
    value === 'pac_script' ||
    value === 'fixed_servers'
  ) {
    return value;
  }
  return 'direct';
};

const normalizeProxyBypassRules = (value: unknown): string => {
  const rules = String(value ?? '')
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 100);
  return rules.join(',') || DEFAULT_NETWORK_SETTINGS.proxyBypassRules;
};

export const normalizeUserAgent = (value: unknown): string => {
  const raw = String(value ?? '').trim();
  // UA 会直接写入请求头，只接受可见 ASCII，避免 Chromium 拒绝非法请求头
  if (!raw || raw.length > 1024 || /[^\x20-\x7e]/.test(raw)) return '';
  return raw;
};

/** 将自定义 UA 写入请求头对象，兼容 AxiosHeaders.set 与普通对象 */
export const writeUserAgentHeader = (headers: unknown, userAgent: string): void => {
  if (!userAgent || !headers || typeof headers !== 'object') return;
  const target = headers as { set?: (key: string, value: string) => unknown };
  if (typeof target.set === 'function') target.set('User-Agent', userAgent);
  else (headers as Record<string, unknown>)['User-Agent'] = userAgent;
};

export const normalizeNetworkSettings = (
  value: Partial<NetworkSettings> | Record<string, unknown> | null | undefined,
): NetworkSettings => {
  const source = value ?? {};

  return {
    proxyMode: normalizeProxyMode(Reflect.get(source, 'proxyMode')),
    proxyPacScript: normalizeProxyPacScript(Reflect.get(source, 'proxyPacScript')),
    proxyRules: normalizeProxyRules(Reflect.get(source, 'proxyRules')),
    proxyUsername: String(Reflect.get(source, 'proxyUsername') ?? '').trim(),
    proxyBypassRules: normalizeProxyBypassRules(Reflect.get(source, 'proxyBypassRules')),
    userAgent: normalizeUserAgent(Reflect.get(source, 'userAgent')),
    kugouUserAgent: normalizeUserAgent(Reflect.get(source, 'kugouUserAgent')),
    kugouApiTimeoutSecs: clampNumber(
      Reflect.get(source, 'kugouApiTimeoutSecs'),
      DEFAULT_NETWORK_SETTINGS.kugouApiTimeoutSecs,
      0,
      300,
    ),
    playerNetworkTimeoutSecs: clampNumber(
      Reflect.get(source, 'playerNetworkTimeoutSecs'),
      DEFAULT_NETWORK_SETTINGS.playerNetworkTimeoutSecs,
      1,
      300,
    ),
  };
};

export const getNetworkSettingsValidationError = (settings: NetworkSettings): string | null => {
  if (settings.proxyMode === 'pac_script' && !settings.proxyPacScript) {
    return 'PAC 脚本地址无效';
  }
  if (settings.proxyMode === 'fixed_servers' && !settings.proxyRules) {
    return '手动代理规则无效';
  }
  return null;
};

export const parseElectronResolvedProxy = (value: string): string[] => {
  const candidates: string[] = [];
  for (const rawEntry of value.split(';')) {
    const [rawKind, endpoint] = rawEntry.trim().split(/\s+/, 2);
    const kind = rawKind.toUpperCase();
    let candidate: string | undefined;
    if (kind === 'DIRECT') candidate = '';
    else if (kind === 'PROXY' && endpoint) candidate = `http://${endpoint}`;
    else if (kind === 'HTTPS' && endpoint) candidate = `https://${endpoint}`;
    else if ((kind === 'SOCKS' || kind === 'SOCKS4') && endpoint) {
      candidate = `socks4://${endpoint}`;
    } else if (kind === 'SOCKS5' && endpoint) {
      candidate = `socks5h://${endpoint}`;
    }
    if (candidate !== undefined && !candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
};
