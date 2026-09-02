export type OrderedPlaybackMode = 'list' | 'sequential';
export type PlaybackMode = OrderedPlaybackMode | 'single' | 'random';
export type QueueAdvanceAuthority = 'local' | 'dynamic-provider' | 'remote-session';

export const resolveQueueAdvanceAuthority = (options: {
  queueId: string | number | null | undefined;
  personalFmQueueId: string;
  listenTogetherQueueId: string;
}): QueueAdvanceAuthority => {
  const queueId = String(options.queueId ?? '');
  if (queueId === options.personalFmQueueId) return 'dynamic-provider';
  if (queueId === options.listenTogetherQueueId) return 'remote-session';
  return 'local';
};

export const canPrepareGaplessTransition = (options: {
  authority: QueueAdvanceAuthority;
  autoNextSuppressed: boolean;
}): boolean => options.authority === 'local' && !options.autoNextSuppressed;

export const resolveOrderedPlaybackMode = (
  playMode: PlaybackMode,
  explicitAdvance: boolean,
): OrderedPlaybackMode | null => {
  if (playMode === 'random') return null;
  if (playMode === 'single') return explicitAdvance ? 'list' : null;
  return playMode;
};

export const resolvePlaybackSourceQueueId = (options: {
  currentSourceQueueId: string | number | null | undefined;
  activeQueueId: string | number | null | undefined;
}): string | null => {
  const currentSourceQueueId = String(options.currentSourceQueueId ?? '');
  if (currentSourceQueueId) return currentSourceQueueId;
  const activeQueueId = String(options.activeQueueId ?? '');
  return activeQueueId || null;
};

export const findPlaybackSourceQueue = <Q>(options: {
  queues: readonly Q[];
  currentSourceQueueId: string | number | null | undefined;
  getQueueId: (queue: Q) => string | number;
}): Q | null => {
  const sourceQueueId = String(options.currentSourceQueueId ?? '');
  if (!sourceQueueId) return null;
  return (
    options.queues.find((queue) => String(options.getQueueId(queue) ?? '') === sourceQueueId) ??
    null
  );
};

export type NextTrackTargetDecision<T> = {
  track: T;
  targetTrackId: string;
  targetIndex: number;
  reason: 'queued-next' | 'queue-order';
  queuedNextTrackId: string | null;
  queuedNextTrackIdsToConsume: string[];
};

export type NextTrackCleanupDecision = {
  track: null;
  targetTrackId: null;
  targetIndex: -1;
  reason: 'cleanup';
  queuedNextTrackId: null;
  queuedNextTrackIdsToConsume: string[];
};

export type NextTrackDecision<T> = NextTrackTargetDecision<T> | NextTrackCleanupDecision;

type ResolveNextTrackDecisionOptions<T> = {
  tracks: readonly T[];
  currentTrackId: string | number | null | undefined;
  queuedNextTrackIds?: readonly string[];
  mode: OrderedPlaybackMode;
  getTrackId: (track: T) => string | number;
  isPlayable: (track: T) => boolean;
};

type ResolveQueuedNextTrackDecisionOptions<T> = Omit<ResolveNextTrackDecisionOptions<T>, 'mode'>;

const normalizeTrackId = (value: string | number | null | undefined): string => String(value ?? '');

export const hasPlaybackQueueOrderChanged = <T>(
  previousTracks: readonly T[],
  nextTracks: readonly T[],
  getTrackId: (track: T) => string | number,
): boolean =>
  previousTracks.length !== nextTracks.length ||
  previousTracks.some(
    (track, index) =>
      normalizeTrackId(getTrackId(track)) !== normalizeTrackId(getTrackId(nextTracks[index]!)),
  );

export const reconcileQueuedNextForQueueReplacement = <T>(options: {
  previousTracks: readonly T[];
  nextTracks: readonly T[];
  queuedNextTrackIds: readonly string[];
  preserveQueuedNext?: boolean;
  getTrackId: (track: T) => string | number;
}): {
  orderChanged: boolean;
  appendOnly: boolean;
  queuedNextTrackIds: string[];
} => {
  const { previousTracks, nextTracks, getTrackId } = options;
  const orderChanged = hasPlaybackQueueOrderChanged(previousTracks, nextTracks, getTrackId);
  const appendOnly =
    previousTracks.length > 0 &&
    nextTracks.length > previousTracks.length &&
    previousTracks.every(
      (track, index) =>
        normalizeTrackId(getTrackId(track)) === normalizeTrackId(getTrackId(nextTracks[index]!)),
    );
  return {
    orderChanged,
    appendOnly,
    queuedNextTrackIds:
      orderChanged && !appendOnly && !options.preserveQueuedNext
        ? []
        : options.queuedNextTrackIds.map(normalizeTrackId).filter(Boolean),
  };
};

