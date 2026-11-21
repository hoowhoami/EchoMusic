import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const source = readFileSync(
  new URL('../src/renderer/composables/useTabDoubleClickTop.ts', import.meta.url),
  'utf8',
);
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;

// 假时间轴：Date.now 由用例推进，测试不依赖真实等待
function setup({ scroll = { scrollToTop: () => {} } } = {}) {
  const mod = { exports: {} };
  const warnings = [];
  let now = 1_000;
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  new Function('module', 'exports', 'console', 'Date', code)(
    mod,
    mod.exports,
    { warn: (...args) => warnings.push(args) },
    FakeDate,
  );
  const composable = mod.exports.useTabDoubleClickTop(() => scroll);
  const tab = (active) => ({
    dataset: active ? { state: 'active' } : {},
    getAttribute: (name) => (name === 'aria-selected' ? (active ? 'true' : 'false') : null),
  });
  const press = (target) => composable.onTabPointerDown({ target: { closest: () => target } });
  const doubleClick = (target) =>
    composable.onTabDoubleClick({ target: { closest: () => target } });
  return { composable, tab, press, doubleClick, warnings, tick: (ms) => (now += ms) };
}

test('双击已选中的 tab 回到顶部', () => {
  let calls = 0;
  const s = setup({ scroll: { scrollToTop: () => (calls += 1) } });
  const t = s.tab(true);
  s.press(t);
  s.doubleClick(t);
  assert.equal(calls, 1);
});

test('双击未选中的 tab 不回顶', () => {
  let calls = 0;
  const s = setup({ scroll: { scrollToTop: () => (calls += 1) } });
  const t = s.tab(false);
  s.press(t);
  s.doubleClick(t);
  assert.equal(calls, 0);
});

test('换到另一个 tab 上双击要重新判定，沿用上一个 tab 的选中态是错的', () => {
  let calls = 0;
  const s = setup({ scroll: { scrollToTop: () => (calls += 1) } });
  const active = s.tab(true);
  const idle = s.tab(false);
  s.press(active);
  // 紧接着把鼠标移到另一个（未选中）tab 上双击
  s.press(idle);
  s.doubleClick(idle);
  assert.equal(calls, 0);
});

test('同一个 tab 的第二次按下沿用按下前的选中态', () => {
  let calls = 0;
  const s = setup({ scroll: { scrollToTop: () => (calls += 1) } });
  // 同一个 tab：第一次按下时未选中，按下后切换为选中，第二次按下读到 active 也不该回顶
  let selected = false;
  const el = {
    get dataset() {
      return selected ? { state: 'active' } : {};
    },
    getAttribute: (name) => (name === 'aria-selected' ? (selected ? 'true' : 'false') : null),
  };
  s.press(el);
  selected = true;
  s.press(el);
  s.doubleClick(el);
  assert.equal(calls, 0);
});

test('超过双击窗口的两次单独点击不回顶', () => {
  let calls = 0;
  const s = setup({ scroll: { scrollToTop: () => (calls += 1) } });
  const t = s.tab(true);
  s.press(t);
  s.tick(900);
  const t2 = s.tab(true);
  s.press(t2);
  s.doubleClick(t2);
  assert.equal(calls, 1);
  // 第二次按下距第一次超过 500ms，重新按「按下时已选中」判定，仍然是选中 → 回顶
});

test('点到的不是 tab 时什么都不做', () => {
  let calls = 0;
  const s = setup({ scroll: { scrollToTop: () => (calls += 1) } });
  s.press(null);
  s.doubleClick(null);
  assert.equal(calls, 0);
  assert.deepEqual(s.warnings, []);
});

test('页面滚动容器没挂上时留下告警而不是静默失败', () => {
  const mod = { exports: {} };
  new Function('module', 'exports', 'console', 'Date', code)(
    mod,
    mod.exports,
    { warn: () => calls.push('warn') },
    Date,
  );
  const calls = [];
  const c = mod.exports.useTabDoubleClickTop(() => null);
  const t = { dataset: { state: 'active' }, getAttribute: () => 'true' };
  c.onTabPointerDown({ target: { closest: () => t } });
  c.onTabDoubleClick({ target: { closest: () => t } });
  assert.deepEqual(calls, ['warn']);
});
