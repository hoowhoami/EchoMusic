import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: `export {PluginResources} from './src/main/plugins/resources';export {createPluginResourceApi} from './src/renderer/plugins/runtime/resources';`,
    loader: 'ts',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  plugins: [
    {
      name: 'metadata-fixture',
      setup(b) {
        b.onResolve({ filter: /media\/audioMetadata$/ }, () => ({
          path: 'audio',
          namespace: 'fixture',
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: 'export const readAudioMetadata=async()=>({});',
        }));
      },
    },
  ],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  require,
  module,
  module.exports,
);
const { PluginResources, createPluginResourceApi } = module.exports;
async function fixture(t, downloads = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-resources-'));
  const chosen = path.join(root, 'user-files');
  await fs.mkdir(chosen);
  await fs.writeFile(path.join(chosen, 'video.mp4'), '0123456789');
  let plugin = {
    id: 'example',
    name: 'Example',
    directory: path.join(root, 'plugins', 'example'),
    manifest: { capabilities: { localFiles: true, downloads } },
    enabled: true,
  };
  const service = new PluginResources({
    root,
    fetch,
    find: (id) => (id === 'example' ? plugin : null),
    current: (p) => p === plugin && p.enabled,
    selectDirectory: async () => chosen,
    selectFiles: async () => [path.join(chosen, 'video.mp4')],
  });
  t.after(async () => {
    await service.downloads.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    chosen,
    service,
    get plugin() {
      return plugin;
    },
    replacePlugin(next) {
      plugin = next;
    },
  };
}
test('failed owner persistence cannot be bypassed by repeating capture', async (t) => {
  const f = await fixture(t);
  const store = path.join(f.root, 'plugin-file-grants');
  await f.service.manageGrants('example');
  await fs.mkdir(store, { recursive: true });
  const identityFile = path.join(store, 'identities.json');
  await fs.mkdir(identityFile);
  await assert.rejects(f.service.capture('example'));
  await assert.rejects(f.service.capture('example'));
  await fs.rm(identityFile, { recursive: true });
  const [first, second] = await Promise.all([
    f.service.capture('example'),
    f.service.capture('example'),
  ]);
  assert.equal(first.owner, second.owner);
  assert.equal(JSON.parse(await fs.readFile(identityFile, 'utf8')).example.owner, first.owner);
});
test('read-only selected media supports full, head, range, suffix, 416 and revocation', async (t) => {
  const f = await fixture(t);
  const result = await f.service.call('example', 'requestFiles', { purpose: 'Preview' });
  const file = result.files[0];
  await assert.rejects(
    f.service.call('example', 'writeFile', { ref: file, data: 'overwrite' }),
    (e) => e.code === 'GRANT_REQUIRED',
  );
  const lease = await f.service.call('example', 'openMedia', { ref: file });
  let response = await f.service.mediaResponse(new Request(lease.url));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '0123456789');
  response = await f.service.mediaResponse(new Request(lease.url, { method: 'HEAD' }));
  assert.equal(response.headers.get('content-length'), '10');
  assert.equal(await response.text(), '');
  response = await f.service.mediaResponse(
    new Request(lease.url, { headers: { Range: 'bytes=2-5' } }),
  );
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await response.text(), '2345');
  response = await f.service.mediaResponse(
    new Request(lease.url, { headers: { Range: 'bytes=-3' } }),
  );
  assert.equal(await response.text(), '789');
  for (const range of ['bytes=99-', 'bytes=1-2,5-6', 'bytes=-0', 'bytes=99999999999999999999999-'])
    assert.equal(
      (await f.service.mediaResponse(new Request(lease.url, { headers: { Range: range } }))).status,
      416,
    );
  assert.equal((await f.service.manageGrants('example'))[0].kind, 'file');
  await f.service.manageRevoke('example', file.fileId);
  assert.equal((await f.service.mediaResponse(new Request(lease.url))).status, 404);
});
test('grant management only lists user selections and cannot revoke private directories', async (t) => {
  const f = await fixture(t);
  let selections = 0;
  f.service['deps'].selectDirectory = async () => {
    selections++;
    return f.chosen;
  };
  f.service['deps'].selectFiles = async () => {
    selections++;
    return [path.join(f.chosen, 'video.mp4')];
  };
  const data = await f.service.call('example', 'getPrivateDirectory', { kind: 'data' });
  const cache = await f.service.call('example', 'getPrivateDirectory', { kind: 'cache' });
  assert.equal(selections, 0);
  assert.deepEqual(await f.service.manageGrants('example'), []);
  const directory = await f.service.call('example', 'requestDirectory', {
    access: 'read-write',
    purpose: 'Save videos',
  });
  const files = await f.service.call('example', 'requestFiles', { purpose: 'Read video' });
  assert.equal(selections, 2);
  f.plugin.enabled = false;
  const grants = await f.service.manageGrants('example');
  assert.equal(grants.length, 2);
  assert.deepEqual(new Set(grants.map((grant) => grant.kind)), new Set(['user', 'file']));
  for (const privateDirectory of [data, cache]) {
    await assert.rejects(
      f.service.manageRevoke('example', privateDirectory.id),
      (error) => error.code === 'GRANT_REQUIRED',
    );
  }
  await f.service.manageRevoke('example', directory.directory.id);
  const after = await f.service.manageGrants('example');
  assert.equal(after.find((grant) => grant.id === directory.directory.id).revoked, true);
  assert.equal(after.find((grant) => grant.id === files.files[0].fileId).revoked, false);
});
test('unified management groups user grants by plugin, including disabled plugins', async (t) => {
  const f = await fixture(t);
  const second = {
    ...f.plugin,
    id: 'second',
    name: 'Second plugin',
    directory: path.join(f.root, 'plugins', 'second'),
  };
  const plugins = new Map([
    ['example', f.plugin],
    ['second', second],
  ]);
  f.service['deps'].find = (id) => plugins.get(id);
  f.service['deps'].current = (plugin) => plugins.get(plugin.id) === plugin && plugin.enabled;
  await f.service.call('example', 'getPrivateDirectory', { kind: 'data' });
  await f.service.call('second', 'getPrivateDirectory', { kind: 'cache' });
  assert.deepEqual(await f.service.manageAllGrants(), []);
  const firstFile = (await f.service.call('example', 'requestFiles', { purpose: 'Read video' }))
    .files[0];
  const secondDirectory = (
    await f.service.call('second', 'requestDirectory', { access: 'read', purpose: 'Read folder' })
  ).directory;
  f.plugin.enabled = false;
  second.enabled = false;
  const groups = await f.service.manageAllGrants();
  assert.deepEqual(
    groups.map((group) => [group.pluginId, group.pluginName, group.grants.length]),
    [
      ['example', 'Example', 1],
      ['second', 'Second plugin', 1],
    ],
  );
  assert.equal(groups[0].grants[0].id, firstFile.fileId);
  assert.equal(groups[1].grants[0].id, secondDirectory.id);
  await assert.rejects(
    f.service.manageRevoke('example', secondDirectory.id),
    (error) => error.code === 'GRANT_REQUIRED',
  );
  await f.service.manageRevoke('example', firstFile.fileId);
  const after = await f.service.manageAllGrants();
  assert.equal(after[0].grants[0].revoked, true);
  assert.equal(after[1].grants[0].revoked, false);
  await f.service.uninstall('second');
  plugins.delete('second');
  assert.deepEqual(
    (await f.service.manageAllGrants()).map((group) => group.pluginId),
    ['example'],
  );
});
test('removing revoked user grants persists without deleting files or accepting active/private/foreign grants', async (t) => {
  const f = await fixture(t);
  const directory = (
    await f.service.call('example', 'requestDirectory', {
      access: 'read-write',
      purpose: 'Save files',
    })
  ).directory;
  const file = (await f.service.call('example', 'requestFiles', { purpose: 'Read video' }))
    .files[0];
  const data = await f.service.call('example', 'getPrivateDirectory', { kind: 'data' });
  const owner = (await f.service.capture('example')).owner;
  await assert.rejects(
    f.service.manageRemove('example', directory.id),
    (e) => e.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(
    f.service.manageRemove('example', data.id),
    (e) => e.code === 'GRANT_REQUIRED',
  );
  const foreign = await f.service.grants.create('other-owner', f.chosen, 'read');
  await f.service.grants.revoke('other-owner', foreign.id);
  await assert.rejects(
    f.service.manageRemove('example', foreign.id),
    (e) => e.code === 'GRANT_REQUIRED',
  );
  for (const id of [directory.id, file.fileId]) {
    await f.service.manageRevoke('example', id);
    await f.service.manageRemove('example', id);
  }
  assert.deepEqual(await f.service.manageAllGrants(), []);
  assert.deepEqual(await f.service.manageGrants('example'), []);
  assert.equal(await fs.readFile(path.join(f.chosen, 'video.mp4'), 'utf8'), '0123456789');
  assert.equal((await fs.stat(f.chosen)).isDirectory(), true);
  await assert.rejects(f.service.grants.resolve(owner, file), (e) => e.code === 'GRANT_REQUIRED');
  await assert.rejects(
    f.service.grants.directory(owner, directory.id),
    (e) => e.code === 'GRANT_REQUIRED',
  );
  const restarted = new f.service.grants.constructor(path.join(f.root, 'plugin-file-grants'));
  assert.deepEqual(
    (await restarted.listAll(owner)).map((g) => g.id),
    [data.id],
  );
  assert.equal((await restarted.listAll('other-owner'))[0].id, foreign.id);
  const selectedAgain = (
    await f.service.call('example', 'requestDirectory', {
      access: 'read-write',
      purpose: 'Save files again',
    })
  ).directory;
  assert.notEqual(selectedAgain.id, directory.id);
  assert.equal(selectedAgain.available, true);
  await assert.rejects(
    f.service.manageRemove('example', selectedAgain.id),
    (e) => e.code === 'INVALID_ARGUMENT',
  );
});
test('failed grant-record removal persistence retains the revoked record in memory and on disk', async (t) => {
  const f = await fixture(t);
  const file = (await f.service.call('example', 'requestFiles', { purpose: 'Read video' }))
    .files[0];
  await f.service.manageRevoke('example', file.fileId);
  const store = path.join(f.root, 'plugin-file-grants', 'grants.json');
  const saved = `${store}.backup`;
  await fs.rename(store, saved);
  await fs.mkdir(store);
  await assert.rejects(f.service.manageRemove('example', file.fileId));
  assert.equal((await f.service.manageGrants('example'))[0].id, file.fileId);
  await fs.rmdir(store);
  await fs.rename(saved, store);
  const owner = (await f.service.capture('example')).owner;
  const restarted = new f.service.grants.constructor(path.join(f.root, 'plugin-file-grants'));
  assert.equal((await restarted.listAll(owner))[0].revoked, true);
  await f.service.manageRemove('example', file.fileId);
  assert.deepEqual(await f.service.manageAllGrants(), []);
});
test('management reauthorization uses matching selectors, restores same refs durably and keeps old leases closed', async (t) => {
  const f = await fixture(t);
  const directory = (
    await f.service.call('example', 'requestDirectory', { access: 'read-write', purpose: 'Save' })
  ).directory;
  const file = (await f.service.call('example', 'requestFiles', { purpose: 'Read' })).files[0];
  const lease = await f.service.call('example', 'openMedia', { ref: file });
  const owner = (await f.service.capture('example')).owner;
  const originalRevision = (await f.service.grants.resolve(owner, file)).revision;
  await f.service.manageRevoke('example', directory.id);
  await f.service.manageRevoke('example', file.fileId);
  f.plugin.enabled = false;
  const requests = [];
  f.service['deps'].selectDirectory = async (plugin, request) => {
    requests.push(['directory', plugin.id, request]);
    return f.chosen;
  };
  f.service['deps'].selectFiles = async (plugin, request) => {
    requests.push(['file', plugin.id, request]);
    return [path.join(f.chosen, 'video.mp4')];
  };
  await f.service.manageReauthorize('example', directory.id);
  await f.service.manageReauthorize('example', file.fileId);
  assert.deepEqual(requests, [
    ['directory', 'example', { purpose: '重新授权', persist: true, access: 'read-write' }],
    ['file', 'example', { purpose: '重新授权', persist: true, multiple: false }],
  ]);
  assert.ok((await f.service.manageGrants('example')).every((g) => !g.revoked && g.available));
  assert.ok((await f.service.grants.resolve(owner, file)).revision > originalRevision);
  assert.equal((await f.service.mediaResponse(new Request(lease.url))).status, 404);
  const restarted = new f.service.grants.constructor(path.join(f.root, 'plugin-file-grants'));
  assert.equal(await restarted.directory(owner, directory.id), await fs.realpath(f.chosen));
  assert.equal(
    (await restarted.resolve(owner, file)).path,
    await fs.realpath(path.join(f.chosen, 'video.mp4')),
  );
  f.plugin.enabled = true;
  const renewed = await f.service.call('example', 'openMedia', { ref: file });
  assert.equal(
    await (await f.service.mediaResponse(new Request(renewed.url))).text(),
    '0123456789',
  );
});
test('reauthorization cancellation preserves revocation, changed targets get new ids, active/private/foreign grants never open selectors', async (t) => {
  const f = await fixture(t);
  const directory = (
    await f.service.call('example', 'requestDirectory', {
      access: 'read',
      purpose: 'Read',
      persist: false,
    })
  ).directory;
  const file = (await f.service.call('example', 'requestFiles', { purpose: 'Read' })).files[0];
  const data = await f.service.call('example', 'getPrivateDirectory', { kind: 'data' });
  let selections = 0;
  f.service['deps'].selectDirectory = async () => {
    selections++;
    return undefined;
  };
  f.service['deps'].selectFiles = async () => {
    selections++;
    return [];
  };
  await assert.rejects(
    f.service.manageReauthorize('example', directory.id),
    (e) => e.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(
    f.service.manageReauthorize('example', data.id),
    (e) => e.code === 'GRANT_REQUIRED',
  );
  const foreign = await f.service.grants.create('foreign', f.chosen, 'read');
  await f.service.grants.revoke('foreign', foreign.id);
  await assert.rejects(
    f.service.manageReauthorize('example', foreign.id),
    (e) => e.code === 'GRANT_REQUIRED',
  );
  assert.equal(selections, 0);
  await f.service.manageRevoke('example', directory.id);
  await f.service.manageRevoke('example', file.fileId);
  await f.service.manageReauthorize('example', directory.id);
  await f.service.manageReauthorize('example', file.fileId);
  assert.ok((await f.service.manageGrants('example')).every((g) => g.revoked));
  const different = path.join(f.root, 'different');
  await fs.mkdir(different);
  await fs.writeFile(path.join(different, 'new.mp4'), 'new');
  f.service['deps'].selectDirectory = async (_, request) => {
    assert.equal(request.access, 'read');
    assert.equal(request.persist, false);
    return different;
  };
  f.service['deps'].selectFiles = async () => [path.join(different, 'new.mp4')];
  await f.service.manageReauthorize('example', directory.id);
  await f.service.manageReauthorize('example', file.fileId);
  const grants = await f.service.manageGrants('example');
  assert.equal(grants.length, 4);
  assert.ok(
    grants.filter((g) => [directory.id, file.fileId].includes(g.id)).every((g) => g.revoked),
  );
  assert.deepEqual(
    new Set(grants.filter((g) => !g.revoked).map((g) => g.displayPath)),
    new Set([await fs.realpath(different), await fs.realpath(path.join(different, 'new.mp4'))]),
  );
  const owner = (await f.service.capture('example')).owner;
  const restarted = new f.service.grants.constructor(path.join(f.root, 'plugin-file-grants'));
  assert.ok(!(await restarted.listAll(owner)).some((g) => g.kind === 'user'));
});
test('late management selections cannot restore removed, re-revoked or replaced-plugin records', async (t) => {
  for (const change of ['remove', 'revoke', 'replace']) {
    await t.test(change, async (t) => {
      const f = await fixture(t);
      const directory = (
        await f.service.call('example', 'requestDirectory', {
          access: 'read-write',
          purpose: 'Save',
        })
      ).directory;
      await f.service.manageRevoke('example', directory.id);
      let finish, opened;
      const ready = new Promise((resolve) => {
        opened = resolve;
      });
      f.service['deps'].selectDirectory = async () => {
        opened();
        return new Promise((resolve) => {
          finish = resolve;
        });
      };
      const pending = f.service.manageReauthorize('example', directory.id);
      await ready;
      if (change === 'remove') await f.service.manageRemove('example', directory.id);
      else if (change === 'revoke') await f.service.manageRevoke('example', directory.id);
      else f.replacePlugin({ ...f.plugin });
      finish(f.chosen);
      await assert.rejects(
        pending,
        (e) =>
          e.code ===
          (change === 'remove'
            ? 'GRANT_REQUIRED'
            : change === 'revoke'
              ? 'GRANT_REVOKED'
              : 'PLUGIN_UNAVAILABLE'),
      );
      assert.ok((await f.service.manageGrants('example')).every((g) => g.revoked));
    });
  }
});
test('failed reauthorization persistence does not restore access', async (t) => {
  const f = await fixture(t);
  const file = (await f.service.call('example', 'requestFiles', { purpose: 'Read' })).files[0];
  await f.service.manageRevoke('example', file.fileId);
  const store = path.join(f.root, 'plugin-file-grants', 'grants.json');
  const backup = `${store}.backup`;
  await fs.rename(store, backup);
  await fs.mkdir(store);
  await assert.rejects(f.service.manageReauthorize('example', file.fileId));
  assert.equal((await f.service.manageGrants('example'))[0].revoked, true);
  const owner = (await f.service.capture('example')).owner;
  await assert.rejects(f.service.grants.resolve(owner, file), (e) => e.code === 'GRANT_REVOKED');
  await fs.rmdir(store);
  await fs.rename(backup, store);
});
test('local-only plugin can copy a large file without download permission', async (t) => {
  const f = await fixture(t, false);
  const data = Buffer.alloc(9 * 1024 * 1024, 3);
  await fs.writeFile(path.join(f.chosen, 'video.mp4'), data);
  const selected = await f.service.call('example', 'requestFiles', { purpose: 'Import' });
  const directory = await f.service.call('example', 'getPrivateDirectory', { kind: 'data' });
  await assert.rejects(
    f.service.call('example', 'download', {
      url: 'https://example.com',
      target: { directoryId: directory.id, relativePath: 'x' },
    }),
    (e) => e.code === 'CAPABILITY_REQUIRED',
  );
  const s = await f.service.call('example', 'copyFile', {
    source: selected.files[0],
    target: { directoryId: directory.id, relativePath: 'import.mp4' },
  });
  const owner = (await f.service.capture('example')).owner;
  const done = await f.service.downloads.wait(owner, s.id);
  assert.deepEqual(
    await fs.readFile((await f.service.grants.resolve(owner, done.result.file)).path),
    data,
  );
});
test('private data survives uninstall while grants/cache/tasks are removed; removal is opt-in', async (t) => {
  const f = await fixture(t);
  const directory = await f.service.call('example', 'getPrivateDirectory', { kind: 'data' });
  const ref = { kind: 'directory-file', directoryId: directory.id, relativePath: 'metadata.json' };
  await f.service.call('example', 'writeFile', { ref, data: 'saved' });
  const owner = (await f.service.capture('example')).owner;
  const cache = await f.service.call('example', 'getPrivateDirectory', { kind: 'cache' });
  await f.service.uninstall('example');
  assert.equal(
    await fs.readFile(path.join(f.root, 'plugin-data', owner, 'metadata.json'), 'utf8'),
    'saved',
  );
  assert.equal(await fs.stat(cache.displayPath).catch(() => null), null);
  assert.deepEqual(await f.service.manageGrants('example'), []);
  const restored = await f.service.call('example', 'getPrivateDirectory', { kind: 'data' });
  assert.notEqual(restored.id, directory.id);
  assert.equal(restored.displayPath, directory.displayPath);
  await f.service.uninstall('example', true);
  assert.equal(await fs.stat(directory.displayPath).catch(() => null), null);
});
test('a late directory selection cannot grant a replaced plugin context', async (t) => {
  const f = await fixture(t);
  let finish, opened;
  const waiting = new Promise((resolve) => {
    opened = resolve;
  });
  f.service.deps.selectDirectory = async () => {
    opened();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const pending = f.service.call(
    'example',
    'requestDirectory',
    { access: 'read', purpose: 'Read' },
    f.plugin,
  );
  await waiting;
  f.replacePlugin({ ...f.plugin });
  finish(f.chosen);
  await assert.rejects(pending, (e) => e.code === 'PLUGIN_UNAVAILABLE');
  assert.deepEqual(await f.service.manageGrants('example'), []);
});
test('runtime wait abort only stops waiting, disposed contexts reject and release leases', async () => {
  const previous = globalThis.window;
  const calls = [];
  let listener;
  let snapshot = { id: 'task', runId: 1, revision: 1, state: 'downloading' };
  globalThis.window = {
    electron: {
      plugins: {
        resources: {
          onDownload(_id, fn) {
            listener = fn;
            return () => calls.push('unsubscribe');
          },
          async call(_id, method) {
            calls.push(method);
            return {
              ok: true,
              value:
                method === 'openMedia'
                  ? { id: 'lease', url: 'echo-plugin-media://lease/media' }
                  : snapshot,
            };
          },
        },
      },
    },
  };
  try {
    const disposables = [];
    const api = createPluginResourceApi('example', (fn) => disposables.push(fn));
    const handle = await api.downloads.attach('task');
    const abort = new AbortController();
    const wait = handle.wait({ signal: abort.signal });
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await assert.rejects(wait, (e) => e.name === 'AbortError');
    assert.ok(!calls.includes('downloadCancel'));
    const pending = handle.wait();
    await new Promise((resolve) => setImmediate(resolve));
    snapshot = {
      ...snapshot,
      revision: 2,
      state: 'completed',
      result: { taskId: 'task', bytes: 10, file: { kind: 'selected-file', fileId: 'file' } },
    };
    listener(snapshot);
    assert.equal((await pending).bytes, 10);
    await api.files.openMedia({ kind: 'selected-file', fileId: 'file' });
    for (const dispose of disposables) dispose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(calls.includes('releaseMedia'));
    assert.ok(calls.includes('unsubscribe'));
    await assert.rejects(api.downloads.get('task'), (e) => e.code === 'PLUGIN_UNAVAILABLE');
    assert.equal(
      (await api.files.requestDirectory({ access: 'read', purpose: 'Late' })).error.code,
      'PLUGIN_UNAVAILABLE',
    );
  } finally {
    globalThis.window = previous;
  }
});

test('revoking a copy source aborts the stream and prevents destination commit', async (t) => {
  const f = await fixture(t, false);
  await fs.writeFile(path.join(f.chosen, 'video.mp4'), Buffer.alloc(16 * 1024 * 1024, 1));
  const selected = await f.service.call('example', 'requestFiles', { purpose: 'Import' });
  const directory = await f.service.call('example', 'getPrivateDirectory', { kind: 'data' });
  const owner = (await f.service.capture('example')).owner;
  const task = await f.service.call('example', 'copyFile', {
    source: selected.files[0],
    target: { directoryId: directory.id, relativePath: 'import.mp4' },
  });
  await new Promise((resolve) => {
    const stop = f.service.downloads.subscribe((_, s) => {
      if (s.id === task.id && s.state === 'downloading') {
        stop();
        resolve();
      }
    });
  });
  await f.service.manageRevoke('example', selected.files[0].fileId);
  assert.equal((await f.service.downloads.get(owner, task.id)).state, 'interrupted');
  assert.equal(
    await fs.stat(path.join(directory.displayPath, 'import.mp4')).catch(() => null),
    null,
  );
  await f.service.downloads.control(owner, task.id, 'resume');
  await assert.rejects(f.service.downloads.wait(owner, task.id), (e) => e.code === 'GRANT_REVOKED');
});
test('renderer context cleanup releases its own leases and preserves other contexts', async (t) => {
  const f = await fixture(t);
  const selected = await f.service.call('example', 'requestFiles', { purpose: 'Preview' });
  const ref = selected.files[0];
  const a = await f.service.call('example', 'openMedia', { ref }, f.plugin, 'renderer:a');
  const b = await f.service.call('example', 'openMedia', { ref }, f.plugin, 'renderer:b');
  f.service.releaseContext('renderer:a');
  assert.equal((await f.service.mediaResponse(new Request(a.url))).status, 404);
  const response = await f.service.mediaResponse(new Request(b.url));
  assert.equal(response.status, 200);
  await response.text();
});

test('an unused resource API does not request capability access for old plugins', async () => {
  const previous = globalThis.window;
  let subscriptions = 0;
  globalThis.window = {
    electron: {
      plugins: {
        resources: {
          onDownload() {
            subscriptions++;
            return () => {};
          },
        },
      },
    },
  };
  try {
    const disposables = [];
    createPluginResourceApi('old-plugin', (fn) => disposables.push(fn));
    assert.equal(subscriptions, 0);
    for (const dispose of disposables) dispose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(subscriptions, 0);
  } finally {
    globalThis.window = previous;
  }
});
