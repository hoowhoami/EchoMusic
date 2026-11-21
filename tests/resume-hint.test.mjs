import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

// 有声续播卡：只提示、不拦播放。这里钉住「什么时候弹」「弹多久」「同一本书别反复弹」。
function load(file, mocks = {}) {
  const module = { exports: {} };
  const source = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('module', 'exports', 'require', source)(module, module.exports, (id) => {
    if (!(id in mocks)) throw new Error('Unexpected dependency: ' + id);
    return mocks[id];
  });
  return module.exports;
}

const hint = load('../src/renderer/utils/resumeHint.ts', {
  vue: { reactive: (value) => value },
});

const scopeOf = (id, trackId, name = '夜的命名术') => ({
  kind: 'audiobook',
  id: String(id),
  trackId: String(trackId),
  name,
});

test('没有有声桶时不弹卡', () => {
  assert.equal(
    hint.maybeShowResumeHint({ id: 1, albumId: 100 }, [], () => ({ position: 30 })),
    0,
  );
  assert.equal(hint.resumeHintState.open, false);
});

test('桶里只有登记、没有真实进度时也不弹', () => {
  assert.equal(
    hint.maybeShowResumeHint({ id: 1, albumId: 200 }, [scopeOf(200, 3)], () => undefined),
    0,
    '读不到进度就不弹',
  );
  assert.equal(
    hint.maybeShowResumeHint({ id: 1, albumId: 200 }, [scopeOf(200, 3)], () => ({ position: 0 })),
    0,
    'position 为 0 视同没有进度',
  );
  assert.equal(hint.resumeHintState.open, false);
});

test('有进度时弹卡：书名、章节名、位置都对得上', () => {
  const shown = hint.maybeShowResumeHint({ id: 2, albumId: 300 }, [scopeOf(300, 9)], () => ({
    position: 442,
    title: '第 3 章',
  }));
  assert.equal(shown, 1);
  assert.equal(hint.resumeHintState.open, true);
  assert.equal(hint.resumeHintState.albumId, '300');
  assert.equal(hint.resumeHintState.scopeName, '夜的命名术');
  assert.equal(hint.resumeHintState.recordTitle, '第 3 章');
  assert.equal(hint.resumeHintState.recordPosition, 442);
  assert.equal(hint.resumeHintState.sameTrack, false, '点的是第 2 集，记的是第 9 集');
  hint.dismissResumeHint();
});

test('点播的就是记录那一集时，卡片说的是「同一集」', () => {
  hint.maybeShowResumeHint({ id: 9, albumId: 301 }, [scopeOf(301, 9)], () => ({ position: 60 }));
  assert.equal(hint.resumeHintState.sameTrack, true);
  hint.dismissResumeHint();
});

test('10 秒内再触发一次就是顶替：内容换新、10 秒重新算', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const scope = scopeOf(400, 5);
  assert.equal(
    hint.maybeShowResumeHint({ id: 5, albumId: 400 }, [scope], () => ({ position: 60 })),
    1,
  );
  assert.equal(hint.resumeHintState.open, true);
  t.mock.timers.tick(4000);
  assert.equal(
    hint.maybeShowResumeHint({ id: 6, albumId: 400 }, [scopeOf(400, 6)], () => ({
      position: 120,
      title: '第 6 集',
    })),
    1,
    '同一张卡再触发不会被静默忽略',
  );
  assert.equal(hint.resumeHintState.open, true);
  assert.equal(hint.resumeHintState.recordPosition, 120, '内容被这次顶替');
  t.mock.timers.tick(hint.RESUME_HINT_VISIBLE_MS - 1000);
  assert.equal(hint.resumeHintState.open, true, '展示计时从这次触发重新算');
  t.mock.timers.tick(2000);
  assert.equal(hint.resumeHintState.open, false);
});

test('卡片 10 秒后自动收起，不点也不留残影', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  hint.maybeShowResumeHint({ id: 4, albumId: 500 }, [scopeOf(500, 4)], () => ({ position: 90 }));
  assert.equal(hint.resumeHintState.open, true);
  t.mock.timers.tick(hint.RESUME_HINT_VISIBLE_MS);
  assert.equal(hint.resumeHintState.open, false);
});

