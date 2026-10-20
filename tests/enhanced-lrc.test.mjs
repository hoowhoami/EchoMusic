import * as embeddedTags from '../src/shared/embeddedMetadata.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as pinia from 'pinia';
import * as offset from '../src/shared/lyricOffset.ts';
import * as opencc from '../src/shared/opencc.ts';
import { hasWordByWordTiming, normalizeLyricLinePayload } from '../src/shared/lyrics.ts';

function compile(file, mocks, window = {}) {
  const module = { exports: {} };
  const { code } = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  });
  new Function('require', 'module', 'exports', 'window', code)(
    (id) => {
      if (!(id in mocks)) throw new Error(`Unexpected dependency: ${id}`);
      return mocks[id];
    },
    module,
    module.exports,
    window,
  );
  return module.exports;
}

const { useLyricStore } = compile('../src/renderer/stores/lyric.ts', {
  pinia,
  '@/api/music': {},
  '@/utils/logger': { info() {}, warn() {}, error() {}, debug() {} },
  '@/utils/color': { DEFAULT_ACCENT: '#0071e3' },
  '@/plugins/lyrics': {},
  '@/services/opencc': { convertLyricLinesForDisplay: async (lines) => lines },
  './theme': {},
  '../../shared/lyricOffset': offset,
  '../../shared/embeddedMetadata': embeddedTags,
  '../../shared/opencc': opencc,
});

const createStore = () => useLyricStore(pinia.createPinia());

const simplifyCharacters = (line) =>
  line.characters.map(({ text, startTime, endTime }) => ({ text, startTime, endTime }));

test('plain LRC without inline timestamps keeps the existing whole-line fallback', () => {
  const lyric = createStore();
  lyric.setLyric('[00:01.00]Hello world', 'plain');

  assert.equal(lyric.lines.length, 1);
  assert.equal(lyric.lines[0].time, 1);
  assert.equal(lyric.lines[0].text, 'Hello world');
  assert.deepEqual(simplifyCharacters(lyric.lines[0]), [
    { text: 'Hello world', startTime: 1000, endTime: 4000 },
  ]);
});

test('enhanced LRC inline timestamps become word-level lyric characters', () => {
  const lyric = createStore();
  lyric.setLyric('[00:47.38]<00:47.38>锁<00:47.65>着<00:47.97>她', 'enhanced');

  assert.equal(lyric.lines.length, 1);
  assert.equal(lyric.lines[0].time, 47.38);
  assert.equal(lyric.lines[0].text, '锁着她');
  assert.deepEqual(simplifyCharacters(lyric.lines[0]), [
    { text: '锁', startTime: 47380, endTime: 47650 },
    { text: '着', startTime: 47650, endTime: 47970 },
    { text: '她', startTime: 47970, endTime: 50970 },
  ]);
});

test('a trailing enhanced LRC timestamp closes the previous segment without adding text', () => {
  const lyric = createStore();
  lyric.setLyric('[00:47.38]<00:47.38>锁<00:47.65>着<00:47.97>', 'closing-tag');

  assert.equal(lyric.lines.length, 1);
  assert.equal(lyric.lines[0].text, '锁着');
  assert.deepEqual(simplifyCharacters(lyric.lines[0]), [
    { text: '锁', startTime: 47380, endTime: 47650 },
    { text: '着', startTime: 47650, endTime: 47970 },
  ]);
});

test('text before the first enhanced LRC timestamp starts at the line timestamp', () => {
  const lyric = createStore();
  lyric.setLyric('[00:10.00]Intro <00:10.50>后半句<00:11.00>', 'prefix');

  assert.equal(lyric.lines.length, 1);
  assert.equal(lyric.lines[0].text, 'Intro 后半句');
  assert.deepEqual(simplifyCharacters(lyric.lines[0]), [
    { text: 'Intro ', startTime: 10000, endTime: 10500 },
    { text: '后半句', startTime: 10500, endTime: 11000 },
  ]);
});

// charactersEstimated 标记「这行没有真实逐字时间戳」。所有歌词表面据此整行直显，
// 不拿估算值做卡拉OK 高亮——那会让高亮进度与真实演唱完全脱节。
test('plain LRC marks its whole-line fallback as estimated', () => {
  const lyric = createStore();
  lyric.setLyric('[00:18.90]檐下风铃还没睡醒', 'estimated-plain');

  assert.equal(lyric.lines[0].charactersEstimated, true);
  assert.equal(hasWordByWordTiming(lyric.lines[0]), false);
});

