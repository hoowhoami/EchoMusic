import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = (path) => transformSync(read(path), { loader: 'ts', format: 'cjs' }).code;

// 与被测模块同构的依赖注入装载器：源码内相对导入按源码目录书写，这里按名字映射
const load = (path, dependencies = {}) => {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compile(path))(
    (name) => {
      assert.ok(name in dependencies, `Unexpected import ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return module.exports;
};

const historyStats = load('../src/shared/historyStats.ts');
const listeningSession = load('../src/shared/listeningSession.ts');
const { createListenHistory, LISTEN_SETTLE_INTERVAL_MS } = load(
  '../src/renderer/stores/player/listenHistory.ts',
  {
    '../../../shared/historyStats': historyStats,
    '../../../shared/listeningSession': listeningSession,
  },
);

const songA = { id: '1', mixSongId: 1, name: 'A', artist: 'X' };
const songB = { id: '2', mixSongId: 2, name: 'B', artist: 'X' };

// record 走微任务串行队列，断言前需要让队列跑完
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const fixture = (options = {}) => {
  let now = 0;
  const writes = [];
  const errors = [];
  const instance = createListenHistory({
    now: () => now,
    record: (song, listenedMs) => {
      writes.push({ id: song.id, listenedMs });
    },
    blocked: options.blocked,
    onError: (error) => {
      errors.push(error);
    },
  });
  return {
    instance,
    writes,
    errors,
    advance: (ms) => {
      now += ms;
    },
  };
};

test('连续前进的播放按时长累计并在 stop 时结算', async () => {
  const f = fixture();
  f.instance.tick(songA, 0, 1);
  f.advance(1000);
  f.instance.tick(songA, 1, 1);
  f.advance(1000);
  f.instance.tick(songA, 2, 1);
  f.instance.stop();
  await settle();
  assert.deepEqual(f.writes, [{ id: '1', listenedMs: 2000 }]);
});

test('暂停门控期间不累计，恢复后从新基线继续', async () => {
  let paused = false;
  const f = fixture({ blocked: () => paused });
  f.instance.tick(songA, 0, 1);
  f.advance(1000);
  f.instance.tick(songA, 1, 1);
  paused = true;
  f.advance(60000);
  f.instance.tick(songA, 30, 1);
  paused = false;
  f.advance(1000);
  f.instance.tick(songA, 30, 1);
  f.advance(1000);
  f.instance.tick(songA, 31, 1);
  f.instance.stop();
  await settle();
  // 虚拟时钟跨过 60s 会触发周期结算，分段写入的总和必须等于真实播放时长
  assert.equal(
    f.writes.reduce((sum, write) => sum + write.listenedMs, 0),
    2000,
  );
  assert.ok(f.writes.every((write) => write.id === '1'));
});

test('seek 跳跃不计入时长', async () => {
  const f = fixture();
  f.instance.tick(songA, 0, 1);
  f.advance(1000);
  f.instance.tick(songA, 1, 1);
  f.instance.resetPosition();
  f.advance(100);
  f.instance.tick(songA, 90, 1); // 拖到 90s，重新建立基线
  f.advance(1000);
  f.instance.tick(songA, 91, 1);
  f.instance.stop();
  await settle();
  assert.deepEqual(f.writes, [{ id: '1', listenedMs: 2000 }]);
});

test('超过 5 秒的采样间隔（卡顿/休眠）丢弃', async () => {
  const f = fixture();
  f.instance.tick(songA, 0, 1);
  f.advance(6000);
  f.instance.tick(songA, 6, 1);
  f.advance(1000);
  f.instance.tick(songA, 7, 1);
  f.instance.stop();
  await settle();
  assert.deepEqual(f.writes, [{ id: '1', listenedMs: 1000 }]);
});

test('倍速播放按墙钟计时', async () => {
  const f = fixture();
  f.instance.tick(songA, 0, 2);
  f.advance(1000);
  f.instance.tick(songA, 2, 2);
  f.advance(1000);
  f.instance.tick(songA, 4, 2);
  f.instance.stop();
  await settle();
  assert.deepEqual(f.writes, [{ id: '1', listenedMs: 2000 }]);
});

test('切歌时先结算旧曲，再为新曲建立基线', async () => {
  const f = fixture();
  f.instance.tick(songA, 0, 1);
  f.advance(1000);
  f.instance.tick(songA, 1, 1);
  f.instance.tick(songB, 0, 1);
  f.advance(1000);
  f.instance.tick(songB, 1, 1);
  f.instance.stop();
  await settle();
  assert.deepEqual(f.writes, [
    { id: '1', listenedMs: 1000 },
    { id: '2', listenedMs: 1000 },
  ]);
});

test('周期结算把时长分批写入，避免强退丢整段', async () => {
  const f = fixture();
  f.instance.tick(songA, 0, 1);
  const cycles = Math.round(LISTEN_SETTLE_INTERVAL_MS / 1000);
  for (let second = 1; second <= cycles; second++) {
    f.advance(1000);
    f.instance.tick(songA, second, 1);
  }
  await settle();
  assert.equal(f.writes.length, 1);
  assert.ok(f.writes[0].listenedMs >= LISTEN_SETTLE_INTERVAL_MS);
  f.instance.stop();
  await settle();
  // 周期结算已把累计清零，stop 不会再重复写入
  assert.equal(f.writes.length, 1);
});

test('空曲目与无效累计不会触发写入', async () => {
  const f = fixture();
  f.instance.tick(null, 0, 1);
  f.instance.tick(songA, 0, 1);
  f.instance.tick(songA, 0, 1);
  f.instance.flush();
  f.instance.stop();
  await settle();
  assert.deepEqual(f.writes, []);
});
