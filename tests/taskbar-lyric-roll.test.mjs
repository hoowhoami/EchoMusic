import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import * as vue from 'vue';

// lyricWidth.test.mjs 只覆盖了纯函数的决策规则；这里补上被它漏掉的「管道」：
// 组件的換行钩子是否真的把 rolling 复位、以及复位后窗口是否真的收窄。
// 单删掉 @after-enter="finishRoll" 时，纯函数用例仍会全绿，但窗口会只增不减。

const filename = 'src/renderer/taskbarPlayer/TaskbarPlayerView.vue';
const source = readFileSync(filename, 'utf8');
const { descriptor } = parse(source, { filename });
const compiled = compileScript(descriptor, { id: 'taskbar-roll-test' });
const code = transformSync(compiled.content, { loader: 'ts', format: 'cjs' }).code;

const widthCode = transformSync(
  readFileSync('src/renderer/taskbarPlayer/lyricWidth.ts', 'utf8'),
  { loader: 'ts', format: 'cjs' },
).code;
const widthMod = { exports: {} };
new Function('module', 'exports', widthCode)(widthMod, widthMod.exports);
const { resolveContentWidth, MIN_CONTENT_WIDTH } = widthMod.exports;

/** 编译并执行组件的 setup，返回可观察的宽度状态与已下发的窗口宽度。 */
function harness() {
  const widths = [];
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    console,
    require: (name) => {
      if (name === 'vue')
        return { ...vue, onMounted() {}, onUnmounted() {}, watch: () => () => {} };
      if (name === './lyricWidth') return { resolveContentWidth, MIN_CONTENT_WIDTH };
      if (name === './useTaskbarLyrics')
        return {
          useTaskbarLyrics: () => ({
            snapshot: vue.ref(null),
            playback: vue.ref(null),
            lyric: vue.ref(null),
            line: vue.ref(null),
            nextLine: vue.ref(null),
            timeMs: vue.ref(0),
            error: vue.ref(''),
          }),
        };
      if (name === './useTaskbarSeek')
        return {
          useTaskbarSeek: () => ({
            progressValue: vue.ref(0),
            duration: vue.ref(0),
            isDragging: vue.ref(false),
            handleStart() {},
            handleKeydown() {},
            handleEnd() {},
            handleValueUpdate() {},
            handleCommit() {},
            handleCancel() {},
          }),
        };
      if (name === '../../shared/taskbar')
        return {
          DEFAULT_TASKBAR_LYRIC_SETTINGS: {
            showCover: true,
            showTranslation: false,
            wordByWord: false,
            fontSize: 14,
          },
          normalizeTaskbarLyricSettings: (value) => value,
        };
      if (name === '../../shared/themePalette')
        return {
          neutralThemePalette: () => ({ text: '#000', secondary: '#555', main: '#fff' }),
          DEFAULT_THEME_ACCENT: '#000',
        };
      if (name === '../../shared/accentPalette')
        return { createAccentPaletteFromPrimary: () => ({ primaryText: '#000' }) };
      if (name === '@/icons')
        return {
          iconHeart: {},
          iconHeartFilled: {},
          iconMusic: {},
          iconPause: {},
          iconPlay: {},
          iconSkipBack: {},
          iconSkipForward: {},
        };
      if (name === '@iconify/vue') return { Icon: {} };
      if (name === 'reka-ui')
        return { SliderTrack: {}, SliderRange: {}, SliderThumb: {} };
      if (name === '@/components/ui/SliderRoot.vue') return { default: {} };
      if (name === './TaskbarLyricLine.vue') return { default: {} };
      if (name === '@/theme/sliders.css') return {};
      throw new Error(`Unexpected dependency: ${name}`);
    },
    getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px', columnGap: '0px' }),
    window: {
      electron: {
        taskbarLyric: { setContentWidth: (value) => widths.push(value), showMain() {} },
        nowPlaying: { command() {} },
      },
    },
    setTimeout,
    clearTimeout,
  });
  const state = module.exports.default.setup({}, { expose() {} });
  // 关掉封面，天然宽度就只取决于文本（natural = ceil(text + 8)）。
  state.settings.value.showCover = false;
  state.maxWidth.value = 800;
  state.root.value = { querySelector: () => null };
  return { state, widths };
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

test('长行切短行：动画期间不收窄，after-enter 复位后才收窄', async () => {
  const h = harness();
  h.state.primaryWidth.value = 512;
  await h.state.reportWidth();
  assert.equal(h.state.width.value, 520, '长行按自然宽度显示');
  assert.deepEqual(h.widths, [520]);

  // 新短行已测量，但换行动画刚开始（before-enter → rolling = true）。
  h.state.rolling = true;
  h.state.primaryWidth.value = 212;
  await h.state.reportWidth();
  assert.equal(h.state.width.value, 520, '动画期间保持旧宽度，旧行尾巴不被裁');
  assert.deepEqual(h.widths, [520], '没收窄就不该通知主进程');

  // after-enter → finishRoll：旧行已滑出，此时才收窄。
  h.state.finishRoll();
  await flush();
  assert.equal(h.state.width.value, 220, '动画结束后收窄到新行尺寸');
  assert.deepEqual(h.widths, [520, 220]);
});

test('短行切长行：动画期间照常放行变宽，新行升入时不被裁', async () => {
  const h = harness();
  h.state.primaryWidth.value = 292;
  await h.state.reportWidth();
  h.state.rolling = true;
  h.state.primaryWidth.value = 612;
  await h.state.reportWidth();
  assert.equal(h.state.width.value, 620, '变宽不必等动画结束');
});

test('finishRoll 一定复位 rolling，否则窗口会只增不减', async () => {
  const h = harness();
  h.state.primaryWidth.value = 512;
  await h.state.reportWidth();
  h.state.rolling = true;
  h.state.finishRoll();
  assert.equal(h.state.rolling, false);
  // 复位后再量到更窄的行，必须能收窄（回归：rolling 卡住 → 永久 520）。
  h.state.primaryWidth.value = 212;
  await h.state.reportWidth();
  assert.equal(h.state.width.value, 220);
});

test('换行动画钩子已接线：before-enter 置 rolling、after-enter 收尾', () => {
  const template = descriptor.template.content;
  assert.ok(
    /@before-enter="\s*rolling\s*=\s*true\s*"/.test(template),
    '过渡必须用 before-enter 置 rolling',
  );
  assert.ok(/@after-enter="finishRoll"/.test(template), '过渡必须用 after-enter 收尾');
  const rendered = compileTemplate({
    source: template,
    filename,
    id: 'taskbar-roll-test',
    compilerOptions: { bindingMetadata: compiled.bindings },
  });
  assert.ok(rendered.code.includes('onBeforeEnter') && rendered.code.includes('onAfterEnter'));
});
