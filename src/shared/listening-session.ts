/** Playback telemetry lifecycle, independent of player/UI stores. */
export interface ListeningIdentity {
  account: string;
  track: string;
  mixsongid: number;
}
interface Segment {
  identity: ListeningIdentity;
  milliseconds: number;
  started: Promise<boolean>;
}
export function createListeningSession(deps: {
  now: () => number;
  start: (identity: ListeningIdentity) => Promise<boolean>;
  end: (identity: ListeningIdentity, duration: number, state: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  let segment: Segment | null = null;
  let sample: { time: number; position: number } | null = null;
  let queue = Promise.resolve();
  const resetPosition = () => {
    sample = null;
  };
  const flush = (state = '中断播放') => {
    const completed = segment;
    segment = null;
    resetPosition();
    if (completed) {
      queue = queue
        .then(async () => {
          // 保持开始请求先完成，但其失败不抹掉已经实际发生的播放时间。
          await completed.started;
          await deps.end(completed.identity, Math.floor(completed.milliseconds), state);
        })
        .catch(deps.onError);
    }
    return queue;
  };
  const tick = (identity: ListeningIdentity | null, position: number, rate: number) => {
    if (!identity) {
      void flush();
      return;
    }
    if (
      segment &&
      (segment.identity.account !== identity.account || segment.identity.track !== identity.track)
    ) {
      void flush();
    }
    if (!segment) {
      const started = queue
        .then(() => deps.start(identity))
        .catch((error) => {
          deps.onError(error);
          return false;
        });
      queue = started.then(() => undefined);
      segment = { identity, milliseconds: 0, started };
    }
    const time = deps.now();
    if (sample) {
      const elapsed = time - sample.time;
      const progress = (position - sample.position) * 1000;
      const speed = Number.isFinite(rate) && rate > 0 ? rate : 1;
      // Long gaps (suspend/stall) and discontinuous seeks never count as listening.
      if (elapsed > 0 && elapsed <= 5000 && progress > 0 && progress <= elapsed * speed + 1000) {
        segment.milliseconds += Math.min(elapsed, progress / speed);
      }
    }
    sample = { time, position };
  };
  return { tick, flush, resetPosition };
}
