import type { Song } from '@/models/song';
import { resolveSongId } from '../../../shared/historyStats';
import { createListeningSession } from '../../../shared/listeningSession';

/** 周期结算间隔：强退/崩溃时最多丢一个周期的时长 */
export const LISTEN_SETTLE_INTERVAL_MS = 60_000;

/**
 * 本地收听时长累计器（与登录态/远端上报完全无关，纯本地统计）。
 *
 * 计时口径复用 `createListeningSession` 的「墙钟 + 音频前进」双门控：
 * 暂停、seek 跳跃、卡顿/休眠造成的长间隔都不计入。
 * 累计结果按周期结算进本地历史条目，切歌/停止/事件钩子时也会立即结算。
 */
export const createListenHistory = (deps: {
  now: () => number;
  /** 把一段实听时长累加到该歌曲的历史条目（条目不存在时应静默忽略） */
  record: (song: Song, listenedMs: number) => Promise<void> | void;
  /** 播放状态门控：加载中/暂停/seek 中一律不计时 */
  blocked?: () => boolean;
  onError?: (error: unknown) => void;
}) => {
  let active: { song: Song; ms: number } | null = null;
  let lastSettleAt = deps.now();
  // 串行化写入，避免同一首歌的多次增量并发乱序
  let writing: Promise<void> = Promise.resolve();

  const session = createListeningSession({
    now: deps.now,
    // 本地统计不需要远端会话，start/end 只保留骨架
    start: async () => true,
    end: async () => {},
    onAccumulate: (milliseconds) => {
      if (active && Number.isFinite(milliseconds) && milliseconds > 0) active.ms += milliseconds;
    },
    onError: (error) => deps.onError?.(error),
  });

  /** 把当前歌曲已累计的毫秒数落库（不清除采样基线，时长继续正常累计） */
  const flush = () => {
    if (!active || active.ms <= 0) return;
    const { song } = active;
    const listenedMs = Math.round(active.ms);
    active.ms = 0;
    if (listenedMs <= 0) return;
    writing = writing
      .then(() => deps.record(song, listenedMs))
      .catch((error) => deps.onError?.(error));
  };

  const tick = (song: Song | null, position: number, rate: number) => {
    if (deps.blocked?.()) {
      // 暂停/加载/seek 期间保持待结算时长，只重置采样基线
      session.resetPosition();
      return;
    }
    if (!song) {
      flush();
      active = null;
      session.resetPosition();
      return;
    }
    const songId = resolveSongId(song);
    if (active && resolveSongId(active.song) !== songId) {
      // 漏发 trackchange 也能在下一帧自动结算旧曲
      flush();
      active = { song, ms: 0 };
      session.resetPosition();
    }
    if (!active) active = { song, ms: 0 };
    session.tick({ account: 'local', track: songId, mixsongid: 0 }, position, rate);
    const now = deps.now();
    if (now - lastSettleAt >= LISTEN_SETTLE_INTERVAL_MS) {
      lastSettleAt = now;
      flush();
    }
  };

  const resetPosition = () => session.resetPosition();

  /** 停止播放：立即结算并清空当前曲目 */
  const stop = () => {
    flush();
    active = null;
    session.resetPosition();
  };

  return { tick, flush, resetPosition, stop };
};
