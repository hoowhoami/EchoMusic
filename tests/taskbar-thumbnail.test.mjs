import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

function setup({ enabled = true, platform = 'win32', available = true, fail = false } = {}) {
  const calls = [],
    decodes = [];
  const native = {
    taskbarThumbnailEnable: (...args) => {
      calls.push(['enable', ...args]);
      if (fail) throw Error('DWM rejected');
    },
    taskbarThumbnailDisable: () => calls.push(['disable']),
    taskbarThumbnailSetCover: (...args) => calls.push(['cover', ...args]),
  };
  function image(label, width = 1024, height = 1024) {
    return {
      isEmpty: () => label === 'invalid',
      getSize: () => ({ width, height }),
      resize: (size) =>
        image(
          label,
          size.width ?? Math.round((width * size.height) / height),
          size.height ?? Math.round((height * size.width) / width),
        ),
      toBitmap: () => Buffer.from(label),
    };
  }
  const mocks = {
    electron: {
      app: { isPackaged: false },
      nativeImage: {
        createFromPath: (path) => {
          decodes.push(path);
          return image('EchoMusic');
        },
        createFromBuffer: (data) => {
          decodes.push(data.toString());
          return image(data.toString(), 1200, 600);
        },
      },
    },
    'node:path': { join },
    'node:crypto': { createHash },
    './native/platform': { getNativePlatform: () => (available ? native : null) },
    './logger': { default: { warn() {} }, __esModule: true },
    './storage/settings': { getMainAppSettings: () => ({ taskbarCoverPreview: enabled }) },
  };
  const module = { exports: {} };
  runInNewContext(
    transformSync(
      readFileSync(new URL('../src/main/taskbarThumbnail.ts', import.meta.url), 'utf8'),
      { loader: 'ts', format: 'cjs' },
    ).code,
    {
      module,
      Buffer,
      __dirname: '/test/dist-electron/main',
      process: { platform },
      require: (id) => {
        assert.ok(id in mocks, id);
        return mocks[id];
      },
    },
  );
  function window(id = 1) {
    const win = new EventEmitter();
    win.isDestroyed = () => false;
    win.getNativeWindowHandle = () => {
      const value = Buffer.alloc(8);
      value.writeBigUInt64LE(BigInt(id));
      return value;
    };
    return win;
  }
  return { api: module.exports, calls, decodes, window };
}
test('DWM starts with a local fallback bitmap, without a network request or JS message hooks', () => {
  const f = setup();
  f.api.setupTaskbarThumbnail(f.window());
  assert.deepEqual(f.calls, [['enable', '1', Buffer.from('EchoMusic'), 512, 512]]);
  assert.match(f.decodes[0], /build\/icons\/icon.png$/);
});
test('covers decode only on change and long edge is bounded without changing aspect ratio', () => {
  const f = setup();
  f.api.setupTaskbarThumbnail(f.window());
  f.api.setTaskbarCover(Buffer.from('album'));
  f.api.setTaskbarCover(Buffer.from('album'));
  assert.equal(f.decodes.filter((v) => v === 'album').length, 1);
  assert.deepEqual(f.calls.at(-1), ['cover', Buffer.from('album'), 512, 256]);
});
test('missing and invalid covers replace the previous album with the local fallback', () => {
  const f = setup();
  f.api.setupTaskbarThumbnail(f.window());
  f.api.setTaskbarCover(Buffer.from('first'));
  f.api.setTaskbarCover(null);
  assert.equal(f.calls.at(-1)[1].toString(), 'EchoMusic');
  const count = f.calls.length;
  f.api.setTaskbarCover(Buffer.alloc(0));
  assert.equal(f.calls.length, count);
  f.api.setTaskbarCover(Buffer.from('invalid'));
  assert.equal(f.calls.at(-1)[1].toString(), 'EchoMusic');
});
test('toggle detaches native subclass and resumes with the latest bounded cover', () => {
  const f = setup({ enabled: false });
  f.api.setupTaskbarThumbnail(f.window());
  f.api.setTaskbarCover(Buffer.from('first'));
  assert.equal(f.calls.length, 0);
  f.api.setCoverPreviewEnabled(true);
  assert.equal(f.calls.at(-1)[0], 'enable');
  f.api.setCoverPreviewEnabled(false);
  assert.deepEqual(f.calls.at(-1), ['disable']);
  f.api.setTaskbarCover(Buffer.from('second'));
  f.api.setCoverPreviewEnabled(true);
  assert.deepEqual(f.calls.at(-1), ['enable', '1', Buffer.from('second'), 512, 256]);
});
test('window replacement detaches old HWND, late close cannot detach new HWND', () => {
  const f = setup(),
    old = f.window(1),
    next = f.window(2);
  f.api.setupTaskbarThumbnail(old);
  f.api.setTaskbarCover(Buffer.from('album'));
  f.api.setupTaskbarThumbnail(next);
  old.emit('closed');
  assert.equal(f.calls.at(-1)[1], '2');
  assert.equal(old.listenerCount('closed'), 0);
  next.emit('closed');
  assert.deepEqual(f.calls.at(-1), ['disable']);
});
test('native errors roll back to system live preview, and cleanup is idempotent', () => {
  const f = setup({ fail: true });
  f.api.setupTaskbarThumbnail(f.window());
  assert.deepEqual(f.calls.at(-1), ['disable']);
  f.api.destroyTaskbarThumbnail();
  f.api.destroyTaskbarThumbnail();
  assert.equal(f.calls.filter((c) => c[0] === 'disable').length, 1);
});
test('unsupported platforms and unavailable addon never attach a preview', () => {
  for (const options of [{ platform: 'darwin' }, { platform: 'linux' }, { available: false }]) {
    const f = setup(options);
    f.api.setupTaskbarThumbnail(f.window());
    f.api.destroyTaskbarThumbnail();
    assert.equal(f.calls.length, 0);
  }
});
