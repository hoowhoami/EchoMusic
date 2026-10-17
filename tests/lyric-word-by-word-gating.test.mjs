import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { hasWordByWordTiming, normalizeLyricLinePayload } from '../src/shared/lyrics.ts';

/**
 * 非逐字歌词（源歌词只有行级时间戳）的整行直显行为。
 *
 * 解析层会为这类歌词凑出 characters：纯 LRC 拿整行当一个字固定 3 秒，KRC 缺逐字标签
 * 则按字数均分。那些时间轴是猜的，拿来做卡拉OK 高亮只会让着色进度与真实演唱脱节，
 * 所以所有歌词表面（任务栏歌词 / mini 歌词 / 主歌词页 / 桌面歌词）都改为整行直显。
 * 判定收敛到 hasWordByWordTiming，避免各处各写一套而逐渐跑偏。
 *
 * 标记必须穿过四处逐字段重建行对象的边界（store 末尾的 map、
 * normalizeLyricLinePayload、主进程 sanitizeLyricLine、桌面歌词 normalizeLinePayload），
 * 漏掉任何一处都会静默退回估算着色。
 */

const estimatedLine = {
  time: 18.9,
  text: '檐下风铃还没睡醒',
  charactersEstimated: true,
  characters: [{ text: '檐下风铃还没睡醒', startTime: 18900, endTime: 21900 }],
};

const genuineLine = {
  time: 47.38,
  text: '锁着她',
  characters: [
    { text: '锁', startTime: 47380, endTime: 47650 },
    { text: '着', startTime: 47650, endTime: 47970 },
    { text: '她', startTime: 47970, endTime: 50970 },
  ],
};

test('hasWordByWordTiming rejects estimated timelines regardless of how real-looking they are', () => {
  assert.equal(hasWordByWordTiming(estimatedLine), false);
  assert.equal(hasWordByWordTiming(genuineLine), true);
});

test('hasWordByWordTiming rejects placeholder and empty character lists', () => {
  // 主进程清洗器在缺 characters 时会补一个 endTime 为 0 的占位字符，不是逐字数据。
  assert.equal(
    hasWordByWordTiming({ characters: [{ text: 'x', startTime: 1000, endTime: 0 }] }),
    false,
  );
  assert.equal(hasWordByWordTiming({ characters: [] }), false);
  assert.equal(hasWordByWordTiming(null), false);
  assert.equal(hasWordByWordTiming(undefined), false);
});

test('the estimated flag survives the shared payload normalizer', () => {
  assert.equal(normalizeLyricLinePayload(estimatedLine).charactersEstimated, true);
  assert.equal(normalizeLyricLinePayload(genuineLine).charactersEstimated, undefined);
  // 字段为 false 时不写入，避免给真实逐字行挂上一个无意义的标记。
  assert.equal('charactersEstimated' in normalizeLyricLinePayload(genuineLine), false);
});

// mini 面板的 hasWordTiming 决定走逐字着色分支还是整行直显分支。这里按现有测试的做法
// 从 SFC 源码切出该函数并注入真实实现，验证它确实按共享判定取舍。
const panel = readFileSync(
  new URL('../src/renderer/miniPlayer/MiniLyricPanel.vue', import.meta.url),
  'utf8',
);
const wordTimingCode = transformSync(
  panel.slice(panel.indexOf('const hasWordTiming ='), panel.indexOf('const canShowRubyToggle')),
  { loader: 'ts' },
).code;
const hasWordTiming = new Function(
  'hasWordByWordTiming',
  `${wordTimingCode};return hasWordTiming;`,
)(hasWordByWordTiming);

test('mini lyric falls back to plain line display for estimated lyrics', () => {
  assert.equal(hasWordTiming(estimatedLine), false, '走整行直显分支');
  assert.equal(hasWordTiming(genuineLine), true, '走逐字着色分支');
});

