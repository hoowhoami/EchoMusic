export interface StableLyricIndexOptions {
  maxBackwardLines?: number;
  maxTimeRegressionSeconds?: number;
}

const DEFAULT_MAX_BACKWARD_LINES = 2;
const DEFAULT_MAX_TIME_REGRESSION_SECONDS = 0.35;

export const createStableLyricIndex = (options: StableLyricIndexOptions = {}) => {
  const maxBackwardLines = options.maxBackwardLines ?? DEFAULT_MAX_BACKWARD_LINES;
  const maxTimeRegressionSeconds =
    options.maxTimeRegressionSeconds ?? DEFAULT_MAX_TIME_REGRESSION_SECONDS;

  let lastStableIndex = -1;
  let lastStableTimeSeconds = 0;

  const apply = (rawIndex: number, timelineMs: number) => {
    let index = rawIndex;
    const timeSeconds = timelineMs / 1000;

    if (
      lastStableIndex >= 0 &&
      index >= 0 &&
      index < lastStableIndex &&
      lastStableIndex - index <= maxBackwardLines &&
      timeSeconds >= lastStableTimeSeconds - maxTimeRegressionSeconds
    ) {
      index = lastStableIndex;
    } else {
      lastStableIndex = index;
    }

    lastStableTimeSeconds = timeSeconds;
    return index;
  };

  const reset = (rawIndex: number, timelineMs: number) => {
    lastStableIndex = rawIndex;
    lastStableTimeSeconds = timelineMs / 1000;
    return rawIndex;
  };

  return {
    apply,
    reset,
  };
};
