import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const bundle = await build({
  stdin: {
    contents: `export {DownloadEngine} from './src/main/downloads/engine';export {FileGrants} from './src/main/plugins/fileGrants';export * from './src/main/downloads/files';export * from './src/main/plugins/installTransaction';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  require,
  module,
  module.exports,
);
const {
  DownloadEngine,
  FileGrants,
  safePath,
  commitFile,
  ResourceError,
  createInstallTransaction,
  recoverInstallTransactions,
} = module.exports;
const digest = (b) => createHash('sha256').update(b).digest('hex');
async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-download-test-'));
  const output = path.join(root, 'output');
  await fs.mkdir(output);
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const engine = new DownloadEngine({
    root: path.join(root, 'tasks'),
    fetch: fetch,
    resolve: async (_owner, target) => ({
      path: await safePath(output, target.relativePath, true),
      validate: async () => {},
      commit: (fn) => fn(),
    }),
  });
  const engines = [engine];
  t.after(async () => {
    for (const engine of engines) await engine.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    output,
    engine,
    engines,
    url: `http://127.0.0.1:${server.address().port}/file?secret=do-not-save`,
  };
}
const target = { directoryId: 'test', relativePath: 'file.bin' };
test(
  'streams more than 8 MiB, checks checksum and never persists source credentials',
  { timeout: 15000 },
  async (t) => {
    const bytes = Buffer.alloc(10 * 1024 * 1024, 42);
    const f = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'Content-Length': bytes.length });
      res.end(bytes);
    });
    const s = await f.engine.create('plugin', {
      url: f.url,
      headers: { Authorization: 'secret' },
      debugSource: { url: f.url, headers: { Authorization: 'secret' } },
      target,
      checksum: { algorithm: 'sha256', value: digest(bytes) },
    });
    const done = await f.engine.wait('plugin', s.id);
    assert.equal(done.state, 'completed');
    assert.deepEqual(await fs.readFile(path.join(f.output, 'file.bin')), bytes);
    const record = await fs.readFile(path.join(f.root, 'tasks', `${s.id}.json`), 'utf8');
    assert.ok(!record.includes('secret'));
    assert.ok(!record.includes(f.url));
  },
);
test(
  'unknown-length oversized responses fail without publishing a file',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, (_req, res) => {
      res.write(Buffer.alloc(1024));
      res.end(Buffer.alloc(1024));
    });
    const s = await f.engine.create('plugin', { url: f.url, target, maxBytes: 1500 });
    await assert.rejects(f.engine.wait('plugin', s.id), (e) => e.code === 'SIZE_LIMIT');
    assert.equal(await fs.stat(path.join(f.output, 'file.bin')).catch(() => null), null);
  },
);
test(
  'checksum failure preserves an existing target and clears corrupt partial',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, (_req, res) => res.end('bad'));
    await fs.writeFile(path.join(f.output, 'file.bin'), 'old');
    const s = await f.engine.create('plugin', {
      url: f.url,
      target,
      conflict: 'replace',
      checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
    });
    await assert.rejects(f.engine.wait('plugin', s.id), (e) => e.code === 'CHECKSUM_MISMATCH');
    assert.equal(await fs.readFile(path.join(f.output, 'file.bin'), 'utf8'), 'old');
    assert.equal((await fs.readdir(f.output)).length, 1);
  },
);
test('pause and resume appends only a validated 206 range', { timeout: 15000 }, async (t) => {
  const bytes = Buffer.alloc(512 * 1024, 7);
  const ranges = [];
  const f = await fixture(t, (req, res) => {
    const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);
    ranges.push(start);
    res.writeHead(start ? 206 : 200, {
      ETag: '"stable"',
      'Content-Length': bytes.length - start,
      ...(start ? { 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}),
    });
    let offset = start;
    const timer = setInterval(() => {
      if (offset >= bytes.length) {
        clearInterval(timer);
        res.end();
      } else {
        res.write(bytes.subarray(offset, offset + 4096));
        offset += 4096;
      }
    }, 3);
    res.on('close', () => clearInterval(timer));
  });
  const s = await f.engine.create('plugin', {
    url: f.url,
    target,
    checksum: { algorithm: 'sha256', value: digest(bytes) },
  });
  await new Promise((resolve) => {
    const stop = f.engine.subscribe((_owner, current) => {
      if (current.id === s.id && current.receivedBytes > 8192) {
        stop();
        resolve();
      }
    });
  });
  const paused = await f.engine.control('plugin', s.id, 'pause');
  assert.equal(paused.state, 'paused');
  await f.engine.control('plugin', s.id, 'resume');
  await f.engine.wait('plugin', s.id);
  assert.ok(ranges.some((n) => n > 0));
  assert.deepEqual(await fs.readFile(path.join(f.output, 'file.bin')), bytes);
});
test('server ignoring Range restarts instead of appending', { timeout: 15000 }, async (t) => {
  const bytes = Buffer.alloc(512 * 1024, 11);
  let requests = 0;
  const f = await fixture(t, (_req, res) => {
    requests++;
    res.writeHead(200, { ETag: '"stable"', 'Content-Length': bytes.length });
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= bytes.length) {
        clearInterval(timer);
        res.end();
      } else {
        res.write(bytes.subarray(offset, offset + 4096));
        offset += 4096;
      }
    }, 3);
    res.on('close', () => clearInterval(timer));
  });
  const s = await f.engine.create('plugin', { url: f.url, target });
  await new Promise((resolve) => {
    const stop = f.engine.subscribe((_owner, current) => {
      if (current.id === s.id && current.receivedBytes > 8192) {
        stop();
        resolve();
      }
    });
  });
  await f.engine.control('plugin', s.id, 'pause');
  await f.engine.control('plugin', s.id, 'resume');
  await f.engine.wait('plugin', s.id);
  assert.equal(requests, 2);
  assert.deepEqual(await fs.readFile(path.join(f.output, 'file.bin')), bytes);
});
test(
  'cancel closes the transfer and removes only its own partial',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, (_req, res) => {
      const timer = setInterval(() => res.write(Buffer.alloc(4096)), 3);
      res.on('close', () => clearInterval(timer));
    });
    await fs.writeFile(path.join(f.output, 'user.part'), 'keep');
    const s = await f.engine.create('plugin', { url: f.url, target });
    await new Promise((resolve) => {
      const stop = f.engine.subscribe((_owner, current) => {
        if (current.id === s.id && current.state === 'downloading') {
          stop();
          resolve();
        }
      });
    });
    assert.equal((await f.engine.control('plugin', s.id, 'cancel')).state, 'canceled');
    assert.deepEqual(await fs.readdir(f.output), ['user.part']);
    await assert.rejects(f.engine.get('other', s.id), (e) => e.code === 'GRANT_REQUIRED');
  },
);
test('connection timeout covers response headers', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, () => {});
  const s = await f.engine.create('plugin', { url: f.url, target, connectTimeoutMs: 30 });
  await assert.rejects(f.engine.wait('plugin', s.id), (e) => e.code === 'NETWORK_TIMEOUT');
});
test('file commit no-clobber, rename and replace preserve correct contents', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-commit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'file');
  const temp = path.join(root, 'temp');
  await fs.writeFile(original, 'old');
  await fs.writeFile(temp, 'new');
  await assert.rejects(commitFile(temp, original, 'fail'), (e) => e.code === 'FILE_EXISTS');
  assert.equal(await fs.readFile(original, 'utf8'), 'old');
  const renamed = await commitFile(temp, original, 'rename');
  assert.equal(path.basename(renamed), 'file (1)');
  assert.equal(await fs.readFile(renamed, 'utf8'), 'new');
});
test('persistent grants enforce owner, mode, traversal, links and revocation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-grants-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'files');
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'one'), 'x');
  const grants = new FileGrants(path.join(root, 'grants'));
  const directory = await grants.create('a', data, 'read');
  const ref = { kind: 'directory-file', directoryId: directory.id, relativePath: 'one' };
  assert.equal((await grants.resolve('a', ref)).path, path.join(await fs.realpath(data), 'one'));
  await assert.rejects(grants.resolve('b', ref), (e) => e.code === 'GRANT_REQUIRED');
  await assert.rejects(grants.resolve('a', ref, true), (e) => e.code === 'GRANT_REQUIRED');
  await assert.rejects(
    grants.resolve('a', { ...ref, relativePath: '../outside' }),
    (e) => e.code === 'PATH_OUTSIDE_ROOT',
  );
  await fs.symlink(root, path.join(data, 'link'));
  await assert.rejects(
    grants.resolve('a', { ...ref, relativePath: 'link/file' }),
    (e) => e.code === 'PATH_OUTSIDE_ROOT',
  );
  const restored = new FileGrants(path.join(root, 'grants'));
  assert.equal((await restored.list('a'))[0].id, directory.id);
  await restored.revoke('a', directory.id);
  await assert.rejects(restored.resolve('a', ref), (e) => e.code === 'GRANT_REVOKED');
});
test('grant persistence failures do not publish grants and still notify revocation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-grant-write-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = path.join(root, 'grants');
  const files = path.join(root, 'files');
  await fs.mkdir(files);
  const grants = new FileGrants(store);
  await grants.list('owner');
  await fs.writeFile(store, 'blocking file');
  await assert.rejects(grants.create('owner', files, 'read'));
  await assert.rejects(grants.privateDirectory('owner', 'data'));
  assert.deepEqual(await grants.list('owner'), []);
  await fs.rm(store);
  const grant = await grants.create('owner', files, 'read');
  await fs.rm(store, { recursive: true });
  await fs.writeFile(store, 'blocking file');
  let notified = false;
  grants.onRevoke(async (id) => {
    notified = id === grant.id;
  });
  await assert.rejects(grants.revoke('owner', grant.id));
  assert.equal(notified, true);
  await assert.rejects(
    grants.resolve('owner', {
      kind: 'directory-file',
      directoryId: grant.id,
      relativePath: 'file',
    }),
    (e) => e.code === 'GRANT_REVOKED',
  );
});
test('failed installation rolls back the old directory and metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'plugin');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'version'), 'old');
  const txn = await createInstallTransaction(root, target, { id: 'plugin' });
  await fs.mkdir(txn.staged);
  await fs.writeFile(path.join(txn.staged, 'version'), 'new');
  let restored = false;
  await assert.rejects(
    txn.apply(
      (fn) => fn(),
      async () => {
        throw new Error('metadata failed');
      },
      async () => {
        restored = true;
      },
    ),
  );
  assert.equal(await fs.readFile(path.join(target, 'version'), 'utf8'), 'old');
  assert.equal(restored, true);
});
test('startup recovery restores an interrupted directory replacement', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-recover-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'plugin');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'version'), 'old');
  const txn = await createInstallTransaction(root, target, { id: 'plugin' });
  const journal = path.join(txn.directory, 'journal.json');
  const saved = JSON.parse(await fs.readFile(journal, 'utf8'));
  saved.phase = 'replacing';
  await fs.writeFile(journal, JSON.stringify(saved));
  await fs.rename(target, saved.rollback);
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'version'), 'partial');
  let restored = false;
  await recoverInstallTransactions(root, async () => {
    restored = true;
  });
  assert.equal(restored, true);
  assert.equal(await fs.readFile(path.join(target, 'version'), 'utf8'), 'old');
});

