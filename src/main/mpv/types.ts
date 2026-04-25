/** mpv 播放状态 */
export interface MpvState {
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
}

/** mpv JSON IPC 消息 */
export interface MpvMessage {
  event?: string;
  name?: string;
  data?: unknown;
  error?: string;
  request_id?: number;
  reason?: string;
}

/** mpv 音频设备信息 */
export interface MpvAudioDevice {
  name: string;
  description: string;
}

/** mpv 音轨信息 */
export interface MpvTrackInfo {
  id: number;
  type: string;
  codec: string;
  title?: string;
  lang?: string;
}
