import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const THUMBNAIL = 0x0323;
const LIVE_PREVIEW = 0x0326;

test('album previews do not ship the retired card renderer or its native packages', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.equal(manifest[section]?.['@resvg/resvg-js'], undefined);
  }
  for (const file of ['pnpm-lock.yaml', 'vite.config.mts', 'THIRD_PARTY_NOTICES.md']) {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /@resvg\//);
  }
});

const packedSize = (width, height) => {
  const value = Buffer.alloc(4);
  value.writeUInt32LE(((width << 16) | height) >>> 0);
  return value;
};

function setup({ enabled = true, platform = 'win32', available = true } = {}) {
  const calls = [];
  const timers = new Set();
  const downloads = [];
  const native = Object.fromEntries(
    ['EnableIconic', 'DisableIconic', 'Invalidate', 'SetThumbnail', 'SetLivePreview'].map(
      (name) => [`taskbar${name}`, (...args) => calls.push([name, ...args])],
    ),
  );
  const mocks = {
    './native/platform': { getNativePlatform: () => (available ? native : null) },
    './logger': { default: { warn() {}, info() {} }, __esModule: true },
    './storage/settings': { getMainAppSettings: () => ({ taskbarCoverPreview: enabled }) },
    './networkPolicy': {
      networkFetch: () => new Promise((resolve, reject) => downloads.push({ resolve, reject })),
    },
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
      AbortController,
      process: { platform },
      setTimeout: (fn) => {
        timers.add(fn);
        return fn;
      },
      clearTimeout: (fn) => timers.delete(fn),
      require: (id) => {
        assert.ok(id in mocks, `Unexpected dependency: ${id}`);
        return mocks[id];
      },
    },
  );
  const window = (id = 1) => {
    const hooks = new Map();
    return {
      hooks,
      isDestroyed: () => false,
      getNativeWindowHandle: () => {
        const handle = Buffer.alloc(8);
        handle.writeBigUInt64LE(BigInt(id));
        return handle;
      },
      hookWindowMessage: (message, callback) => hooks.set(message, callback),
      unhookWindowMessage: (message) => hooks.delete(message),
      request: (message, size = Buffer.alloc(0)) => hooks.get(message)?.(Buffer.alloc(0), size),
    };
  };
  return { api: module.exports, calls, timers, downloads, window };
}

test('DWM receives original album bytes at each requested size, not a miniature strip', () => {
  const f = setup();
  const win = f.window();
  const cover = Buffer.from('original album bytes');
  f.api.setupTaskbarThumbnail(win);
  f.api.setTaskbarCover(cover);
  for (const [width, height] of [
    [230, 150],
    [320, 200],
    [150, 230],
    [600, 400],
  ]) {
    win.request(THUMBNAIL, packedSize(width, height));
    assert.deepEqual(f.calls.at(-1), ['SetThumbnail', '1', cover, width, height]);
    assert.equal(f.calls.at(-1)[2], cover);
  }
  win.request(LIVE_PREVIEW);
  assert.deepEqual(f.calls.at(-1), ['SetLivePreview', '1', cover, 600, 600]);
  // Only the fallback download timeout exists; no playback/card render timers.
  assert.equal(f.timers.size, 1);
});

test('missing or partial DWM dimensions use the default bounds', () => {
  const f = setup();
  const win = f.window();
  const cover = Buffer.from('album');
  f.api.setupTaskbarThumbnail(win);
  f.api.setTaskbarCover(cover);
  for (const [input, width, height] of [
    [Buffer.alloc(0), 200, 200],
    [packedSize(0, 150), 200, 150],
    [packedSize(320, 0), 320, 200],
  ]) {
    win.request(THUMBNAIL, input);
    assert.deepEqual(f.calls.at(-1), ['SetThumbnail', '1', cover, width, height]);
  }
});