test('the mini panel slice was actually located, not silently empty', () => {
  assert.ok(
    wordTimingCode.includes('hasWordTiming'),
    '未能从 SFC 中切出 hasWordTiming，测试可能已失效',
  );
  assert.ok(
    wordTimingCode.includes('hasWordByWordTiming'),
    'hasWordTiming 未使用共享判定，说明实现与测试脱节',
  );
});

// 卡拉OK 渐变只在挂了 mini-lyric-karaoke 的行上生效，而该类把文字设为
// color: transparent，颜色完全来自渐变。渐变的 background-position-x 默认 100%
// 即未播放色——不给估算行挂这个类，它的文字就会永远停在暗色，看着像非活跃行。
test('every mini karaoke class binding is gated on real word-by-word timing', () => {
  const bindings = [...panel.matchAll(/'mini-lyric-karaoke':\s*([^}]+?)\s*\}/g)].map((match) =>
    match[1].trim(),
  );
  assert.ok(bindings.length >= 2, `预期至少两处绑定，实际找到 ${bindings.length} 处`);
  for (const condition of bindings) {
    assert.ok(
      condition.includes('hasWordTiming(entry.line)'),
      `卡拉OK 类绑定未按逐字数据设限：${condition}`,
    );
  }
});

// applyActiveLineKaraoke 决定要不要给注音/翻译文字写 background-position-x。
// 估算行必须一个都不写：CSS 默认 background-position-x:100% 即未播放态，
// 写了反而会让整行直显的歌词出现半句着色的观感。
const karaokeCode = transformSync(
  panel.slice(panel.indexOf('const applyActiveLineKaraoke ='), panel.indexOf('watch(')),
  { loader: 'ts' },
).code;

const runKaraoke = (line) => {
  const written = [];
  const makeEl = (selector) => ({
    selector,
    style: {
      set backgroundPositionX(value) {
        written.push([selector, value]);
      },
    },
  });
  const root = {
    querySelectorAll: (selector) => [makeEl(selector)],
  };
  new Function(
    'activeLyricIndex',
    'lyricLines',
    'lineElementRefs',
    'props',
    'hasWordByWordTiming',
    'computeLyricCharBackgroundPosition',
    `${karaokeCode};return applyActiveLineKaraoke;`,
  )(
    { value: 0 },
    { value: [line] },
    new Map([[0, root]]),
    { visible: true, timelineMs: 19000 },
    hasWordByWordTiming,
    // 只关心「写了没有」，渐变位置的具体数值由 useLyricTimeline 的用例覆盖。
    () => '0%',
  )();
  return written;
};

test('mini karaoke leaves estimated lines entirely unfilled', () => {
  assert.deepEqual(runKaraoke(estimatedLine), [], '估算行不应写入任何着色位置');
  assert.ok(
    runKaraoke(genuineLine).length > 0,
    '真实逐字行仍需着色，否则这条守卫会把真正的逐字效果一起关掉',
  );
});

test('the karaoke slice was actually located, not silently empty', () => {
  assert.ok(
    karaokeCode.includes('applyActiveLineKaraoke'),
    '未能从 SFC 中切出 applyActiveLineKaraoke，测试可能已失效',
  );
});

// 主歌词页与桌面歌词各自维护一个 isYrcLine，模板里多处引用。切成函数体并注入
// 真实判定，确认两处也认这个标记——否则用户在这两个界面上仍会看到估算高亮。
const readSource = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
const sliceAs = (file, startMarker, endMarker, names, deps = {}) => {
  const source = readSource(file);
  const from = source.indexOf(startMarker);
  const to = source.indexOf(endMarker);
  // 标记没命中时 indexOf 返回 -1，切片会静默变成空串或整份文件，
  // 让下面的断言变成永真或报出与被测行为无关的语法错。
  assert.ok(from >= 0, `${file} 中找不到起始标记：${startMarker}`);
  assert.ok(to > from, `${file} 中找不到结束标记 ${endMarker}（或它排在起始标记之前）`);
  const code = transformSync(source.slice(from, to), { loader: 'ts' }).code;
  const keys = ['hasWordByWordTiming', ...Object.keys(deps)];
  return new Function(...keys, `${code};return { ${names.join(', ')} };`)(
    hasWordByWordTiming,
    ...Object.values(deps),
  );
};