export const resolveNextTrackDecision = <T>(
  options: ResolveNextTrackDecisionOptions<T>,
): NextTrackDecision<T> | null => {
  const { tracks, mode, getTrackId, isPlayable } = options;
  if (tracks.length === 0) return null;

  const currentTrackId = normalizeTrackId(options.currentTrackId);
  const queuedDecision = resolveQueuedNextTrackDecision(options);
  if (queuedDecision?.reason === 'queued-next') return queuedDecision;
  const queuedNextTrackIdsToConsume = queuedDecision?.queuedNextTrackIdsToConsume ?? [];
  const cleanupOnly = (): NextTrackCleanupDecision | null =>
    queuedNextTrackIdsToConsume.length > 0
      ? {
          track: null,
          targetTrackId: null,
          targetIndex: -1,
          reason: 'cleanup',
          queuedNextTrackId: null,
          queuedNextTrackIdsToConsume,
        }
      : null;
  const currentIndex = tracks.findIndex(
    (track) => normalizeTrackId(getTrackId(track)) === currentTrackId,
  );
  if (currentIndex < 0) {
    const targetIndex = tracks.findIndex(isPlayable);
    if (targetIndex < 0) return cleanupOnly();
    const track = tracks[targetIndex]!;
    return {
      track,
      targetTrackId: normalizeTrackId(getTrackId(track)),
      targetIndex,
      reason: 'queue-order',
      queuedNextTrackId: null,
      queuedNextTrackIdsToConsume,
    };
  }

  if (mode === 'sequential' && currentIndex >= tracks.length - 1) return cleanupOnly();
  const wraps = mode === 'list';
  for (let offset = 1; offset <= tracks.length; offset += 1) {
    const targetIndex = currentIndex + offset;
    if (!wraps && targetIndex >= tracks.length) return cleanupOnly();
    const normalizedIndex = targetIndex % tracks.length;
    const track = tracks[normalizedIndex];
    if (!track || !isPlayable(track)) continue;
    return {
      track,
      targetTrackId: normalizeTrackId(getTrackId(track)),
      targetIndex: normalizedIndex,
      reason: 'queue-order',
      queuedNextTrackId: null,
      queuedNextTrackIdsToConsume,
    };
  }

  return cleanupOnly();
};

export const resolveQueuedNextTrackDecision = <T>(
  options: ResolveQueuedNextTrackDecisionOptions<T>,
): NextTrackTargetDecision<T> | NextTrackCleanupDecision | null => {
  const { tracks, getTrackId, isPlayable } = options;
  if (tracks.length === 0) return null;

  const currentTrackId = normalizeTrackId(options.currentTrackId);
  const queuedNextTrackIdsToConsume: string[] = [];
  for (const queuedIdValue of options.queuedNextTrackIds ?? []) {
    const queuedId = normalizeTrackId(queuedIdValue);
    if (!queuedId || queuedId === currentTrackId) {
      if (queuedId) queuedNextTrackIdsToConsume.push(queuedId);
      continue;
    }
    const targetIndex = tracks.findIndex(
      (track) => normalizeTrackId(getTrackId(track)) === queuedId,
    );
    if (targetIndex < 0 || !isPlayable(tracks[targetIndex]!)) {
      queuedNextTrackIdsToConsume.push(queuedId);
      continue;
    }
    queuedNextTrackIdsToConsume.push(queuedId);
    return {
      track: tracks[targetIndex]!,
      targetTrackId: queuedId,
      targetIndex,
      reason: 'queued-next',
      queuedNextTrackId: queuedId,
      queuedNextTrackIdsToConsume,
    };
  }
  return queuedNextTrackIdsToConsume.length > 0
    ? {
        track: null,
        targetTrackId: null,
        targetIndex: -1,
        reason: 'cleanup',
        queuedNextTrackId: null,
        queuedNextTrackIdsToConsume,
      }
    : null;
};

export const buildNextTrackDecisionKey = (options: {
  queueId: string | null | undefined;
  queueRevision: number;
  currentTrackId: string | number | null | undefined;
  targetTrackId: string | number | null | undefined;
  mode: OrderedPlaybackMode;
  reason: NextTrackTargetDecision<unknown>['reason'];
  queuedNextTrackId?: string | null;
}): string =>
  [
    normalizeTrackId(options.queueId),
    Math.max(0, Math.floor(options.queueRevision || 0)),
    normalizeTrackId(options.currentTrackId),
    normalizeTrackId(options.targetTrackId),
    options.mode,
    options.reason,
    normalizeTrackId(options.queuedNextTrackId),
  ].join('|');
