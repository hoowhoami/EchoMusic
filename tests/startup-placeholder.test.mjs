import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
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
    assert.equal(state.root.dataset.echoStarting, '');
    assert.equal(state.classes.has('dark'), dark);
    assert.ok(state.values.get('--startup-bg').includes(dark ? '#26262a' : '#f5f5f7'));
  }
  const frost = bootstrap({
    echoInitialDark: true,
    echoWindowBackground: { enabled: true, frosted: true, transparency: 30 },
  });
  assert.equal(frost.values.get('--startup-bg'), 'transparent');
  const alpha = bootstrap({
    echoInitialDark: false,
    echoWindowBackground: { enabled: true, color: '#334455', transparency: 30 },
  });
  assert.equal(alpha.values.get('--startup-bg'), 'color-mix(in srgb, #334455 70%, transparent)');
  assert.deepEqual(bootstrap({}).root.dataset, {});
});

test('Vue hands the splash off to the mounted Loading, home or error route', async () => {
  const source = readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const mountApplication ='));
  for (const routeName of ['loading', 'home', 'error']) {
    const failure = routeName === 'error';
    const calls = [];
    let resolve, reject;
    const ready = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    runInNewContext(code, {
      markStartup() {},
      finishStartup: () => calls.push('remove'),
      nextTick: (callback) => Promise.resolve().then(callback),
      app: { mount: () => calls.push('mount') },
      document: { documentElement: { removeAttribute: () => calls.push('remove') } },
      router: { isReady: () => ready, currentRoute: { value: { name: routeName } } },
    });
    assert.deepEqual(calls, []);
    if (failure) reject(new Error('route failed'));
    else resolve();
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(calls, ['mount', 'remove']);
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

test('startup screen is outside the Vue mount target and its styles are inline', () => {
  assert.match(html, /<div id="app"><\/div>\s*<div id="startup-placeholder"/);
  assert.match(html, /<style>[\s\S]*\.startup-main/);
  assert.doesNotMatch(html, /<link[^>]+startup\.css/);
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