test(
  'restart requires a fresh source and resumes the same durable task',
  { timeout: 15000 },
  async (t) => {
    const bytes = Buffer.alloc(512 * 1024, 19);
    const f = await fixture(t, (req, res) => {
      const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);
      res.writeHead(start ? 206 : 200, {
        ETag: '"v1"',
        'Content-Length': bytes.length - start,
        ...(start ? { 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}),
      });
      let offset = start;
      const timer = setInterval(() => {
        if (offset >= bytes.length) {
          clearInterval(timer);
          res.end();
        } else {
          res.write(bytes.subarray(offset, offset + 4096));
          offset += 4096;
        }
      }, 3);
      res.on('close', () => clearInterval(timer));
    });
    const s = await f.engine.create('plugin', { url: f.url, target });
    await new Promise((resolve) => {
      const stop = f.engine.subscribe((_, v) => {
        if (v.id === s.id && v.receivedBytes > 8192) {
          stop();
          resolve();
        }
      });
    });
    await f.engine.shutdown();
    const restored = new DownloadEngine({
      root: path.join(f.root, 'tasks'),
      fetch,
      resolve: async (_owner, t) => ({
        path: await safePath(f.output, t.relativePath, true),
        validate: async () => {},
        commit: (fn) => fn(),
      }),
    });
    f.engines.push(restored);
    assert.equal((await restored.get('plugin', s.id)).state, 'interrupted');
    await assert.rejects(
      restored.control('plugin', s.id, 'resume'),
      (e) => e.code === 'SOURCE_AUTH_REQUIRED',
    );
    await restored.control('plugin', s.id, 'resume', { url: f.url });
    await restored.wait('plugin', s.id);
    assert.deepEqual(await fs.readFile(path.join(f.output, 'file.bin')), bytes);
  },
);
test(
  'simultaneous pause, resume and cancel serialize without resurrecting the task',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, (_req, res) => {
      const timer = setInterval(() => res.write(Buffer.alloc(4096)), 3);
      res.on('close', () => clearInterval(timer));
    });
    const s = await f.engine.create('plugin', { url: f.url, target });
    const commands = await Promise.allSettled([
      f.engine.control('plugin', s.id, 'pause'),
      f.engine.control('plugin', s.id, 'resume'),
      f.engine.control('plugin', s.id, 'cancel'),
    ]);
    assert.ok(commands.every((r) => r.status === 'fulfilled'));
    assert.equal((await f.engine.get('plugin', s.id)).state, 'canceled');
    assert.deepEqual(await fs.readdir(f.output), []);
  },
);
test('cancel refuses to delete a replaced partial file', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, (_req, res) => {
    const timer = setInterval(() => res.write(Buffer.alloc(4096)), 3);
    res.on('close', () => clearInterval(timer));
  });
  const s = await f.engine.create('plugin', { url: f.url, target });
  await new Promise((resolve) => {
    const stop = f.engine.subscribe((_, v) => {
      if (v.id === s.id && v.state === 'downloading') {
        stop();
        resolve();
      }
    });
  });
  await f.engine.control('plugin', s.id, 'pause');
  const partial = path.join(f.output, `.echo-${s.id}.part`);
  await fs.rename(partial, partial + '.old');
  await fs.writeFile(partial, 'user file');
  await assert.rejects(
    f.engine.control('plugin', s.id, 'cancel'),
    (e) => e.code === 'PATH_OUTSIDE_ROOT',
  );
  assert.equal(await fs.readFile(partial, 'utf8'), 'user file');
});
test(
  'idempotency is atomic when two callers create the same task',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, (_req, res) => res.end('one'));
    const options = { url: f.url, target, idempotencyKey: 'resource-v1' };
    const [a, b] = await Promise.all([
      f.engine.create('plugin', options),
      f.engine.create('plugin', options),
    ]);
    assert.equal(a.id, b.id);
    await f.engine.wait('plugin', a.id);
    assert.equal((await f.engine.list('plugin')).length, 1);
  },
);
test('metadata refresh or descriptor validation failure rolls installation back', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-refresh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'plugin');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'version'), 'old');
  const txn = await createInstallTransaction(root, target);
  await fs.mkdir(txn.staged);
  await fs.writeFile(path.join(txn.staged, 'version'), 'new');
  await assert.rejects(
    txn.apply(
      (fn) => fn(),
      async () => {},
      async () => {},
      () => {
        throw new Error('bad descriptor');
      },
    ),
  );
  assert.equal(await fs.readFile(path.join(target, 'version'), 'utf8'), 'old');
});

