import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

function compile(file, deps) {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in deps, `unexpected dependency: ${name}`);
      return deps[name];
    },
    module,
    module.exports,
  );
  return module.exports;
}
const local = compile('../src/shared/localMusic.ts', {});
const cloud = compile('../src/shared/cloud.ts', { './localMusic': local });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setImmediate(r));
const stat = (size = 3, isFile = true) => ({ size, mtimeMs: 1, isFile: () => isFile });
const file = (name, size = 3) => ({
  name,
  path: `/uploads/${name}`,
  size,
  modifiedAt: 1,
  extension: path.extname(name),
  kind: 'audio',
  relativePath: '',
});
class Sender extends EventEmitter {
  destroyed = false;
  constructor(id = 1) {
    super();
    this.id = id;
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}
function fixture(t, overrides = {}) {
  const handlers = new Map(),
    calls = { metadata: [], reads: [], closes: 0, opens: 0, realpath: [] };
  let dialog = async () => ({ canceled: false, filePaths: ['/uploads/a.mp3'] });
  let metadata = async () => ({ title: 'tag-title', artist: 'tag-artist', duration: 30 });
  let scan = async () => ({ root: '/uploads', files: [file('a.mp3')], limitReached: false });
  const bytes = Buffer.from('abc');
  const filesystem = {
    realpath: async (value) => {
      calls.realpath.push(value);
      return value;
    },
    stat: async () => stat(),
    readFile: async () => bytes,
    open: async () => {
      calls.opens++;
      return {
        stat: async () => stat(),
        read: async (target, offset, length, position) => {
          calls.reads.push({ length, position, capacity: target.length });
          const bytesRead = bytes.copy(
            target,
            offset,
            position,
            Math.min(bytes.length, position + length),
          );
          return { bytesRead, buffer: target };
        },
        close: async () => {
          calls.closes++;
        },
      };
    },
    ...overrides.fs,
  };
  const api = compile('../src/main/ipc/cloud.ts', {
    'fs/promises': filesystem,
    path,
    electron: { dialog: { showOpenDialog: (...args) => dialog(...args) } },
    './registry': {
      ipcRegistry: { registerHandler: (name, handler) => handlers.set(name, handler) },
    },
    '../logger': { debug() {} },
    '../../shared/cloud': cloud,
    '../media/audioMetadata': {
      readAudioMetadata: (...args) => {
        calls.metadata.push(args[0]);
        return metadata(...args);
      },
      resolveAudioTitleAndArtist: (name, value) => ({
        title: value?.title || name,
        artist: value?.artist || '',
      }),
    },
    '../media/fileScanner': {
      normalizeFileExtension: (value) => `.${value.replace(/^\./, '').toLowerCase()}`,
      scanLocalFiles: (...args) => scan(...args),
    },
  });
  api.registerCloudHandlers({ getMainWindow: () => null });
  const sender = new Sender();
  t.after(() => sender.destroy());
  const invoke = (name, owner, ...args) =>
    handlers.get(`cloud:${name}`)({ sender: owner }, ...args);
  return {
    sender,
    calls,
    filesystem,
    dialog: (fn) => {
      dialog = fn;
    },
    metadata: (fn) => {
      metadata = fn;
    },
    scan: (fn) => {
      scan = fn;
    },
    pick: (mode = 'file', owner = sender) => invoke('pick-upload-files', owner, mode),
    read: (value = '/uploads/a.mp3', owner = sender) =>
      invoke('read-upload-file-data', owner, value),
    clear: (owner = sender) => invoke('clear-upload-files', owner),
  };
}
for (const stage of ['dialog', 'scan', 'metadata']) {
  for (const invalidation of ['clear', 'destroy', 'new-pick']) {
    test(`round15: ${invalidation} invalidates a pending ${stage} selection`, async (t) => {
      const f = fixture(t),
        read = deferred();
      t.after(() =>
        read.resolve(
          stage === 'dialog'
            ? { canceled: false, filePaths: ['/uploads/a.mp3'] }
            : stage === 'scan'
              ? { root: '/uploads', files: [file('a.mp3')], limitReached: false }
              : {},
        ),
      );
      if (stage === 'dialog') f.dialog(() => read.promise);
      if (stage === 'scan') f.scan(() => read.promise);
      if (stage === 'metadata') f.metadata(() => read.promise);
      const first = f.pick(stage === 'scan' ? 'folder' : 'file');
      await tick();
      if (invalidation === 'clear') f.clear();
      if (invalidation === 'destroy') f.sender.destroy();
      if (invalidation === 'new-pick') {
        f.dialog(async () => ({ canceled: false, filePaths: ['/uploads/b.mp3'] }));
        f.scan(async () => ({ root: '/uploads', files: [file('b.mp3')], limitReached: false }));
        f.metadata(async () => ({}));
        const newer = await f.pick();
        assert.equal(newer.files[0].path, '/uploads/b.mp3');
      }
      read.resolve(
        stage === 'dialog'
          ? { canceled: false, filePaths: ['/uploads/a.mp3'] }
          : stage === 'scan'
            ? { root: '/uploads', files: [file('a.mp3')], limitReached: false }
            : {},
      );
      assert.deepEqual(await first, { canceled: true, files: [] });
      assert.equal((await f.read('/uploads/a.mp3')).ok, false);
      if (invalidation === 'new-pick') assert.equal((await f.read('/uploads/b.mp3')).ok, true);
    });
  }
}
test('round15: repeated clear and pick retain one destruction listener', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) {
    await f.pick();
    f.clear();
  }
  assert.equal(f.sender.listenerCount('destroyed'), 1);
});
test('round15: equal numeric sender IDs cannot share upload authorization', async (t) => {
  const f = fixture(t),
    second = new Sender(f.sender.id);
  t.after(() => second.destroy());
  await f.pick();
  assert.equal((await f.read('/uploads/a.mp3', second)).ok, false);
  f.clear(second);
  assert.equal((await f.read()).ok, true);
});
test('round15: destruction and ID reuse do not authorize a replacement sender', async (t) => {
  const f = fixture(t),
    read = deferred();
  f.metadata(() => read.promise);
  const selection = f.pick();
  await tick();
  f.sender.destroy();
  read.resolve({});
  await selection;
  const second = new Sender(f.sender.id);
  t.after(() => second.destroy());
  assert.equal((await f.read('/uploads/a.mp3', second)).ok, false);
});
test('round15: an invalid successful selection clears the preceding allow-list', async (t) => {
  const f = fixture(t);
  await f.pick();
  f.dialog(async () => ({ canceled: false, filePaths: ['/uploads/not-audio.txt'] }));
  const result = await f.pick();
  assert.equal(result.canceled, false);
  assert.deepEqual(result.files, []);
  assert.equal((await f.read()).ok, false);
});
test('round15: canceled dialog preserves the preceding successful selection', async (t) => {
  const f = fixture(t);
  await f.pick();
  f.dialog(async () => ({ canceled: true, filePaths: [] }));
  assert.deepEqual(await f.pick(), { canceled: true, files: [] });
  assert.equal((await f.read()).ok, true);
});
test('round15: invalid pick mode and destroyed sender do not open a dialog', async (t) => {
  const f = fixture(t);
  let count = 0;
  f.dialog(async () => {
    count++;
    return { canceled: true, filePaths: [] };
  });
  await f.pick('bad');
  f.sender.destroy();
  await f.pick();
  assert.equal(count, 0);
});
test('round15: parallel metadata reads stay bounded and preserve selected order', async (t) => {
  const f = fixture(t),
    waiting = [],
    list = Array.from({ length: 9 }, (_, i) => file(`${i}.mp3`));
  f.scan(async () => ({ root: '/uploads', files: list, limitReached: false }));
  let running = 0,
    max = 0;
  f.metadata(() => {
    const d = deferred();
    running++;
    max = Math.max(max, running);
    waiting.push(d);
    return d.promise.finally(() => running--);
  });
  const operation = f.pick('folder');
  await tick();
  const initial = waiting.length;
  while (waiting.length < list.length || running) {
    for (const d of [...waiting].reverse()) d.resolve({});
    await tick();
  }
  const result = await operation;
  assert.equal(initial, 4);
  assert.equal(max, 4);
  assert.deepEqual(
    result.files.map((v) => v.name),
    list.map((v) => v.name),
  );
});
test('round15: duplicate selected paths parse metadata once and return one file', async (t) => {
  const f = fixture(t);
  f.dialog(async () => ({ canceled: false, filePaths: ['/uploads/a.mp3', '/uploads/a.mp3'] }));
  const result = await f.pick();
  assert.equal(result.files.length, 1);
  assert.equal(f.calls.metadata.length, 1);
});
test('round15: revoked metadata workers stop scheduling further files', async (t) => {
  const f = fixture(t),
    read = deferred();
  f.scan(async () => ({
    root: '/uploads',
    files: Array.from({ length: 9 }, (_, i) => file(`${i}.mp3`)),
    limitReached: false,
  }));
  f.metadata(() => read.promise);
  const operation = f.pick('folder');
  await tick();
  f.clear();
  read.resolve({});
  assert.deepEqual(await operation, { canceled: true, files: [] });
  assert.equal(f.calls.metadata.length, 4);
});
for (const stage of ['realpath', 'open', 'stat', 'read', 'close']) {
  for (const invalidation of ['clear', 'destroy']) {
    test(`round15: ${invalidation} during ${stage} rejects file data and closes its handle`, async (t) => {
      const f = fixture(t);
      await f.pick();
      const waiting = deferred();
      let entered = false,
        closed = 0;
      const pause = async () => {
        entered = true;
        await waiting.promise;
      };
      if (stage === 'realpath')
        f.filesystem.realpath = async (v) => {
          await pause();
          return v;
        };
      const content = Buffer.from('abc');
      f.filesystem.open = async () => {
        if (stage === 'open') await pause();
        return {
          stat: async () => {
            if (stage === 'stat') await pause();
            return stat();
          },
          read: async (buffer, offset, length, position) => {
            if (stage === 'read') await pause();
            return {
              bytesRead: content.copy(buffer, offset, position, Math.min(3, position + length)),
            };
          },
          close: async () => {
            closed++;
            if (stage === 'close') await pause();
          },
        };
      };
      // The old implementation uses stat/readFile instead of file handles; pause those too.
      f.filesystem.stat = async () => {
        if (stage === 'stat') await pause();
        return stat();
      };
      f.filesystem.readFile = async () => {
        if (['read', 'close', 'open'].includes(stage)) await pause();
        return content;
      };
      const reading = f.read();
      await tick();
      assert.equal(entered, true);
      if (invalidation === 'clear') f.clear();
      else f.sender.destroy();
      waiting.resolve();
      const result = await reading;
      assert.equal(result.ok, false);
      if (stage !== 'realpath') assert.equal(closed, 1);
    });
  }
}
for (const mutation of ['grow', 'shrink']) {
  test(`round15: file ${mutation} after stat cannot return mismatched or unbounded data`, async (t) => {
    const f = fixture(t);
    await f.pick();
    const content = Buffer.from(mutation === 'grow' ? 'abcdef' : 'a');
    f.filesystem.readFile = async () => content;
    f.filesystem.open = async () => ({
      stat: async () => stat(),
      read: async (buffer, offset, length, position) => ({
        bytesRead: content.copy(
          buffer,
          offset,
          position,
          Math.min(content.length, position + length),
        ),
      }),
      close: async () => {},
    });
    const result = await f.read();
    assert.equal(result.ok, false);
    assert.match(result.error, /读取期间/);
  });
}
test('round15 control: large file reads use bounded chunks and exact ArrayBuffer length', async (t) => {
  const f = fixture(t);
  await f.pick();
  const content = Buffer.alloc(1200001, 9),
    reads = [];
  f.filesystem.stat = async () => stat(content.length);
  f.filesystem.readFile = async () => content;
  f.filesystem.open = async () => ({
    stat: async () => stat(content.length),
    read: async (buffer, offset, length, position) => {
      reads.push(length);
      return {
        bytesRead: content.copy(
          buffer,
          offset,
          position,
          Math.min(content.length, position + length),
        ),
      };
    },
    close: async () => {},
  });
  const result = await f.read();
  assert.equal(result.ok, true);
  assert.equal(result.size, content.length);
  assert.equal(result.data.byteLength, content.length);
  assert.deepEqual(Buffer.from(result.data), content);
  assert.deepEqual(reads, [524288, 524288, 151425, 1]);
});
for (const size of [0, cloud.CLOUD_UPLOAD_MAX_SIZE + 1]) {
  test(`round15 control: selected file size ${size} is rejected before reading data`, async (t) => {
    const f = fixture(t);
    await f.pick();
    f.filesystem.stat = async () => stat(size);
    f.filesystem.open = async () => ({
      stat: async () => stat(size),
      read: async () => assert.fail('must not read'),
      close: async () => {
        f.calls.closes++;
      },
    });
    const result = await f.read();
    assert.equal(result.ok, false);
    assert.match(result.error, /限制/);
    assert.equal(f.calls.closes, 1);
  });
}
test('round15 control: read failure closes the handle and preserves the actionable error', async (t) => {
  const f = fixture(t);
  await f.pick();
  f.filesystem.readFile = async () => {
    throw new Error('read broken');
  };
  f.filesystem.open = async () => ({
    stat: async () => stat(),
    read: async () => {
      throw new Error('read broken');
    },
    close: async () => {
      f.calls.closes++;
      throw new Error('close broken');
    },
  });
  const result = await f.read();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'read broken');
  assert.equal(f.calls.closes, 1);
});
test('round15: metadata failures fall back to names and oversize selection remains rejected', async (t) => {
  const f = fixture(t);
  f.scan(async () => ({
    root: '/uploads',
    files: [file('bad.mp3', 0), file('a.mp3'), file('huge.mp3', cloud.CLOUD_UPLOAD_MAX_SIZE + 1)],
    limitReached: true,
  }));
  f.metadata(async () => {
    throw new Error('bad tag');
  });
  const result = await f.pick('folder');
  assert.deepEqual(
    result.files.map((v) => v.title),
    ['a.mp3'],
  );
  assert.equal(result.errors.length, 3);
  assert.equal(f.calls.metadata.length, 1);
});
test('round15: real filesystem pick read clear and reread preserve exact bytes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-cloud-upload-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const selected = path.join(directory, 'song.mp3'),
    content = Buffer.from([0, 1, 2, 254, 255]);
  await fs.writeFile(selected, content);
  const f = fixture(t, { fs });
  f.dialog(async () => ({ canceled: false, filePaths: [selected] }));
  const picked = await f.pick();
  assert.equal(picked.files.length, 1);
  const result = await f.read(picked.files[0].path);
  assert.equal(result.ok, true);
  assert.equal(result.size, content.length);
  assert.deepEqual(Buffer.from(result.data), content);
  f.clear();
  assert.equal((await f.read(picked.files[0].path)).ok, false);
});

