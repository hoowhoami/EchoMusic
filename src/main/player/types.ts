/** 播放状态 */
export interface PlayerState {
  playing: boolean;
  paused: boolean;
  duration: number;
  timePos: number;
  volume: number;
  speed: number;
  idle: boolean;
  /** 当前播放的 URL */
  path: string;
  audioDevice: string;
  audioTrackId: number;
}

/** 音频设备信息 */
export interface PlayerAudioDevice {
  name: string;
  description: string;
}

/** 音轨信息 */
export interface PlayerTrackInfo {
  id: number;
  type: string;
  codec: string;
  title?: string;
  lang?: string;
}