test(
  'idle timeout stops a stalled response body and never publishes it',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'Content-Length': 10000 });
      res.write('partial');
    });
    const task = await f.engine.create('plugin', { url: f.url, target, idleTimeoutMs: 30 });
    await assert.rejects(f.engine.wait('plugin', task.id), (e) => e.code === 'NETWORK_TIMEOUT');
    assert.equal(await fs.stat(path.join(f.output, 'file.bin')).catch(() => null), null);
  },
);
test(
  'cross-origin redirect strips authorization and custom headers',
  { timeout: 15000 },
  async (t) => {
    let seen;
    const other = http.createServer((req, res) => {
      seen = req.headers;
      res.end('redirected');
    });
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      other.closeAllConnections();
      await new Promise((resolve) => other.close(resolve));
    });
    const f = await fixture(t, (_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${other.address().port}/target` });
      res.end();
    });
    const task = await f.engine.create('plugin', {
      url: f.url,
      headers: { Authorization: 'Bearer secret', 'X-Custom-Key': 'secret', Cookie: 'secret' },
      target,
    });
    await f.engine.wait('plugin', task.id);
    assert.equal(seen.authorization, undefined);
    assert.equal(seen['x-custom-key'], undefined);
    assert.equal(seen.cookie, undefined);
  },
);
test(
  'a changed 206 validator fails safely then retries from zero',
  { timeout: 15000 },
  async (t) => {
    const bytes = Buffer.alloc(512 * 1024, 47);
    let version = 'old';
    const ranges = [];
    const f = await fixture(t, (req, res) => {
      const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);
      ranges.push(start);
      res.writeHead(start ? 206 : 200, {
        ETag: `"${version}"`,
        'Content-Length': bytes.length - start,
        ...(start ? { 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}),
      });
      let offset = start;
      const timer = setInterval(() => {
        if (offset >= bytes.length) {
          clearInterval(timer);
          res.end();
        } else {
          res.write(bytes.subarray(offset, offset + 4096));
          offset += 4096;
        }
      }, 3);
      res.on('close', () => clearInterval(timer));
    });
    const task = await f.engine.create('plugin', { url: f.url, target });
    await new Promise((resolve) => {
      const stop = f.engine.subscribe((_, s) => {
        if (s.id === task.id && s.receivedBytes > 8192) {
          stop();
          resolve();
        }
      });
    });
    await f.engine.control('plugin', task.id, 'pause');
    version = 'new';
    await f.engine.control('plugin', task.id, 'resume');
    await assert.rejects(f.engine.wait('plugin', task.id), (e) => e.code === 'SOURCE_CHANGED');
    assert.equal(await fs.stat(path.join(f.output, 'file.bin')).catch(() => null), null);
    const retry = await f.engine.control('plugin', task.id, 'retry');
    assert.equal(retry.runId, 2);
    await f.engine.wait('plugin', task.id);
    assert.equal(ranges.at(-1), 0);
    assert.deepEqual(await fs.readFile(path.join(f.output, 'file.bin')), bytes);
  },
);
test(
  'idempotent completed tasks detect externally changed files',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, (_req, res) => res.end('one'));
    const options = { url: f.url, target, idempotencyKey: 'v1' };
    const task = await f.engine.create('plugin', options);
    await f.engine.wait('plugin', task.id);
    await fs.writeFile(path.join(f.output, 'file.bin'), 'two');
    await assert.rejects(f.engine.create('plugin', options), (e) => e.code === 'SOURCE_CHANGED');
  },
);

test('invalid source headers fail before creating a durable record without exposing their value', async (t) => {
  const f = await fixture(t, () => {});
  await assert.rejects(
    f.engine.create('plugin', {
      url: f.url,
      headers: { Authorization: 'super-secret\ninjected' },
      target,
    }),
    (e) => e.code === 'INVALID_ARGUMENT' && !e.message.includes('super-secret'),
  );
  assert.deepEqual(await f.engine.list('plugin'), []);
});

test('a failed creation checkpoint leaves no task or started transfer', async (t) => {
  let requests = 0;
  const f = await fixture(t, (_req, res) => {
    requests++;
    res.end('unexpected');
  });
  await f.engine.list('plugin');
  const tasks = path.join(f.root, 'tasks');
  await fs.rm(tasks, { recursive: true });
  await fs.writeFile(tasks, 'blocked storage');
  await assert.rejects(f.engine.create('plugin', { url: f.url, target }));
  assert.deepEqual(await f.engine.list('plugin'), []);
  assert.equal(requests, 0);
  assert.deepEqual(await fs.readdir(f.output), []);
});