// 「双行同时间戳」：内嵌标签工具会把译文写成与原词同一时间戳的第二行。
const PAIRED_LRC = [
  '[ti:Song]',
  '[00:53.02]Baby just let me let go',
  '[00:53.02]允许我离开',
  '[00:57.10]You were the shadow',
  '[00:57.10]你是我的影子',
].join('\n');

test('embedded lyrics pair duplicate-timestamp lines into translation', () => {
  const lyric = createStore();
  lyric.useEmbeddedLyric('hash-paired', PAIRED_LRC);

  assert.equal(lyric.lines.length, 2, '两行应合并为两条');
  assert.equal(lyric.lines[0].text, 'Baby just let me let go');
  assert.equal(lyric.lines[0].translated, '允许我离开');
  assert.equal(lyric.lines[1].text, 'You were the shadow');
  assert.equal(lyric.lines[1].translated, '你是我的影子');
  assert.equal(lyric.hasTranslation, true, '翻译开关应可用');
});

test('duplicate-timestamp pairing is off for non-embedded lyrics', () => {
  const lyric = createStore();
  lyric.setLyric(PAIRED_LRC, 'network-paired');

  assert.equal(lyric.lines.length, 4, '非内嵌歌词不配对，两条原词两条译文各自成行');
  assert.equal(lyric.lines[0].text, 'Baby just let me let go');
  assert.equal(lyric.lines[0].translated, undefined);
});

test('a stray duplicate timestamp does not turn into a translation', () => {
  // 普通歌词偶有同时间戳的回声句；零星出现时必须保持原样。
  const lyric = createStore();
  lyric.useEmbeddedLyric(
    'hash-stray',
    ['[00:10.00]啦啦啦啦', '[00:10.00]啦啦啦啦', '[00:20.00]下一句', '[00:30.00]再下一句'].join(
      '\n',
    ),
  );

  assert.equal(lyric.lines.length, 4);
  assert.equal(lyric.lines[0].translated, undefined);
  assert.equal(lyric.hasTranslation, false);
});

test('a single duplicate-timestamp pair among many lines is not the doubled format', () => {
  // 只有一对、其余都是独立行——多半是偶然重复，不该整份按译文配对。
  const lyric = createStore();
  lyric.useEmbeddedLyric(
    'hash-one-pair',
    [
      '[00:10.00]原词',
      '[00:10.00]译文',
      '[00:20.00]另一句',
      '[00:30.00]再一句',
      '[00:40.00]还有一句',
    ].join('\n'),
  );

  assert.equal(lyric.lines.length, 5);
  assert.equal(lyric.lines[0].translated, undefined);
  assert.equal(lyric.hasTranslation, false);
});

test('two pairs alone do not make a mostly-single-line lyric a doubled one', () => {
  // 恰好两对、其余都是独立行：不足以说明整份歌词是这个格式。
  const lyric = createStore();
  lyric.useEmbeddedLyric(
    'hash-two-pairs',
    [
      '[00:10.00]原词一',
      '[00:10.00]译文一',
      '[00:20.00]独立句',
      '[00:25.00]原词二',
      '[00:25.00]译文二',
      '[00:30.00]啦啦啦',
      '[00:30.00]啦啦啦',
      '[00:40.00]另一句',
      '[00:50.00]还有一句',
    ].join('\n'),
  );

  assert.equal(lyric.lines.length, 9);
  assert.equal(lyric.lines[0].translated, undefined);
  assert.equal(lyric.hasTranslation, false);
});

test('repeated identical duplicate timestamps are not mistaken for translations', () => {
  // 两句文本相同，回声而非译文；不能因为「成对」就当成译文。
  const lyric = createStore();
  lyric.useEmbeddedLyric(
    'hash-echo',
    ['[00:10.00]啦啦啦啦', '[00:10.00]啦啦啦啦', '[00:20.00]啦啦啦啦', '[00:20.00]啦啦啦啦'].join(
      '\n',
    ),
  );

  assert.equal(lyric.lines.length, 4);
  assert.equal(lyric.hasTranslation, false);
});

