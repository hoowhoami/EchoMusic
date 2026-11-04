import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const require = createRequire(import.meta.url);
const load = (file, mocks, extras = {}) => {
  const module = { exports: {} };
  runInNewContext(
    transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
      loader: 'ts',
      format: 'cjs',
    }).code,
    {
      module,
      Buffer,
      process: { platform: 'win32' },
      require: (id) => (id in mocks ? mocks[id] : require(id)),
      ...extras,
    },
  );
  return module.exports;
};
const logger = { default: { info() {}, debug() {}, warn() {} }, __esModule: true };
function thumbar() {
  const ipcMain = new EventEmitter();
  const nativeTheme = new EventEmitter();
  // thumbar 首帧异步读取注册表；测试注入同步回调，随后用 settle() 等待应用按钮。
  const execFile = (_file, _args, _options, callback) =>
    callback(null, { stdout: 'SystemUsesLightTheme REG_DWORD 0x0' }, '');
  const api = load(
    '../src/main/thumbar.ts',
    {
      electron: {
        app: { isPackaged: false },
        ipcMain,
        nativeTheme,
        nativeImage: {
          createFromBuffer: (buffer) => buffer,
          createFromPath: (file) => file,
        },
      },
      child_process: { execFile },
      './logger': logger,
    },
    { __dirname: process.cwd() },
  );
  const window = (id) => {
    const win = new EventEmitter();
    win.dead = false;
    win.applied = [];
    win.sent = [];
    win.isDestroyed = () => win.dead;
    win.webContents = { id, send: (...args) => win.sent.push(args) };
    win.setThumbarButtons = (buttons) => {
      win.applied.push(buttons);
      return true;
    };
    return win;
  };
  return { api, ipcMain, window };
}
const playback = {
  trackId: 'test',
  title: '琵琶曲',
  artist: '郑浩、冰洁',
  isPlaying: true,
  isFavorite: false,
  currentTime: 50,
  duration: 100,
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('retains three transport buttons and adds exactly one disabled favorite when empty', async () => {
  const { api, window } = thumbar();
  const win = window(1);
  api.setupThumbarButtons(win);
  await settle();
  const buttons = win.applied.at(-1);
  assert.deepEqual(
    Array.from(buttons, (b) => b.tooltip),
    ['上一曲', '播放', '下一曲', '收藏'],
  );
  for (const button of buttons) assert.deepEqual(Array.from(button.flags), ['disabled']);
  buttons[3].click();
  assert.equal(win.sent.length, 0);
});

test('snapshot drives play and favorite; commands reuse existing channels, not new playback logic', async () => {
  const { api, window } = thumbar();
  const win = window(1);
  api.setupThumbarButtons(win);
  await settle();
  api.updateThumbarPlayback(playback);
  let buttons = win.applied.at(-1);
  assert.equal(buttons[1].tooltip, '暂停');
  assert.equal(buttons[3].flags.length, 0);
  buttons[0].click();
  buttons[1].click();
  buttons[2].click();
  buttons[3].click();
  assert.deepEqual(
    win.sent.map((s) => JSON.parse(JSON.stringify(s))),
    [
      ['media-control:event', { type: 'PreviousSong' }],
      ['media-control:event', { type: 'Pause' }],
      ['media-control:event', { type: 'NextSong' }],
      ['now-playing:command', 'toggleFavorite'],
    ],
  );
  const outline = buttons[3].icon;
  api.updateThumbarPlayback({ ...playback, isFavorite: true, isPlaying: false });
  buttons = win.applied.at(-1);
  assert.equal(buttons[3].tooltip, '取消收藏');
  assert.equal(buttons[1].tooltip, '播放');
  assert.notDeepEqual(buttons[3].icon, outline);
  api.updateThumbarPlayback(null);
  assert.equal(win.applied.at(-1)[3].tooltip, '收藏');
});

test('progress-only snapshots do not rebuild native buttons', async () => {
  const { api, window } = thumbar();
  const win = window(1);
  api.setupThumbarButtons(win);
  await settle();
  api.updateThumbarPlayback(playback);
  const count = win.applied.length;
  api.updateThumbarPlayback({ ...playback, currentTime: 60 });
  assert.equal(win.applied.length, count);
});

test('recreating main window rebinds show events and rejects stale renderer messages', async () => {
  const { api, ipcMain, window } = thumbar();
  const old = window(1),
    next = window(2);
  api.setupThumbarButtons(old);
  await settle();
  api.updateThumbarPlayback(playback);
  old.dead = true;
  old.emit('closed');
  api.setupThumbarButtons(next);
  api.setupThumbarButtons(next);
  assert.equal(ipcMain.listenerCount('thumbar:update-play-state'), 1);
  assert.equal(next.listenerCount('show'), 1);
  const count = next.applied.length;
  ipcMain.emit('thumbar:update-play-state', { sender: { id: 1 } }, false);
  assert.equal(next.applied.length, count);
  ipcMain.emit('thumbar:update-play-state', { sender: { id: 2 } }, false);
  assert.equal(next.applied.at(-1)[1].tooltip, '播放');
  next.emit('show');
  assert.equal(next.applied.length, count + 2);
});

test('new main snapshot integration sanitizes and forwards state without an extra IPC channel', () => {
  const states = [];
  const api = load('../src/main/nowPlaying.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [] } },
    './ipc/registry': {},
    './window': {},
    './storage/settings': {},
    '../shared/nowPlaying': load('../src/shared/nowPlaying.ts', {}),
    '../shared/playback': load('../src/shared/playback.ts', {}),
    '../shared/opencc': load('../src/shared/opencc.ts', {}),
    './taskbarThumbnail': {
      isCoverPreviewEnabled: () => true,
    },
    './taskbarProgress': {},
    './thumbar': { updateThumbarPlayback: (state) => states.push(state) },
  });
  api.syncNowPlayingSnapshot({ playback: { ...playback, currentTime: -8, duration: Infinity } });
  assert.equal(states[0].currentTime, 0);
  assert.equal(states[0].duration, 0);
  api.syncNowPlayingSnapshot({ appearance: { isDark: true } });
  assert.equal(states[1], states[0]);
  api.syncNowPlayingSnapshot({ playback: null });
  assert.equal(states[2], null);
});

