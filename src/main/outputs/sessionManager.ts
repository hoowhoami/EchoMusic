/**
 * OutputSessionManager —— 宿主唯一活动输出会话。
 *
 * 职责（design §4、§9）：
 * - 持有 routeEpoch / trackGeneration；旧会话事件不得推动新队列。
 * - 将 renderer 既有 player:* 控制路由到当前后端（本机 / DLNA / AirPlay）。
 * - 统一事件总线：本机 PlayerController 与远端适配器的事件按活动后端切换；
 *   旧纪元事件在总线入口被丢弃。
 * - 断线默认暂停并保留队列；不自动外放。
 *
 * 本类不直接触碰原生；后端对象通过依赖注入，便于对会话竞争/EOF/取消做单测。
 */
import { EventEmitter } from 'events';
import type {
  OutputBackendSemantics,
  OutputCapability,
  OutputProtocol,
  OutputSessionSnapshot,
  OutputTargetEntry,
  OutputTrackMeta,
} from '../../shared/playbackOutput';
import { DEFAULT_OUTPUT_CAPABILITIES } from '../../shared/playbackOutput';
import { acceptsEvent, advanceGate, type EpochGate } from './sessionLogic';

export interface OutputBackendLike {
  readonly protocol: OutputProtocol;
  readonly semantics: OutputBackendSemantics;
  beginSourceChange(): number;
  load(url: string, requestId?: number): Promise<{ seq: number; duration: number } | null>;
  loadMkv(
    url: string,
    trackId: number,
    requestId?: number,
  ): Promise<{ seq: number; duration: number } | null>;
  switchSource(url: string, trackId?: number | null): Promise<[number, number, number] | null>;
  play(requestId?: number): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(time: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  getState(): unknown;
  isBusy(): Promise<boolean>;
  setTrackMeta?(meta: OutputTrackMeta): Promise<void>;
}

export interface OutputAdapterHandle {
  connect(options: {
    targetId?: string;
    protocol: OutputProtocol;
  }): Promise<{ ok: boolean; error?: string }>;
  disconnect(reason?: string): Promise<void>;
  getTargets(): OutputTargetEntry[];
  refreshTargets(): Promise<OutputTargetEntry[]>;
  getCapabilities(): OutputCapability;
  setEnabled(enabled: boolean): void;
  clearRecords(): Promise<void>;
  readonly outputEvents: EventEmitter;
}

export interface SessionManagerDeps {
  /** 事件总线（对外就是 player 转发总线） */
  bus: EventEmitter;
  /** 远端/设备相关事件广播 */
  notify?: (event: { type: string; payload?: unknown }) => void;
  now?: () => number;
}

export type ActiveOutput =
  | { kind: 'local'; backend: OutputBackendLike }
  | {
      kind: 'session';
      protocol: OutputProtocol;
      backend: OutputBackendLike;
      adapter: OutputAdapterHandle;
    };

export class OutputSessionManager {
  private readonly bus: EventEmitter;
  private readonly notify?: (event: { type: string; payload?: unknown }) => void;
  private readonly now: () => number;
  private local: OutputBackendLike | null = null;
  private active: ActiveOutput | null = null;
  private gate: EpochGate = { routeEpoch: 0, trackGeneration: 0 };
  private sourceRequestSeq = 0;
  private trackMeta: OutputTrackMeta | null = null;
  private sessionSnapshot: OutputSessionSnapshot | null = null;
  private pendingAdapter: OutputAdapterHandle | null = null;
  private subscribedAdapter: OutputAdapterHandle | null = null;
  private lastKnownPositionSec = 0;
  private capabilities: OutputCapability = { ...DEFAULT_OUTPUT_CAPABILITIES };

  constructor(deps: SessionManagerDeps) {
    this.bus = deps.bus;
    this.notify = deps.notify;
    this.now = deps.now ?? (() => Date.now());
  }

  attachBackend(backend: OutputBackendLike): void {
    if (backend.protocol === 'local') this.local = backend;
  }