test('round15: late dialog failure after revocation becomes a canceled selection', async (t) => {
  const f = fixture(t),
    dialog = deferred();
  f.dialog(() => dialog.promise);
  const operation = f.pick();
  f.clear();
  dialog.reject(new Error('destroyed dialog'));
  assert.deepEqual(await operation, { canceled: true, files: [] });
});
test('round15: current dialog failure remains actionable and preserves existing files', async (t) => {
  const f = fixture(t);
  await f.pick();
  f.dialog(async () => {
    throw new Error('dialog failed');
  });
  await assert.rejects(f.pick(), /dialog failed/);
  assert.equal((await f.read()).ok, true);
});
test('round15 control: successful read survives close failure without losing the buffer', async (t) => {
  const f = fixture(t);
  await f.pick();
  const content = Buffer.from('abc');
  f.filesystem.open = async () => ({
    stat: async () => stat(),
    read: async (buffer, offset, length, position) => ({
      bytesRead: content.copy(
        buffer,
        offset,
        position,
        Math.min(content.length, position + length),
      ),
    }),
    close: async () => {
      f.calls.closes++;
      throw new Error('close failed');
    },
  });
  const result = await f.read();
  assert.equal(result.ok, true);
  assert.deepEqual(Buffer.from(result.data), content);
  assert.equal(f.calls.closes, 1);
});
test('round15 control: short filesystem reads are accumulated without dropping bytes', async (t) => {
  const f = fixture(t);
  await f.pick();
  const content = Buffer.from('abc');
  let reads = 0;
  f.filesystem.open = async () => ({
    stat: async () => stat(),
    read: async (buffer, offset, length, position) => {
      reads++;
      return {
        bytesRead: content.copy(
          buffer,
          offset,
          position,
          Math.min(content.length, position + Math.min(1, length)),
        ),
      };
    },
    close: async () => {},
  });
  const result = await f.read();
  assert.equal(result.ok, true);
  assert.deepEqual(Buffer.from(result.data), content);
  assert.equal(reads, 4);
});
test('round15: unsupported files are denied without opening a read handle', async (t) => {
  const f = fixture(t);
  await f.pick();
  assert.equal((await f.read('/uploads/a.txt')).ok, false);
  assert.equal(f.calls.opens, 0);
});
test('round15 control: a selected path replaced by a directory is rejected and closed', async (t) => {
  const f = fixture(t);
  await f.pick();
  f.filesystem.stat = async () => stat(3, false);
  f.filesystem.open = async () => ({
    stat: async () => stat(3, false),
    read: async () => assert.fail('must not read'),
    close: async () => {
      f.calls.closes++;
    },
  });
  assert.equal((await f.read()).ok, false);
  assert.equal(f.calls.closes, 1);
});

