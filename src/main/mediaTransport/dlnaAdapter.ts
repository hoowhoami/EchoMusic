/**
 * dlnaAdapter.ts —— 宿主 DLNA 远程媒体后端（design §5"宿主统一输出会话 + 内部协议适配器"）。
 *
 * 契约（对齐 outputs/sessionManager 的 OutputBackendLike，测试注入 mock，不依赖 .node）：
 * - 把宿主输出命令翻译成 AVTransport / RenderingControl SOAP action（经 echo-upnp
 *   原生 loadDevice / action / clearDeviceCache）；
 * - 以 didlLite.buildDidlLite 生成 CurrentURIMetaData，复用输出会话门（sessionLogic 的
 *   EpochGate + advanceGate + acceptsEvent）过滤旧纪元事件；
 * - LastChange（genaReceiver.parseLastChange）驱动的只是"上报分类"，命令面完全走 SOAP action；
 * - 命令失败走 sessionLogic.degradeCapability 降级，不改变会话门（routeEpoch/trackGeneration）。
 *
 * 本文件不触碰插件 API；renderer 的 player:* 契约不变。
 */
import { EventEmitter } from 'events';
import type { OutputBackendLike } from '../outputs/sessionManager';
import {
  type OutputCapability,
  type OutputSessionSnapshot,
  type OutputTrackMeta,
} from '../../shared/playbackOutput';
import {
  acceptsEvent,
  advanceGate,
  classifyRemoteStop,
  degradeCapability,
  shouldEmitPlaybackEnded,
  type CommandResult,
  type EpochGate,
  type RemoteStopContext,
  type StopClassification,
} from '../outputs/sessionLogic';
import { buildDidlLite, formatUpnpDuration } from './didlLite';
import { parseLastChange } from './genaReceiver';

/** echo-upnp 原生桥接面（测试注入 mock，不依赖 .node）。 */
export interface UpnpNativeLike {
  loadDevice(descriptionUrl: string): Promise<UpnpDeviceSnapshot>;
  action(
    descriptionUrl: string,
    serviceId: string,
    actionName: string,
    args: Record<string, string>,
  ): Promise<Record<string, string>>;
  clearDeviceCache(): Promise<void>;
}

export interface UpnpServiceEndpoint {
  serviceId: string;
  serviceType: string;
  controlUrl: string;
  eventSubUrl: string;
}

export interface UpnpDeviceSnapshot {
  descriptionUrl: string;
  deviceType: string;
  friendlyName: string;
  services: UpnpServiceEndpoint[];
}

export interface DlnaAdapterDeps {
  descriptionUrl: string;
  targetId: string;
  displayName: string;
  routeEpoch: number;
  trackGeneration: number;
  native: UpnpNativeLike;
  bus: EventEmitter;
  now?: () => number;
  /** 设备描述里的 serviceId。缺省保持旧的服务类型 URN，供既有单测使用。 */
  avTransportServiceId?: string;
  renderingControlServiceId?: string;
}

export interface DlnaCommand {
  instanceId?: string;
  speed?: string;
  unit?: string;
  target?: string;
  channel?: string;
  desiredVolume?: number;
  currentUri?: string;
  currentUriMetaData?: string;
}

export const AV_TRANSPORT_SERVICE = 'urn:schemas-upnp-org:service:AVTransport:1';
export const RENDERING_CONTROL_SERVICE = 'urn:schemas-upnp-org:service:RenderingControl:1';

const STOPPED_STATES = new Set(['STOPPED', 'NO_MEDIA_PRESENT', 'IDLE']);

export { formatUpnpDuration } from './didlLite';

function parseUpnpDuration(value: string | undefined): number | null {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value ?? '');
  if (!match) return null;
  const [hours, minutes, seconds] = match.slice(1).map(Number);
  return minutes < 60 && seconds < 60 ? hours * 3600 + minutes * 60 + seconds : null;
}

export class DlnaBackend implements OutputBackendLike {
  readonly protocol = 'dlna' as const;
  readonly semantics = 'remote-media' as const;
  private readonly deps: DlnaAdapterDeps;
  private readonly bus: EventEmitter;
  private readonly now: () => number;
  private gate: EpochGate;
  private currentCapabilities: OutputCapability = {
    pause: true,
    seek: 'by-time',
    volume: true,
    mute: false,
    rate: false,
    position: 'approximate',
    nextUri: false,
    gapless: false,
    dsp: false,
    spectrum: false,
  };
  private currentUri = '';
  private durationSec: number | null = null;
  private volume: number | null = null;
  private trackMeta: OutputTrackMeta = {};
  private pendingCommand: RemoteStopContext['pendingCommand'] = 'none';
  private lastKnownState = 'STOPPED';
  private lastKnownPositionSec = 0;
  private positionUpdatedAt = 0;
  private lastClassification: StopClassification = {
    kind: 'user-stop',
    proceed: false,
  };
  private readonly avTransportId: string;
  private readonly renderingId: string;
  private sourceMime = 'audio/*';

