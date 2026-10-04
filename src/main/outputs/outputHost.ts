/**
 * 宿主输出会话。播放命令仍走既有 player:*；DLNA 原曲由这里接管，
 * AirPlay 继续用本机解码，只在旁边做发送、冲洗和音量。
 * 断线暂停并保留队列，不自动改回本机外放。
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type {
  OutputSessionSnapshot,
  OutputTargetEntry,
  OutputTrackMeta,
} from '../../shared/playbackOutput';
import { DEFAULT_PLAYER_VOLUME } from '../../shared/playback';
import { CommandGate } from './commandGate';
import { decideMediaDelivery, type RelaySource } from '../mediaTransport/delivery';
import {
  DlnaBackend,
  type UpnpDeviceSnapshot,
  type UpnpNativeLike,
} from '../mediaTransport/dlnaAdapter';
import { MediaServer } from '../mediaTransport/mediaServer';
import {
  endpointAllowed,
  findService,
  hostOf,
  isTransportOffline,
  parseUpnpTime,
  renewEvent,
  subscribeEvent,
  unsubscribeEvent,
} from '../mediaTransport/upnpClient';

export interface LocalTransport {
  beginSourceChange(): number;
  loadFile(url: string, requestId?: number): Promise<{ seq: number; duration: number } | null>;
  pause(): Promise<void>;
  play(requestId?: number): Promise<void>;
  stop(): Promise<void>;
  seek(time: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  getState(): {
    playing?: boolean;
    paused?: boolean;
    timePos?: number;
    duration?: number;
    volume?: number;
    path?: string;
    trackSeq?: number;
  } | null;
  setAudioOutput?(deviceName: string, exclusive: boolean): Promise<void>;
  getAudioDevices?(): Promise<Array<{ name: string; description: string; isDefault?: boolean }>>;
  setAirplayTap?(port: number, enabled: boolean): Promise<void>;
  setAirplayEpoch?(epoch: number): Promise<void>;
  getAirplayTapStats?(): {
    enabled: boolean;
    epoch: number;
    queuedFrames: number;
    queuedBytes: number;
    writtenFrames: number;
    writtenBytes: number;
    overruns: number;
    writeErrors: number;
  } | null;
}

export interface AirplayDeviceInfo {
  id: string;
  name: string;
  model?: string;
  addresses?: string[];
  needsPin: boolean;
  supportsAirplay2?: boolean;
  supportsRaop?: boolean;
}

export interface AirplayStatus {
  connected: boolean;
  delaySec: number;
  format: string;
  inputBits: number;
  error?: string;
  feederReceivedFrames?: number;
  feederSentFrames?: number;
  feederSendErrors?: number;
}

/** 原生 AirPlay 发送。发现或 SETUP 成功不等于已经在送音频。 */
export interface AirplayControl {
  available: boolean;
  discoveryBackend?: () => string;
  discover(timeoutMs: number): Promise<AirplayDeviceInfo[]>;
  discoverEach?(
    timeoutMs: number,
    onDevice: (device: AirplayDeviceInfo) => void,
  ): Promise<AirplayDeviceInfo[]>;
  connect(
    id: string,
    pin?: string,
    initialVolume?: number,
  ): Promise<{ ok: boolean; error?: string; format?: string; pcmPort?: number }>;
  disconnect(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(seconds: number): Promise<number>;
  stop(): Promise<void>;
  setVolume(volume: number): Promise<void>;
  flushTrack(): Promise<number>;
  status(): AirplayStatus;
  clearRecords?(): Promise<void>;
}

export interface GenaPort {
  start(port?: number): Promise<number>;
  stop(): Promise<void>;
  callbackUrl(instance: string, token?: string): string;
  armToken(token: string): void;
  disarmToken(token: string): void;
  trackSubscription(sid: string): void;
  untrackSubscription(sid: string): void;
}

export interface HostTrackMeta extends OutputTrackMeta {
  mime?: string;
  headers?: Record<string, string>;
}

export interface OutputHostDeps {
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  local: LocalTransport;
  emitPlayer?: (event: string, ...args: unknown[]) => void;
  emitOutput?: (event: { type: string; payload?: unknown }) => void;
  native?: UpnpNativeLike | null;
  airplay?: AirplayControl | null;
  media?: MediaServer;
  /** 单测允许回环中转；正式环境设备访问不了 127.0.0.1。 */
  allowLoopbackRelay?: boolean;
  gena?: GenaPort | null;
  subscribe?: typeof subscribeEvent;
  renew?: typeof renewEvent;
  unsubscribe?: typeof unsubscribeEvent;
  localNetworkIdentity?: () => { addresses: string[]; macs: string[] };
  runAirplayDiagnostics?: () => void;
  schedule?: (fn: () => void, ms: number) => { cancel(): void };
}

interface DlnaTarget {
  kind: 'dlna';
  targetId: string;
  location: string;
  displayName: string;
  server: string;
  manufacturer?: string;
  manufacturerUrl?: string;
  modelName?: string;
  modelDescription?: string;
  modelNumber?: string;
  modelUrl?: string;
  serialNumber?: string;
  udn?: string;
  upc?: string;
  presentationUrl?: string;
  st?: string;
  interface?: string;
  maxAgeSec?: number;
}

interface DlnaDeviceEntry {
  usn: string;
  location: string;
  server?: string;
  name?: string;
  manufacturer?: string;
  manufacturerUrl?: string;
  modelName?: string;
  modelDescription?: string;
  modelNumber?: string;
  modelUrl?: string;
  serialNumber?: string;
  udn?: string;
  upc?: string;
  presentationUrl?: string;
  st?: string;
  interface?: string;
  maxAgeSec?: number;
}

interface AirplayTarget {
  kind: 'airplay';
  targetId: string;
  displayName: string;
  model?: string;
  addresses?: string[];
  needsPin: boolean;
  supportsAirplay2?: boolean;
  supportsRaop?: boolean;
}

type RouteMode = 'local' | 'dlna' | 'airplay';

const OFFLINE_LIMIT = 3;
const VOLUME_GUARD_MS = 1000;
const DLNA_POLL_LOG_INTERVAL_MS = 30_000;

function normalizeAddress(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/^::ffff:/, '')
      .split('%')[0] ?? ''
  );
}

function normalizeMac(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '');
}

function hasDlnaTargetChanged(previous: DlnaTarget, next: DlnaTarget): boolean {
  return (
    previous.location !== next.location ||
    previous.displayName !== next.displayName ||
    previous.server !== next.server ||
    previous.manufacturer !== next.manufacturer ||
    previous.manufacturerUrl !== next.manufacturerUrl ||
    previous.modelName !== next.modelName ||
    previous.modelDescription !== next.modelDescription ||
    previous.modelNumber !== next.modelNumber ||
    previous.modelUrl !== next.modelUrl ||
    previous.serialNumber !== next.serialNumber ||
    previous.udn !== next.udn ||
    previous.upc !== next.upc ||
    previous.presentationUrl !== next.presentationUrl ||
    previous.st !== next.st ||
    previous.interface !== next.interface
  );
}

function formatDlnaTarget(target: DlnaTarget): string {
  const parts = [`${target.displayName}`, `id=${target.targetId}`, `location=${target.location}`];
  if (target.manufacturer) parts.push(`manufacturer=${target.manufacturer}`);
  if (target.manufacturerUrl) parts.push(`manufacturerUrl=${target.manufacturerUrl}`);
  if (target.modelName) parts.push(`model=${target.modelName}`);
  if (target.modelDescription) parts.push(`modelDescription=${target.modelDescription}`);
  if (target.modelNumber) parts.push(`modelNumber=${target.modelNumber}`);
  if (target.modelUrl) parts.push(`modelUrl=${target.modelUrl}`);
  if (target.serialNumber) parts.push(`serial=${target.serialNumber}`);
  if (target.udn) parts.push(`udn=${target.udn}`);
  if (target.upc) parts.push(`upc=${target.upc}`);
  if (target.presentationUrl) parts.push(`presentationUrl=${target.presentationUrl}`);
  if (target.server) parts.push(`server=${target.server}`);
  if (target.st) parts.push(`st=${target.st}`);
  if (target.interface) parts.push(`from=${target.interface}`);
  return parts.join(', ');
}

function hostLabelFromLocation(location: string): string {
  try {
    return new URL(location).host;
  } catch {
    return '';
  }
}

function describeUrlForLog(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    const queryIndex = value.indexOf('?');
    return queryIndex >= 0 ? value.slice(0, queryIndex) : value;
  }
}

function compactJoin(parts: Array<string | undefined | null>): string {
  return parts
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' · ');
}

function dlnaTargetNote(target: DlnaTarget): string | undefined {
  const model = compactJoin([
    target.manufacturer,
    target.modelName,
    target.modelNumber,
    target.serialNumber,
  ]);
  const host = hostLabelFromLocation(target.location) || target.interface;
  return compactJoin([model, host]) || undefined;
}

