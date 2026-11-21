import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

// 续播记录线：同一首曲目可以同时挂在专辑卡、歌单卡和自己的单曲播放上，
// 各条线互不覆盖。这里锁住「起播读哪条线」「什么长度才记」「桶之间怎么归属」。
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

const resume = load('../src/renderer/stores/player/resume.ts', {
  '@/utils/historyLimits': { HISTORY_MAX_ENTRIES: 3 },
});

const fresh = () => ({ resumePositions: {}, resumeScopes: [] });
const scope = (kind, id, trackId = '') => ({
  kind,
  id,
  name: id,
  cover: '',
  trackId,
  updatedAt: Date.now(),
});

test('只有详情页点播才认领桶，其它入口记单曲线', () => {
  const state = fresh();
  state.resumeScopes.push(scope('audiobook', '100'));
  assert.equal(
    resume.resolveResumeEntry(state, { albumId: 100, trackId: 1 }),
    'single',
    '没有认领标记时不能认领桶',
  );
  state.resumeClaim = { kind: 'audiobook', id: '100' };
  assert.equal(resume.resolveResumeEntry(state, { albumId: 100, trackId: 1 }), 'audiobook:100');
  assert.equal(
    resume.resolveResumeEntry(state, { albumId: 999, trackId: 1 }),
    'single',
    '曲目不属于这一页时退回单曲',
  );
});

test('随机播放不认领桶，但已认领的曲目继续留在桶里', () => {
  const state = fresh();
  state.resumeScopes.push(scope('playlist', 'p1', '7'));
  state.resumeClaim = { kind: 'playlist', id: 'p1' };
  assert.equal(
    resume.resolveResumeEntry(state, { playMode: 'random', trackId: 7 }),
    'single',
    '随机播放一律记单曲线',
  );
  state.resumeClaim = null;
  assert.equal(
    resume.resolveResumeEntry(state, { trackId: 7 }),
    'playlist:p1',
    '桶里认领过的曲目从其它入口再播不迁移',
  );
  assert.equal(resume.resolveResumeEntry(state, { trackId: 8 }), 'single');
});

test('记录线解析：只认四种桶，single 与其它前缀都不算', () => {
  assert.deepEqual(resume.parseScopeEntry('album:9'), { kind: 'album', id: '9' });
  assert.equal(resume.parseScopeEntry('single'), null);
  assert.equal(resume.parseScopeEntry('queue:album:9'), null);
  assert.equal(resume.parseScopeEntry('album:'), null);
});

test('起播位置：不足 30 秒、或已经播到开头 3 秒内都不续播', () => {
  const state = fresh();
  resume.rememberResumePosition(state, '1', 60, 120, 'single');
  assert.equal(resume.resolveResumePosition(state, '1', 120, 'single'), 57);
  assert.equal(resume.resolveResumePosition(state, '1', 20, 'single'), 0);
  assert.equal(resume.resolveResumePosition(state, '1', 0, 'single'), 57, '时长缺省用记录里的');
  assert.equal(resume.resolveResumePosition(state, '2', 120, 'single'), 0);
});

test('不够长的曲目不记录，也不留下空记录线', () => {
  const state = fresh();
  resume.rememberResumePosition(state, '1', 5, 20, 'single');
  assert.deepEqual(state.resumePositions, {});
  resume.rememberResumePosition(state, '1', 0.5, 200, 'single');
  assert.deepEqual(state.resumePositions, {});
  resume.rememberResumePosition(state, '1', 30, 200, 'single');
  assert.equal(state.resumePositions['1'].single.position, 30);
});

test('同一首各条线各记各的，互不覆盖', () => {
  const state = fresh();
  resume.rememberResumePosition(state, '1', 30, 200, 'single');
  resume.rememberResumePosition(state, '1', 90, 200, 'album:9');
  assert.equal(resume.resolveResumePosition(state, '1', 200, 'single'), 27);
  assert.equal(resume.resolveResumePosition(state, '1', 200, 'album:9'), 87);
});

const scopeKeys = (state) => state.resumeScopes.map((item) => item.kind + ':' + item.id).sort();

test('有声桶建起来时清掉同 id 的专辑桶', () => {
  const state = fresh();
  resume.rememberResumePosition(state, '1', 30, 200, 'album:9');
  assert.deepEqual(scopeKeys(state), ['album:9']);
  resume.rememberResumePosition(state, '1', 60, 200, 'audiobook:9');
  assert.deepEqual(scopeKeys(state), ['audiobook:9']);
  assert.equal(state.resumeScopes[0].trackId, '1');
});

test('专辑桶不会反过来清掉有声桶：两边各留一条线', () => {
  const state = fresh();
  resume.rememberResumePosition(state, '2', 30, 200, 'audiobook:9');
  resume.rememberResumePosition(state, '2', 60, 200, 'album:9');
  assert.deepEqual(scopeKeys(state), ['album:9', 'audiobook:9']);
});

test('删掉正在播的那个桶时一并撤销认领，下一秒不会被写回来', () => {
  const state = fresh();
  state.resumeScopes.push(scope('audiobook', '100', '5'));
  state.resumeClaim = { kind: 'audiobook', id: '100' };
  resume.forgetResumeScope(state, 'audiobook', '100');
  assert.equal(state.resumeScopes.length, 0, '桶要被删掉');
  assert.equal(state.resumeClaim, null, '认领也要撤掉，否则定时写入会重建这个桶');
  assert.equal(
    resume.resolveResumeEntry(state, { albumId: 100, trackId: 5 }),
    'single',
    '撤销认领后，这一首回落到单曲线',
  );
  resume.rememberResumePosition(state, '5', 120, 600, 'single');
  assert.equal(state.resumeScopes.length, 0, '写进度不该把删掉的桶带回来');
});

test('删的是别的桶时不动当前认领', () => {
  const state = fresh();
  state.resumeScopes.push(scope('audiobook', '100', '5'), scope('album', '200', '6'));
  state.resumeClaim = { kind: 'audiobook', id: '100' };
  resume.forgetResumeScope(state, 'album', '200');
  assert.deepEqual(state.resumeClaim, { kind: 'audiobook', id: '100' });
  assert.equal(state.resumeScopes.length, 1);
  assert.equal(state.resumeScopes[0].kind, 'audiobook');
});