  constructor(deps: DlnaAdapterDeps) {
    this.deps = deps;
    this.bus = deps.bus;
    this.now = deps.now ?? (() => Date.now());
    this.gate = { routeEpoch: deps.routeEpoch, trackGeneration: deps.trackGeneration };
    this.avTransportId = deps.avTransportServiceId || AV_TRANSPORT_SERVICE;
    this.renderingId = deps.renderingControlServiceId || RENDERING_CONTROL_SERVICE;
  }

  /** 宿主在 load 前声明探测到的 MIME。不改变音源内容。 */
  setSourceHint(hint: { mime?: string | null; relayed?: boolean }): void {
    if (hint.mime?.trim()) this.sourceMime = hint.mime.trim();
    if (hint.relayed != null)
      this.currentCapabilities = { ...this.currentCapabilities, relayed: hint.relayed };
  }

  private didlFor(url: string, title?: string): string {
    return buildDidlLite({
      title: this.trackMeta.title || title || url,
      artist: this.trackMeta.artist,
      album: this.trackMeta.album,
      coverUrl: this.trackMeta.artwork,
      url,
      mime: this.sourceMime,
      durationSec: this.trackMeta.durationMs != null ? this.trackMeta.durationMs / 1000 : undefined,
    });
  }

  beginSourceChange(): number {
    return this.gate.routeEpoch;
  }

  async load(url: string): Promise<{ seq: number; duration: number } | null> {
    const meta = this.didlFor(url);
    await this.soap(this.avTransportId, 'SetAVTransportURI', {
      InstanceID: '0',
      CurrentURI: url,
      CurrentURIMetaData: meta,
    });
    this.gate = advanceGate(this.gate, true);
    this.recordLoadedSource(url);
    return { seq: this.gate.trackGeneration, duration: this.durationSec ?? 0 };
  }

  async loadMkv(url: string, trackId: number): Promise<{ seq: number; duration: number } | null> {
    const meta = this.didlFor(url, `track-${trackId}`);
    await this.soap(this.avTransportId, 'SetAVTransportURI', {
      InstanceID: '0',
      CurrentURI: url,
      CurrentURIMetaData: meta,
    });
    this.gate = advanceGate(this.gate, true);
    this.recordLoadedSource(url);
    return { seq: this.gate.trackGeneration, duration: this.durationSec ?? 0 };
  }

  private recordLoadedSource(url: string): void {
    this.currentUri = url;
    this.durationSec = this.trackMeta.durationMs != null ? this.trackMeta.durationMs / 1000 : null;
    this.lastKnownPositionSec = 0;
    this.positionUpdatedAt = this.now();
    this.lastKnownState = 'STOPPED';
    this.pendingCommand = 'none';
    this.lastClassification = { kind: 'user-stop', proceed: false };
  }

  async setTrackMeta(meta: OutputTrackMeta): Promise<void> {
    this.trackMeta = { ...meta };
  }

  async switchSource(
    url: string,
    trackId?: number | null,
  ): Promise<[number, number, number] | null> {
    const position = this.lastKnownPositionSec;
    const wasPlaying = this.lastKnownState === 'PLAYING';
    const loaded = trackId == null ? await this.load(url) : await this.loadMkv(url, trackId);
    if (!loaded) return null;
    if (position > 0) await this.seek(position);
    if (wasPlaying) await this.play();
    return [position, loaded.duration, loaded.seq];
  }

  async play(): Promise<void> {
    await this.soap(this.avTransportId, 'Play', { InstanceID: '0', Speed: '1' });
    this.pendingCommand = 'none';
    this.lastKnownState = 'PLAYING';
  }

  async pause(): Promise<void> {
    await this.soap(this.avTransportId, 'Pause', { InstanceID: '0' });
    this.lastKnownState = 'PAUSED_PLAYBACK';
  }

  async stop(): Promise<void> {
    this.pendingCommand = 'stop';
    try {
      await this.soap(this.avTransportId, 'Stop', { InstanceID: '0' });
    } catch (error) {
      this.pendingCommand = 'none';
      throw error;
    }
    this.lastKnownState = 'STOPPED';
    this.lastKnownPositionSec = 0;
  }

  async seek(timeSec: number): Promise<void> {
    await this.soap(this.avTransportId, 'Seek', {
      InstanceID: '0',
      Unit: 'REL_TIME',
      Target: formatUpnpDuration(timeSec) ?? '00:00:00',
    });
    this.lastKnownPositionSec = timeSec;
  }

