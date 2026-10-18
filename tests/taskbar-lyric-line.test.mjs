import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { parse, compileScript } from 'vue/compiler-sfc';
import * as vue from 'vue';
import { hasWordByWordTiming } from '../src/shared/lyrics.ts';

const filename = 'src/renderer/taskbarPlayer/TaskbarLyricLine.vue';
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const code = transformSync(compileScript(descriptor, { id: 'taskbar-line-test' }).content, {
  loader: 'ts',
  format: 'cjs',
}).code;

function harness(anchor, wordByWord = false, lineOverride) {
  let mounted;
  let resized;
  const frames = [];
  const props = vue.reactive({
    text: '很长的歌词末尾必须完整显示',
    line: lineOverride ?? {
      time: 1,
      characters: [
        { text: '很长的歌词', startTime: 1000, endTime: 3000 },
        { text: '末尾必须', startTime: 3000, endTime: 5000 },
        { text: '完整显示', startTime: 5000, endTime: 7000 },
      ],
    },
    timeMs: 1000,
    endTimeMs: 7000,
    anchor,
    wordByWord,
  });
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    require: (name) => {
      if (name === 'vue')
        return {
          ...vue,
          onMounted: (fn) => (mounted = fn),
          onUnmounted() {},
        };
      if (name === '@/composables/useLyricTimeline')
        return { computeLyricCharBackgroundPosition() {} };
      if (name === '../../shared/lyrics') return { hasWordByWordTiming };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    ResizeObserver: class {
      constructor(fn) {
        resized = fn;
      }
      observe() {}
    },
    requestAnimationFrame: (fn) => frames.push(fn),
    document: { fonts: { ready: new Promise(() => {}) } },
  });
  const state = module.exports.default.setup(props, { expose() {}, emit() {} });
  let viewportWidth = 220.375;
  const contentWidth = 439.453125;
  state.viewport.value = { getBoundingClientRect: () => ({ width: viewportWidth }) };
  state.content.value = { getBoundingClientRect: () => ({ width: contentWidth }) };
  mounted();
  return {
    props,
    state,
    left: () => (props.anchor === 'right' ? viewportWidth - contentWidth : 0) + state.offset.value,
    right: () => (props.anchor === 'right' ? 0 : contentWidth - viewportWidth) + state.offset.value,
    resize(width) {
      viewportWidth = width;
      resized();
      frames.splice(0).forEach((fn) => fn());
    },
  };
}

for (const anchor of ['left', 'right']) {
  for (const wordByWord of [false, true]) {
    test(`${anchor}, ${wordByWord ? 'word' : 'plain'}: both ends align without fading visible text`, () => {
      const h = harness(anchor, wordByWord);
      assert.equal(h.left(), 0, 'start shows the first character, including fractional widths');
      assert.equal(h.state.fade.value['--fade-left'], '0px');
      h.props.timeMs = 3500;
      assert.ok(h.left() < 0 && h.right() > 0);
      assert.equal(h.state.fade.value['--fade-left'], '12px');
      assert.equal(h.state.fade.value['--fade-right'], '12px');
      h.props.timeMs = 5500;
      assert.equal(h.right(), 0, 'tail is fully visible before the next line at 7000ms');
      assert.equal(h.state.fade.value['--fade-right'], '0px');
      h.props.timeMs = 1000;
      assert.equal(h.left(), 0, 'seeking back restores the first character');
      assert.equal(h.state.fade.value['--fade-left'], '0px');
    });
  }
}

test('resize and changing anchor preserve the tail; short lyrics retain their alignment', () => {
  const h = harness('left');
  h.props.timeMs = 6999;
  h.resize(185.625);
  assert.equal(h.right(), 0);
  h.props.anchor = 'right';
  assert.equal(h.right(), 0);
  assert.equal(h.state.fade.value['--fade-right'], '0px');
  h.resize(500);
  assert.equal(h.state.overflow.value, 0);
  assert.equal(h.state.offset.value, 0);
  assert.equal(h.right(), 0);
  h.props.anchor = 'left';
  assert.equal(h.left(), 0);
});

test('short plain lines reserve proportional reading time; missing timing stays stationary', () => {
  const h = harness('left');
  h.props.endTimeMs = 1400;
  assert.equal(h.left(), 0);
  h.props.timeMs = 1299;
  assert.ok(h.right() > 0);
  h.props.timeMs = 1300;
  assert.equal(h.right(), 0);
  h.props.endTimeMs = undefined;
  assert.equal(h.left(), 0);
});

// 非逐字歌词（源歌词只有行级时间戳）即便开着逐字开关也要整行直显：估算出来的
// 字符时间轴只会让高亮进度与真实演唱脱节，不如不闪。
test('estimated characters render the line as plain text even with word-by-word on', () => {
  const h = harness('left', true, {
    time: 1,
    charactersEstimated: true,
    characters: [{ text: '很长的歌词末尾必须完整显示', startTime: 1000, endTime: 4000 }],
  });

  assert.equal(h.state.chars.value.length, 0, '不产生逐字着色片段，走整行直显分支');
  // 整行直显时改用阅读尾句的平移节奏：行首不偏移，行尾在切行前完整露出。
  h.props.timeMs = 1000;
  assert.equal(h.left(), 0, '行首不偏移');
  h.props.timeMs = 5500;
  assert.equal(h.right(), 0, '行尾完整可见，而不是停在估算的逐字位置');
});

test('genuine word-by-word characters keep per-character colouring', () => {
  const genuine = harness('left', true);
  assert.equal(genuine.state.chars.value.length, 3);

  const estimated = harness('left', true, {
    time: 1,
    charactersEstimated: true,
    characters: [
      { text: '很长的歌词', startTime: 1000, endTime: 3000 },
      { text: '末尾必须', startTime: 3000, endTime: 5000 },
      { text: '完整显示', startTime: 5000, endTime: 7000 },
    ],
  });
  assert.equal(estimated.state.chars.value.length, 0);
});
