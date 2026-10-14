import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { transformSync } from 'esbuild';
import { compileStyle, parse } from '@vue/compiler-sfc';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function bootstrap(window) {
  const values = new Map(),
    classes = new Set();
  const root = {
    dataset: {},
    setAttribute(name, value) {
      this[name] = value;
    },
    style: { setProperty: (k, v) => values.set(k, v) },
    classList: { toggle: (key, on) => (on ? classes.add(key) : classes.delete(key)) },
  };
  runInNewContext(script, {
    window,
    document: { documentElement: root, createElement: () => ({}), head: { appendChild() {} } },
  });
  return { root, values, classes };
}
test('main startup adopts the saved theme and material, other windows stay untouched', () => {
  for (const dark of [false, true]) {
    const state = bootstrap({ echoInitialDark: dark });
    assert.equal(state.root.dataset.echoStarting, undefined);
    assert.equal(state.classes.has('dark'), dark);
  }
  const frost = bootstrap({
    echoInitialDark: true,
    echoWindowBackground: { enabled: true, frosted: true, transparency: 30 },
  });
  assert.equal(frost.classes.has('app-background-frosted'), true);
  assert.equal(frost.classes.has('app-background-transparent'), true);
  const alpha = bootstrap({
    echoInitialDark: false,
    echoWindowBackground: { enabled: true, color: '#334455', transparency: 30 },
  });
  assert.equal(alpha.values.get('--app-background-color'), '#334455');
  assert.equal(alpha.values.get('--app-background-opacity'), '0.7');
  assert.equal(alpha.classes.has('app-background-enabled'), true);
  const pure = bootstrap({
    echoInitialDark: false,
    echoWindowBackground: {
      enabled: true,
      color: '#334455',
      transparency: 30,
      transparentMode: 'pure',
    },
  });
  assert.equal(pure.values.get('--app-background-opacity'), '0');
  assert.deepEqual(bootstrap({}).root.dataset, {});
});

test('Vue notifies the main process after mounting and painting the initial route', async () => {
  const source = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const mountApplication ='));
  for (const routeName of ['loading', 'home', 'error']) {
    const failure = routeName === 'error';
    const calls = [];
    const frames = [];
    let resolve, reject;
    const ready = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    runInNewContext(code, {
      markStartup() {},
      nextTick: (callback) => Promise.resolve().then(callback),
      app: { mount: () => calls.push('mount') },
      requestAnimationFrame: (callback) => frames.push(callback),
      window: { electron: { notifyPageMounted: () => calls.push('notify') } },
      router: { isReady: () => ready, currentRoute: { value: { name: routeName } } },
    });
    assert.deepEqual(calls, []);
    if (failure) reject(new Error('route failed'));
    else resolve();
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(calls, ['mount']);
    frames.shift()();
    assert.deepEqual(calls, ['mount']);
    frames.shift()();
    assert.deepEqual(calls, ['mount', 'notify']);
  }
});

test('initial theme is read once and bracketed by startup marks', () => {
  let reads = 0;
  const events = [];
  bootstrap({
    performance: { mark: (name) => events.push(name) },
    get echoInitialDark() {
      reads++;
      events.push('theme-getter');
      return false;
    },
  });
  assert.equal(reads, 1);
  assert.deepEqual(events, ['echo:html-start', 'theme-getter', 'echo:theme-read']);
});

test('Loading owns its styles and there is no static startup page or app-hiding layer', () => {
  assert.doesNotMatch(
    html,
    /startup-placeholder|startup-splash|data-echo-starting|visibility:\s*hidden/,
  );
  const loading = readFileSync(
    new URL('../src/renderer/views/Loading.vue', import.meta.url),
    'utf8',
  );
  assert.match(loading, /<style scoped>[\s\S]*\.startup-main/);
  const styles = compileStyle({
    source: parse(loading).descriptor.styles[0].content,
    id: 'data-v-test',
    scoped: true,
  });
  assert.match(styles.code, /html\.dark \.startup-mark\s*\{/);
  assert.doesNotMatch(styles.code, /html\.dark\s*\{/);
  assert.doesNotMatch(loading, /finishStartup|updateStartupStatus/);
});

const startupCode = transformSync(
  readFileSync(new URL('../src/main/window/startup.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
function startup() {
  const ipcMain = new EventEmitter();
  const module = { exports: {} };
  runInNewContext(startupCode, { module, require: () => ({ ipcMain }) });
  const win = Object.assign(new EventEmitter(), {
    webContents: { mainFrame: {} },
    isDestroyed: () => false,
  });
  let shows = 0;
  const ready = module.exports.waitForMainWindowStartup(win, () => shows++);
  return {
    win,
    ipcMain,
    ready,
    get shows() {
      return shows;
    },
    mounted(event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }) {
      ipcMain.emit('main-window:page-mounted', event);
    },
  };
}
for (const first of ['native', 'page']) {
  test(`window waits for both signals when ${first} is ready first, and only presents once`, async () => {
    const e = startup();
    if (first === 'native') e.win.emit('ready-to-show');
    else e.mounted();
    assert.equal(e.shows, 0);
    if (first === 'native') e.mounted();
    else e.win.emit('ready-to-show');
    await e.ready;
    assert.equal(e.shows, 1);
    e.mounted();
    e.win.emit('ready-to-show');
    assert.equal(e.shows, 1);
    assert.equal(e.ipcMain.listenerCount('main-window:page-mounted'), 0);
  });
}
test('another window or a subframe cannot reveal the main window', async () => {
  const e = startup();
  e.win.emit('ready-to-show');
  e.mounted({ sender: {}, senderFrame: e.win.webContents.mainFrame });
  e.mounted({ sender: e.win.webContents, senderFrame: {} });
  assert.equal(e.shows, 0);
  e.mounted();
  await e.ready;
  assert.equal(e.shows, 1);
});
test('closing before mount cancels startup and removes all listeners', async () => {
  const e = startup();
  e.win.emit('closed');
  await e.ready;
  e.win.emit('ready-to-show');
  e.mounted();
  assert.equal(e.shows, 0);
  assert.equal(e.ipcMain.listenerCount('main-window:page-mounted'), 0);
  assert.equal(e.win.listenerCount('ready-to-show'), 0);
});

test('clear window corners apply before Vue mounts, without masking system Acrylic', () => {
  const clear = bootstrap({
    echoInitialDark: true,
    echoWindowBackground: { enabled: true, clientCornerRadius: 8 },
  });
  assert.equal(clear.root['data-echo-client-corners'], '');
  assert.equal(clear.values.get('--app-window-frame-radius'), '8px');
  const frost = bootstrap({
    echoInitialDark: true,
    echoWindowBackground: { enabled: true, frosted: true, clientCornerRadius: 0 },
  });
  assert.equal(frost.root['data-echo-client-corners'], undefined);
});