test('taskbar window receives the estimated-timings flag through the lyric snapshot', () => {
  const bar = new EventEmitter();
  const messages = [];
  bar.isDestroyed = () => false;
  bar.isVisible = () => true;
  bar.webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (...args) => messages.push(args),
  });
  const api = load('../src/main/nowPlaying.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [bar] } },
    './ipc/registry': {},
    './window': { getMainWindow: () => null },
    './storage/settings': {},
    '../shared/nowPlaying': load('../src/shared/nowPlaying.ts', {}),
    '../shared/playback': load('../src/shared/playback.ts', {}),
    '../shared/opencc': load('../src/shared/opencc.ts', {}),
    './taskbarThumbnail': { isCoverPreviewEnabled: () => true },
    './taskbarProgress': {},
    './thumbar': { updateThumbarPlayback() {} },
  });
  api.bindVisibleNowPlayingWindow(bar);
  api.syncNowPlayingSnapshot({
    playback,
    lyric: {
      lines: [
        {
          time: 18.9,
          text: '檐下风铃还没睡醒',
          charactersEstimated: true,
          characters: [{ text: '檐下风铃还没睡醒', startTime: 18900, endTime: 21900 }],
        },
        {
          time: 47.38,
          text: '锁着她',
          characters: [
            { text: '锁', startTime: 47380, endTime: 47650 },
            { text: '着', startTime: 47650, endTime: 47970 },
            { text: '她', startTime: 47970, endTime: 50970 },
          ],
        },
      ],
    },
  });

  const lines = messages[0][1].lyric.lines;
  assert.equal(lines[0].charactersEstimated, true, '清洗器不能吞掉估算标记');
  assert.equal(lines[1].charactersEstimated, undefined, '真实逐字行不带该标记');
});

