import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

/**
 * 封面下载请求头回归测试。
 *
 * 背景：任务栏封面预览把封面字节交给 `nativeImage.createFromBuffer()` 解码，
 * 而 Electron 的 nativeImage 在 Windows 上不支持 WebP。酷狗 CDN 按 `Accept`
 * 协商格式，一旦请求头声明了 `image/webp` 就返回 WebP，解码失败后
 * `setTaskbarCover` 只能退回应用图标 —— 所有任务的封面预览都变成 EchoMusic 图标。
 *
 * 这个测试直接驱动 `media-control:update-metadata`，断言真实发出的请求头。
 */
const code = transformSync(
  readFileSync(new URL('../src/main/mediaControls.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;

function setup({ coverBuffer = Buffer.from('cover') } = {}) {
  const handlers = new Map();
  const fetches = [];
  const taskbarCovers = [];
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    on: () => {},
    removeHandler: (channel) => handlers.delete(channel),
    listenerCount: () => 1,
  };
  const nativeControls = {
    initialize: () => {},
    shutdown: () => {},
    updateMetadata: async () => {},
    updatePlayState: () => {},
    updateTimeline: () => {},
    registerEventHandler: () => {},
  };
  const mocks = {
    electron: { ipcMain, app: { getVersion: () => '0.0.0' } },
    'node:module': { createRequire: () => () => nativeControls },
    path: { join: (...parts) => parts.join('/'), default: { join: (...p) => p.join('/') } },
    '../shared/abortError': { isAbortError: () => false },
    './logger': { default: { warn() {}, error() {}, info() {} }, __esModule: true },
    './native/logging': { registerNativeLogHandler: () => {} },
    './taskbarThumbnail': { setTaskbarCover: (value) => taskbarCovers.push(value) },
    './networkPolicy': {
      networkFetch: async (url, init) => {
        fetches.push({ url, headers: init?.headers });
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => coverBuffer.buffer.slice(
            coverBuffer.byteOffset,
            coverBuffer.byteOffset + coverBuffer.byteLength,
          ),
        };
      },
    },
  };
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    exports: module.exports,
    Buffer,
    AbortController,
    setTimeout,
    clearTimeout,
    process: { cwd: () => '/repo', platform: 'win32' },
    require: (id) => {
      assert.ok(id in mocks, `unexpected dependency: ${id}`);
      return mocks[id];
    },
  });
  module.exports.initMediaControls(() => null);
  return { handlers, fetches, taskbarCovers };
}

async function updateMetadata(setupResult, payload = {}) {
  const handler = setupResult.handlers.get('media-control:update-metadata');
  assert.ok(handler, 'media-control:update-metadata was not registered');
  await handler({}, {
    title: '歌名',
    artist: '歌手',
    album: '专辑',
    coverUrl: 'https://imge.kugou.com/stdmusic/400/20250328/abc.jpg',
    durationMs: 200000,
    ...payload,
  });
}

test('the cover request never advertises WebP', async () => {
  // Windows 上 nativeImage 只解 JPEG/PNG；声明 webp 会让 CDN 回 WebP，
  // 任务栏封面预览就只剩应用图标。
  const f = setup();
  await updateMetadata(f);

  assert.equal(f.fetches.length, 1);
  const accept = f.fetches[0].headers.Accept;
  assert.ok(!/webp/i.test(accept), `cover Accept must not offer WebP, got: ${accept}`);
  assert.match(accept, /image\/jpeg/);
  assert.match(accept, /image\/png/);
});

test('the requested cover bytes still reach the taskbar thumbnail', async () => {
  const cover = Buffer.from('album-cover-bytes');
  const f = setup({ coverBuffer: cover });
  await updateMetadata(f);

  assert.equal(f.fetches.length, 1);
  assert.equal(f.taskbarCovers.length, 1);
  assert.deepEqual(f.taskbarCovers[0], cover);
});

test('a cover-less metadata update does not download anything', async () => {
  const f = setup();
  await updateMetadata(f, { coverUrl: '' });
  assert.equal(f.fetches.length, 0);
});