function primaryNetworkAddress(addresses?: string[]): string | undefined {
  const normalized = (addresses ?? []).map(normalizeAddress).filter(Boolean);
  return (
    normalized.find((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address) && address !== '127.0.0.1') ??
    normalized.find((address) => address !== '::1' && address !== '127.0.0.1') ??
    normalized[0]
  );
}

function airplayTargetNote(target: AirplayTarget): string | undefined {
  return (
    compactJoin([
      target.supportsRaop && target.supportsAirplay2 === false ? 'AirPlay 1' : undefined,
      target.needsPin ? '需要 PIN' : undefined,
      target.model,
      primaryNetworkAddress(target.addresses),
    ]) || undefined
  );
}

function formatAirplayTarget(target: AirplayTarget): string {
  const parts = [`${target.displayName}`, `id=${target.targetId}`];
  if (target.model) parts.push(`model=${target.model}`);
  if (target.addresses?.length) parts.push(`addresses=${target.addresses.join('/')}`);
  if (target.needsPin) parts.push('pin=required');
  if (target.supportsAirplay2 === false) parts.push('airplay2=unsupported');
  if (target.supportsRaop) parts.push('raop=supported');
  return parts.join(', ');
}

function airplayConnectErrorMessage(error?: string): string {
  switch (error) {
    case 'pin-required':
      return '请输入 AirPlay 密码或设备屏幕上显示的验证码';
    case 'pin-invalid':
      return 'AirPlay 密码或验证码不正确，请重新输入';
    case 'airplay-permission-required':
      return '设备拒绝了 AirPlay 连接，请在接收设备上允许 EchoMusic 后重试';
    case 'airplay-mfi-required':
      return '该 AirPlay 设备需要 Apple MFi 硬件认证，EchoMusic 当前无法连接';
    default:
      return error || 'AirPlay 连接失败';
  }
}

function dlnaConnectErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(401|403)\b|unauthorized|forbidden/i.test(message)) {
    return '设备要求授权，请在设备端允许当前网络后重试';
  }
  return error instanceof Error ? error.message : fallback;
}

function readLocalNetworkIdentity(): { addresses: string[]; macs: string[] } {
  const addresses = new Set<string>();
  const macs = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.address) addresses.add(normalizeAddress(entry.address));
      const mac = normalizeMac(entry.mac || '');
      if (mac && mac !== '000000000000') macs.add(mac);
    }
  }
  return { addresses: [...addresses], macs: [...macs] };
}

interface AirplayScanStats {
  found: number;
  accepted: number;
  filteredLocal: number;
}

export class OutputHost {
  private readonly now: () => number;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly commands = new CommandGate();
  private routeTail: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private shutdownFlight: Promise<void> | null = null;
  private readonly volumes = new Map<string, number>();
  private readonly dlnaTargets = new Map<string, DlnaTarget>();
  private readonly airplayTargets = new Map<string, AirplayTarget>();
  private localDevices: OutputTargetEntry[] = [];
  private mode: RouteMode = 'local';
  private link: 'up' | 'lost' = 'up';
  private enabled = false;
  private browsing = false;
  private routeEpoch = 0;
  private sessionToken = 0;
  private backend: DlnaBackend | null = null;
  private backendBus: EventEmitter | null = null;
  private device: UpnpDeviceSnapshot | null = null;
  private sinkInfo: string | null = null;
  private trackMeta: HostTrackMeta = {};
  private originalUrl = '';
  private mediaSessionId = 'output';
  private activeToken: string | null = null;
  private playing = false;
  private position = 0;
  private duration = 0;
  private trackSeq = 0;
  private playerTrackSeq = 0;
  private deviceVolume: number | null = null;
  private savedLocalVolume: number | null = null;
  private volumeGuardUntil = 0;
  private takenOver = false;
  private offlineStreak = 0;
  private diagnostics = '网络播放未开启';
  private pollTimer: { cancel(): void } | null = null;
  private renewTimer: { cancel(): void } | null = null;
  private readonly tapStatsTimers = new Set<{ cancel(): void }>();
  private subscription: { sid: string; url: string; host: string } | null = null;
  private pendingCallbackToken: string | null = null;
  private airplayFormat = '';
  private airplayPaused = false;
  private sourceStale = false;
  private refreshFlight: Promise<OutputTargetEntry[]> | null = null;
  private airplayScanFlight: Promise<void> | null = null;
  private airplayConnecting = false;
  private airplayScanToken = 0;
  private loggedAirplayDiscoveryBackend = '';
  private loggedLocalAirplayIds = new Set<string>();
  private lastDlnaPollLogAt = 0;
  private lastDlnaPollLogKey = '';