const SCROLLER = '../src/renderer/views/lyric/LyricScroller.vue';
const scrollerIsYrcLine = sliceAs(SCROLLER, 'const isYrcLine =', 'const rubyFontSize', [
  'isYrcLine',
]).isYrcLine;
// isRubyLine 引用了 isYrcLine，且与它之间隔着用 computed 的 rubyFontSize，故分两段切。
const scrollerIsRubyLine = sliceAs(
  SCROLLER,
  'const isRubyLine =',
  'const handleLineClick',
  ['isRubyLine'],
  {
    isYrcLine: scrollerIsYrcLine,
    lyricStore: { showRomanization: true, showRomanizationAsRuby: true },
  },
).isRubyLine;

const { isYrcLine: desktopIsYrcLine, isRubyLine: desktopIsRubyLine } = sliceAs(
  '../src/renderer/desktopLyric/DesktopLyricView.vue',
  'const isYrcLine =',
  'const lineRefs = new Map',
  ['isYrcLine', 'isRubyLine'],
  {
    isVerticalLayout: { value: false },
    lyricsMode: { value: 'both' },
    settings: { value: { showRomanizationAsRuby: true } },
  },
);

test('the main lyric page also falls back to plain display for estimated lyrics', () => {
  assert.equal(scrollerIsYrcLine(estimatedLine), false);
  assert.equal(scrollerIsYrcLine(genuineLine), true);
});

test('the desktop lyric also falls back to plain display for estimated lyrics', () => {
  assert.equal(desktopIsYrcLine(estimatedLine), false);
  assert.equal(desktopIsYrcLine(genuineLine), true);
});

// 注音把音译标在每个字正上方，前提是该行真有逐字时间戳。估算行走注音分支时，
// 主歌词页会无条件套上双色渐变（.lyric-yrc-char 的 color: transparent 是无条件的，
// 颜色只能来自渐变），而填充位置又已被 isYrcLine 拦住不再更新——结果整行停在
// 未播放色，看着像非活跃行。关掉注音布局后音译降级为普通副行，内容不丢。
const miniIsRubyLine = sliceAs(
  '../src/renderer/miniPlayer/MiniLyricPanel.vue',
  'const isRubyLine =',
  'const hasWordTiming =',
  ['isRubyLine'],
  {
    props: { lyric: { wantRomanization: true, showRomanizationAsRuby: true } },
    hasWordTiming,
  },
).isRubyLine;

test('estimated lines never take the ruby-annotation branch on any surface', () => {
  const withRuby = (line) => ({
    ...line,
    rubyUnits: [{ text: 'yan', ruby: 'yan', startTime: 0, endTime: 1, charStart: 0, chars: [] }],
  });
  assert.equal(scrollerIsRubyLine(withRuby(genuineLine)), true, '真实逐字行仍可使用注音');
  assert.equal(scrollerIsRubyLine(withRuby(estimatedLine)), false, '估算行不得进入注音分支');
  assert.equal(desktopIsRubyLine(withRuby(genuineLine)), true);
  assert.equal(desktopIsRubyLine(withRuby(estimatedLine)), false);
  assert.equal(miniIsRubyLine(withRuby(genuineLine)), true);
  assert.equal(miniIsRubyLine(withRuby(estimatedLine)), false);
});