test('a trailing unpaired line still counts as the doubled format', () => {
  const lyric = createStore();
  lyric.useEmbeddedLyric(
    'hash-tail',
    [
      '[00:53.02]Baby just let me let go',
      '[00:53.02]允许我离开',
      '[00:57.10]You were the shadow',
      '[00:57.10]你是我的影子',
      '[01:00.00]Ending',
    ].join('\n'),
  );

  assert.equal(lyric.lines.length, 3);
  assert.equal(lyric.lines[0].translated, '允许我离开');
  assert.equal(lyric.lines[2].text, 'Ending');
  assert.equal(lyric.lines[2].translated, undefined);
});

test('enhanced LRC doubled lines pair as translation without losing word timing', () => {
  const lyric = createStore();
  lyric.useEmbeddedLyric(
    'hash-enhanced',
    [
      '[00:47.38]<00:47.38>Lock<00:47.65>ing<00:47.97>her',
      '[00:47.38]锁着她',
      '[00:51.00]<00:51.00>Autumn<00:51.30>wind',
      '[00:51.00]秋风',
    ].join('\n'),
  );

  assert.equal(lyric.lines.length, 2);
  assert.equal(lyric.lines[0].text, 'Lockingher');
  assert.equal(lyric.lines[0].translated, '锁着她');
  // 原文仍保留真实逐字时间轴，配对不应把它降级为估算。
  assert.equal(hasWordByWordTiming(lyric.lines[0]), true);
  assert.equal(lyric.lines[1].translated, '秋风');
});

test('a four-line file with a single pair is still not the doubled format', () => {
  // 4 行 / 1 对 / 2 独立行：成对比例刚好卡在上限内，但只有一对不足以说明格式。
  const lyric = createStore();
  lyric.useEmbeddedLyric(
    'hash-short-one-pair',
    ['[00:10.00]原词', '[00:10.00]译文', '[00:20.00]独立句', '[00:30.00]另一句'].join('\n'),
  );

  assert.equal(lyric.lines.length, 4);
  assert.equal(lyric.lines[0].translated, undefined);
  assert.equal(lyric.hasTranslation, false);
});

test('interlude markers and untranslated tail lines do not defeat the doubled format', () => {
  // 真实内嵌 LRC 常见形态：开头有间奏标记、结尾有没译文的衬词。
  const lyric = createStore();
  lyric.useEmbeddedLyric(
    'hash-mixed',
    [
      '[00:00.00]纯音乐，请欣赏',
      '[00:53.02]Baby just let me let go',
      '[00:53.02]允许我离开',
      '[00:57.10]You were the shadow',
      '[00:57.10]你是我的影子',
      '[01:01.20]The fire you start once is now',
      '[01:01.20]你是导火线',
      '[01:05.00]Ending',
    ].join('\n'),
  );

  assert.equal(lyric.lines.length, 5, '3 对合并 + 间奏 + 末尾衬词');
  assert.equal(lyric.lines[0].text, '纯音乐，请欣赏');
  assert.equal(lyric.lines[1].text, 'Baby just let me let go');
  assert.equal(lyric.lines[1].translated, '允许我离开');
  assert.equal(lyric.lines[4].text, 'Ending');
});

test('a small timestamp drift between the two lines still counts as a pair', () => {
  // 有些标签工具给译文单独四舍五入，与原词差几十毫秒。
  const lyric = createStore();
  lyric.useEmbeddedLyric(
    'hash-drift',
    [
      '[00:53.02]Baby just let me let go',
      '[00:53.04]允许我离开',
      '[00:57.10]You were the shadow',
      '[00:57.11]你是我的影子',
    ].join('\n'),
  );

  assert.equal(lyric.lines.length, 2);
  assert.equal(lyric.lines[0].translated, '允许我离开');
  assert.equal(lyric.lines[1].translated, '你是我的影子');
});

