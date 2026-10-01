import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as pinia from 'pinia';
import * as opencc from '../src/shared/opencc.ts';
import * as offset from '../src/shared/lyricOffset.ts';
import * as lyrics from '../src/shared/lyrics.ts';
import * as nowPlaying from '../src/shared/nowPlaying.ts';
import * as desktopLyric from '../src/shared/desktopLyric.ts';
import * as lruMap from '../src/renderer/utils/lruMap.ts';

function compile(file, dependencies, window = {}) {
  const module = { exports: {} };
  const { code } = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  });
  new Function('require', 'module', 'exports', 'window', code)(
    (id) => {
      if (!(id in dependencies)) throw new Error(`Unexpected dependency: ${id}`);
      return dependencies[id];
    },
    module,
    module.exports,
    window,
  );
  return module.exports;
}

const conversion = compile('../src/shared/lyricTextConversion.ts', { './opencc': opencc });
const line = (text) => ({ time: 0, text, characters: [] });
const traditional = (texts) =>
  texts.map(
    (text) =>
      new Map([
        ['头发', '頭髮'],
        ['干燥', '乾燥'],
        ['后来', '後來'],
      ]).get(text) ?? text,
  );

function setup(convertBatch) {
  const warnings = [];
  const window = { electron: { opencc: convertBatch ? { convertBatch } : undefined } };
  const service = compile(
    '../src/renderer/services/opencc.ts',
    {
      vue,
      '../../shared/opencc': opencc,
      '../../shared/lyricTextConversion': conversion,
      '@/utils/logger': { __esModule: true, default: { warn: (...args) => warnings.push(args) } },
    },
    window,
  );
  return { ...service, window, warnings };
}

test('original mode preserves source identity and never invokes the bridge', async () => {
  const service = setup(() => {
    throw new Error('should not run');
  });
  const source = [line('头发')];
  assert.strictEqual(
    await service.convertLyricLinesForDisplay(vue.reactive(source), 'none'),
    source,
  );
});

test('non-Han lyrics avoid native initialization in every conversion mode', async () => {
  const service = setup(() => {
    throw new Error('should not run');
  });
  const source = [line('Hello 🎵 かな 한글')];
  for (const mode of opencc.LYRIC_TEXT_CONVERSION_MODES) {
    assert.strictEqual(await service.convertLyricLinesForDisplay(source, mode), source);
  }
});

test('mode results reuse a plain source snapshot and do not duplicate conversion', async () => {
  let calls = 0;
  const service = setup(async (texts) => {
    calls++;
    return traditional(texts);
  });
  const source = [line('头发')];
  const first = await service.convertLyricLinesForDisplay(vue.reactive(source), 'traditional');
  assert.equal(first[0].text, '頭髮');
  assert.equal(source[0].text, '头发');
  assert.strictEqual(await service.convertLyricLinesForDisplay(source, 'traditional'), first);
  assert.equal(calls, 1);
});

test('transient failures and absent bridges remain retryable for the same source', async () => {
  let calls = 0;
  const service = setup(async (texts) => {
    if (++calls === 1) throw new Error('temporary failure');
    return traditional(texts);
  });
  const source = [line('头发')];
  assert.strictEqual(await service.convertLyricLinesForDisplay(source, 'traditional'), source);
  assert.equal((await service.convertLyricLinesForDisplay(source, 'traditional'))[0].text, '頭髮');
  assert.equal(calls, 2);

  const absent = setup();
  assert.strictEqual(await absent.convertLyricLinesForDisplay(source, 'traditional'), source);
  absent.window.electron.opencc = { convertBatch: async (texts) => traditional(texts) };
  assert.equal((await absent.convertLyricLinesForDisplay(source, 'traditional'))[0].text, '頭髮');
});

