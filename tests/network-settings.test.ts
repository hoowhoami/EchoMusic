import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addProxyCredentialsToUrl,
  DEFAULT_NETWORK_SETTINGS,
  getNetworkSettingsValidationError,
  normalizeNetworkSettings,
  normalizeProxyPacScript,
  normalizeProxyRules,
  parseElectronResolvedProxy,
} from '../src/shared/network.ts';

test('defaults to the system proxy and keeps timeouts independent', () => {
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

test('unknown modes fall back to system without inferring a configuration', () => {
  const settings = normalizeNetworkSettings({ proxyMode: 'unsupported', arbitrary: 'proxy:80' });
  assert.equal(settings.proxyMode, 'system');
  assert.equal(settings.proxyRules, '');
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
