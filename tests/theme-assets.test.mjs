import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'echo-theme-assets-test-'));
after(() => rm(directory, { recursive: true, force: true }));
const fixture = {
  directory,
  handlers: new Map(),
  size: { width: 640, height: 360 },
  empty: false,
};
const png = Buffer.alloc(24);
Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
png.write('IHDR', 12);
png.writeUInt32BE(640, 16);
png.writeUInt32BE(360, 20);
const result = await build({
  stdin: {
    contents: `export * from './src/main/ipc/themeAssets';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  packages: 'external',
  plugins: [
    {
      name: 'native-image-fixture',
      setup(builder) {
        builder.onResolve({ filter: /^(electron|\.\/registry)$/ }, (args) => ({
          path: args.path,
          namespace: 'fixture',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents:
            args.path === 'electron'
              ? `export const app={getPath:()=>fixture.directory};export const nativeImage={createFromBuffer:()=>({getSize:()=>fixture.size,isEmpty:()=>fixture.empty})};`
              : `export const ipcRegistry={registerHandler:(name,handler)=>fixture.handlers.set(name,handler)};`,
        }));
      },
    },
  ],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', 'fixture', result.outputFiles[0].text)(
  require,
  module,
  module.exports,
  fixture,
);
module.exports.registerThemeAssetHandlers();
const invoke = (name, ...args) => fixture.handlers.get('appearance:' + name)({}, ...args);
test('background assets are content-addressed, duplicate imports and scoped reads work', async () => {
  const first = await invoke('import-image', new Uint8Array(png));
  assert.equal(first.ok, true);
  const second = await invoke('import-image', new Uint8Array(png));
  assert.equal(first.id, second.id);
  assert.match(first.id, /^[a-f0-9]{64}\.png$/);
  assert.deepEqual(await readFile(join(directory, 'theme-backgrounds', first.id)), png);
  assert.equal((await invoke('read-image', first.id)).url, first.url);
});
test('invalid and unprocessed images return clear errors; asset paths remain scoped', async () => {
  assert.match((await invoke('import-image', new Uint8Array([1, 2, 3]))).error, /格式无效/);
  assert.equal((await invoke('import-image', new Uint8Array(32 * 1024 * 1024 + 1))).ok, false);
  fixture.size = { width: 100000, height: 100000 };
  assert.match((await invoke('import-image', new Uint8Array(png))).error, /尚未完成缩放/);
  fixture.size = { width: 640, height: 360 };
  fixture.empty = true;
  assert.match((await invoke('import-image', new Uint8Array(png))).error, /无法解码/);
  fixture.empty = false;
  await assert.rejects(invoke('read-image', '../../settings.json'));
  await assert.rejects(invoke('clean-images', ['../settings.json']));
});
test('prepared images save without re-encoding and cleanup keeps retained and unrelated files', async () => {
  fixture.size = { width: 2560, height: 1707 };
  const result = await invoke('import-image', new Uint8Array(png));
  assert.equal(result.ok, true);
  const assets = join(directory, 'theme-backgrounds');
  await writeFile(join(assets, 'unrelated.txt'), 'keep');
  await invoke('clean-images', [result.id]);
  await access(join(assets, result.id));
  await invoke('clean-images', []);
  await assert.rejects(access(join(assets, result.id)));
  assert.equal(await readFile(join(assets, 'unrelated.txt'), 'utf8'), 'keep');
});
