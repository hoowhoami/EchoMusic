type TimedPlaybackContext = {
  trackSeq?: number;
  generation?: number;
  updatedAt: number;
  revision: number;
};

type CoreBufferingState = TimedPlaybackContext & {
  state?: string;
};

type AudioOutputBufferingState = TimedPlaybackContext & {
  paused?: boolean;
  bufferingState?: number;
};

export const shouldShowPlaybackBuffering = (options: {
  core: CoreBufferingState | null;
  ao: AudioOutputBufferingState | null;
  isPlaying: boolean;
  nativePlaybackProgressRevision: number;
}): boolean => {
  const { core, ao, isPlaying, nativePlaybackProgressRevision } = options;
  if (!isPlaying) return false;

  const coreState = String(core?.state ?? '').toLowerCase();
  const coreTrackSeq = Number(core?.trackSeq);
  const aoTrackSeq = Number(ao?.trackSeq);
  const coreGeneration = Number(core?.generation);
  const aoGeneration = Number(ao?.generation);
  const aoBufferingState = Number(ao?.bufferingState);
  const sameTrack =
    !Number.isFinite(coreTrackSeq) || !Number.isFinite(aoTrackSeq) || coreTrackSeq === aoTrackSeq;
  const sameGeneration =
    !Number.isFinite(coreGeneration) ||
    !Number.isFinite(aoGeneration) ||
    coreGeneration === aoGeneration;
  const latestBufferingRevision = Math.max(core?.revision ?? 0, ao?.revision ?? 0);

  // A contextual native time-update is emitted only after the actual output sample
  // count advances. It therefore invalidates older buffering snapshots from either
  // asynchronous diagnostic stream.
  return (
    coreState === 'buffering' &&
    ao?.paused === true &&
    Number.isFinite(aoBufferingState) &&
    aoBufferingState < 100 &&
    sameTrack &&
    sameGeneration &&
    nativePlaybackProgressRevision <= latestBufferingRevision
  );
};
