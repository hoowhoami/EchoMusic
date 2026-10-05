import { normalizeWindowBackground, type WindowBackground } from '../../shared/windowBackground';

/** One amount drives both the skin and the alpha-capable native window. */
export const windowBackgroundFromTransparency = (
  transparency: number,
  frosted: boolean,
  keepOnBlur = false,
) => {
  const background = normalizeWindowBackground({
    transparency,
    frosted,
    keepFrostedOnBlur: keepOnBlur,
    color: '',
  });
  return { ...background, enabled: background.transparency > 0 || background.frosted };
};

/** Serialize IPC writes and coalesce slider bursts so an old reply cannot win. */
export function createWindowTransparencySync(
  apply: (value: WindowBackground) => Promise<void>,
  report: (error: unknown | null) => void,
) {
  let pending: WindowBackground | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;
  return {
    update(value: WindowBackground): Promise<void> {
      if (disposed) return Promise.resolve();
      pending = value;
      if (!running) {
        running = Promise.resolve().then(async () => {
          try {
            while (pending && !disposed) {
              const next = pending;
              pending = null;
              try {
                await apply(next);
                if (!disposed) report(null);
              } catch (error) {
                if (!disposed) report(error);
              }
            }
          } finally {
            running = null;
          }
        });
      }
      return running;
    },
    dispose() {
      disposed = true;
      pending = null;
    },
  };
}