test('a KRC line between two LRC lines stops the pairing', () => {
  // 现实中不会在同一份歌词里混 KRC 与 LRC；这条钉住的是解析循环里
  // 「遇到 KRC 就清空待配对行」的防御——否则后面的同时间戳 LRC 行会跨格式配上。
  const lyric = createStore();
  lyric.useEmbeddedLyric(
    'hash-mixed-format',
    [
      '[00:10.00]原词一',
      '[10100,2000]<0,500,0>K',
      '[00:10.10]译文一',
      '[00:20.00]原词二',
      '[00:20.00]译文二',
      '[00:30.00]原词三',
      '[00:30.00]译文三',
    ].join('\n'),
  );

  assert.equal(lyric.lines.length, 5, 'KRC 打断了配对，后面仍有两对有效译文');
  assert.equal(lyric.lines[0].text, '原词一');
  assert.equal(lyric.lines[0].translated, undefined, '不得跨 KRC 配上译文');
  assert.equal(lyric.lines[2].text, '译文一');
  assert.equal(lyric.lines[3].translated, '译文二', 'KRC 之后的对仍正常配对');
  assert.equal(lyric.lines[4].translated, '译文三');
});

test('an empty line between the pair stops the following line from being swallowed', () => {
  // 空译文行被跳过时若不清空待配对状态，下一句原词（时间戳相近）会被当成译文吞掉，
  // 整行歌词凭空消失——比不配对严重得多。
  const lyric = createStore();
  lyric.useEmbeddedLyric(
    'hash-empty-translation',
    [
      '[00:10.00]原词A',
      '[00:10.00]',
      '[00:10.10]原词B',
      '[00:20.00]原词C',
      '[00:20.00]译文C',
      '[00:30.00]原词D',
      '[00:30.00]译文D',
    ].join('\n'),
  );

  assert.deepEqual(
    lyric.lines.map((line) => line.text),
    ['原词A', '原词B', '原词C', '原词D'],
    '原词B 必须独立成行，不能被当成原词A的译文',
  );
  assert.equal(lyric.lines[0].translated, undefined);
  assert.equal(lyric.lines[1].translated, undefined);
  assert.equal(lyric.lines[2].translated, '译文C', '空行之后的正常配对不受影响');
  assert.equal(lyric.lines[3].translated, '译文D');
});

test('a lyric whose only pair is broken is not treated as the doubled format', () => {
  // 只有一个真对（空行那处不算），达不到 pairs >= 2 的下限，整份按普通歌词处理。
  // 这条也钉住格式判定与解析循环的一致性：两边若对「空行是否打断相邻性」有分歧，
  // 就会得到「判定认可、实际把原词吞成译文」的结果。
  const lyric = createStore();
  lyric.useEmbeddedLyric(
    'hash-one-broken-pair',
    ['[00:10.00]原词A', '[00:10.00]', '[00:10.10]原词B', '[00:20.00]原词C', '[00:20.00]译文C'].join(
      '\n',
    ),
  );

  assert.deepEqual(
    lyric.lines.map((line) => line.text),
    ['原词A', '原词B', '原词C', '译文C'],
  );
  assert.equal(lyric.hasTranslation, false, '不成格式就不该冒出译文');
});

test('timed empty lines do not hide unpaired lyrics from format detection', () => {
  const lyric = createStore();
  const content = [
    '[00:01.00]First voice',
    '[00:01.10]Second voice',
    '[00:02.00]Third voice',
    '[00:02.10]Fourth voice',
    ...Array.from({ length: 8 }, (_, i) =>
      [`[00:${10 + i}.00]Solo ${i}`, `[00:${10 + i}.50]`].join('\n'),
    ),
  ].join('\n');

  lyric.useEmbeddedLyric('mostly-solo-with-gaps', content);
  assert.equal(lyric.lines.length, 12, 'two coincidental pairs cannot override eight solo lines');
  assert.equal(lyric.hasTranslation, false);
  const preview = lyric.previewEmbeddedLyric(content);
  assert.deepEqual(
    preview.lines.map(({ text }) => text),
    lyric.lines.map(({ text }) => text),
  );
  assert.ok(preview.lines.every((line) => line.translated === undefined));
  assert.equal(preview.hasTranslation, false);
});

