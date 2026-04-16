import type { PlayMode } from './playback';

export type TrayCommand =
  | 'togglePlayback'
  | 'previousTrack'
  | 'nextTrack'
  | 'volumeUp'
  | 'volumeDown'
  | 'toggleMute';

export type TrayPlaybackPayload = {
  isPlaying?: boolean;
  playMode?: PlayMode;
  volume?: number;
};