test('malformed and length-changing bridge results are not cached', async () => {
  for (const invalid of [[], [123], ['頭髮多'], undefined]) {
    let calls = 0;
    const service = setup(async (texts) => (++calls === 1 ? invalid : traditional(texts)));
    const source = [line('头发')];
    assert.strictEqual(await service.convertLyricLinesForDisplay(source, 'traditional'), source);
    assert.equal(
      (await service.convertLyricLinesForDisplay(source, 'traditional'))[0].text,
      '頭髮',
    );
    assert.equal(calls, 2);
  }
});

test('overlapping concurrent batches share each text while profiles remain isolated', async () => {
  const batches = [];
  const service = setup(
    (texts, profile) =>
      new Promise((resolve) => {
        batches.push({ texts, profile, resolve });
      }),
  );
  const a = service.convertLyricLinesForDisplay([line('头发'), line('干燥')], 'traditional');
  const b = service.convertLyricLinesForDisplay([line('头发'), line('后来')], 'traditional');
  const c = service.convertLyricLinesForDisplay([line('头发')], 'traditional-hk');
  assert.deepEqual(
    batches.map(({ texts, profile }) => [profile, texts]),
    [
      ['s2t', ['头发', '干燥']],
      ['s2t', ['后来']],
      ['s2hk', ['头发']],
    ],
  );
  batches.toReversed().forEach(({ texts, resolve }) => resolve(traditional(texts)));
  assert.deepEqual(
    (await a).map((l) => l.text),
    ['頭髮', '乾燥'],
  );
  assert.deepEqual(
    (await b).map((l) => l.text),
    ['頭髮', '後來'],
  );
  assert.equal((await c)[0].text, '頭髮');
});

test('entry budget evicts old text but keeps recently accessed entries', async () => {
  const batches = [];
  const service = setup(async (texts) => {
    batches.push(texts);
    return texts;
  });
  await service.convertLyricLinesForDisplay(
    Array.from({ length: 4096 }, (_, i) => line(`汉${i}`)),
    'traditional',
  );
  await service.convertLyricLinesForDisplay([line('汉0')], 'traditional');
  await service.convertLyricLinesForDisplay([line('汉4096')], 'traditional');
  await service.convertLyricLinesForDisplay([line('汉0')], 'traditional');
  await service.convertLyricLinesForDisplay([line('汉1')], 'traditional');
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.at(-1), ['汉1']);
});

test('byte budget evicts large texts before the entry count limit is reached', async () => {
  const batches = [];
  const service = setup(async (texts) => {
    batches.push(texts);
    return texts;
  });
  const texts = Array.from({ length: 30 }, (_, i) => `${'汉'.repeat(20000)}${i}`);
  await service.convertLyricLinesForDisplay(texts.map(line), 'traditional');
  await service.convertLyricLinesForDisplay([line(texts.at(-1))], 'traditional');
  await service.convertLyricLinesForDisplay([line(texts[0])], 'traditional');
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.at(-1), [texts[0]]);
});

const settle = async () => {
  await new Promise(setImmediate);
  await vue.nextTick();
};
function store(service) {
  const { useLyricStore } = compile('../src/renderer/stores/lyric.ts', {
    pinia,
    '@/api/music': {},
    '@/utils/logger': {},
    '@/utils/color': { DEFAULT_ACCENT: '#0071e3' },
    '@/plugins/lyrics': {},
    '@/services/opencc': service,
    './theme': {},
    '../../shared/lyricOffset': offset,
    '../../shared/opencc': opencc,
  });
  return useLyricStore(pinia.createPinia());
}

