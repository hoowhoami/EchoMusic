import type { PlayMode } from './playback';

export type TrayCommand =
  'togglePlayback' | 'previousTrack' | 'nextTrack' | 'volumeUp' | 'volumeDown' | 'toggleMute';

export type TrayPlaybackPayload = {
  isPlaying?: boolean;
  playMode?: PlayMode;
  volume?: number;
  /** 托盘菜单顶部展示的当前曲目信息；空串表示暂无曲目。 */
  trackTitle?: string;
  trackArtist?: string;
};