test('round15: reselecting the same file invalidates an older read without revoking new access', async (t) => {
  const f = fixture(t);
  await f.pick();
  const read = deferred();
  let first = true;
  f.filesystem.realpath = async (value) => {
    if (first) {
      first = false;
      await read.promise;
    }
    return value;
  };
  const previous = f.read();
  await tick();
  await f.pick();
  read.resolve();
  assert.equal((await previous).ok, false);
  assert.equal((await f.read()).ok, true);
});
test('round15: real recursive scanner selects supported files and authorizes each exact payload', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-cloud-folder-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'nested'));
  await fs.writeFile(path.join(directory, 'a.mp3'), Buffer.from('abc'));
  await fs.writeFile(path.join(directory, 'nested', 'b.flac'), Buffer.from('defg'));
  await fs.writeFile(path.join(directory, 'skip.txt'), Buffer.from('text'));
  const f = fixture(t, { fs });
  const scanner = compile('../src/main/media/fileScanner.ts', { 'fs/promises': fs, path });
  f.scan(scanner.scanLocalFiles);
  f.dialog(async () => ({ canceled: false, filePaths: [directory] }));
  const selection = await f.pick('folder');
  assert.deepEqual(
    selection.files.map((item) => item.name),
    ['a.mp3', 'b.flac'],
  );
  for (const item of selection.files) {
    const result = await f.read(item.path);
    assert.equal(result.ok, true);
    assert.deepEqual(Buffer.from(result.data), await fs.readFile(item.path));
  }
  assert.equal((await f.read(path.join(directory, 'skip.txt'))).ok, false);
});