test('播放流程里不再有拦截式弹窗', () => {
  const source = readFileSync(
    new URL('../src/renderer/utils/playback.ts', import.meta.url),
    'utf8',
  );
  assert.equal(source.includes('audiobookResumePrompt'), false, '旧的拦截式提示已删除');
  assert.equal(source.includes('maybeShowResumeHint('), true, '改为只提示');
});

test('详情页那张卡是常驻的：进页面就贴，不自动收起', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  hint.showPageResumeHint({
    kind: 'audiobook',
    id: '600',
    scopeName: '夜的命名术',
    recordTitle: '第 7 集',
    recordPosition: 321,
    trackId: '11',
  });
  assert.equal(hint.resumeHintState.open, true);
  assert.equal(hint.resumeHintState.persistent, true, '常驻卡不跟着 5 秒计时器走');
  assert.equal(hint.resumeHintState.kindLabel, '有声');
  assert.equal(hint.resumeHintState.key, 'audiobook:600');
  assert.equal(hint.resumeHintState.recordPosition, 321);
  t.mock.timers.tick(hint.RESUME_HINT_VISIBLE_MS * 3);
  assert.equal(hint.resumeHintState.open, true, '过多久都不自己收');
  hint.dismissResumeHint();
});

test('详情页那一页没有真实进度就不贴卡', () => {
  hint.showPageResumeHint({ kind: 'album', id: '700', recordPosition: 0, trackId: '1' });
  assert.equal(hint.resumeHintState.open, false);
  hint.showPageResumeHint({ kind: 'album', id: '', recordPosition: 30, trackId: '1' });
  assert.equal(hint.resumeHintState.open, false);
});

test('点常驻卡会发出续播请求，带上这张卡的 key', () => {
  hint.showPageResumeHint({ kind: 'playlist', id: 'p9', recordPosition: 88, trackId: '2' });
  const before = hint.resumeHintRequest.token;
  hint.requestResumeHintPlay();
  assert.equal(hint.resumeHintRequest.token, before + 1);
  assert.equal(hint.resumeHintRequest.key, 'playlist:p9');
  assert.equal(hint.resumeHintState.kindLabel, '歌单');
  hint.dismissResumeHint();
});

test('另一入口的 5 秒卡不会沿用常驻卡的状态', () => {
  hint.showPageResumeHint({ kind: 'audiobook', id: '800', recordPosition: 45, trackId: '3' });
  assert.equal(hint.resumeHintState.persistent, true);
  hint.dismissResumeHint();
  hint.maybeShowResumeHint({ id: 3, albumId: 810 }, [scopeOf(810, 3)], () => ({ position: 45 }));
  assert.equal(hint.resumeHintState.persistent, false);
  assert.equal(hint.resumeHintState.kindLabel, '有声');
  hint.dismissResumeHint();
});

test('顶替是旧卡消失、新卡出现：每贴一次换一个 token', () => {
  hint.maybeShowResumeHint({ id: 5, albumId: 900 }, [scopeOf(900, 5)], () => ({ position: 20 }));
  const first = hint.resumeHintState.token;
  hint.maybeShowResumeHint({ id: 5, albumId: 900 }, [scopeOf(900, 5)], () => ({ position: 40 }));
  assert.equal(hint.resumeHintState.token, first + 1, '再触发一次要重新挂载，用户才看得见');
  assert.equal(hint.resumeHintState.recordPosition, 40);
  hint.dismissResumeHint();
});

test('详情页那张卡用同一套文案：正在播记录里那一集就算同一集', () => {
  hint.showPageResumeHint({
    kind: 'audiobook',
    id: '910',
    recordPosition: 60,
    trackId: '6',
    sameTrack: true,
  });
  assert.equal(hint.resumeHintState.sameTrack, true);
  hint.showPageResumeHint({
    kind: 'audiobook',
    id: '910',
    recordPosition: 60,
    trackId: '6',
    sameTrack: false,
  });
  assert.equal(hint.resumeHintState.sameTrack, false);
  hint.dismissResumeHint();
});

