import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const require = createRequire(import.meta.url);
const source = readFileSync(
  new URL('../src/main/player/dspProviderRegistry.ts', import.meta.url),
  'utf8',
);
const { code } = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node22' });
const module = { exports: {} };
new Function('require', 'module', 'exports', code)(require, module, module.exports);
const { DspProviderRegistry } = module.exports;

const inspection = async (filePath) => {
  const [providerId, providerVersion = '1'] = (await readFile(filePath, 'utf8')).trim().split('|');
  return {
    providerId,
    providerVersion,
    latencyFrames: 0,
    preferredBlockFrames: 512,
    maxChannels: 2,
    manifestJson: JSON.stringify({ schemaVersion: 1, displayName: providerId }),
    stateJson: '{}',
  };
};

const exists = (filePath) =>
  stat(filePath)
    .then(() => true)
    .catch(() => false);

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition was not satisfied');
};

const fixture = async (inspectProvider = inspection) => {
  const workspace = await mkdtemp(join(tmpdir(), 'echo-dsp-registry-'));
  const root = join(workspace, 'dsp-providers');
  await mkdir(root, { recursive: true });
  return { workspace, root, registry: new DspProviderRegistry(root, inspectProvider) };
};

const sourceFile = async (workspace, directory, name, contents) => {
  const filePath = join(workspace, directory, name);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
  return filePath;
};

test('providerId is the identity and identical content is stored once', async () => {
  let inspectionCount = 0;
  const { workspace, root, registry } = await fixture(async (filePath) => {
    inspectionCount += 1;
    return await inspection(filePath);
  });
  const selected = await sourceFile(workspace, 'downloads', 'FriendlyName.dll', 'engine.alpha|1');
  const first = await registry.prepareImport(selected);
  await registry.commit(first);
  const repeated = await registry.prepareImport(selected);

  assert.equal(first.providerId, 'engine.alpha');
  assert.equal(first.path, repeated.path);
  assert.equal(inspectionCount, 1);
  assert.notEqual(first.originalFileName, first.path.split('/').at(-1));
  const installed = await registry.list();
  assert.equal(installed.length, 1);
  assert.equal(installed[0].providerId, 'engine.alpha');
  const versionFiles = (await readdir(dirname(first.path))).filter((name) => name.endsWith('.dll'));
  assert.deepEqual(versionFiles, [`${first.contentHash}.dll`]);
  assert.ok(first.path.startsWith(root));
});

test('different provider IDs with the same source filename do not collide', async () => {
  const { workspace, registry } = await fixture();
  const left = await sourceFile(workspace, 'left', 'Provider.dll', 'engine.left|1');
  const right = await sourceFile(workspace, 'right', 'Provider.dll', 'engine.right|1');
  await registry.commit(await registry.prepareImport(left));
  await registry.commit(await registry.prepareImport(right));

  const installed = await registry.list();
  assert.deepEqual(
    installed.map((provider) => provider.providerId),
    ['engine.left', 'engine.right'],
  );
  assert.notEqual(installed[0].path, installed[1].path);
});

test('a new content hash replaces one provider version and retires the old file', async () => {
  const { workspace, registry } = await fixture();
  const v1 = await sourceFile(workspace, 'v1', 'Provider.dll', 'engine.update|1');
  const old = await registry.commit(await registry.prepareImport(v1));
  const v2 = await sourceFile(workspace, 'v2', 'Renamed.dll', 'engine.update|2');
  const current = await registry.commit(await registry.prepareImport(v2));

  assert.notEqual(old.contentHash, current.contentHash);
  assert.equal((await registry.list())[0].providerVersion, '2');
  await waitFor(async () => !(await exists(old.path)));
  assert.equal(await exists(current.path), true);
});

test('failed activation can roll metadata and files back to the previous version', async () => {
  const { workspace, registry } = await fixture();
  const v1 = await sourceFile(workspace, 'v1', 'Provider.dll', 'engine.rollback|1');
  const previous = await registry.commit(await registry.prepareImport(v1));
  const v2 = await sourceFile(workspace, 'v2', 'Provider.dll', 'engine.rollback|2');
  const candidate = await registry.prepareImport(v2);
  await registry.commit(candidate, false);
  await registry.rollback(candidate, previous);

  const installed = await registry.list();
  assert.equal(installed[0].contentHash, previous.contentHash);
  assert.equal(installed[0].providerVersion, '1');
  await waitFor(async () => !(await exists(candidate.path)));
  assert.equal(await exists(previous.path), true);
});

test('legacy flat files migrate and remain resolvable from their saved path', async () => {
  const { root, registry } = await fixture();
  const legacyPath = join(root, 'LegacyName.dll');
  await writeFile(legacyPath, 'engine.legacy|1');
  const [installed] = await registry.list();

  assert.equal(installed.providerId, 'engine.legacy');
  assert.notEqual(installed.path, legacyPath);
  assert.deepEqual(installed.legacyPaths, [legacyPath]);
  assert.equal(await exists(legacyPath), false);
  assert.equal(await exists(installed.path), true);
});

test('deleting by providerId removes the logical record and retires its version', async () => {
  const { workspace, registry } = await fixture();
  const source = await sourceFile(workspace, 'downloads', 'Provider.dll', 'engine.delete|1');
  const installed = await registry.commit(await registry.prepareImport(source));
  await registry.delete(installed.providerId);

  assert.deepEqual(await registry.list(), []);
  await waitFor(async () => !(await exists(installed.path)));
});

test('startup garbage collection retires an interrupted orphan version', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'echo-dsp-registry-'));
  const root = join(workspace, 'dsp-providers');
  const orphan = join(root, 'interrupted-provider', 'old-version.dll');
  await mkdir(dirname(orphan), { recursive: true });
  await writeFile(orphan, 'orphan');

  const registry = new DspProviderRegistry(root, inspection);
  await registry.current('missing-provider');
  await waitFor(async () => !(await exists(orphan)));
});
