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
  const api = load('../src/main/thumbar.ts', {
    electron: { ipcMain, nativeImage: { createFromBuffer: (buffer) => buffer } },
    './logger': logger,
  });
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

test('retains three transport buttons and adds exactly one disabled favorite when empty', () => {
  const { api, window } = thumbar();
  const win = window(1);
  api.setupThumbarButtons(win);
  const buttons = win.applied.at(-1);
  assert.deepEqual(
    Array.from(buttons, (b) => b.tooltip),
    ['上一曲', '播放', '下一曲', '收藏'],
  );
  for (const button of buttons) assert.deepEqual(Array.from(button.flags), ['disabled']);
  buttons[3].click();
  assert.equal(win.sent.length, 0);
});

test('snapshot drives play and favorite; commands reuse existing channels, not new playback logic', () => {
  const { api, window } = thumbar();
  const win = window(1);
  api.setupThumbarButtons(win);
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

test('progress-only snapshots do not rebuild native buttons', () => {
  const { api, window } = thumbar();
  const win = window(1);
  api.setupThumbarButtons(win);
  api.updateThumbarPlayback(playback);
  const count = win.applied.length;
  api.updateThumbarPlayback({ ...playback, currentTime: 60 });
  assert.equal(win.applied.length, count);
});

test('recreating main window rebinds show events and rejects stale renderer messages', () => {
  const { api, ipcMain, window } = thumbar();
  const old = window(1),
    next = window(2);
  api.setupThumbarButtons(old);
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
  const states = [],
    cards = [];
  const api = load('../src/main/nowPlaying.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [] } },
    './ipc/registry': {},
    './window': {},
    './storage/settings': {},
    '../shared/nowPlaying': load('../src/shared/nowPlaying.ts', {}),
    '../shared/playback': load('../src/shared/playback.ts', {}),
    './taskbarThumbnail': {
      isCoverPreviewEnabled: () => true,
      setTaskbarCardPlayback: (state) => cards.push(state),
    },
    './taskbarProgress': {},
    './thumbar': { updateThumbarPlayback: (state) => states.push(state) },
  });
  api.syncNowPlayingSnapshot({ playback: { ...playback, currentTime: -8, duration: Infinity } });
  assert.equal(states[0].currentTime, 0);
  assert.equal(states[0].duration, 0);
  assert.equal(cards[0], states[0]);
  api.syncNowPlayingSnapshot({ appearance: { isDark: true } });
  assert.equal(states[1], states[0]);
  api.syncNowPlayingSnapshot({ playback: null });
  assert.equal(states[2], null);
});

test('hover card escapes metadata and clamps non-finite progress', async () => {
  const { buildTaskbarCardSvg, cardProgressPixel } = await import('../src/main/taskbarCard.ts');
  const svg = buildTaskbarCardSvg({ ...playback, title: '<script>&"', artist: "A'B" });
  assert.ok(svg.includes('&lt;script&gt;&amp;&quot;'));
  assert.ok(svg.includes('A&apos;B'));
  assert.equal(cardProgressPixel({ ...playback, currentTime: Infinity }), 0);
  assert.equal(cardProgressPixel({ ...playback, currentTime: -1 }), 0);
  assert.equal(cardProgressPixel({ ...playback, currentTime: 200 }), 495);
});

test('real renderer produces a valid, changing PNG including Chinese metadata without Electron or desktop', async () => {
  const { renderTaskbarCard } = await import('../src/main/taskbarCard.ts');
  const first = await renderTaskbarCard(playback);
  const second = await renderTaskbarCard({ ...playback, title: '另一首歌', currentTime: 80 });
  assert.deepEqual(first.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(first.readUInt32BE(16), 511);
  assert.equal(first.readUInt32BE(20), 85);
  assert.ok(first.length > 1000);
  assert.notDeepEqual(first, second);
});
