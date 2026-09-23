/**
 * EchoMusic DLNA / AirPlay 发送 - 宿主内部输出会话共享契约。
 *
 * 本文件是宿主内部实现（design §7：设备路由状态不作为插件公开结构），
 * 不新增/修改任何插件 API。音源插件继续返回 ResolvedAudioSource，
 * 播放控制继续走既有 player:* 通道，由主进程路由到当前输出。
 */

export const OUTPUT_IPC_CHANNELS = {
  /** renderer -> main */
  ListTargets: 'output:list-targets',
  Refresh: 'output:refresh',
  Connect: 'output:connect',
  Disconnect: 'output:disconnect',
  SetEnabled: 'output:set-enabled',
  SetTrackMeta: 'output:set-track-meta',
  GetSession: 'output:get-session',
  ClearRecords: 'output:clear-records',
  /** main -> renderer */
  Event: 'output:event',
} as const;

export type OutputProtocol = 'local' | 'dlna' | 'airplay';

export type OutputBackendSemantics = 'remote-media' | 'local-pcm';

export interface OutputTargetIdentity {
  /** provider 内稳定目标身份，不使用会变化的 IP */
  targetId: string;
  protocol: OutputProtocol;
  displayName: string;
  /** 描述加载的主 location（DLNA）或 AirPlay 主机地址 */
  location?: string;
  addresses?: string[];
  manufacturer?: string;
  modelName?: string;
  modelNumber?: string;
  udn?: string;
  note?: string;
  paired?: boolean;
}

export interface OutputConnectionState {
  connected: boolean;
  available: boolean;
  busylight?: boolean;
  error?: string;
}

/** 发现条目（内部缓存经此序列化到 renderer） */
export interface OutputTargetEntry extends OutputTargetIdentity {
  lastSeenAt: number;
  connection: OutputConnectionState;
}

/**
 * 能力按设备和当前资源共同计算。未知即为不可保证；命令被拒后
 * 宿主下调能力，不只信协议标识（design §4）。
 */
export interface OutputCapability {
  pause: boolean;
  seek: 'by-time' | 'by-relative' | 'none';
  volume: boolean;
  mute: boolean;
  rate: boolean;
  position: 'accurate' | 'approximate' | 'none';
  nextUri: boolean;
  gapless: boolean;
  dsp: boolean;
  spectrum: boolean;
  /** 设备上传记录还是 EchoMusic 中转（远程媒体语义） */
  relayed?: boolean;
}

/** 会话成功提交后的快照（设计 §4 会话契约） */
export interface OutputSessionSnapshot {
  sessionId: string;
  routeEpoch: number;
  protocol: OutputProtocol;
  targetId: string | null;
  displayName: string;
  state: 'idle' | 'connecting' | 'playing' | 'paused' | 'stopped' | 'ended' | 'error' | 'unknown';
  trackGeneration: number;
  positionSec: number;
  observedAt: number;
  clockAccuracy: 'accurate' | 'approximate' | 'unknown';
  durationSec: number | null;
  actualFormat: string | null;
  volume: number | null;
  capabilities: OutputCapability;
}

export interface OutputEvent {
  type: 'targets-updated' | 'session-changed' | 'transport-error' | 'session-ended';
  payload?: unknown;
}

export interface OutputSessionDetail {
  snapshot: OutputSessionSnapshot | null;
  targets: OutputTargetEntry[];
}

export interface OutputTrackMeta {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: string;
  durationMs?: number;
}

/** DLNA 原曲直拉/中转决策（宿主内部） */
export interface DlnaMediaDelivery {
  mode: 'direct' | 'relay';
  url: string;
  mime: string | null;
  requiresHeaders: boolean;
}

export const DEFAULT_OUTPUT_CAPABILITIES: OutputCapability = {
  pause: false,
  seek: 'none',
  volume: false,
  mute: false,
  rate: false,
  position: 'none',
  nextUri: false,
  gapless: false,
  dsp: false,
  spectrum: false,
};

export const LOCAL_OUTPUT_CAPABILITIES: OutputCapability = {
  pause: true,
  seek: 'by-time',
  volume: true,
  mute: true,
  rate: true,
  position: 'accurate',
  nextUri: true,
  gapless: true,
  dsp: true,
  spectrum: true,
};
