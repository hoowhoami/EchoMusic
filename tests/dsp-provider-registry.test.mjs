import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

const fixture = async (inspectProvider = inspection, reportIssue) => {
  const workspace = await mkdtemp(join(tmpdir(), 'echo-dsp-registry-'));
  const root = join(workspace, 'dsp-providers');
  await mkdir(root, { recursive: true });
  return {
    workspace,
    root,
    registry: new DspProviderRegistry(root, inspectProvider, reportIssue),
  };
};

const sourceFile = async (workspace, directory, name, contents) => {
  const filePath = join(workspace, directory, name);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
  return filePath;
};

const providerDirectory = (root, providerId) =>
  join(root, createHash('sha256').update(providerId).digest('hex'));

const metadata = (providerId, contentHash, extension = '.dll') => ({
  schemaVersion: 1,
  providerId,
  current: {
    contentHash,
    extension,
    originalFileName: 'Provider.dll',
    importedAt: Date.now(),
    inspection: {
      providerId,
      providerVersion: '1',
      latencyFrames: 0,
      preferredBlockFrames: 512,
      maxChannels: 2,
      manifestJson: '{}',
      stateJson: '{}',
    },
  },
});

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
  assert.equal(
    first.contentHash,
    createHash('sha256')
      .update(await readFile(first.path))
      .digest('hex'),
  );
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

test('failed first activation removes only its own valid candidate metadata and file', async () => {
  const { workspace, registry } = await fixture();
  const source = await sourceFile(workspace, 'first', 'Provider.dll', 'engine.first-failure|1');
  const candidate = await registry.prepareImport(source);
  await registry.commit(candidate, false);
  await registry.rollback(candidate, null);

  assert.equal(await registry.current(candidate.providerId), null);
  await waitFor(async () => !(await exists(candidate.path)));
});

test('rollback preserves a candidate if its metadata became unreadable', async () => {
  const { workspace, registry } = await fixture(inspection, () => undefined);
  const source = await sourceFile(workspace, 'first', 'Provider.dll', 'engine.rollback-corrupt|1');
  const candidate = await registry.prepareImport(source);
  await registry.commit(candidate, false);
  await writeFile(join(dirname(candidate.path), 'provider.json'), '{corrupt');
  await registry.rollback(candidate, null);

  assert.equal(await exists(candidate.path), true);
  assert.equal(await exists(join(dirname(candidate.path), 'provider.json')), true);
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

test('corrupt and unsupported metadata preserve every provider binary and report once', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'echo-dsp-registry-'));
  const root = join(workspace, 'dsp-providers');
  const corruptDirectory = providerDirectory(root, 'engine.corrupt');
  const futureDirectory = providerDirectory(root, 'engine.future');
  const corruptBinary = join(corruptDirectory, `${'a'.repeat(64)}.dll`);
  const futureBinary = join(futureDirectory, `${'b'.repeat(64)}.dll`);
  await mkdir(corruptDirectory, { recursive: true });
  await mkdir(futureDirectory, { recursive: true });
  await writeFile(corruptBinary, 'corrupt-binary');
  await writeFile(futureBinary, 'future-binary');
  await writeFile(join(corruptDirectory, 'provider.json'), '{truncated');
  await writeFile(
    join(futureDirectory, 'provider.json'),
    JSON.stringify({ ...metadata('engine.future', 'b'.repeat(64)), schemaVersion: 2 }),
  );
  const reports = [];
  const registry = new DspProviderRegistry(root, inspection, (message) => reports.push(message));

  assert.deepEqual(await registry.list(), []);
  assert.deepEqual(await registry.list(), []);
  assert.equal(await exists(corruptBinary), true);
  assert.equal(await exists(futureBinary), true);
  assert.equal(reports.filter((message) => message.includes('已保留目录')).length, 2);
});

test('malicious content hashes and non-string provider IDs cannot escape the registry root', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'echo-dsp-registry-'));
  const root = join(workspace, 'dsp-providers');
  const providerId = 'engine.malicious';
  const directory = providerDirectory(root, providerId);
  const victim = join(workspace, 'victim.dll');
  await mkdir(directory, { recursive: true });
  await writeFile(victim, 'keep-me');
  await writeFile(
    join(directory, 'provider.json'),
    JSON.stringify(metadata(providerId, '../../../../victim')),
  );
  const registry = new DspProviderRegistry(root, inspection, () => undefined);

  assert.deepEqual(await registry.list(), []);
  assert.equal(await exists(victim), true);
  await assert.rejects(
    registry.discard({
      ...metadata(providerId, '../../../../victim').current.inspection,
      path: victim,
      contentHash: '../../../../victim',
      originalFileName: 'Provider.dll',
      importedAt: Date.now(),
    }),
    /身份或内容哈希无效/u,
  );
  await assert.rejects(registry.current(42), /Provider ID 无效/u);
  assert.equal(await exists(victim), true);
});

test('import transactions are serialized across every await boundary', async () => {
  const { registry } = await fixture();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = registry.runExclusive(async () => {
    events.push('first:start');
    await firstGate;
    events.push('first:end');
  });
  const second = registry.runExclusive(async () => {
    events.push('second:start');
    events.push('second:end');
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('an invalid legacy binary is inspected only once per process', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'echo-dsp-registry-'));
  const root = join(workspace, 'dsp-providers');
  const legacyPath = join(root, 'Unknown.dll');
  await mkdir(root, { recursive: true });
  await writeFile(legacyPath, 'not-a-provider');
  let inspectionCount = 0;
  const registry = new DspProviderRegistry(
    root,
    async () => {
      inspectionCount += 1;
      throw new Error('invalid binary');
    },
    () => undefined,
  );

  await registry.list();
  await registry.list();
  assert.equal(inspectionCount, 1);
  assert.equal(await exists(legacyPath), true);
});