test('store publishes original mode once, and waits for conversion instead of flashing raw lyrics', async () => {
  for (const mode of ['none', 'traditional']) {
    let complete;
    const service = setup(
      (texts) =>
        new Promise((resolve) => {
          complete = () => resolve(traditional(texts));
        }),
    );
    const lyric = store(service);
    lyric.textConversionMode = mode;
    const snapshots = [];
    const stop = vue.watch(
      () => lyric.displayLines,
      (lines) => snapshots.push(lines.map((l) => l.text)),
    );
    lyric.setLyric('[00:00.000]头发', 'a');
    await vue.nextTick();
    if (mode === 'traditional') {
      assert.deepEqual(snapshots, [[]]);
      complete();
      await settle();
      assert.deepEqual(snapshots, [[], ['頭髮']]);
    } else {
      await settle();
      assert.deepEqual(snapshots, [['头发']]);
      assert.strictEqual(lyric.displayLines, lyric.lines);
    }
    stop();
  }
});

test('late conversion cannot overwrite a new track, a cleared store, or original mode', async () => {
  const batches = [];
  const service = setup((texts) => new Promise((resolve) => batches.push({ texts, resolve })));
  const lyric = store(service);
  lyric.textConversionMode = 'traditional';
  lyric.setLyric('[00:00.000]头发', 'a');
  lyric.setLyric('[00:00.000]后来', 'b');
  batches[1].resolve(traditional(batches[1].texts));
  await settle();
  assert.equal(lyric.displayLines[0].text, '後來');
  batches[0].resolve(traditional(batches[0].texts));
  await settle();
  assert.equal(lyric.displayLines[0].text, '後來');
  lyric.setLyric('[00:00.000]干燥', 'c');
  lyric.setTextConversionMode('none');
  batches[2].resolve(traditional(batches[2].texts));
  await settle();
  assert.equal(lyric.displayLines[0].text, '干燥');
  lyric.setTextConversionMode('traditional');
  lyric.clear();
  await settle();
  assert.deepEqual(lyric.displayLines, []);
});

async function syncFixture(t, service, targets = ['nowPlaying', 'miniPlayer', 'desktopLyric']) {
  const root = pinia.createPinia();
  const lyric = store(service);
  const player = pinia.defineStore('opencc-sync-player', {
    state: () => ({
      playbackClock: undefined,
      currentTime: 0,
      currentTimeUpdatedAt: 1000,
      isPlaying: true,
      duration: 100,
      playbackRate: 1,
      currentTrackId: 'a',
      currentTrackSnapshot: { id: 'a', hash: 'a', name: 'test' },
      seekTimestamp: 0,
      nativeTrackSeq: 1,
      volume: 50,
      currentSourceQueueId: 'q',
      playbackProgressBusyReason: null,
      playbackProgressIsBusy: false,
    }),
  })(root);
  const playlist = pinia.defineStore('opencc-sync-playlist', {
    state: () => ({ favorites: [], favoritesLoaded: true }),
    actions: { getQueueById: () => null, isFavoriteSong: () => false },
  })(root);
  const settings = vue.reactive({ globalFont: '', buildGlobalFontFamily: () => '' });
  const theme = vue.reactive({ isDark: false });
  const desktop = vue.reactive({ settings: { enabled: false }, hydrate: async () => null });
  const patches = { nowPlaying: [], miniPlayer: [], desktopLyric: [] };
  const electron = Object.fromEntries(
    Object.keys(patches).map((key) => [
      key,
      {
        syncSnapshot: (patch) => patches[key].push(patch),
        onSnapshot: () => () => {},
        onCommand: () => () => {},
      },
    ]),
  );
  electron.ipcRenderer = { on() {}, off() {} };
  let normalizations = 0;
  const mocks = {
    vue,
    pinia,
    '@/stores/player': { usePlayerStore: () => player },
    '@/stores/playlist': { usePlaylistStore: () => playlist },
    '@/stores/lyric': { useLyricStore: () => lyric },
    '@/stores/setting': { useSettingStore: () => settings },
    '@/stores/theme': { useThemeStore: () => theme },
    '@/stores/toast': { useToastStore: () => ({ success() {} }) },
    '@/desktopLyric/store': { useDesktopLyricStore: () => desktop },
    './store': { useDesktopLyricStore: () => desktop },
    '@/utils/shortcuts': {},
    '@/utils/lruMap': lruMap,
    '@/utils/playbackQueuePresentation': { getPlaybackQueuePresentation: () => ({ title: '' }) },
    '@/stores/playlist/helpers': { resolveFavoriteSongKey: () => 'a' },
    '../../shared/nowPlaying': nowPlaying,
    '../../shared/desktopLyric': desktopLyric,
    '../../shared/lyrics': {
      ...lyrics,
      normalizeLyricLinePayload: (line) => {
        normalizations++;
        return lyrics.normalizeLyricLinePayload(line);
      },
    },
  };
  for (const target of targets) {
    const api = compile(`../src/renderer/${target}/sync.ts`, mocks, { electron });
    const init = `init${target[0].toUpperCase()}${target.slice(1)}Sync`;
    t.after(await api[init]());
  }
  return { lyric, player, patches, normalizations: () => normalizations };
}