  async setVolume(volume: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(volume)));
    await this.soap(this.renderingId, 'SetVolume', {
      InstanceID: '0',
      Channel: 'Master',
      DesiredVolume: String(clamped),
    });
    this.volume = clamped;
  }

  async getState(): Promise<OutputSessionSnapshot> {
    const state: OutputSessionSnapshot['state'] =
      this.lastKnownState === 'PLAYING'
        ? 'playing'
        : this.lastKnownState === 'PAUSED_PLAYBACK'
          ? 'paused'
          : STOPPED_STATES.has(this.lastKnownState)
            ? 'stopped'
            : 'unknown';
    return {
      sessionId: `${this.protocol}:${this.gate.routeEpoch}`,
      routeEpoch: this.gate.routeEpoch,
      trackGeneration: this.gate.trackGeneration,
      protocol: this.protocol,
      targetId: this.deps.targetId,
      displayName: this.deps.displayName,
      state,
      positionSec: this.lastKnownPositionSec,
      observedAt: this.positionUpdatedAt,
      clockAccuracy: this.positionUpdatedAt > 0 ? 'approximate' : 'unknown',
      durationSec: this.durationSec,
      actualFormat: null,
      volume: this.volume,
      capabilities: { ...this.currentCapabilities },
    };
  }

  async isBusy(): Promise<boolean> {
    return this.lastKnownState !== 'STOPPED';
  }

  /** LastChange 上报：只做事件分类与纪元过滤，不在此重放命令。 */
  private async soap(
    serviceId: string,
    actionName: string,
    args: Record<string, string>,
  ): Promise<Record<string, string>> {
    try {
      return await this.deps.native.action(this.deps.descriptionUrl, serviceId, actionName, args);
    } catch (e) {
      const rejectedAction: CommandResult['rejectedAction'] =
        actionName === 'Pause'
          ? 'pause'
          : actionName === 'Seek'
            ? 'seek'
            : actionName === 'SetVolume'
              ? 'volume'
              : undefined;
      this.currentCapabilities = degradeCapability(this.currentCapabilities, {
        ok: false,
        rejectedAction,
      });
      throw e;
    }
  }

  /**
   * 轮询或 GENA 共用的观测入口。pending 命令只抑制这一次判定，
   * 避免用户 Stop 之后把曲尾的下一次 STOPPED 永久当成非 EOF。
   */
  observeTransport(
    update: {
      transportState?: string;
      positionSec?: number | null;
      durationSec?: number | null;
      trackUri?: string | null;
    },
    eventGate: EpochGate = this.gate,
  ): void {
    if (!acceptsEvent(this.gate, eventGate)) return;
    if (update.durationSec != null && Number.isFinite(update.durationSec)) {
      this.durationSec = update.durationSec;
    }
    if (update.positionSec != null && Number.isFinite(update.positionSec)) {
      this.lastKnownPositionSec = update.positionSec;
      this.positionUpdatedAt = this.now();
    }
    const state = update.transportState;
    if (!state) return;
    const prev = this.lastClassification;
    if (!STOPPED_STATES.has(state)) {
      this.lastKnownState = state;
      return;
    }
    this.lastKnownState = state;
    const next = classifyRemoteStop({
      currentUri: this.currentUri,
      eventUri: update.trackUri ?? null,
      durationSec: this.durationSec,
      positionSec: this.lastKnownPositionSec,
      reportedState: state,
      pendingCommand: this.pendingCommand,
      sessionEpoch: eventGate.routeEpoch,
      activeEpoch: this.gate.routeEpoch,
      trackGeneration: eventGate.trackGeneration,
      activeGeneration: this.gate.trackGeneration,
      ceassedLastPoll: true,
      nearEnd: false,
    });
    if (this.pendingCommand !== 'none') this.pendingCommand = 'none';
    if (next.kind === 'other-controller' && prev.kind !== 'other-controller') {
      this.bus.emit('taken-over', { targetId: this.deps.targetId });
    }
    if (shouldEmitPlaybackEnded(prev, next)) {
      this.bus.emit('playback-ended', {
        targetId: this.deps.targetId,
        trackGeneration: this.gate.trackGeneration,
        routeEpoch: this.gate.routeEpoch,
      });
    }
    this.lastClassification = next;
  }

  /** LastChange 上报：只做事件分类与纪元过滤，不在此重放命令。 */
  handleLastChange(payload: string, eventGate: EpochGate = this.gate): void {
    const parsed = parseLastChange(payload);
    if (!parsed) return;
    this.observeTransport(
      {
        transportState: parsed.values.TransportState,
        positionSec: parseUpnpDuration(parsed.values.RelativeTimePosition),
        durationSec: parseUpnpDuration(parsed.values.CurrentTrackDuration),
        trackUri: parsed.values.CurrentTrackURI ?? parsed.values.AVTransportURI ?? null,
      },
      eventGate,
    );
  }
}