  get currentProtocol(): OutputProtocol {
    return this.active?.kind === 'session' ? this.active.protocol : 'local';
  }

  get isRemote(): boolean {
    return this.active?.kind === 'session' && this.active.protocol !== 'airplay';
  }

  get gateSnapshot(): EpochGate {
    return { ...this.gate };
  }

  emitSessionChanged(): void {
    const snapshot = this.buildSnapshot();
    this.sessionSnapshot = snapshot;
    this.notify?.({ type: 'session-changed', payload: snapshot });
  }

  buildSnapshot(): OutputSessionSnapshot {
    const active = this.active;
    return {
      sessionId:
        active && active.kind === 'session'
          ? `${active.protocol}:${this.gate.routeEpoch}`
          : 'local',
      routeEpoch: this.gate.routeEpoch,
      protocol: active && active.kind === 'session' ? active.protocol : 'local',
      targetId: active && active.kind === 'session' ? (this.lastTargetId ?? null) : null,
      displayName: active && active.kind === 'session' ? (this.lastTargetName ?? '') : '',
      state: active && active.kind === 'session' ? 'unknown' : 'idle',
      trackGeneration: this.gate.trackGeneration,
      positionSec: this.lastKnownPositionSec,
      observedAt: this.now(),
      clockAccuracy: 'unknown',
      durationSec: null,
      actualFormat: null,
      volume: null,
      capabilities: { ...this.capabilities },
    };
  }

  private lastTargetId: string | null = null;
  private lastTargetName = '';

  // ── 设备连接/切换 ──

  async connectAdapter(
    adapter: OutputAdapterHandle,
    options: { targetId?: string; protocol: OutputProtocol },
  ): Promise<{ ok: boolean; error?: string }> {
    // 切换流程：保留旧输出播放，先准备新目标，成功后才提交路由。
    const result = await adapter.connect(options);
    if (!result.ok) return result;
    const old = this.active;
    this.gate = advanceGate(this.gate, true);
    this.capabilities = adapter.getCapabilities();
    this.subscribeAdapter(adapter);
    this.active = {
      kind: 'session',
      protocol: options.protocol,
      backend: adapter as unknown as OutputBackendLike,
      adapter,
    };
    this.lastTargetId = options.targetId ?? null;
    this.lastTargetName =
      adapter.getTargets().find((t) => t.targetId === options.targetId)?.displayName ?? '';
    try {
      if (old?.kind === 'session' && old.adapter !== adapter) {
        await old.adapter.disconnect('switch');
      }
    } catch {
      // 尽力清理旧目标。
    }
    this.emitSessionChanged();
    return { ok: true };
  }

  async activateLocal(reason = 'user'): Promise<void> {
    const old = this.active;
    if (old && old.kind === 'session') {
      try {
        await old.adapter.disconnect(reason);
      } catch {
        // 尽力清理。
      }
      this.unsubscribeAdapter(old.adapter);
      this.pendingAdapter = null;
    }
    this.gate = advanceGate(this.gate, true);
    this.active = null;
    this.emitSessionChanged();
  }

  // 只有成功提交的路由才算活动；未提交的 connect 失败时清理新目标。
  get hasActiveSession(): boolean {
    return this.active?.kind === 'session';
  }

  private subscribeAdapter(adapter: OutputAdapterHandle): void {
    if (this.subscribedAdapter === adapter) return;
    this.subscribedAdapter = adapter;
    adapter.outputEvents.on('remote-event', (payload) => {
      if (
        !acceptsEvent(this.gate, {
          routeEpoch: payload?.routeEpoch,
          trackGeneration: payload?.trackGeneration,
        })
      ) {
        return;
      }
      if (payload.type === 'playback-end' && payload.reason === 'eof') {
        // 自然结束只推进一次 —— 由 adapter 内部守卫；这里按 generation 去重。
        if (payload.trackGeneration !== this.gate.trackGeneration) return;
      }
      if (payload.type === 'position') {
        this.lastKnownPositionSec = payload.positionSec;
      }
      const name = this.controllerEventName(payload.type);
      if (name) this.bus.emit(name, payload.p);
    });
  }