test('暂停后再按播放也算触发：播放恢复会去叫这张卡', () => {
  const source = readFileSync(
    new URL('../src/renderer/stores/player/playback.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /resumeHintState\.persistent/, '详情页常驻卡不打断，普通卡允许顶替');
  assert.match(source, /maybeShowResumeHint\(/, '恢复播放要触发续播卡');
  assert.ok(
    source.includes('按播放键接着播这一首'),
    '恢复播放这条路径上要有说明，免得以后被当成多余逻辑删掉',
  );
});

test('命中几个桶就弹几张：有声、专辑、歌手、歌单一次都弹出来', () => {
  const song = { id: 't1', albumId: '300', artists: [{ id: 'a7', name: '某人' }] };
  const scopes = [
    { kind: 'audiobook', id: '300', trackId: 't9', name: '夜的命名术', cover: 'c1' },
    { kind: 'album', id: '300', trackId: 't8', name: '同名专辑' },
    { kind: 'artist', id: 'a7', trackId: 't7', name: '某人' },
    { kind: 'playlist', id: 'p5', trackId: 't6', name: '睡前歌单' },
  ];
  const shown = hint.maybeShowResumeHint(song, scopes, () => ({ position: 60, title: '第 3 章' }), {
    queueId: 'queue:playlist:p5',
  });
  assert.equal(shown, 4, '四间桶都命中的时候四张一起弹');
  assert.deepEqual(
    hint.resumeHintState.cards.map((card) => card.kind),
    ['audiobook', 'album', 'artist', 'playlist'],
    '顺序固定：有声在最上面',
  );
  assert.deepEqual(
    hint.resumeHintState.cards.map((card) => card.kindLabel),
    ['有声', '专辑', '歌手', '歌单'],
  );
  hint.dismissResumeHint();
});

test('歌单桶只认当前队列：队列不是这个歌单就不弹它', () => {
  const song = { id: 't1', albumId: '301' };
  const scopes = [{ kind: 'playlist', id: 'p5', trackId: 't1', name: '睡前歌单' }];
  const read = () => ({ position: 30 });
  assert.equal(
    hint.maybeShowResumeHint(song, scopes, read, { queueId: 'queue:playlist:p6' }),
    0,
    '队列是别的歌单，不能猜',
  );
  assert.equal(hint.maybeShowResumeHint(song, scopes, read, { queueId: 'queue:album:301' }), 0);
  assert.equal(hint.maybeShowResumeHint(song, scopes, read), 0, '压根不知道队列就不弹');
  assert.equal(
    hint.maybeShowResumeHint(song, scopes, read, { queueId: 'queue:playlist:p5' }),
    1,
    '队列就是这个歌单才弹',
  );
  hint.dismissResumeHint();
});

test('最多只弹七张：和搜索页牌堆同一个上限，多出来的桶不再往上叠', () => {
  const artists = Array.from({ length: 10 }, (_, index) => ({
    id: 'a' + (index + 1),
    name: '歌手' + (index + 1),
  }));
  const song = { id: 't1', albumId: '302', artists };
  const scopes = [
    { kind: 'audiobook', id: '302', trackId: 'x' },
    { kind: 'album', id: '302', trackId: 'x' },
    ...artists.map((artist) => ({ kind: 'artist', id: artist.id, trackId: 'x' })),
    { kind: 'playlist', id: 'p5', trackId: 'x' },
  ];
  const shown = hint.maybeShowResumeHint(song, scopes, () => ({ position: 10 }), {
    queueId: 'queue:playlist:p5',
  });
  assert.equal(hint.RESUME_HINT_MAX_CARDS, 7);
  assert.equal(shown, 7);
  assert.equal(hint.resumeHintState.cards.length, 7);
  hint.dismissResumeHint();
});

test('同一间桶只出一张：同 id 重复登记不会叠出两张一样的卡', () => {
  const song = { id: 't1', albumId: '303' };
  const scopes = [
    { kind: 'audiobook', id: '303', trackId: 'a' },
    { kind: 'audiobook', id: '303', trackId: 'b' },
  ];
  assert.equal(
    hint.maybeShowResumeHint(song, scopes, () => ({ position: 10 })),
    1,
  );
  assert.equal(hint.resumeHintState.cards.length, 1);
  hint.dismissResumeHint();
});

test('开关关掉就不弹：弹卡、详情页卡各管各的', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  hint.setResumeHintConfig({ popup: false });
  assert.equal(
    hint.maybeShowResumeHint({ id: 5, albumId: 950 }, [scopeOf(950, 5)], () => ({ position: 30 })),
    0,
    '播放时提示续播关掉，命中桶也不弹',
  );
  assert.equal(hint.resumeHintState.open, false);
  hint.setResumeHintConfig({ page: false });
  hint.showPageResumeHint({ kind: 'audiobook', id: '950', recordPosition: 30, trackId: '5' });
  assert.equal(hint.resumeHintState.open, false, '详情页续播卡关掉就不贴');
  hint.setResumeHintConfig({ popup: true, page: true });
  assert.equal(
    hint.maybeShowResumeHint({ id: 5, albumId: 950 }, [scopeOf(950, 5)], () => ({ position: 30 })),
    1,
    '开关打开后恢复原样',
  );
  hint.dismissResumeHint();
});

test('停留时间可以自己调：按设置里的秒数收卡', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  hint.setResumeHintConfig({ visibleMs: 3000 });
  assert.equal(hint.getResumeHintConfig().visibleMs, 3000);
  hint.maybeShowResumeHint({ id: 6, albumId: 960 }, [scopeOf(960, 6)], () => ({ position: 30 }));
  t.mock.timers.tick(2500);
  assert.equal(hint.resumeHintState.open, true, '3 秒还没到');
  t.mock.timers.tick(700);
  assert.equal(hint.resumeHintState.open, false, '过 3 秒就收');
  hint.setResumeHintConfig({ visibleMs: hint.RESUME_HINT_VISIBLE_MS });
});

test('卡正开着时改停留时间，按新值重新计时', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  hint.maybeShowResumeHint({ id: 7, albumId: 970 }, [scopeOf(970, 7)], () => ({ position: 30 }));
  t.mock.timers.tick(8000);
  hint.setResumeHintConfig({ visibleMs: 3000 });
  assert.equal(hint.resumeHintState.open, true, '改设置不会立刻收卡');
  t.mock.timers.tick(3200);
  assert.equal(hint.resumeHintState.open, false, '按新的 3 秒重算');
  hint.setResumeHintConfig({ visibleMs: hint.RESUME_HINT_VISIBLE_MS });
});

