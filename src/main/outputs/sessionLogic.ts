/**
 * 输出会话的纯决策逻辑（可测，不依赖 Electron/native）。
 *
 * 职责（design §4）：
 * - routeEpoch：目标切换使旧 generation 失效，旧事件不得推动新队列。
 * - STOPPED vs EOF：结合当前 URI、时长、位置与 pending command 判定，
 *   自然结束只推进一次；用户停止 / 外部接管 / 错误不算 EOF。
 * - 能力降级：命令被拒后下调能力，不只信协议标识。
 */
import type {
  OutputBackendSemantics,
  OutputCapability,
  OutputProtocol,
} from '../../shared/playbackOutput';

export interface RemoteStopContext {
  currentUri: string;
  eventUri: string | null;
  durationSec: number | null;
  positionSec: number;
  /** 设备报告的 TransportState = STOPPED / NO_MEDIA_PRESENT 等 */
  reportedState: string;
  pendingCommand: 'play' | 'pause' | 'seek' | 'next' | 'stop' | 'none';
  sessionEpoch: number;
  activeEpoch: number;
  trackGeneration: number;
  activeGeneration: number;
  ceassedLastPoll: boolean;
  /** 贴近曲尾（位置 + 缓冲余量 >= duration） */
  nearEnd: boolean;
}

export type StopClassification =
  | { kind: 'eof'; proceed: true }
  | { kind: 'user-stop'; proceed: false }
  | { kind: 'other-controller'; proceed: false }
  | { kind: 'error'; proceed: false }
  | { kind: 'stale'; proceed: false }
  | { kind: 'pending-command'; proceed: false };

const STOPPED_STATES = ['STOPPED', 'NO_MEDIA_PRESENT', 'IDLE'];

/**
 * EOF 判定：远端 STOPPED 不能直接当作 EOF。
 * 1) 旧会话/旧代事件 -> stale，丢弃。
 * 2) pending command 未了结 -> 不推进；由后续观测再判。
 * 3) 位置/URI 不吻合 -> other-controller 接管或错误。
 * 4) 贴近曲尾 -> eof；否则 user-stop/error。
 */
export function classifyRemoteStop(ctx: RemoteStopContext): StopClassification {
  if (ctx.sessionEpoch !== ctx.activeEpoch || ctx.trackGeneration !== ctx.activeGeneration) {
    return { kind: 'stale', proceed: false };
  }
  if (ctx.currentUri && ctx.eventUri && ctx.eventUri !== ctx.currentUri) {
    return { kind: 'other-controller', proceed: false };
  }
  if (ctx.pendingCommand !== 'none') {
    // 我们自己的命令可能刚把设备带到 STOPPED（如 stop/seek 边界）。
    return { kind: 'pending-command', proceed: false };
  }
  if (ctx.eventUri !== null && ctx.eventUri !== ctx.currentUri)
    return { kind: 'other-controller', proceed: false };

  const stopped = STOPPED_STATES.some((s) => ctx.reportedState.toUpperCase().includes(s));
  if (!stopped) return { kind: 'user-stop', proceed: false };

  const atEnd =
    ctx.durationSec != null &&
    Number.isFinite(ctx.durationSec) &&
    ctx.durationSec > 0 &&
    ctx.positionSec >= ctx.durationSec - 2.5;

  if (ctx.nearEnd || atEnd) return { kind: 'eof', proceed: true };
  // 已知时长但停在中间：用户停止或外部控制。
  if (ctx.durationSec != null && ctx.durationSec > 0) return { kind: 'user-stop', proceed: false };
  // 时长未知：无法证明自然结束。
  return { kind: 'user-stop', proceed: false };
}

/** EOF 校验：自然结束只推进一次（配合宿主侧 generation 递增）。 */
export function shouldEmitPlaybackEnded(
  prev: StopClassification,
  next: StopClassification,
): boolean {
  return prev.kind !== 'eof' && next.kind === 'eof';
}

export interface EpochGate {
  routeEpoch: number;
  trackGeneration: number;
}

/** 会话竞争：事件/结果只有在 epoch 与 generation 都匹配时才被接受。 */
export function acceptsEvent(
  gate: EpochGate,
  event: { routeEpoch?: number; trackGeneration?: number },
): boolean {
  if (event.routeEpoch !== undefined && event.routeEpoch !== gate.routeEpoch) return false;
  if (event.trackGeneration !== undefined && event.trackGeneration !== gate.trackGeneration) {
    return false;
  }
  return true;
}

/** 目标切换：旧 generation 全部作废，成功提交后返回新的 active gate。 */
export function advanceGate(previous: EpochGate, bumpGeneration: boolean): EpochGate {
  return {
    routeEpoch: previous.routeEpoch + 1,
    trackGeneration: bumpGeneration ? previous.trackGeneration + 1 : previous.trackGeneration,
  };
}

export interface CommandResult {
  ok: boolean;
  rejectedAction?: 'pause' | 'seek' | 'volume' | 'mute' | 'rate';
}

/** 能力降级：失败命令下调对应能力，未知保持不可保证。 */
export function degradeCapability(cap: OutputCapability, result: CommandResult): OutputCapability {
  const next = { ...cap };
  if (!result.ok) {
    switch (result.rejectedAction) {
      case 'pause':
        next.pause = false;
        break;
      case 'seek':
        next.seek = 'none';
        break;
      case 'volume':
        next.volume = false;
        break;
      case 'mute':
        next.mute = false;
        break;
      case 'rate':
        next.rate = false;
        break;
    }
  }
  return next;
}

/** 音量映射：DLNA 0-100 直通；AirPlay 用遥控音量（0-100），避免本机二次衰减。 */
export function applyRemoteVolumePolicy(volume0to100: number): number {
  return Math.max(0, Math.min(100, Math.round(volume0to100)));
}

/** 时钟模型：短时插值 + 定期校正；数据过期即停止伪装精确进度。 */
export const POSITION_VALIDITY_MS = 15_000;

export function interpolatePosition(
  observed: { positionSec: number; observedAt: number },
  clock: { timestamp: number; accuracy: 'accurate' | 'approximate' },
): { positionSec: number; accuracy: 'accurate' | 'approximate' | 'unknown' } {
  if (
    clock.accuracy === 'accurate' &&
    clock.timestamp - observed.observedAt <= POSITION_VALIDITY_MS
  ) {
    return { positionSec: observed.positionSec, accuracy: 'accurate' };
  }
  return { positionSec: observed.positionSec, accuracy: 'unknown' };
}

export function protocolBackendSemantics(protocol: OutputProtocol): OutputBackendSemantics {
  switch (protocol) {
    case 'dlna':
      return 'remote-media';
    case 'airplay':
      return 'local-pcm';
    default:
      return 'remote-media';
  }
}

/** 断线默认暂停：不自动外放、不推进队列；保留最近可信位置。 */
export function handleDisconnect(prevPosition: number): {
  paused: true;
  lastKnownPositionSec: number;
} {
  return { paused: true, lastKnownPositionSec: prevPosition };
}