test('hidden taskbar window receives no playback pushes and resumes with the latest paused track', () => {
  const bar = new EventEmitter();
  const messages = [];
  let visible = false;
  bar.isDestroyed = () => false;
  bar.isVisible = () => visible;
  bar.webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (...args) => messages.push(args),
  });
  const api = load('../src/main/nowPlaying.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [bar] } },
    './ipc/registry': {},
    './window': { getMainWindow: () => null },
    './storage/settings': {},
    '../shared/nowPlaying': load('../src/shared/nowPlaying.ts', {}),
    '../shared/playback': load('../src/shared/playback.ts', {}),
    '../shared/opencc': load('../src/shared/opencc.ts', {}),
    './taskbarThumbnail': { isCoverPreviewEnabled: () => true },
    './taskbarProgress': {},
    './thumbar': { updateThumbarPlayback() {} },
  });
  api.bindVisibleNowPlayingWindow(bar);
  api.syncNowPlayingSnapshot({ playback });
  api.syncNowPlayingSnapshot({ playback: { ...playback, trackId: 'next', isPlaying: false } });
  assert.equal(messages.length, 0);
  visible = true;
  bar.emit('show');
  assert.equal(messages.length, 1);
  assert.equal(messages[0][1].playback.trackId, 'next');
  assert.equal(messages[0][1].playback.isPlaying, false);
  api.syncNowPlayingSnapshot({ appearance: { isDark: true } });
  assert.equal(messages.length, 2);
});
test('show full snapshot updates the incremental baseline and reload forces a full snapshot', () => {
  const bar = new EventEmitter();
  const messages = [];
  let visible = true;
  bar.isDestroyed = () => false;
  bar.isVisible = () => visible;
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (...args) => messages.push(args),
  });
  bar.webContents = webContents;
  const api = load('../src/main/nowPlaying.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [bar] } },
    './ipc/registry': {},
    './window': { getMainWindow: () => null },
    './storage/settings': {},
    '../shared/nowPlaying': load('../src/shared/nowPlaying.ts', {}),
    '../shared/playback': load('../src/shared/playback.ts', {}),
    '../shared/opencc': load('../src/shared/opencc.ts', {}),
    './taskbarThumbnail': { isCoverPreviewEnabled: () => true },
    './taskbarProgress': {},
    './thumbar': { updateThumbarPlayback() {} },
  });
  api.bindVisibleNowPlayingWindow(bar);

  api.syncNowPlayingSnapshot({ playback, appearance: { isDark: false } });
  assert.equal(messages.length, 1);

  visible = false;
  api.syncNowPlayingSnapshot({ playback: { ...playback, trackId: 'hidden' } });
  visible = true;
  bar.emit('show');
  assert.equal(messages.length, 2);
  assert.equal(messages.at(-1)[1].playback.trackId, 'hidden');

  // show 补发的全量必须同步基线：仅外观变化时不应重发 playback。
  api.syncNowPlayingSnapshot({ appearance: { isDark: true } });
  assert.equal(messages.length, 3);
  assert.ok(!('playback' in messages.at(-1)[1]));

  // reload 后 preload 的 merged 归零，下一条广播必须是完整快照。
  webContents.emit('did-start-navigation');
  api.syncNowPlayingSnapshot({ playback: { ...playback, trackId: 'after-reload' } });
  assert.equal(messages.length, 4);
  const reloaded = messages.at(-1)[1];
  assert.equal(reloaded.playback.trackId, 'after-reload');
  assert.ok('lyric' in reloaded && 'appearance' in reloaded);
});