test('停留秒数有下限：0 或负数都夹到 1 秒以上', () => {
  hint.setResumeHintConfig({ visibleMs: 0 });
  assert.equal(hint.getResumeHintConfig().visibleMs >= 1000, true);
  hint.setResumeHintConfig({ visibleMs: hint.RESUME_HINT_VISIBLE_MS });
});

test('续播请求只认领一次：同一个 key 第二次拿不到', () => {
  hint.requestResumeHintPlay('audiobook:980');
  assert.equal(hint.takeResumeHintRequest(''), false, '页面还没有 key');
  assert.equal(hint.takeResumeHintRequest('album:980'), false, '不是这张卡');
  assert.equal(hint.takeResumeHintRequest('audiobook:980'), true, '命中就认领');
  assert.equal(hint.takeResumeHintRequest('audiobook:980'), false, '缓存页回头再调不会重复定位');
});

test('没有请求时不认领：token 从 0 起', () => {
  assert.equal(hint.takeResumeHintRequest('audiobook:990'), false);
});

test('续播请求不再区分入口：一律走同一个请求，播不播看设置', () => {
  hint.requestResumeHintPlay('playlist:p3');
  assert.equal(hint.takeResumeHintRequest('playlist:p3'), true, '发出来就能认领');
  assert.equal(hint.requestResumeHintLocate, undefined, '只定位那个入口已经删掉');
});

test('总开关关掉后整个续播卡都不生效，已经贴着的也收走', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  hint.setResumeHintConfig({ enabled: false });
  assert.equal(
    hint.maybeShowResumeHint({ id: 8, albumId: 995 }, [scopeOf(995, 8)], () => ({ position: 30 })),
    0,
    '提示卡不弹',
  );
  hint.showPageResumeHint({ kind: 'audiobook', id: '995', recordPosition: 30, trackId: '8' });
  assert.equal(hint.resumeHintState.open, false, '详情页卡也不贴');
  hint.setResumeHintConfig({ enabled: true });
  hint.maybeShowResumeHint({ id: 8, albumId: 995 }, [scopeOf(995, 8)], () => ({ position: 30 }));
  assert.equal(hint.resumeHintState.open, true, '打开后恢复');
  hint.setResumeHintConfig({ enabled: false });
  assert.equal(hint.resumeHintState.open, false, '正开着的时候关总开关，立刻收卡');
  hint.setResumeHintConfig({ enabled: true });
});