  constructor(private readonly deps: OutputHostDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => {});
  }

  get ownsTransport(): boolean {
    return this.mode === 'dlna';
  }

  get suppressLocalPlaybackEvents(): boolean {
    return this.mode === 'dlna';
  }

  get airplayActive(): boolean {
    return !this.shuttingDown && this.mode === 'airplay' && this.link === 'up';
  }

  get wantsScan(): boolean {
    return !this.shuttingDown && (this.enabled || this.browsing || this.mode !== 'local');
  }

  get diagnosticMessage(): string {
    return this.diagnostics;
  }

  setEnabled(enabled: boolean): void {
    if (this.shuttingDown) return;
    this.enabled = enabled;
    if (!enabled && !this.browsing && this.mode === 'local') {
      this.diagnostics = '网络播放未开启';
    }
    this.publish();
  }

  setBrowsing(open: boolean): void {
    if (this.shuttingDown) return;
    this.browsing = open;
    this.publish();
  }

  setTrackMeta(meta: HostTrackMeta): void {
    if (this.shuttingDown) return;
    this.trackMeta = { ...meta };
    if (this.backend) void this.backend.setTrackMeta(this.trackMeta);
  }

  noteDlnaDevices(entries: DlnaDeviceEntry[]): void {
    if (this.shuttingDown) return;
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry.usn || !hostOf(entry.location)) continue;
      seen.add(entry.usn);
      const previous = this.dlnaTargets.get(entry.usn);
      const displayName = pickDlnaDisplayName(entry, previous?.displayName);
      const target: DlnaTarget = {
        kind: 'dlna',
        targetId: entry.usn,
        location: entry.location,
        displayName,
        server: entry.server || previous?.server || '',
        manufacturer: entry.manufacturer || previous?.manufacturer,
        manufacturerUrl: entry.manufacturerUrl || previous?.manufacturerUrl,
        modelName: entry.modelName || previous?.modelName,
        modelDescription: entry.modelDescription || previous?.modelDescription,
        modelNumber: entry.modelNumber || previous?.modelNumber,
        modelUrl: entry.modelUrl || previous?.modelUrl,
        serialNumber: entry.serialNumber || previous?.serialNumber,
        udn: entry.udn || previous?.udn,
        upc: entry.upc || previous?.upc,
        presentationUrl: entry.presentationUrl || previous?.presentationUrl,
        st: entry.st || previous?.st,
        interface: entry.interface || previous?.interface,
        maxAgeSec: entry.maxAgeSec ?? previous?.maxAgeSec,
      };
      this.dlnaTargets.set(entry.usn, target);
      if (!previous) {
        this.log('info', `DLNA 发现设备: ${formatDlnaTarget(target)}`);
      } else if (hasDlnaTargetChanged(previous, target)) {
        this.log('info', `DLNA 设备更新: ${formatDlnaTarget(target)}`);
      }
    }
    // 搜索刚开始时缓存可能还是空的，不能据此把活动会话判成离线。
    if (seen.size > 0) {
      for (const id of [...this.dlnaTargets.keys()]) {
        if (!seen.has(id)) {
          const removed = this.dlnaTargets.get(id);
          this.dlnaTargets.delete(id);
          if (removed) this.log('info', `DLNA 设备离线: ${formatDlnaTarget(removed)}`);
          if (this.mode === 'dlna' && this.device && this.targetId === id) {
            void this.loseLink('device-offline');
          }
        }
      }
    }
    this.publish();
  }

  removeDlnaDevice(usn: string): void {
    if (this.shuttingDown) return;
    const removed = this.dlnaTargets.get(usn);
    if (!this.dlnaTargets.delete(usn)) return;
    if (removed) this.log('info', `DLNA 设备离线: ${formatDlnaTarget(removed)}`);
    if (this.mode === 'dlna' && this.device && this.targetId === usn) {
      void this.loseLink('device-offline');
    }
    this.publish();
  }

  noteAirplayDevices(
    devices: AirplayDeviceInfo[],
    options: { pruneMissing?: boolean } = {},
  ): AirplayScanStats {
    if (this.shuttingDown) return { found: devices.length, accepted: 0, filteredLocal: 0 };
    const pruneMissing = options.pruneMissing ?? true;
    const seen = new Set<string>();
    let filteredLocal = 0;
    const localIdentity = this.deps.localNetworkIdentity?.() ?? readLocalNetworkIdentity();
    const localAddresses = new Set(localIdentity.addresses.map(normalizeAddress).filter(Boolean));
    const localMacs = new Set(localIdentity.macs.map(normalizeMac).filter(Boolean));
    for (const device of devices) {
      if (!device.id) continue;
      const deviceAddresses = (device.addresses ?? []).map(normalizeAddress).filter(Boolean);
      const deviceMac = normalizeMac(device.id);
      if (
        (deviceMac && localMacs.has(deviceMac)) ||
        deviceAddresses.some((address) => localAddresses.has(address))
      ) {
        if (!this.loggedLocalAirplayIds.has(device.id)) {
          this.loggedLocalAirplayIds.add(device.id);
          this.log('info', `忽略本机 AirPlay 接收器: ${device.name || device.id}`);
        }
        filteredLocal += 1;
        continue;
      }
      seen.add(device.id);
      this.airplayTargets.set(device.id, {
        kind: 'airplay',
        targetId: device.id,
        displayName: device.name || 'AirPlay',
        model: device.model,
        addresses: device.addresses,
        needsPin: device.needsPin,
        supportsAirplay2: device.supportsAirplay2,
        supportsRaop: device.supportsRaop,
      });
    }
    if (pruneMissing && devices.length > 0) {
      for (const id of [...this.airplayTargets.keys()]) {
        if (!seen.has(id)) this.airplayTargets.delete(id);
      }
    }
    this.publish();
    return { found: devices.length, accepted: seen.size, filteredLocal };
  }

  private targetId: string | null = null;
  private targetName = '';

  async refresh(): Promise<OutputTargetEntry[]> {
    if (this.refreshFlight) return this.refreshFlight;
    this.refreshFlight = this.refreshNow().finally(() => {
      this.refreshFlight = null;
    });
    return this.refreshFlight;
  }

  private async refreshNow(): Promise<OutputTargetEntry[]> {
    if (this.wantsScan) {
      this.diagnostics = '正在搜索投放设备...';
      this.publish();
    }
    if (this.deps.local.getAudioDevices) {
      try {
        const devices = await this.deps.local.getAudioDevices();
        if (this.shuttingDown) return this.targets();
        this.localDevices = devices.map((device) => ({
          targetId: `local:${device.name}`,
          protocol: 'local' as const,
          displayName: device.description || device.name,
          lastSeenAt: this.now(),
          connection: { connected: this.mode === 'local', available: true },
        }));
      } catch (error) {
        this.log('warn', `读取本机设备失败: ${String(error)}`);
      }
    }
    if (this.shuttingDown) return this.targets();
    if (this.wantsScan && this.deps.airplay?.available) {
      this.startAirplayScan();
    } else if (
      this.wantsScan &&
      this.mode === 'local' &&
      this.deps.airplay &&
      !this.deps.airplay.available
    ) {
      this.diagnostics = this.deps.native
        ? 'AirPlay 发送模块尚未构建，不能把发现或 SETUP 当成正在播放'
        : 'DLNA 与 AirPlay 发送模块都尚未构建';
    } else if (
      this.wantsScan &&
      this.mode === 'local' &&
      !this.deps.native &&
      this.dlnaTargets.size === 0
    ) {
      this.diagnostics = 'DLNA 模块尚未构建';
    }
    this.publish();
    return this.targets();
  }

  private startAirplayScan(): void {
    if (this.shuttingDown) return;
    if (this.airplayConnecting) return;
    if (this.airplayScanFlight || !this.deps.airplay?.available) return;
    this.diagnostics = '正在搜索投放设备...';
    this.publish();
    const token = ++this.airplayScanToken;
    this.airplayScanFlight = this.scanAirplayDevices(token).finally(() => {
      this.airplayScanFlight = null;
    });
  }

  private isCurrentAirplayScan(token: number): boolean {
    return !this.shuttingDown && this.airplayScanToken === token && !this.airplayConnecting;
  }

  private async scanAirplayDevices(token: number): Promise<void> {
    try {
      const backend = this.deps.airplay?.discoveryBackend?.() || 'unknown';
      if (backend !== this.loggedAirplayDiscoveryBackend) {
        this.loggedAirplayDiscoveryBackend = backend;
        this.log('info', `AirPlay 发现后端: ${backend}`);
      }
      const discovered = new Map<string, AirplayDeviceInfo>();
      const mergeDiscoveredDevice = (device: AirplayDeviceInfo) => {
        if (!this.isCurrentAirplayScan(token)) return;
        if (!device.id) return;
        discovered.set(device.id, device);
        const stats = this.noteAirplayDevices([...discovered.values()], {
          pruneMissing: false,
        });
        if (stats.accepted > 0) {
          this.diagnostics = `已发现 ${stats.accepted} 台 AirPlay 设备，仍在搜索...`;
          this.publish();
        }
      };
      const devices = this.deps.airplay!.discoverEach
        ? await this.deps.airplay!.discoverEach(5000, mergeDiscoveredDevice)
        : await this.deps.airplay!.discover(5000);
      if (!this.isCurrentAirplayScan(token)) return;
      const stats = this.noteAirplayDevices(devices);
      const visibleDevices = devices
        .map((device) => this.airplayTargets.get(device.id))
        .filter((target): target is AirplayTarget => Boolean(target));
      this.log(
        'info',
        `AirPlay 发现完成: visible=${stats.accepted}/${stats.found}, hiddenLocal=${stats.filteredLocal}, devices=${visibleDevices.map(formatAirplayTarget).join(' | ') || '-'}`,
      );
      if (stats.found === 0) {
        this.deps.runAirplayDiagnostics?.();
      }
      if (stats.accepted > 0) {
        this.diagnostics = `已发现 ${stats.accepted} 台 AirPlay 设备`;
      } else if (stats.found > 0 && stats.filteredLocal === stats.found) {
        this.diagnostics = `仅发现本机 AirPlay，已隐藏`;
      } else if (stats.found === 0 && this.dlnaTargets.size === 0) {
        this.diagnostics =
          '未发现 AirPlay / DLNA 设备，请确认设备在同一局域网且 AirPlay 接收器已允许当前网络访问';
      } else if (stats.found === 0) {
        this.diagnostics = '未发现 AirPlay 设备，请确认设备在同一局域网且 AirPlay 接收器已开启';
      }
      this.publish();
    } catch (error) {
      if (!this.isCurrentAirplayScan(token)) return;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('命令超时')) {
        this.diagnostics = 'AirPlay 搜索仍在后台进行，可稍后刷新';
        this.log('info', `AirPlay 发现未在本轮刷新内完成: ${message}`);
      } else {
        this.diagnostics = `AirPlay 发现失败: ${message}`;
        this.log('warn', this.diagnostics);
      }
      this.publish();
    }
  }

  targets(): OutputTargetEntry[] {
    const dlna: OutputTargetEntry[] = [...this.dlnaTargets.values()].map((target) => ({
      targetId: target.targetId,
      protocol: 'dlna',
      displayName: target.displayName,
      location: target.location,
      manufacturer: target.manufacturer,
      manufacturerUrl: target.manufacturerUrl,
      modelName: target.modelName,
      modelDescription: target.modelDescription,
      modelNumber: target.modelNumber,
      modelUrl: target.modelUrl,
      serialNumber: target.serialNumber,
      udn: target.udn,
      upc: target.upc,
      presentationUrl: target.presentationUrl,
      note: dlnaTargetNote(target),
      lastSeenAt: this.now(),
      connection: {
        connected: this.mode === 'dlna' && this.targetId === target.targetId && this.link === 'up',
        available: true,
      },
    }));
    const airplay: OutputTargetEntry[] = [...this.airplayTargets.values()].map((target) => ({
      targetId: target.targetId,
      protocol: 'airplay',
      displayName: target.displayName,
      addresses: target.addresses,
      modelName: target.model,
      paired: !target.needsPin,
      note: airplayTargetNote(target),
      lastSeenAt: this.now(),
      connection: {
        connected:
          this.mode === 'airplay' && this.targetId === target.targetId && this.link === 'up',
        available: true,
      },
    }));
    return [...this.localDevices, ...dlna, ...airplay];
  }

  snapshot(): OutputSessionSnapshot {
    const protocol = this.mode;
    return {
      sessionId: protocol === 'local' ? 'local' : `${protocol}:${this.routeEpoch}`,
      routeEpoch: this.routeEpoch,
      protocol,
      targetId: protocol === 'local' ? null : this.targetId,
      displayName: protocol === 'local' ? '' : this.targetName,
      state:
        this.link === 'lost'
          ? 'paused'
          : this.playing
            ? 'playing'
            : protocol === 'local'
              ? 'idle'
              : 'paused',
      trackGeneration: this.trackSeq,
      positionSec: this.position,
      observedAt: this.now(),
      clockAccuracy: protocol === 'local' ? 'accurate' : 'approximate',
      durationSec: this.duration || null,
      actualFormat: protocol === 'airplay' ? this.airplayFormat || null : null,
      volume: this.deviceVolume,
      capabilities: {
        pause: protocol !== 'local',
        seek: protocol === 'dlna' || protocol === 'airplay' ? 'by-time' : 'none',
        volume: protocol !== 'local',
        mute: false,
        rate: false,
        position: protocol === 'local' ? 'accurate' : 'approximate',
        nextUri: false,
        gapless: false,
        dsp: protocol === 'airplay',
        spectrum: protocol !== 'dlna',
        relayed: protocol === 'dlna' ? Boolean(this.activeToken) : undefined,
      },
    };
  }

  /** 连接和释放共享原生发送器，按请求顺序交接，失败不能阻塞后续切换。 */
  private runRoute<T>(task: () => Promise<T>): Promise<T> {
    const flight = this.routeTail.then(task);
    this.routeTail = flight.then(
      () => undefined,
      () => undefined,
    );
    return flight;
  }

  private canceledConnection(): { ok: false; error: string } {
    return { ok: false, error: '应用正在退出，连接已取消' };
  }

  connect(targetId: string, pin?: string): Promise<{ ok: boolean; error?: string }> {
    if (this.shuttingDown) return Promise.resolve(this.canceledConnection());
    return this.runRoute(() => this.connectBody(targetId, pin));
  }

  private async connectBody(
    targetId: string,
    pin?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.shuttingDown) return this.canceledConnection();
    if (targetId.startsWith('local:')) {
      const name = targetId.slice('local:'.length);
      await this.activateLocalBody('user');
      if (this.shuttingDown) return this.canceledConnection();
      await this.deps.local.setAudioOutput?.(name, false);
      if (this.shuttingDown) return this.canceledConnection();
      this.diagnostics = '已切回本机';
      this.publish();
      return { ok: true };
    }
    const dlna = this.dlnaTargets.get(targetId);
    if (dlna) return this.connectDlna(dlna);
    const airplay = this.airplayTargets.get(targetId);
    if (airplay) return this.connectAirplay(airplay, pin);
    return { ok: false, error: '设备不在当前发现结果里' };
  }

  private async connectDlna(target: DlnaTarget): Promise<{ ok: boolean; error?: string }> {
    if (!this.deps.native) return { ok: false, error: 'DLNA 模块尚未构建' };
    const allowed = hostOf(target.location);
    if (!allowed) return { ok: false, error: '设备地址无效' };
    let loaded: UpnpDeviceSnapshot;
    try {
      loaded = await this.deps.native.loadDevice(target.location);
      this.log(
        'info',
        `DLNA 连接设备描述完成: name=${loaded.friendlyName || '-'}, type=${loaded.deviceType || '-'}, services=${loaded.services.length}`,
      );
    } catch (error) {
      this.log(
        'warn',
        `DLNA 连接设备描述失败: ${formatDlnaTarget(target)}, error=${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false, error: dlnaConnectErrorMessage(error, '读取设备描述失败') };
    }
    if (this.shuttingDown) return this.canceledConnection();
    const av = findService(loaded.services, 'AVTransport');
    const rc = findService(loaded.services, 'RenderingControl');
    if (!av) return { ok: false, error: '设备没有 AVTransport，不能播放' };
    let sink: string | null = null;
    const cm = findService(loaded.services, 'ConnectionManager');
    if (cm) {
      try {
        const info = await this.deps.native.action(
          loaded.descriptionUrl,
          cm.serviceId,
          'GetProtocolInfo',
          {},
        );
        sink = info.Sink ?? null;
      } catch (error) {
        this.log('warn', `GetProtocolInfo 失败，按未知能力继续: ${String(error)}`);
      }
    }
    if (this.shuttingDown) return this.canceledConnection();
    let volume: number | null = null;
    if (rc) {
      try {
        const result = await this.deps.native.action(
          loaded.descriptionUrl,
          rc.serviceId,
          'GetVolume',
          {
            InstanceID: '0',
            Channel: 'Master',
          },
        );
        const parsed = Number(result.CurrentVolume);
        if (Number.isFinite(parsed)) volume = parsed;
      } catch (error) {
        this.log('warn', `读取设备音量失败: ${String(error)}`);
      }
    }
    if (this.shuttingDown) return this.canceledConnection();
    await this.stopRemote(false);
    if (this.shuttingDown) return this.canceledConnection();
    const localState = this.deps.local.getState();
    const handoffUrl = String(localState?.path ?? '').trim();
    const handoffPosition =
      Number.isFinite(localState?.timePos) && (localState?.timePos ?? 0) > 0
        ? Number(localState?.timePos)
        : 0;
    const handoffWasPlaying = Boolean(localState?.playing) && !localState?.paused;
    this.savedLocalVolume = localState?.volume ?? this.savedLocalVolume;
    try {
      await this.deps.local.pause();
    } catch (error) {
      this.log('warn', `暂停本机失败: ${String(error)}`);
    }
    if (this.shuttingDown) return this.canceledConnection();
    this.routeEpoch += 1;
    this.sessionToken += 1;
    this.mode = 'dlna';
    this.link = 'up';
    this.targetId = target.targetId;
    this.targetName = pickDlnaDisplayName(
      { name: loaded.friendlyName, server: target.server },
      target.displayName,
    );
    this.device = loaded;
    this.sinkInfo = sink;
    this.deviceVolume = volume;
    this.volumeGuardUntil = this.now() + VOLUME_GUARD_MS;
    this.playing = false;
    this.takenOver = false;
    this.offlineStreak = 0;
    this.mediaSessionId = `dlna:${this.routeEpoch}`;
    this.backendBus = new EventEmitter();
    this.backend = new DlnaBackend({
      descriptionUrl: loaded.descriptionUrl,
      targetId: target.targetId,
      displayName: this.targetName,
      routeEpoch: this.routeEpoch,
      trackGeneration: 1,
      native: this.deps.native,
      bus: this.backendBus,
      now: this.now,
      avTransportServiceId: av.serviceId,
      renderingControlServiceId: rc?.serviceId,
    });
    const token = this.sessionToken;
    this.backendBus.on('playback-ended', (payload) => {
      if (token !== this.sessionToken || this.link !== 'up') return;
      this.playing = false;
      this.emitPlayer('state-change', this.statePayload());
      this.emitPlayer('playback-end', 'eof', {
        trackSeq: this.playerEventTrackSeq(payload?.trackGeneration),
        generation: this.routeEpoch,
      });
    });
    this.backendBus.on('taken-over', () => {
      if (token !== this.sessionToken) return;
      this.takenOver = true;
      this.diagnostics = '设备已被其他控制端接管，已停止自动推进';
      this.publish();
    });
    this.dlnaTargets.set(target.targetId, {
      ...target,
      displayName: this.targetName,
      manufacturer: loaded.manufacturer || target.manufacturer,
      manufacturerUrl: loaded.manufacturerUrl || target.manufacturerUrl,
      modelName: loaded.modelName || target.modelName,
      modelDescription: loaded.modelDescription || target.modelDescription,
      modelNumber: loaded.modelNumber || target.modelNumber,
      modelUrl: loaded.modelUrl || target.modelUrl,
      serialNumber: loaded.serialNumber || target.serialNumber,
      udn: loaded.udn || target.udn,
      upc: loaded.upc || target.upc,
      presentationUrl: loaded.presentationUrl || target.presentationUrl,
    });
    this.diagnostics =
      volume == null ? '已连接，未能读取设备音量' : '已连接。本机音效不会作用在 DLNA 原曲上';
    await this.startObserve(loaded, av.eventSubUrl, allowed, token);
    if (this.shuttingDown) return this.canceledConnection();
    if (handoffUrl) {
      const generation = this.commands.bump();
      const handoffTrackSeq =
        Number.isFinite(localState?.trackSeq) && (localState?.trackSeq ?? 0) > 0
          ? Number(localState?.trackSeq)
          : null;
      try {
        const handoff = await this.commands.run(async () => {
          const loaded = await this.loadBody(
            handoffUrl,
            generation,
            generation,
            undefined,
            handoffTrackSeq,
          );
          if (!loaded || this.shuttingDown || generation !== this.commands.current) return null;
          if (handoffPosition > 0) await this.seekBody(handoffPosition, generation);
          if (this.shuttingDown || generation !== this.commands.current) return null;
          if (handoffWasPlaying && !this.takenOver) await this.playBody(generation);
          return loaded;
        });
        if (this.shuttingDown) return this.canceledConnection();
        this.diagnostics = handoff
          ? handoffWasPlaying
            ? '已连接并开始投放当前歌曲'
            : '已连接，当前歌曲已发送到设备'
          : '已连接';
      } catch (error) {
        if (this.shuttingDown) return this.canceledConnection();
        if (generation !== this.commands.current) return { ok: true };
        const message = error instanceof Error ? error.message : String(error);
        this.log(
          'warn',
          `DLNA 接管当前音源失败: target=${this.targetName || this.targetId || '-'}, error=${message}`,
        );
        await this.stopRemote(false);
        if (this.shuttingDown) return this.canceledConnection();
        this.mode = 'local';
        this.link = 'up';
        this.targetId = null;
        this.targetName = '';
        this.sinkInfo = null;
        this.deviceVolume = localState?.volume ?? this.deviceVolume;
        this.diagnostics = `投放失败：${message}，已继续本机播放`;
        try {
          if (handoffPosition > 0) await this.deps.local.seek(handoffPosition);
          if (!this.shuttingDown && handoffWasPlaying) await this.deps.local.play();
        } catch (restoreError) {
          this.log('warn', `恢复本机播放失败: ${String(restoreError)}`);
        }
        this.publish();
        this.emitPlayer('state-change', this.statePayload());
        return { ok: false, error: message };
      }
    } else {
      this.log('info', `DLNA 已连接，但本机没有当前音源可接管: target=${this.targetName || '-'}`);
    }
    this.publish();
    this.emitPlayer('state-change', this.statePayload());
    return { ok: true };
  }

  private async connectAirplay(
    target: AirplayTarget,
    pin?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const airplay = this.deps.airplay;
    if (!airplay?.available) {
      return { ok: false, error: 'AirPlay 发送模块尚未构建，不能把发现或 SETUP 当成正在播放' };
    }
    if (target.needsPin && !pin) return { ok: false, error: 'pin-required' };
    const localVolume = this.deps.local.getState()?.volume;
    const initialVolume = clampVolume(
      typeof localVolume === 'number' && Number.isFinite(localVolume)
        ? localVolume
        : (this.savedLocalVolume ?? DEFAULT_PLAYER_VOLUME),
    );
    await this.stopRemote(false);
    if (this.shuttingDown) return this.canceledConnection();
    const startedAt = this.now();
    const protocol =
      target.supportsRaop && target.supportsAirplay2 === false ? 'AirPlay 1/RAOP' : 'AirPlay 2';
    const backend = airplay.discoveryBackend?.() || 'unknown';
    this.log(
      'info',
      `AirPlay 连接开始: ${formatAirplayTarget(target)}, protocol=${protocol}, backend=${backend}, pin=${pin ? 'yes' : 'no'}`,
    );
    this.airplayConnecting = true;
    this.airplayScanToken += 1;
    let elapsedTimer: NodeJS.Timeout | null = null;
    elapsedTimer = setInterval(() => {
      const elapsedMs = Math.max(0, this.now() - startedAt);
      let status = '';
      try {
        const current = airplay.status();
        const phase = current.error || (current.connected ? 'connected' : '等待 native CONNECT');
        status = `, nativeConnected=${current.connected}, nativePhase=${phase}`;
      } catch (error) {
        status = `, statusError=${error instanceof Error ? error.message : String(error)}`;
      }
      this.log(
        'info',
        `AirPlay 连接仍在进行: ${target.displayName} (${target.targetId}), elapsed=${Math.round(elapsedMs / 1000)}s${status}`,
      );
    }, 5000);
    elapsedTimer.unref?.();
    let result: { ok: boolean; error?: string; format?: string; pcmPort?: number };
    try {
      result = await airplay.connect(target.targetId, pin, initialVolume);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const elapsedMs = Math.max(0, this.now() - startedAt);
      this.log(
        'warn',
        `AirPlay 连接异常: ${formatAirplayTarget(target)}, elapsed=${Math.round(elapsedMs / 1000)}s, error=${message}`,
      );
      return { ok: false, error: message };
    } finally {
      if (elapsedTimer) clearInterval(elapsedTimer);
      this.airplayConnecting = false;
    }
    if (this.shuttingDown) {
      if (result.ok) await airplay.disconnect().catch(() => undefined);
      return this.canceledConnection();
    }
    if (!result.ok) {
      const message = airplayConnectErrorMessage(result.error);
      const elapsedMs = Math.max(0, this.now() - startedAt);
      this.log(
        'warn',
        `AirPlay 连接失败: ${formatAirplayTarget(target)}, elapsed=${Math.round(elapsedMs / 1000)}s, error=${message}`,
      );
      return result;
    }
    const port = result.pcmPort ?? 0;
    if (!this.deps.local.setAirplayTap || !port) {
      await airplay.disconnect().catch(() => undefined);
      return {
        ok: false,
        error: '本机播放器还没有 AirPlay 音频出口，需要重新构建 echo-audio-player 后才能发送',
      };
    }
    try {
      await this.deps.local.setAirplayTap(port, true);
      if (!this.shuttingDown) await this.deps.local.setAirplayEpoch?.(1);
    } catch (error) {
      await this.deps.local.setAirplayTap(0, false).catch(() => undefined);
      await airplay.disconnect().catch(() => undefined);
      return { ok: false, error: error instanceof Error ? error.message : '无法接上本机音频出口' };
    }
    if (this.shuttingDown) {
      await this.deps.local.setAirplayTap(0, false).catch(() => undefined);
      await airplay.disconnect().catch(() => undefined);
      return this.canceledConnection();
    }
    this.log(
      'info',
      `AirPlay 连接成功: ${formatAirplayTarget(target)}, pcmPort=${port}, format=${result.format || 'unknown'}, elapsed=${Math.round((this.now() - startedAt) / 1000)}s`,
    );
    this.routeEpoch += 1;
    this.mode = 'airplay';
    this.link = 'up';
    this.targetId = target.targetId;
    this.targetName = target.displayName;
    this.airplayFormat = result.format || 'ALAC 44100Hz 16-bit stereo; input i16';
    this.airplayPaused = false;
    this.savedLocalVolume = this.deps.local.getState()?.volume ?? this.savedLocalVolume;
    this.volumes.set(target.targetId, initialVolume);
    this.deviceVolume = initialVolume;
    this.diagnostics =
      'AirPlay 发送已连接。传输是 16-bit，不会保留 24-bit 源；歌词延迟只按发送缓冲估算';
    this.startAirplayWatch(this.sessionToken + 1);
    this.sessionToken += 1;
    this.scheduleAirplayTapStats('连接后 2s', 2000);
    this.publish();
    return { ok: true };
  }

  private scheduleAirplayTapStats(label: string, delayMs: number): void {
    const token = this.sessionToken;
    let timer: { cancel(): void } | null = null;
    timer = this.schedule(() => {
      timer?.cancel();
      if (timer) this.tapStatsTimers.delete(timer);
      timer = null;
      if (this.shuttingDown || token !== this.sessionToken || !this.airplayActive) return;
      this.logAirplayTapStats(label);
    }, delayMs);
    this.tapStatsTimers.add(timer);
  }

  probeAirplayPlayback(label: string): void {
    if (!this.airplayActive) return;
    this.scheduleAirplayTapStats(`${label} 2s`, 2000);
  }

  private logAirplayTapStats(label: string): void {
    const stats = this.deps.local.getAirplayTapStats?.();
    const airplayStatus = this.deps.airplay?.status();
    const feeder = airplayStatus
      ? `, feeder=${airplayStatus.feederReceivedFrames ?? 0}/${airplayStatus.feederSentFrames ?? 0}, feederErrors=${airplayStatus.feederSendErrors ?? 0}`
      : '';
    if (!stats) {
      this.log('info', `AirPlay 音频出口状态(${label}): 当前播放器模块没有 tap 统计${feeder}`);
      return;
    }
    this.log(
      'info',
      `AirPlay 音频出口状态(${label}): enabled=${stats.enabled}, epoch=${stats.epoch}, queued=${stats.queuedFrames}/${stats.queuedBytes}B, written=${stats.writtenFrames}/${stats.writtenBytes}B, overruns=${stats.overruns}, writeErrors=${stats.writeErrors}${feeder}`,
    );
  }

  activateLocal(reason: 'user' | 'switch' = 'user'): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    return this.runRoute(async () => {
      if (!this.shuttingDown) await this.activateLocalBody(reason);
    });
  }

  private async activateLocalBody(reason: 'user' | 'switch'): Promise<void> {
    const resume = reason === 'user' && this.mode !== 'local';
    const url = this.originalUrl;
    const position = this.position;
    const wasPlaying = this.playing;
    const volume = this.savedLocalVolume;
    await this.stopRemote(true);
    if (this.shuttingDown) return;
    this.mode = 'local';
    this.link = 'up';
    this.targetId = null;
    this.targetName = '';
    this.takenOver = false;
    if (volume != null) {
      try {
        await this.deps.local.setVolume(volume);
      } catch (error) {
        this.log('warn', `恢复本机音量失败: ${String(error)}`);
      }
    }
    if (!this.shuttingDown && resume && url) {
      const loaded = await this.deps.local.loadFile(url);
      if (this.shuttingDown) return;
      if (loaded && position > 0) await this.deps.local.seek(position);
      if (!this.shuttingDown && wasPlaying) await this.deps.local.play();
    }
    this.diagnostics = '本机播放';
    this.publish();
  }

  beginSourceChange(): number {
    const id = this.commands.bump();
    try {
      this.deps.local.beginSourceChange();
    } catch (error) {
      this.log('warn', `本机切源序号失败: ${String(error)}`);
    }
    return id;
  }

  load(url: string, requestId?: number, trackId?: number | null) {
    if (this.shuttingDown || !this.ownsTransport) return Promise.resolve(null);
    if (requestId != null && requestId !== this.commands.current) return Promise.resolve(null);
    return this.commands.run((generation) => this.loadBody(url, generation, requestId, trackId));
  }

  async switchSource(
    url: string,
    trackId?: number | null,
  ): Promise<[number, number, number] | null> {
    if (this.shuttingDown || !this.ownsTransport) return null;
    this.commands.bump();
    return this.commands.run(async (generation) => {
      const position = this.position;
      const wasPlaying = this.playing;
      const loaded = await this.loadBody(url, generation, generation, trackId);
      if (!loaded || generation !== this.commands.current) return null;
      if (position > 0) await this.seekBody(position, generation);
      if (wasPlaying && !this.takenOver) await this.playBody(generation);
      return [position, loaded.duration, loaded.seq];
    });
  }

  play() {
    if (this.shuttingDown) return Promise.resolve();
    if (this.airplayActive) return this.resumeAirplay();
    if (!this.ownsTransport) return Promise.resolve();
    return this.commands.run((generation) => this.playBody(generation));
  }

  pause() {
    if (this.shuttingDown) return Promise.resolve();
    if (this.airplayActive) return this.pauseAirplay();
    if (!this.ownsTransport) return Promise.resolve();
    return this.commands.run((generation) => this.pauseBody(generation));
  }

  stop() {
    if (this.shuttingDown) return Promise.resolve();
    if (this.airplayActive) return this.stopAirplay();
    if (!this.ownsTransport) return Promise.resolve();
    return this.commands.run((generation) => this.stopBody(generation));
  }

  seek(time: number) {
    if (this.shuttingDown) return Promise.resolve();
    if (this.airplayActive) return this.seekAirplay(time);
    if (!this.ownsTransport) return Promise.resolve();
    return this.commands.run((generation) => this.seekBody(time, generation));
  }

  setVolume(volume: number) {
    if (this.shuttingDown) return Promise.resolve();
    if (this.airplayActive) return this.setAirplayVolume(volume);
    if (!this.ownsTransport) return Promise.resolve();
    return this.commands.run((generation) => this.volumeBody(volume, generation));
  }

  async getState() {
    if (!this.ownsTransport && !this.airplayActive) return null;
    return this.statePayload();
  }

  airplayDelaySec(): number {
    if (!this.airplayActive) return 0;
    return Math.max(0, this.deps.airplay?.status().delaySec ?? 0);
  }

  async prepareAirplayTrack(): Promise<void> {
    if (this.shuttingDown || !this.airplayActive) return;
    const token = this.sessionToken;
    const epoch = await this.requireAirplay().flushTrack();
    if (this.shuttingDown || token !== this.sessionToken) return;
    await this.deps.local.setAirplayEpoch?.(epoch);
  }

  async resumeAirplay(): Promise<void> {
    const token = this.sessionToken;
    if (!this.airplayPaused) return;
    try {
      await this.requireAirplay().resume();
      if (this.shuttingDown || token !== this.sessionToken) return;
      this.airplayPaused = false;
    } catch (error) {
      await this.loseAirplay(`resume-failed: ${String(error)}`, token);
      throw error;
    }
  }

  async pauseAirplay(): Promise<void> {
    const token = this.sessionToken;
    try {
      await this.requireAirplay().pause();
      if (this.shuttingDown || token !== this.sessionToken) return;
      this.airplayPaused = true;
    } catch (error) {
      this.log('warn', `AirPlay 连接已断开，暂停命令已忽略: ${String(error)}`);
      await this.loseAirplay(`pause-failed: ${String(error)}`, token);
    }
  }

  async stopAirplay(): Promise<void> {
    const token = this.sessionToken;
    try {
      await this.requireAirplay().stop();
      if (this.shuttingDown || token !== this.sessionToken) return;
      this.airplayPaused = true;
    } catch (error) {
      this.log('warn', `AirPlay 连接已断开，停止命令已忽略: ${String(error)}`);
      await this.loseAirplay(`stop-failed: ${String(error)}`, token);
    }
  }

  async seekAirplay(seconds: number): Promise<void> {
    const token = this.sessionToken;
    const epoch = await this.requireAirplay().seek(seconds);
    if (this.shuttingDown || token !== this.sessionToken) return;
    await this.deps.local.setAirplayEpoch?.(epoch);
  }

  async setAirplayVolume(volume: number): Promise<void> {
    const token = this.sessionToken;
    const clamped = clampVolume(volume);
    await this.requireAirplay().setVolume(clamped);
    if (this.shuttingDown || token !== this.sessionToken) return;
    if (this.targetId) this.volumes.set(this.targetId, clamped);
    this.deviceVolume = clamped;
  }

  sessionView() {
    return { snapshot: this.snapshot(), targets: this.targets(), diagnostics: this.diagnostics };
  }

  /** GENA 通知。旧会话的回调在替换 backend 后自然落到新门上会被拒绝。 */
  ingestLastChange(xml: string): void {
    if (!this.backend || this.mode !== 'dlna' || this.link !== 'up' || !xml) return;
    const backend = this.backend;
    const token = this.sessionToken;
    backend.handleLastChange(xml);
    void backend.getState().then((state) => {
      if (
        this.shuttingDown ||
        token !== this.sessionToken ||
        backend !== this.backend ||
        this.mode !== 'dlna' ||
        this.link !== 'up'
      )
        return;
      this.position = state.positionSec;
      this.duration = state.durationSec ?? this.duration;
      this.trackSeq = state.trackGeneration;
      this.playing = state.state === 'playing';
      if (this.trackSeq > 0) {
        this.emitPlayer('time-update', {
          time: this.position,
          trackSeq: this.playerEventTrackSeq(),
          generation: this.routeEpoch,
        });
      }
    });
  }

  /** 退出时只停止远端，不恢复本机外放。 */
  shutdown(): Promise<void> {
    if (this.shutdownFlight) return this.shutdownFlight;
    this.shuttingDown = true;
    this.airplayScanToken += 1;
    this.sessionToken += 1;
    this.commands.bump();
    this.stopTimers();
    this.disarmPendingCallback();
    this.shutdownFlight = this.runRoute(async () => {
      await this.stopRemote(true);
      this.mode = 'local';
      this.link = 'up';
      this.targetId = null;
      this.targetName = '';
    });
    return this.shutdownFlight;
  }

  async clearRecords(): Promise<void> {
    this.volumes.clear();
    await this.deps.airplay?.clearRecords?.();
    this.diagnostics = '已清除设备音量和配对记录';
    this.publish();
  }

  /** 测试和运行时共用的一次状态轮询。 */
  async pollOnce(): Promise<void> {
    if (
      this.shuttingDown ||
      this.mode !== 'dlna' ||
      this.link !== 'up' ||
      !this.backend ||
      !this.device ||
      !this.deps.native
    ) {
      return;
    }
    const token = this.sessionToken;
    const backend = this.backend;
    const device = this.device;
    const av = findService(device.services, 'AVTransport');
    if (!av) return;
    try {
      const transport = await this.deps.native.action(
        device.descriptionUrl,
        av.serviceId,
        'GetTransportInfo',
        { InstanceID: '0' },
      );
      if (this.shuttingDown || token !== this.sessionToken) return;
      const position = await this.deps.native.action(
        device.descriptionUrl,
        av.serviceId,
        'GetPositionInfo',
        { InstanceID: '0' },
      );
      if (token !== this.sessionToken || this.link !== 'up') return;
      this.offlineStreak = 0;
      backend.observeTransport({
        transportState: transport.CurrentTransportState,
        positionSec: parseUpnpTime(position.RelTime),
        durationSec: parseUpnpTime(position.TrackDuration),
        trackUri: position.TrackURI ?? null,
      });
      const state = await backend.getState();
      if (this.shuttingDown || token !== this.sessionToken || backend !== this.backend) return;
      this.position = state.positionSec;
      this.duration = state.durationSec ?? this.duration;
      this.trackSeq = state.trackGeneration;
      this.playing = state.state === 'playing';
      this.logDlnaPollState(
        transport.CurrentTransportState,
        position.RelTime,
        position.TrackDuration,
        position.TrackURI,
      );
      if (this.trackSeq > 0) {
        this.emitPlayer('time-update', {
          time: this.position,
          trackSeq: this.playerEventTrackSeq(),
          generation: this.routeEpoch,
        });
      }
    } catch (error) {
      if (token !== this.sessionToken) return;
      if (!isTransportOffline(error)) return;
      this.offlineStreak += 1;
      if (this.offlineStreak >= OFFLINE_LIMIT) await this.loseLink('device-offline');
    }
  }

  private async loadBody(
    url: string,
    generation: number,
    requestId?: number,
    trackId?: number | null,
    playerTrackSeqOverride?: number | null,
  ): Promise<{ seq: number; duration: number } | null> {
    if (this.shuttingDown || generation !== this.commands.current) return null;
    if (this.link !== 'up' || !this.backend) {
      throw new Error('设备已断开，已暂停。请重连或切回本机');
    }
    if (requestId != null && requestId !== generation) return null;
    const backend = this.backend;
    const plan = decideMediaDelivery({
      url,
      headers: this.trackMeta.headers,
      mime: this.trackMeta.mime,
      sinkProtocolInfo: this.sinkInfo,
    });
    if (!plan.ok) throw new Error(plan.reason);
    const deliveryUrl =
      plan.mode === 'direct' ? plan.url : await this.relay(plan.source, plan.mime, generation);
    if (
      !deliveryUrl ||
      this.shuttingDown ||
      generation !== this.commands.current ||
      backend !== this.backend
    )
      return null;
    this.takenOver = false;
    await backend.setTrackMeta(this.trackMeta);
    if (this.shuttingDown || generation !== this.commands.current || backend !== this.backend)
      return null;
    backend.setSourceHint({ mime: plan.mime, relayed: plan.mode === 'relay' });
    const loaded =
      trackId != null && trackId > 0
        ? await backend.loadMkv(deliveryUrl, trackId)
        : await backend.load(deliveryUrl);
    if (!loaded || generation !== this.commands.current) {
      await backend.stop().catch(() => undefined);
      return null;
    }
    this.originalUrl = url;
    this.position = 0;
    this.duration = loaded.duration;
    this.trackSeq = loaded.seq;
    this.playerTrackSeq =
      playerTrackSeqOverride != null && playerTrackSeqOverride > 0
        ? playerTrackSeqOverride
        : loaded.seq;
    this.playing = false;
    this.sourceStale = false;
    return loaded;
  }

  private async relay(
    source: RelaySource,
    mime: string | null,
    generation: number,
  ): Promise<string | null> {
    const media = this.deps.media;
    if (!media) throw new Error('媒体中转不可用');
    if (!this.deps.allowLoopbackRelay && media.host === '127.0.0.1') {
      throw new Error('没有可用的局域网地址，无法把音源中转给设备');
    }
    if (!media.port) await media.start(0);
    if (this.shuttingDown || generation !== this.commands.current) return null;
    if (this.activeToken) media.revokeToken(this.activeToken);
    const registered = media.registerResource(
      {
        source,
        mime,
        length: null,
        sessionId: this.mediaSessionId,
        title: this.trackMeta.title,
        artist: this.trackMeta.artist,
        album: this.trackMeta.album,
      },
      this.mediaSessionId,
    );
    if (!registered) throw new Error('媒体中转没有启动');
    this.activeToken = registered.token;
    return registered.url;
  }

  private async playBody(generation: number): Promise<void> {
    if (this.shuttingDown || generation !== this.commands.current) return;
    if (this.link !== 'up' || !this.backend)
      throw new Error('设备已断开，已暂停。请重连或切回本机');
    if (this.takenOver) throw new Error('播放已被其他控制端接管');
    if (!this.originalUrl && this.trackSeq <= 0) {
      const message = '设备尚未加载音源，无法播放';
      this.log(
        'warn',
        `DLNA 播放失败: target=${this.targetName || this.targetId || '-'}, ${message}`,
      );
      throw new Error(message);
    }
    try {
      await this.backend.play();
    } catch (error) {
      this.log(
        'warn',
        `DLNA Play 失败: target=${this.targetName || this.targetId || '-'}, error=${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
    if (generation !== this.commands.current) return;
    this.playing = true;
    this.offlineStreak = 0;
    this.emitPlayer('state-change', this.statePayload());
  }

  private async pauseBody(generation: number): Promise<void> {
    if (this.shuttingDown || generation !== this.commands.current) return;
    if (!this.backend || this.link !== 'up') return;
    await this.backend.pause();
    if (generation !== this.commands.current) return;
    this.playing = false;
    this.emitPlayer('state-change', this.statePayload());
  }

  private async stopBody(generation: number): Promise<void> {
    if (this.shuttingDown || generation !== this.commands.current) return;
    if (!this.backend) return;
    await this.backend.stop();
    if (generation !== this.commands.current) return;
    this.playing = false;
    this.position = 0;
    this.emitPlayer('state-change', this.statePayload());
  }

  private async seekBody(time: number, generation: number): Promise<void> {
    if (this.shuttingDown || generation !== this.commands.current) return;
    if (this.link !== 'up' || !this.backend)
      throw new Error('设备已断开，已暂停。请重连或切回本机');
    try {
      await this.backend.seek(time);
    } catch (error) {
      this.log(
        'warn',
        `DLNA Seek 失败: target=${this.targetName || this.targetId || '-'}, time=${time}, error=${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
    if (generation !== this.commands.current) return;
    this.position = time;
    this.emitPlayer('seeked', time);
    this.emitPlayer('time-update', {
      time,
      trackSeq: this.playerEventTrackSeq(),
      generation: this.routeEpoch,
    });
  }

  private async volumeBody(volume: number, generation: number): Promise<void> {
    if (this.shuttingDown || generation !== this.commands.current) return;
    if (!this.backend || this.link !== 'up') return;
    const clamped = clampVolume(volume);
    if (
      this.now() < this.volumeGuardUntil &&
      this.savedLocalVolume != null &&
      this.deviceVolume != null &&
      clamped === Math.round(this.savedLocalVolume) &&
      clamped !== Math.round(this.deviceVolume)
    ) {
      return;
    }
    await this.backend.setVolume(clamped);
    if (generation !== this.commands.current) return;
    this.deviceVolume = clamped;
    if (this.targetId) this.volumes.set(this.targetId, clamped);
    this.volumeGuardUntil = 0;
  }

  private async startObserve(
    device: UpnpDeviceSnapshot,
    eventUrl: string | undefined,
    allowedHost: string,
    token: number,
  ): Promise<void> {
    this.stopTimers();
    const av = findService(device.services, 'AVTransport');
    if (
      this.deps.gena &&
      this.deps.subscribe &&
      eventUrl &&
      av &&
      endpointAllowed(eventUrl, allowedHost)
    ) {
      try {
        if (!this.deps.gena) return;
        await this.deps.gena.start(0);
        if (this.shuttingDown || token !== this.sessionToken) return;
        const callbackToken = randomBytes(16).toString('hex');
        this.deps.gena.armToken(callbackToken);
        this.pendingCallbackToken = callbackToken;
        let subscribed: Awaited<ReturnType<typeof subscribeEvent>>;
        try {
          const callback = this.deps.gena.callbackUrl('avt', callbackToken);
          subscribed = await this.deps.subscribe(eventUrl, callback, allowedHost);
          if (token === this.sessionToken) this.deps.gena.trackSubscription(subscribed.sid);
        } finally {
          this.deps.gena.disarmToken(callbackToken);
          if (this.pendingCallbackToken === callbackToken) this.pendingCallbackToken = null;
        }
        if (token !== this.sessionToken) {
          await this.deps.unsubscribe?.(eventUrl, subscribed.sid, allowedHost);
          return;
        }
        this.subscription = { sid: subscribed.sid, url: eventUrl, host: allowedHost };
        const renew = this.deps.renew ?? renewEvent;
        this.renewTimer = this.schedule(() => {
          if (this.shuttingDown || token !== this.sessionToken) return;
          void renew(eventUrl, subscribed.sid, allowedHost).catch((error) => {
            this.log('warn', `GENA 续订失败: ${String(error)}`);
          });
        }, 120_000);
      } catch (error) {
        this.log('warn', `GENA 不可用，改为轮询: ${String(error)}`);
      }
    }
    if (this.shuttingDown || token !== this.sessionToken) return;
    this.pollTimer = this.schedule(() => {
      void this.pollOnce();
    }, 2000);
  }

  private startAirplayWatch(token: number): void {
    this.stopTimers();
    this.pollTimer = this.schedule(() => {
      if (token !== this.sessionToken || this.mode !== 'airplay') return;
      const status = this.deps.airplay?.status();
      if (!status || !status.connected || status.error)
        void this.loseAirplay(status?.error || 'device-offline');
    }, 2000);
  }

  private loseLink(reason: string): Promise<void> {
    const token = this.sessionToken;
    return this.runRoute(async () => {
      if (!this.shuttingDown && token === this.sessionToken) await this.loseLinkBody(reason);
    });
  }

  private async loseLinkBody(reason: string): Promise<void> {
    if (this.mode !== 'dlna' || this.link === 'lost') return;
    this.link = 'lost';
    this.playing = false;
    this.sessionToken += 1;
    this.commands.bump();
    this.stopTimers();
    await this.dropSubscription();
    this.deps.media?.revokeSession(this.mediaSessionId);
    this.activeToken = null;
    this.diagnostics = '设备已断开，已暂停并保留队列。不会自动改回本机播放';
    this.emitPlayer('state-change', this.statePayload());
    this.emitOutput({
      type: 'session-ended',
      payload: { reason, lastKnownPositionSec: this.position },
    });
    this.publish();
  }

  private loseAirplay(reason: string, token = this.sessionToken): Promise<void> {
    return this.runRoute(async () => {
      if (!this.shuttingDown && token === this.sessionToken) await this.loseAirplayBody(reason);
    });
  }

  private async loseAirplayBody(reason: string): Promise<void> {
    if (this.mode !== 'airplay' || this.link === 'lost') return;
    this.link = 'lost';
    this.playing = false;
    this.airplayPaused = true;
    this.sessionToken += 1;
    this.commands.bump();
    this.stopTimers();
    this.diagnostics = 'AirPlay 已断开，已暂停。不会自动改从本机扬声器播出';
    for (const stop of [
      () => this.deps.local.setAirplayTap?.(0, false),
      () => this.deps.local.pause(),
    ]) {
      try {
        await stop();
      } catch (error) {
        this.log('warn', `断开时暂停本机失败: ${String(error)}`);
      }
    }
    try {
      await this.deps.airplay?.disconnect();
    } catch (error) {
      this.log('warn', `关闭 AirPlay 失败: ${String(error)}`);
    }
    this.emitPlayer('state-change', this.statePayload());
    this.emitOutput({
      type: 'session-ended',
      payload: { reason, lastKnownPositionSec: this.position },
    });
    this.publish();
  }

  private async stopRemote(clearUrl: boolean): Promise<void> {
    this.commands.bump();
    this.sessionToken += 1;
    this.stopTimers();
    await this.dropSubscription();
    if (this.backend) {
      try {
        await this.backend.stop();
      } catch (error) {
        this.log('warn', `停止 DLNA 失败: ${String(error)}`);
      }
    }
    if (this.mode === 'airplay') {
      // 每个资源独立释放；音频出口失败也必须断开发送器。
      for (const stop of [
        () => this.deps.local.setAirplayTap?.(0, false),
        () => this.deps.local.pause(),
        () => this.deps.airplay?.disconnect(),
      ]) {
        try {
          await stop();
        } catch (error) {
          this.log('warn', `停止 AirPlay 失败: ${String(error)}`);
        }
      }
      this.airplayPaused = false;
    }
    this.deps.media?.revokeSession(this.mediaSessionId);
    this.backend = null;
    this.backendBus = null;
    this.device = null;
    this.activeToken = null;
    this.playing = false;
    this.playerTrackSeq = 0;
    this.lastDlnaPollLogAt = 0;
    this.lastDlnaPollLogKey = '';
    this.mode = 'local';
    this.link = 'up';
    this.targetId = null;
    this.targetName = '';
    if (clearUrl) this.originalUrl = '';
  }

  private async dropSubscription(): Promise<void> {
    this.disarmPendingCallback();
    const current = this.subscription;
    this.subscription = null;
    if (!current) return;
    this.deps.gena?.untrackSubscription(current.sid);
    if (!this.deps.unsubscribe) return;
    try {
      await this.deps.unsubscribe(current.url, current.sid, current.host);
    } catch (error) {
      this.log('warn', `退订失败: ${String(error)}`);
    }
  }

  private disarmPendingCallback(): void {
    if (!this.pendingCallbackToken) return;
    this.deps.gena?.disarmToken(this.pendingCallbackToken);
    this.pendingCallbackToken = null;
  }

  private stopTimers(): void {
    for (const timer of this.tapStatsTimers) timer.cancel();
    this.tapStatsTimers.clear();
    this.pollTimer?.cancel();
    this.renewTimer?.cancel();
    this.pollTimer = null;
    this.renewTimer = null;
  }

  private schedule(fn: () => void, ms: number): { cancel(): void } {
    return (this.deps.schedule ?? defaultSchedule)(fn, ms);
  }

  private logDlnaPollState(
    transportState?: string,
    relTime?: string,
    duration?: string,
    trackUri?: string,
  ): void {
    const now = this.now();
    const key = `${transportState || '-'}|${duration || '-'}|${trackUri || '-'}`;
    if (key === this.lastDlnaPollLogKey && now - this.lastDlnaPollLogAt < DLNA_POLL_LOG_INTERVAL_MS)
      return;
    this.lastDlnaPollLogAt = now;
    this.lastDlnaPollLogKey = key;
    this.log(
      'info',
      `DLNA 状态: target=${this.targetName || this.targetId || '-'}, state=${transportState || '-'}, position=${relTime || '-'}, duration=${duration || '-'}, uri=${trackUri ? describeUrlForLog(trackUri) : '-'}`,
    );
  }

  private requireAirplay(): AirplayControl {
    const airplay = this.deps.airplay;
    if (!airplay?.available || !this.airplayActive) {
      throw new Error('AirPlay 发送未连接');
    }
    return airplay;
  }

  private statePayload() {
    return {
      playing: this.link === 'up' && this.playing,
      paused: !(this.link === 'up' && this.playing),
      timePos: this.position,
      duration: this.duration,
      volume: this.deviceVolume ?? undefined,
      speed: 1,
      idle: this.mode === 'local',
      path: this.originalUrl,
      audioDevice: this.targetName,
      trackSeq: this.playerEventTrackSeq(),
      generation: this.routeEpoch,
    };
  }

  private playerEventTrackSeq(fallback = this.trackSeq): number {
    return this.playerTrackSeq > 0 ? this.playerTrackSeq : fallback;
  }

  private emitPlayer(event: string, ...args: unknown[]): void {
    if (this.shuttingDown) return;
    this.deps.emitPlayer?.(event, ...args);
  }

  private emitOutput(event: { type: string; payload?: unknown }): void {
    if (this.shuttingDown) return;
    this.deps.emitOutput?.(event);
  }

  private publish(): void {
    if (this.shuttingDown) return;
    this.emitOutput({
      type: 'session-changed',
      payload: {
        snapshot: this.snapshot(),
        targets: this.targets(),
        diagnostics: this.diagnostics,
      },
    });
  }

  notifySourceStale(status: number): void {
    if (this.sourceStale) return;
    this.sourceStale = true;
    this.diagnostics = `音源返回 ${status}，需要按原来的解析流程重新获取`;
    this.emitPlayer('error', { code: 'output-source-stale', message: this.diagnostics });
    this.publish();
  }
}

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 0;
  return Math.max(0, Math.min(100, Math.round(volume)));
}

function pickDlnaDisplayName(
  entry: { name?: string | null; server?: string | null },
  previousName?: string | null,
): string {
  const explicit = cleanDisplayName(entry.name);
  if (explicit) return explicit;
  const previous = cleanDisplayName(previousName);
  if (previous && !looksLikeSsdpServer(previous)) return previous;
  const server = cleanDisplayName(entry.server);
  if (server?.toLowerCase().includes('smartshare')) return 'SmartShare';
  return 'DLNA 设备';
}

function cleanDisplayName(value?: string | null): string {
  return String(value ?? '').trim();
}

function looksLikeSsdpServer(value: string): boolean {
  return /\bUPnP\/\d/i.test(value) || /^[A-Za-z]+\/[\d.]/.test(value);
}

function defaultSchedule(fn: () => void, ms: number): { cancel(): void } {
  const timer = setInterval(fn, ms);
  return { cancel: () => clearInterval(timer) };
}

let singleton: OutputHost | null = null;

export function initOutputHost(deps: OutputHostDeps): OutputHost {
  singleton = new OutputHost(deps);
  return singleton;
}

export function getOutputHost(): OutputHost | null {
  return singleton;
}