test('a single-character genuine line still counts as word-by-word', () => {
  // 主歌词页原先用 characters.length > 1 判定，单字逐字行会被当成普通行。
  // 统一到 hasWordByWordTiming 后按「有无真实时间戳」判断，单字行不再被漏掉。
  const singleChar = {
    time: 1,
    text: '嗯',
    characters: [{ text: '嗯', startTime: 1000, endTime: 1500 }],
  };
  assert.equal(scrollerIsYrcLine(singleChar), true);
  assert.equal(desktopIsYrcLine(singleChar), true);
});

// 桌面歌词的副歌词（翻译/音译）由 makeSecondary 单独造行。它沿用主行的
// charactersEstimated：主行若是估算行，副行的时间跨度也是按猜测均分的，逐字填充
// 同样没有意义；主行有真实逐字数据时，副行仍按原有行为填充。
const desktopViewSource = readSource('../src/renderer/desktopLyric/DesktopLyricView.vue');
const makeSecondaryFactory = new Function(
  'current',
  'idx',
  'safeEnd',
  'renderScopeKey',
  `${
    transformSync(
      desktopViewSource.slice(
        desktopViewSource.indexOf('const makeSecondary ='),
        desktopViewSource.indexOf('const result: RenderLine[] ='),
      ),
      { loader: 'ts' },
    ).code
  };return makeSecondary;`,
);

// makeSecondary 依赖外层的 current/idx/safeEnd/renderScopeKey，这里把它们作为闭包注入。
const secondaryOf = (primary, chars) => {
  const makeSecondary = makeSecondaryFactory(
    primary,
    0,
    primary.characters[primary.characters.length - 1]?.endTime ?? 0,
    { value: 'scope' },
  );
  return makeSecondary('secondary-key', '译文', chars).line;
};

test('desktop secondary lines follow the primary line timing quality', () => {
  // 走 karaoke 分支（传入副行字符），这正是原先会显示估算填充的路径。
  const estimatedChars = [
    { text: '允', startTime: 18900, endTime: 19900 },
    { text: '许', startTime: 19900, endTime: 20900 },
  ];
  const estimatedSecondary = secondaryOf(estimatedLine, estimatedChars);
  assert.equal(estimatedSecondary.charactersEstimated, true, '估算行的译文副行不应逐字填充');
  assert.equal(hasWordByWordTiming(estimatedSecondary), false);

  const genuineChars = [
    { text: '锁', startTime: 47380, endTime: 47650 },
    { text: '着', startTime: 47650, endTime: 47970 },
  ];
  const genuineSecondary = secondaryOf(genuineLine, genuineChars);
  assert.equal(genuineSecondary.charactersEstimated, undefined);
  assert.equal(hasWordByWordTiming(genuineSecondary), true, '真实逐字行的译文副行仍应填充');
});

// 桌面歌词的 sync.ts 有自己的 normalizeLinePayload，是第四道逐字段重建的边界。
// 漏掉标记会让桌面歌词独自继续显示估算高亮。
const desktopSyncSource = readFileSync(
  new URL('../src/renderer/desktopLyric/sync.ts', import.meta.url),
  'utf8',
);
const normalizeLinePayload = new Function(
  `${
    transformSync(
      desktopSyncSource.slice(
        desktopSyncSource.indexOf('const normalizeLinePayload ='),
        desktopSyncSource.indexOf('const buildPlaybackPayload'),
      ),
      { loader: 'ts' },
    ).code
  };return normalizeLinePayload;`,
)();

test('the desktop lyric snapshot keeps the estimated flag', () => {
  const estimatedPayload = normalizeLinePayload({
    ...estimatedLine,
    characters: estimatedLine.characters.map((char) => ({ ...char })),
  });
  assert.equal(estimatedPayload.charactersEstimated, true, '桌面歌词的清洗器不能吞掉估算标记');
  assert.equal(hasWordByWordTiming(estimatedPayload), false);

  const genuinePayload = normalizeLinePayload(genuineLine);
  assert.equal(genuinePayload.charactersEstimated, undefined);
  assert.equal(hasWordByWordTiming(genuinePayload), true);
});
