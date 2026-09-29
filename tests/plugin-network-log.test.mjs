import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
  stdin: {
    contents: `export { sanitizePluginNetworkLogUrl } from './src/main/plugins/networkLog';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  treeShaking: true,
});

const [{ text }] = bundle.outputFiles;
const { sanitizePluginNetworkLogUrl } = await import(
  `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
);

test('plugin network log URL keeps address while redacting query and hash', () => {
  assert.equal(
    sanitizePluginNetworkLogUrl(
      'https://example.com:8443/backups/EchoMusic/file.echomusic-backup?token=secret&uid=42#frag',
    ),
    'https://example.com:8443/backups/EchoMusic/file.echomusic-backup?[redacted]#[redacted]',
  );
});

test('plugin network log URL handles local addresses and invalid values safely', () => {
  assert.equal(
    sanitizePluginNetworkLogUrl('http://127.0.0.1:8080/api/v1/snapshot'),
    'http://127.0.0.1:8080/api/v1/snapshot',
  );
  assert.equal(sanitizePluginNetworkLogUrl('not a url with token=secret'), '[invalid-url]');
  assert.equal(sanitizePluginNetworkLogUrl(undefined), '');
});