for (const separator of ['', '   ', '[ar:Artist]', '[10100,2000]<0,500,0>Interlude']) {
  test(`pair detection does not count across a separator: ${JSON.stringify(separator)}`, () => {
    const lyric = createStore();
    lyric.useEmbeddedLyric(
      'separated-pair',
      [
        '[00:10.00]First',
        separator,
        '[00:10.10]Second',
        '[00:20.00]Third',
        '[00:20.00]Fourth',
      ].join('\n'),
    );
    assert.equal(lyric.hasTranslation, false, 'only one adjacent pair remains');
    assert.equal(lyric.lines.at(-1).text, 'Fourth');
  });
}

test('a blank separator preserves both original lines even in an otherwise paired lyric', () => {
  const lyric = createStore();
  lyric.useEmbeddedLyric(
    'paired-with-blank',
    ['[00:10.00]First voice', '', '[00:10.10]Second voice', PAIRED_LRC].join('\n'),
  );
  assert.deepEqual(
    lyric.lines.map(({ text }) => text),
    ['First voice', 'Second voice', 'Baby just let me let go', 'You were the shadow'],
  );
  assert.equal(lyric.lines[0].translated, undefined);
  assert.equal(lyric.lines[1].translated, undefined);
  assert.equal(lyric.lines[2].translated, '允许我离开');
});

test('a timestamp-only enhanced line is a separator, not lyric text', () => {
  // 只剩行内时间戳的行与空行等价；若被当成正文建行，下一句原词会被吞成译文。
  const lyric = createStore();
  lyric.useEmbeddedLyric(
    'tag-only-line',
    [
      '[00:10.00]原词一',
      '[00:10.00]<00:10.00>',
      '[00:10.10]原词二',
      '[00:20.00]原词三',
      '[00:20.00]译文三',
      '[00:30.00]原词四',
      '[00:30.00]译文四',
    ].join('\n'),
  );

  assert.deepEqual(
    lyric.lines.map(({ text }) => text),
    ['原词一', '原词二', '原词三', '原词四'],
  );
  assert.equal(lyric.lines[0].translated, undefined);
  assert.equal(lyric.lines[1].translated, undefined);
  assert.equal(lyric.lines[2].translated, '译文三');
  assert.equal(lyric.lines[3].translated, '译文四');
  assert.equal(lyric.hasTranslation, true);
});

test('a normal embedded LRC is untouched by the pairing rule', () => {
  const lyric = createStore();
  lyric.useEmbeddedLyric(
    'hash-plain',
    ['[00:18.90]檐下风铃还没睡醒', '[00:22.56]踮起脚尖吹一口气'].join('\n'),
  );

  assert.equal(lyric.lines.length, 2);
  assert.equal(lyric.lines[0].translated, undefined);
  assert.equal(lyric.hasTranslation, false);
});

test('the embedded preview shows the same pairing as playback', () => {
  const lyric = createStore();
  const preview = lyric.previewEmbeddedLyric(PAIRED_LRC);

  assert.equal(preview.lines.length, 2);
  assert.equal(preview.lines[0].translated, '允许我离开');
  assert.equal(preview.hasTranslation, true);
});

test('enhanced LRC keeps real per-character timing and is not marked estimated', () => {
  const lyric = createStore();
  lyric.setLyric('[00:47.38]<00:47.38>锁<00:47.65>着<00:47.97>她', 'estimated-enhanced');

  assert.equal(lyric.lines[0].charactersEstimated, undefined);
  assert.equal(hasWordByWordTiming(lyric.lines[0]), true);
});

test('KRC with per-character tags is real word-by-word data', () => {
  const lyric = createStore();
  lyric.setLyric('[18900,4000]<0,400,0>檐<400,400,0>下<800,400,0>风', 'estimated-krc-real');

  assert.equal(lyric.lines.length, 1);
  assert.equal(lyric.lines[0].charactersEstimated, undefined);
  assert.equal(hasWordByWordTiming(lyric.lines[0]), true);
});

test('KRC without per-character tags marks the evenly spread timeline as estimated', () => {
  const lyric = createStore();
  lyric.setLyric('[18900,4000]檐下风铃还没睡醒', 'estimated-krc-fallback');

  assert.equal(lyric.lines.length, 1);
  assert.equal(lyric.lines[0].characters.length, 8, '仍按字数均分出字符，供主歌词页估算着色');
  assert.equal(lyric.lines[0].charactersEstimated, true);
  assert.equal(hasWordByWordTiming(lyric.lines[0]), false);
});