test('all windows receive committed contextual text and original timed boundaries', async (t) => {
  const service = setup(async (texts) => traditional(texts));
  const { lyric, patches } = await syncFixture(t, service);
  lyric.setTextConversionMode('traditional');
  lyric.setLyric('[00:00.000]<00:00.000>头<00:00.500>发<00:01.000>', 'a');
  await settle();
  const full = [
    patches.nowPlaying.filter((p) => p.lyric?.lines?.length).map((p) => p.lyric.lines),
    patches.miniPlayer.filter((p) => p.lyric?.lines?.length).map((p) => p.lyric.lines),
    patches.desktopLyric.filter((p) => p.lyrics?.length).map((p) => p.lyrics),
  ];
  for (const snapshots of full) {
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0][0].text, '頭髮');
    assert.deepEqual(snapshots[0][0].characters, [
      { text: '頭', startTime: 0, endTime: 500 },
      { text: '髮', startTime: 500, endTime: 1000 },
    ]);
  }
  assert.equal(lyric.copyableText, '頭髮');
  assert.equal(lyric.rawLyric.includes('头'), true);
  const before = Object.values(patches).map((p) => p.length);
  lyric.lines[0].characters[0].highlighted = true;
  await vue.nextTick();
  assert.deepEqual(
    Object.values(patches).map((p) => p.length),
    before,
  );
});

test('a mode change is synchronized even when conversion leaves the display reference unchanged', async (t) => {
  const service = setup(async (texts) => texts);
  const { lyric, patches } = await syncFixture(t, service);
  lyric.setLyric('[00:00.000]Hello', 'a');
  await settle();
  const original = lyric.displayLines;
  lyric.setTextConversionMode('traditional-hk');
  await settle();
  assert.strictEqual(lyric.displayLines, original);
  assert.equal(
    patches.nowPlaying.filter((p) => p.lyric?.lines).at(-1).lyric.textConversionMode,
    'traditional-hk',
  );
  assert.equal(
    patches.miniPlayer.filter((p) => p.lyric?.lines).at(-1).lyric.textConversionMode,
    'traditional-hk',
  );
  assert.equal(
    patches.desktopLyric.filter((p) => p.settings).at(-1).settings.textConversionMode,
    'traditional-hk',
  );
});

test('Mini progress ticks never normalize the full lyric collection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = await syncFixture(
    t,
    setup(async (texts) => texts),
    ['miniPlayer'],
  );
  fixture.lyric.setLyric('[00:00.000]头发', 'a');
  await vue.nextTick();
  const baseline = fixture.normalizations();
  assert.ok(baseline > 0);
  for (let i = 0; i < 3; i++) {
    fixture.player.currentTime += 0.5;
    await vue.nextTick();
    t.mock.timers.tick(500);
  }
  assert.equal(fixture.normalizations(), baseline);
  assert.ok(fixture.patches.miniPlayer.some((p) => p.playback?.currentTime === 1.5));
});
