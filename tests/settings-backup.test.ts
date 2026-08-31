import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizePortableNetworkSettings } from '../src/shared/portableNetworkSettings.ts';

test('keeps remote PAC URLs portable', () => {
  assert.deepEqual(
    sanitizePortableNetworkSettings({
      proxyMode: 'pac_script',
      proxyPacScript: 'https://config.example/proxy.pac',
    }),
    {
      proxyMode: 'pac_script',
      proxyPacScript: 'https://config.example/proxy.pac',
    },
  );
});

test('removes local PAC paths and downgrades the exported mode', () => {
  assert.deepEqual(
    sanitizePortableNetworkSettings({
      proxyMode: 'pac_script',
      proxyPacScript: 'file:///Users/alice/private/proxy.pac',
      playerNetworkTimeoutSecs: 45,
    }),
    {
      proxyMode: 'system',
      playerNetworkTimeoutSecs: 45,
    },
  );
});