  private unsubscribeAdapter(adapter: OutputAdapterHandle): void {
    if (this.subscribedAdapter === adapter) {
      adapter.outputEvents.removeAllListeners('remote-event');
      this.subscribedAdapter = null;
    }
  }

  /** 控制器事件名 → player 总线事件名（本机与远端事件契约一致）。 */
  private controllerEventName(type: string): string | null {
    switch (type) {
      case 'time-update':
      case 'seeked':
      case 'seek-state-change':
      case 'playback-restart':
      case 'duration-change':
      case 'file-loaded':
      case 'state-change':
      case 'core-state-change':
      case 'ao-state-change':
      case 'playback-end':
      case 'stalled':
      case 'error':
      case 'audio-device-list-changed':
      case 'packet-cache-stats':
      case 'audio-output-stats':
      case 'audio-graph-change':
        return type;
      default:
        return null;
    }
  }

  // ── 播放命令路由（renderer 既有 player:* 语义不变） ──

  activeBackend(): OutputBackendLike {
    if (this.active?.kind === 'session') return this.active.backend;
    if (!this.local) throw new Error('播放器未初始化');
    return this.local;
  }

  beginSourceChange(): number {
    const id = ++this.sourceRequestSeq;
    if (this.active?.kind === 'session') {
      try {
        this.active.backend.beginSourceChange();
      } catch {
        // fallthrough
      }
    } else {
      this.local?.beginSourceChange();
    }
    return id;
  }

  async load(url: string, requestId?: number) {
    // 先让音源 URL 在 Host 中登记为会话媒体资源（DLNA 适配器内部完成 token 化）。
    if (this.active?.kind === 'session') {
      const backend = this.active.backend;
      await backend.setTrackMeta?.(this.trackMeta ?? {});
      return backend.load(url, requestId);
    }
    return this.local?.load(url, requestId) ?? null;
  }

  async loadMkv(url: string, trackId: number, requestId?: number) {
    if (this.active?.kind === 'session') {
      const backend = this.active.backend;
      await backend.setTrackMeta?.(this.trackMeta ?? {});
      return backend.loadMkv(url, trackId, requestId);
    }
    return this.local?.loadMkv(url, trackId, requestId) ?? null;
  }

  async switchSource(url: string, trackId?: number | null) {
    if (this.active?.kind === 'session') {
      const backend = this.active.backend;
      await backend.setTrackMeta?.(this.trackMeta ?? {});
      return backend.switchSource(url, trackId);
    }
    return this.local?.switchSource(url, trackId) ?? null;
  }

  async play(requestId?: number) {
    return this.activeBackend().play(requestId);
  }

  async pause() {
    return this.activeBackend().pause();
  }

  async stop() {
    return this.activeBackend().stop();
  }

  async seek(time: number) {
    return this.activeBackend().seek(time);
  }

  async setVolume(volume: number) {
    return this.activeBackend().setVolume(volume);
  }

  getState() {
    return this.activeBackend().getState();
  }

  setTrackMeta(meta: OutputTrackMeta): void {
    this.trackMeta = { ...meta };
  }

  get trackMetaSnapshot(): OutputTrackMeta | null {
    return this.trackMeta ? { ...this.trackMeta } : null;
  }

  /** 断线默认暂停：adapter 应在断连时调用并保留最近可信位置。 */
  async handleConnectionLost(reason: string): Promise<void> {
    if (this.active?.kind !== 'session') return;
    const snapshot = this.buildSnapshot();
    this.lastKnownPositionSec = snapshot.positionSec;
    const active = this.active;
    this.unsubscribeAdapter(active.adapter);
    this.gate = advanceGate(this.gate, false);
    this.active = null;
    this.notify?.({
      type: 'session-ended',
      payload: { reason, lastKnownPositionSec: this.lastKnownPositionSec },
    });
  }
}
