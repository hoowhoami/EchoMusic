import type { PlayerState } from '../renderer/stores/player/state';
import type { PlaybackQueueState } from '../renderer/stores/playlist/types';

// Runtime metadata belongs to the live engine, not the persisted startup queue.
export const PLAYER_SESSION_KEYS = [
  'currentTrackId',
  'currentSourceQueueId',
  'currentTrackSnapshot',
  'currentPlaylist',
  'nativeTrackSeq',
  'currentAudioUrl',
  'currentPlaybackSource',
  'currentAudioCandidateUrls',
  'currentAudioCandidateSources',
  'currentAudioCandidateIndex',
  'currentResolvedAudioQuality',
  'currentResolvedAudioEffect',
  'currentResolvedAudioLoudness',
  'currentResolvedSourceKind',
  'currentAudioQualityOverride',
  'currentCatalogSourceOverrideTrackId',
  'currentCloudSourceOverrideTrackId',
  'historyUploadCommitted',
  'historyUploadTrackId',
  'historyLocalRecorded',
  'climaxMarks',
] as const satisfies readonly (keyof PlayerState)[];

export interface PlayerRuntimeSession {
  player: Pick<PlayerState, (typeof PLAYER_SESSION_KEYS)[number]>;
  queue: PlaybackQueueState | null;
}

export interface PlayerSessionTransport {
  playing: boolean;
  paused: boolean;
  duration: number;
  timePos: number;
  idle?: boolean;
  trackSeq?: number;
  speed?: number;
}

export interface PlayerSessionRestore {
  session: PlayerRuntimeSession;
  transport: PlayerSessionTransport;
}

export const matchesPlayerSession = (
  session: PlayerRuntimeSession | null,
  transport: PlayerSessionTransport | null,
): boolean =>
  Boolean(
    session &&
    transport &&
    !transport.idle &&
    Number(session.player.nativeTrackSeq) > 0 &&
    session.player.nativeTrackSeq === transport.trackSeq &&
    session.player.currentTrackId &&
    String(session.player.currentTrackSnapshot?.id ?? '') === session.player.currentTrackId &&
    session.player.currentAudioUrl,
  );