test('changing albums invalidates once and replaces both previews without a stale card', () => {
  const f = setup();
  const win = f.window();
  const first = Buffer.from('first album');
  const second = Buffer.from('second album');
  f.api.setupTaskbarThumbnail(win);
  f.api.setTaskbarCover(first);
  f.calls.length = 0;
  f.api.setTaskbarCover(first);
  assert.equal(f.calls.length, 0);
  f.api.setTaskbarCover(second);
  assert.deepEqual(f.calls, [['Invalidate', '1']]);
  win.request(THUMBNAIL, packedSize(230, 150));
  assert.equal(f.calls.at(-1)[2], second);
  win.request(LIVE_PREVIEW);
  assert.equal(f.calls.at(-1)[2], second);
  f.api.setTaskbarCover(null);
  f.api.setTaskbarCover(Buffer.alloc(0));
  win.request(THUMBNAIL);
  assert.equal(f.calls.at(-1)[2], second, 'retain cover while the next download is pending');
});

test('cover-preview toggle restores live-window mode and re-enables the latest album', () => {
  const f = setup({ enabled: false });
  const win = f.window();
  const cover = Buffer.from('album');
  f.api.setupTaskbarThumbnail(win);
  f.api.setTaskbarCover(cover);
  win.request(THUMBNAIL);
  assert.equal(f.calls.length, 0);
  f.api.setCoverPreviewEnabled(true);
  assert.equal(f.api.isCoverPreviewEnabled(), true);
  assert.deepEqual(f.calls, [
    ['EnableIconic', '1'],
    ['Invalidate', '1'],
  ]);
  f.api.setCoverPreviewEnabled(false);
  assert.equal(f.api.isCoverPreviewEnabled(), false);
  assert.deepEqual(f.calls.slice(-2), [
    ['DisableIconic', '1'],
    ['Invalidate', '1'],
  ]);
  const count = f.calls.length;
  win.request(THUMBNAIL);
  win.request(LIVE_PREVIEW);
  assert.equal(f.calls.length, count);
  const next = Buffer.from('next album');
  f.api.setTaskbarCover(next);
  f.api.setCoverPreviewEnabled(true);
  win.request(THUMBNAIL);
  assert.equal(f.calls.at(-1)[2], next);
});

test('fallback is used before any album and never replaces an available album', async () => {
  for (const hasAlbum of [false, true]) {
    const f = setup();
    const win = f.window();
    const fallback = Buffer.from('fallback');
    const album = Buffer.from('album');
    f.api.setupTaskbarThumbnail(win);
    if (hasAlbum) f.api.setTaskbarCover(album);
    f.downloads[0].resolve({ ok: true, arrayBuffer: async () => fallback });
    await new Promise(setImmediate);
    win.request(THUMBNAIL);
    assert.deepEqual(f.calls.at(-1)[2], hasAlbum ? album : fallback);
    assert.equal(f.timers.size, 0);
  }
});

test('failed fallback download keeps normal preview until a real album arrives', async () => {
  const f = setup();
  const win = f.window();
  f.api.setupTaskbarThumbnail(win);
  f.downloads[0].reject(new Error('offline'));
  await new Promise(setImmediate);
  win.request(THUMBNAIL);
  assert.equal(f.calls.length, 0);
  const album = Buffer.from('album');
  f.api.setTaskbarCover(album);
  win.request(THUMBNAIL);
  assert.equal(f.calls.at(-1)[2], album);
});

test('destroy unhooks DWM and a recreated window gets its own album and handle', () => {
  const f = setup();
  const old = f.window(1);
  f.api.setupTaskbarThumbnail(old);
  f.api.setTaskbarCover(Buffer.from('old album'));
  f.api.destroyTaskbarThumbnail();
  assert.equal(old.hooks.size, 0);
  assert.deepEqual(f.calls.slice(-2), [
    ['DisableIconic', '1'],
    ['Invalidate', '1'],
  ]);
  const next = f.window(2);
  f.api.setupTaskbarThumbnail(next);
  const album = Buffer.from('new album');
  f.api.setTaskbarCover(album);
  next.request(THUMBNAIL);
  assert.deepEqual(f.calls.at(-1), ['SetThumbnail', '2', album, 200, 200]);
});

test('unsupported platforms or missing native addon leave previews untouched', () => {
  for (const options of [{ platform: 'linux' }, { platform: 'darwin' }, { available: false }]) {
    const f = setup(options);
    const win = f.window();
    f.api.setupTaskbarThumbnail(win);
    f.api.setTaskbarCover(Buffer.from('album'));
    f.api.destroyTaskbarThumbnail();
    assert.equal(win.hooks.size, 0);
    assert.equal(f.calls.length, 0);
  }
});
