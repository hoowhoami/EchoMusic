import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHistoryStats, type HistoryStatsEntry } from '../src/shared/historyStats.ts';

const entry = (overrides: Partial<HistoryStatsEntry>): HistoryStatsEntry => ({
  song: { id: '1', name: '歌曲', artist: '歌手' },
  lastPlayedAt: 1_700_000_000_000,
  playCount: 1,
  historyKey: '1:1700000000000',
  ...overrides,
});

const durationCard = (entries: HistoryStatsEntry[]) =>
  buildHistoryStats(entries).statCards.find((card) => card.label === '已记录时长');

test('已记录时长逐条累加本地实听毫秒', () => {
  const stats = buildHistoryStats([
    entry({ listenedMs: 90_000 }),
    entry({ historyKey: '2:1', song: { id: '2', name: 'B', artist: '歌手' }, listenedMs: 30_000 }),
    entry({ historyKey: '3:1', song: { id: '3', name: 'C', artist: '歌手' } }),
    entry({ historyKey: '4:1', song: { id: '4', name: 'D', artist: '歌手' }, listenedMs: -5_000 }),
    entry({
      historyKey: '5:1',
      song: { id: '5', name: 'E', artist: '歌手' },
      listenedMs: Number.NaN,
    }),
  ]);
  // 缺省/负值/NaN 一律按 0 处理
  assert.equal(stats.listenedMs, 120_000);
  assert.equal(durationCard([])!.value, '0 分钟');
  const card = durationCard([
    entry({ listenedMs: 90_000 }),
    entry({ historyKey: '2:1', song: { id: '2', name: 'B', artist: '歌手' }, listenedMs: 30_000 }),
  ]);
  assert.equal(card!.value, '2 分钟');
  assert.equal(card!.caption, '本机实际播放累计');
});

test('空历史时已记录时长显示为 0 分钟占位', () => {
  const stats = buildHistoryStats([]);
  assert.equal(stats.listenedMs, 0);
  assert.equal(durationCard([])!.value, '0 分钟');
});
