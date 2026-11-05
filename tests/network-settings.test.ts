import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addProxyCredentialsToUrl,
  DEFAULT_NETWORK_SETTINGS,
  getNetworkSettingsValidationError,
  normalizeNetworkSettings,
  normalizeProxyPacScript,
  normalizeProxyRules,
  normalizeUserAgent,
  parseElectronResolvedProxy,
  writeUserAgentHeader,
} from '../src/shared/network.ts';

test('defaults to direct connection and keeps timeouts independent', () => {
  assert.deepEqual(normalizeNetworkSettings(undefined), DEFAULT_NETWORK_SETTINGS);
  assert.deepEqual(
    normalizeNetworkSettings({ kugouApiTimeoutSecs: 17, playerNetworkTimeoutSecs: 41 }),
    { ...DEFAULT_NETWORK_SETTINGS, kugouApiTimeoutSecs: 17, playerNetworkTimeoutSecs: 41 },
  );
});

test('preserves all Electron proxy modes and mode-specific fields', () => {
  const settings = normalizeNetworkSettings({
    proxyMode: 'fixed_servers',
    proxyPacScript: 'https://config.example/proxy.pac?tenant=echo',
    proxyRules:
      'http=proxy.example:80;https=https://secure.example:443;socks=socks5://127.0.0.1:1080',
    proxyUsername: ' user ',
    proxyBypassRules: ' <local>; localhost, *.lan ',
  });
  assert.equal(settings.proxyMode, 'fixed_servers');
  assert.equal(settings.proxyPacScript, 'https://config.example/proxy.pac?tenant=echo');
  assert.equal(
    settings.proxyRules,
    'http=proxy.example:80;https=https://secure.example:443;socks=socks5://127.0.0.1:1080',
  );
  assert.equal(settings.proxyUsername, 'user');
  assert.equal(settings.proxyBypassRules, '<local>,localhost,*.lan');
  assert.equal(normalizeProxyRules('proxy:80,direct://'), 'proxy:80,direct://');
  assert.equal(
    normalizeProxyRules('http=proxy:80;https=https://secure:443'),
    'http=proxy:80;https=https://secure:443',
  );
  assert.equal(normalizeProxyRules('invalid=proxy:80'), '');
  assert.equal(normalizeProxyRules('http://user:pass@proxy:80'), '');
  assert.equal(normalizeProxyRules('http://proxy:80/path'), '');
  assert.equal(normalizeProxyPacScript('file:///tmp/proxy.pac'), 'file:///tmp/proxy.pac');
});

test('unknown modes fall back to direct without inferring a configuration', () => {
  const settings = normalizeNetworkSettings({ proxyMode: 'unsupported', arbitrary: 'proxy:80' });
  assert.equal(settings.proxyMode, 'direct');
  assert.equal(settings.proxyRules, '');
});

test('normalizes custom user agent and rejects values unsafe for request headers', () => {
  assert.equal(DEFAULT_NETWORK_SETTINGS.userAgent, '');
  assert.equal(DEFAULT_NETWORK_SETTINGS.kugouUserAgent, '');
  const normalized = normalizeNetworkSettings({
    userAgent: '  GlobalUA/1.0  ',
    kugouUserAgent: ' KugouUA/2.0 ',
  });
  assert.equal(normalized.userAgent, 'GlobalUA/1.0');
  assert.equal(normalized.kugouUserAgent, 'KugouUA/2.0');
  assert.equal(
    normalizeNetworkSettings({ userAgent: '  EchoTest/1.0 (Windows NT 10.0)  ' }).userAgent,
    'EchoTest/1.0 (Windows NT 10.0)',
  );
  assert.equal(normalizeUserAgent(''), '');
  assert.equal(normalizeUserAgent('bad\nagent'), '');
  assert.equal(normalizeUserAgent('中文 UA'), '');
  assert.equal(normalizeUserAgent('a'.repeat(1025)), '');
  assert.equal(normalizeUserAgent('a'.repeat(1024)), 'a'.repeat(1024));
  assert.equal(getNetworkSettingsValidationError(DEFAULT_NETWORK_SETTINGS), null);
});

test('writes custom user agent into plain and axios-style header objects', () => {
  const plain: Record<string, string> = {};
  writeUserAgentHeader(plain, 'EchoTest/1.0');
  assert.equal(plain['User-Agent'], 'EchoTest/1.0');

  const axiosLike = {
    'User-Agent': 'Android15-default',
    set(key: string, value: string) {
      this[key] = value;
    },
  };
  writeUserAgentHeader(axiosLike, 'EchoTest/2.0');
  assert.equal(axiosLike['User-Agent'], 'EchoTest/2.0');

  // 空 UA 不得写入，保持上游默认行为
  const untouched: Record<string, string> = { 'User-Agent': 'Android15-default' };
  writeUserAgentHeader(untouched, '');
  assert.equal(untouched['User-Agent'], 'Android15-default');
  writeUserAgentHeader(undefined, 'EchoTest/3.0');
});

test('requires the mode-specific PAC URL or manual rules', () => {
  assert.equal(
    getNetworkSettingsValidationError({
      ...DEFAULT_NETWORK_SETTINGS,
      proxyMode: 'pac_script',
    }),
    'PAC 脚本地址无效',
  );
  assert.equal(
    getNetworkSettingsValidationError({
      ...DEFAULT_NETWORK_SETTINGS,
      proxyMode: 'fixed_servers',
    }),
    '手动代理规则无效',
  );
  assert.equal(
    getNetworkSettingsValidationError({
      ...DEFAULT_NETWORK_SETTINGS,
      proxyMode: 'auto_detect',
    }),
    null,
  );
});

test('parses Chromium PAC results into ordered native proxy candidates', () => {
  assert.deepEqual(
    parseElectronResolvedProxy(
      'HTTPS secure.example:443; PROXY proxy.example:80; SOCKS4 old.example:1080; SOCKS5 socks.example:1080; DIRECT',
    ),
    [
      'https://secure.example:443',
      'http://proxy.example:80',
      'socks4://old.example:1080',
      'socks5h://socks.example:1080',
      '',
    ],
  );
});

test('adds safely encoded credentials to native proxy schemes that support authentication', () => {
  const credentials = { username: 'user@corp', password: 'p:a/ss?#' };
  assert.equal(
    addProxyCredentialsToUrl('http://proxy.example:8080', credentials),
    'http://user%40corp:p%3Aa%2Fss%3F%23@proxy.example:8080/',
  );
  assert.equal(
    addProxyCredentialsToUrl('https://proxy.example:8443', credentials),
    'https://user%40corp:p%3Aa%2Fss%3F%23@proxy.example:8443/',
  );
  assert.equal(
    addProxyCredentialsToUrl('socks5h://proxy.example:1080', credentials),
    'socks5h://user%40corp:p%3Aa%2Fss%3F%23@proxy.example:1080',
  );
  assert.equal(
    addProxyCredentialsToUrl('socks5://proxy.example:1080', credentials),
    'socks5://user%40corp:p%3Aa%2Fss%3F%23@proxy.example:1080',
  );
  assert.equal(
    addProxyCredentialsToUrl('socks4://proxy.example:1080', credentials),
    'socks4://proxy.example:1080',
  );
});