test('failed now-playing send does not advance the incremental baseline', () => {
  const bar = new EventEmitter();
  const messages = [];
  let fail = true;
  bar.isDestroyed = () => false;
  bar.isVisible = () => true;
  bar.webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (...args) => {
      if (fail) throw new Error('renderer unavailable');
      messages.push(args);
    },
  });
  const api = load('../src/main/nowPlaying.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [bar] } },
    './ipc/registry': {},
    './window': { getMainWindow: () => null },
    './storage/settings': {},
    '../shared/nowPlaying': load('../src/shared/nowPlaying.ts', {}),
    '../shared/playback': load('../src/shared/playback.ts', {}),
    '../shared/opencc': load('../src/shared/opencc.ts', {}),
    './taskbarThumbnail': { isCoverPreviewEnabled: () => true },
    './taskbarProgress': {},
    './thumbar': { updateThumbarPlayback() {} },
  });
  api.bindVisibleNowPlayingWindow(bar);

  api.syncNowPlayingSnapshot({ playback });
  assert.equal(messages.length, 0);
  fail = false;
  api.syncNowPlayingSnapshot({ playback: { ...playback, currentTime: 51 } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0][1].playback.currentTime, 51);
  assert.ok('lyric' in messages[0][1] && 'appearance' in messages[0][1]);
});

test('main window reload resets the now-playing baseline without visibility binding', () => {
  const main = new EventEmitter();
  const messages = [];
  main.isDestroyed = () => false;
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (...args) => messages.push(args),
  });
  main.webContents = webContents;
  const api = load('../src/main/nowPlaying.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [main] } },
    './ipc/registry': {},
    './window': { getMainWindow: () => main },
    './storage/settings': {},
    '../shared/nowPlaying': load('../src/shared/nowPlaying.ts', {}),
    '../shared/playback': load('../src/shared/playback.ts', {}),
    '../shared/opencc': load('../src/shared/opencc.ts', {}),
    './taskbarThumbnail': { isCoverPreviewEnabled: () => true },
    './taskbarProgress': {},
    './thumbar': { updateThumbarPlayback() {} },
  });
  api.syncNowPlayingSnapshot({ playback, appearance: { isDark: false } });
  assert.equal(messages.length, 1);

  // 主窗口没有 bindVisibleNowPlayingWindow，首次广播后也必须装上导航监听。
  webContents.emit('did-start-navigation');
  api.syncNowPlayingSnapshot({ playback: { ...playback, currentTime: 51 } });
  assert.equal(messages.length, 2);
  const reloaded = messages.at(-1)[1];
  assert.equal(reloaded.playback.currentTime, 51);
  assert.ok('lyric' in reloaded && 'appearance' in reloaded);
});

test('invalidated native window receives no playback pushes or visibility calls before closed', () => {
  let alive = true;
  const messages = [];
  const bar = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isVisible: () => {
      assert.equal(alive, true);
      return true;
    },
    webContents: Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: (...args) => messages.push(args),
    }),
  });
  const api = load('../src/main/nowPlaying.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [bar] } },
    './ipc/registry': {},
    './window': { getMainWindow: () => null },
    './storage/settings': {},
    '../shared/nowPlaying': load('../src/shared/nowPlaying.ts', {}),
    '../shared/playback': load('../src/shared/playback.ts', {}),
    '../shared/opencc': load('../src/shared/opencc.ts', {}),
    './taskbarThumbnail': { isCoverPreviewEnabled: () => true },
    './taskbarProgress': {},
    './thumbar': { updateThumbarPlayback() {} },
  });
  api.bindVisibleNowPlayingWindow(bar, () => alive);
  api.syncNowPlayingSnapshot({ playback });
  assert.equal(messages.length, 1);
  alive = false;
  api.syncNowPlayingSnapshot({ playback: { ...playback, currentTime: 51 } });
  bar.emit('show');
  assert.equal(messages.length, 1);
});
