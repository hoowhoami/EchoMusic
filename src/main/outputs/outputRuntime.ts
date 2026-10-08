/**
 * 把输出会话接到 Electron、SSDP、媒体中转和原生模块。
 * 插件 API 不经过这里。
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import log from '../logger';
import { getMainWindow } from '../window';
import { publishPlayerEvent } from '../player';
import { registerNativeLogHandler } from '../native/logging';
import type { PlayerController } from '../player/controller';
import {
  createSsdpDiscovery,
  type SsdpDeviceEntry,
  type SsdpHandle,
} from '../mediaTransport/discovery';
import { GenaReceiver } from '../mediaTransport/genaReceiver';
import { MediaServer, pickLanIpv4 } from '../mediaTransport/mediaServer';
import type { UpnpNativeLike } from '../mediaTransport/dlnaAdapter';
import {
  argsToXml,
  parseActionResult,
  renewEvent,
  subscribeEvent,
  unsubscribeEvent,
} from '../mediaTransport/upnpClient';
import {
  getOutputHost,
  initOutputHost,
  type AirplayControl,
  type AirplayDeviceInfo,
  type AirplayStatus,
  type DlnaDescriptionFailure,
} from './outputHost';
import { runMacAirplayBonjourDiagnostics } from './airplayBonjourDiagnostics';

const nativeRequire = createRequire(path.join(process.cwd(), 'package.json'));

let discovery: SsdpHandle | null = null;
let scanTimer: NodeJS.Timeout | null = null;
let scanSearchFlight: Promise<void> | null = null;
/** 进行中的 SSDP 扫描数。串行补轮时用它避免 `searching` 中途假停。 */
let dlnaScansInFlight = 0;
/** 排队等待补一轮的刷新数。串行补轮时用它避免 `searching` 中途假停。 */
let dlnaRescanQueued = 0;
/** 上一次 sync 时是否处在「应当扫描」的状态，用于边沿触发完整周期。 */
let scanWanted = false;
/** 一次性许可：进入扫描状态时置位，能发起扫描时才消费。 */
let scanArmed = false;
let scanStopFlight: Promise<void> | null = null;
let shuttingDown = false;
let shutdownFlight: Promise<void> | null = null;
let stopReceivers: (() => Promise<void>) | null = null;
let upnpNative: UpnpNativeLike | null = null;
let scanActiveLogged = false;
const ignoredDlnaDeviceIds = new Set<string>();
const dlnaDescriptionCache = new Map<
  string,
  {
    location: string;
    name?: string;
    deviceType?: string;
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
    services?: string[];
    pending?: Promise<void>;
    failedUntil?: number;
    failureCount?: number;
    lastError?: string;
  }
>();

function isRendererSearchTarget(st: string): boolean {
  const lower = st.toLowerCase();
  return lower.includes('mediarenderer') || lower.includes('avtransport');
}

function shouldPublishDlnaDevice(device: SsdpDeviceEntry): boolean {
  const description = dlnaDescriptionCache.get(device.usn);
  if (description?.location === device.location && description.lastError && !description.name) {
    return false;
  }
  if (!description || description.location !== device.location || description.pending) {
    return isRendererSearchTarget(device.st);
  }
  if (description.deviceType?.toLowerCase().includes('mediarenderer')) return true;
  if (description.services?.some((service) => service.toLowerCase().includes('avtransport'))) {
    return true;
  }
  if (!ignoredDlnaDeviceIds.has(device.usn)) {
    ignoredDlnaDeviceIds.add(device.usn);
    log.info(
      `DLNA 忽略不可播放设备: id=${device.usn}, name=${description.name || '-'}, type=${description.deviceType || '-'}, services=${description.services?.join('/') || '-'}`,
    );
  }
  return false;
}

function outputLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') {
    log.error(message);
  } else if (level === 'warn') {
    log.warn(message);
  } else {
    log.info(message);
  }
}

function addonPath(name: string): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'native', `${name}.node`)]
    : [
        path.join(__dirname, `../../native/${name}/${name}.node`),
        path.join(process.cwd(), `native/${name}/${name}.node`),
      ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function loadAddon(name: string): Record<string, (...args: any[]) => any> | null {
  const candidate = addonPath(name);
  if (!candidate) return null;
  try {
    return nativeRequire(candidate);
  } catch (error) {
    log.warn(
      `[Output] 未能加载 ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function loadUpnp(): UpnpNativeLike | null {
  const addon = loadAddon('echo-upnp');
  if (!addon?.loadDevice || !addon?.action) return null;
  return {
    loadDevice: (url) => addon.loadDevice(url),
    async action(url, serviceId, name, args) {
      const raw = await addon.action(url, serviceId, name, argsToXml(args));
      return parseActionResult(raw);
    },
    async clearDeviceCache() {
      addon.clearDeviceCache?.();
    },
  };
}

function unavailableAirplay(): AirplayControl {
  const status = (): AirplayStatus => ({
    connected: false,
    delaySec: 0,
    format: '',
    inputBits: 16,
  });
  return {
    available: false,
    async discover() {
      return [];
    },
    async connect() {
      return { ok: false, error: 'AirPlay 发送模块尚未构建，不能把发现或 SETUP 当成正在播放' };
    },
    async disconnect() {},
    async pause() {},
    async resume() {},
    async seek() {
      throw new Error('AirPlay 发送未连接');
    },
    async stop() {},
    async setVolume() {},
    async flushTrack() {
      throw new Error('AirPlay 发送未连接');
    },
    status,
  };
}

function loadAirplay(): AirplayControl {
  const addon = loadAddon('echo-airplay');
  if (!addon?.discover || !addon?.connect) return unavailableAirplay();
  registerNativeLogHandler(addon, 'AirPlayNative');
  return {
    available: true,
    discoveryBackend: addon.discoveryBackend ? () => String(addon.discoveryBackend()) : undefined,
    discover: (timeoutMs) => addon.discover(timeoutMs) as Promise<AirplayDeviceInfo[]>,
    discoverEach: addon.discoverEach
      ? (timeoutMs, onDevice) =>
          addon.discoverEach(timeoutMs, (error: Error | null, device: AirplayDeviceInfo) => {
            if (!error && device) onDevice(device);
          }) as Promise<AirplayDeviceInfo[]>
      : undefined,
    connect: (id, pin, initialVolume) => addon.connect(id, pin ?? '', initialVolume),
    disconnect: () => addon.disconnect(),
    pause: () => addon.pause(),
    resume: () => addon.resume(),
    seek: (seconds) => addon.seek(seconds),
    stop: () => addon.stop(),
    setVolume: (volume) => addon.setVolume(volume),
    flushTrack: () => addon.flushTrack(),
    status: () => addon.status() as AirplayStatus,
    clearRecords: addon.clearRecords ? () => addon.clearRecords() : undefined,
  };
}

function localTransport(getController: () => PlayerController | null) {
  const controller = () => {
    const current = getController();
    if (!current) throw new Error('播放器未初始化');
    return current;
  };
  return {
    beginSourceChange() {
      return getController()?.beginSourceChange() ?? 0;
    },
    loadFile(url: string, requestId?: number) {
      return getController()?.loadFile(url, requestId) ?? Promise.resolve(null);
    },
    pause() {
      return controller().pause();
    },
    play(requestId?: number) {
      return controller().play(requestId);
    },
    stop() {
      return controller().stop();
    },
    seek(time: number) {
      return controller().seek(time);
    },
    setVolume(volume: number) {
      return controller().setVolume(volume);
    },
    getState() {
      return getController()?.getState() ?? null;
    },
    setAudioOutput(deviceName: string, exclusive: boolean) {
      return Promise.resolve(controller().setAudioOutput(deviceName, exclusive)).then(
        () => undefined,
      );
    },
    getAudioDevices() {
      return Promise.resolve(controller().getAudioDevices());
    },
    setAirplayTap(port: number, enabled: boolean) {
      return controller().setAirplayTap(port, enabled);
    },
    setAirplayEpoch(epoch: number) {
      return controller().setAirplayEpoch(epoch);
    },
    getAirplayTapStats() {
      return controller().getAirplayTapStats();
    },
  };
}

function scheduleDlnaDescriptionLoad(device: SsdpDeviceEntry): void {
  if (!upnpNative || !device.location) return;
  const cached = dlnaDescriptionCache.get(device.usn);
  const now = Date.now();
  if (
    cached?.location === device.location &&
    cached.failedUntil &&
    cached.failedUntil > now &&
    !cached.name
  ) {
    return;
  }
  if (cached?.location === device.location && (cached.name || cached.pending)) return;
  const record = {
    location: device.location,
    name: cached?.location === device.location ? cached.name : undefined,
    deviceType: cached?.location === device.location ? cached.deviceType : undefined,
    manufacturer: cached?.location === device.location ? cached.manufacturer : undefined,
    manufacturerUrl: cached?.location === device.location ? cached.manufacturerUrl : undefined,
    modelName: cached?.location === device.location ? cached.modelName : undefined,
    modelDescription: cached?.location === device.location ? cached.modelDescription : undefined,
    modelNumber: cached?.location === device.location ? cached.modelNumber : undefined,
    modelUrl: cached?.location === device.location ? cached.modelUrl : undefined,
    serialNumber: cached?.location === device.location ? cached.serialNumber : undefined,
    udn: cached?.location === device.location ? cached.udn : undefined,
    upc: cached?.location === device.location ? cached.upc : undefined,
    presentationUrl: cached?.location === device.location ? cached.presentationUrl : undefined,
    services: cached?.location === device.location ? cached.services : undefined,
    failureCount: cached?.location === device.location ? cached.failureCount : undefined,
    failedUntil: undefined as number | undefined,
    lastError: undefined as string | undefined,
    pending: undefined as Promise<void> | undefined,
  };
  dlnaDescriptionCache.set(device.usn, record);
  record.pending = upnpNative
    .loadDevice(device.location)
    .then((loaded) => {
      record.name = loaded.friendlyName;
      record.deviceType = loaded.deviceType;
      record.manufacturer = loaded.manufacturer;
      record.manufacturerUrl = loaded.manufacturerUrl;
      record.modelName = loaded.modelName;
      record.modelDescription = loaded.modelDescription;
      record.modelNumber = loaded.modelNumber;
      record.modelUrl = loaded.modelUrl;
      record.serialNumber = loaded.serialNumber;
      record.udn = loaded.udn;
      record.upc = loaded.upc;
      record.presentationUrl = loaded.presentationUrl;
      record.services = loaded.services.map(
        (service) => `${service.serviceId}:${service.serviceType}`,
      );
      pushDlnaDevices();
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const failureCount = Math.min((record.failureCount ?? 0) + 1, 5);
      record.failureCount = failureCount;
      record.lastError = message;
      record.failedUntil = Date.now() + Math.min(15_000 * 2 ** (failureCount - 1), 180_000);
      log.warn(
        `DLNA 设备描述失败: id=${device.usn}, location=${device.location}, retryIn=${Math.round((record.failedUntil - Date.now()) / 1000)}s, error=${message}`,
      );
      pushDlnaDevices();
    })
    .finally(() => {
      const latest = dlnaDescriptionCache.get(device.usn);
      if (latest === record) record.pending = undefined;
    });
}

function pushDlnaDevices(): void {
  const host = getOutputHost();
  if (!host?.wantsScan || !discovery) return;
  // 描述失败的设备不会进入投放列表。把它单列上报，否则 UI 只能显示
  // 「没有找到设备」，把描述解析问题伪装成发现失败。
  const failures: DlnaDescriptionFailure[] = [];
  const entries = [];
  for (const device of discovery.list()) {
    scheduleDlnaDescriptionLoad(device);
    if (!shouldPublishDlnaDevice(device)) {
      const description = dlnaDescriptionCache.get(device.usn);
      if (description && description.location === device.location && !description.pending) {
        host.removeDlnaDevice(device.usn);
        if (description.lastError && !description.name) {
          failures.push({
            usn: device.usn,
            location: device.location,
            error: description.lastError,
          });
        }
      }
      continue;
    }
    const description = dlnaDescriptionCache.get(device.usn);
    entries.push({
      usn: device.usn,
      location: device.location,
      server: device.server,
      name: description?.location === device.location ? description.name : undefined,
      manufacturer:
        description?.location === device.location ? description.manufacturer : undefined,
      manufacturerUrl:
        description?.location === device.location ? description.manufacturerUrl : undefined,
      modelName: description?.location === device.location ? description.modelName : undefined,
      modelDescription:
        description?.location === device.location ? description.modelDescription : undefined,
      modelNumber: description?.location === device.location ? description.modelNumber : undefined,
      modelUrl: description?.location === device.location ? description.modelUrl : undefined,
      serialNumber:
        description?.location === device.location ? description.serialNumber : undefined,
      udn: description?.location === device.location ? description.udn : undefined,
      upc: description?.location === device.location ? description.upc : undefined,
      presentationUrl:
        description?.location === device.location ? description.presentationUrl : undefined,
      st: device.st,
      interface: device.interface,
      maxAgeSec: device.maxAgeSec,
    });
  }
  host.noteDlnaDevices(entries);
  host.noteDlnaDescriptionFailures(failures);
}

function handleDlnaDeviceChange(device: SsdpDeviceEntry): void {
  const host = getOutputHost();
  if (!host?.wantsScan || !discovery) return;
  if (!device.location) {
    dlnaDescriptionCache.delete(device.usn);
    host.removeDlnaDevice(device.usn);
    return;
  }
  scheduleDlnaDescriptionLoad(device);
  pushDlnaDevices();
}

/** 保证设备推送定时器在扫描期望期间运行。它不发网络包，只把结果推给 UI。 */
function ensureScanTimer(): void {
  if (!scanTimer) scanTimer = setInterval(pushDlnaDevices, 4000);
}

let dlnaScanningReported = false;

/**
 * 由「进行中的扫描数 + 排队等待的刷新数」推导 `searching` 并只在变化时上报。
 *
 * 刷新会在当前轮结束后串行补一轮。若每轮各自清状态，按钮会在一次点击中途
 * 假停一下，所以这两者必须合起来看。
 */
function syncDlnaScanningState(): void {
  const scanning = dlnaScansInFlight > 0 || dlnaRescanQueued > 0;
  if (scanning === dlnaScanningReported) return;
  dlnaScanningReported = scanning;
  getOutputHost()?.noteDlnaScanning(scanning);
}

/**
 * 启动一轮 SSDP 扫描。`once` 为真时只发一轮 M-SEARCH（手动刷新用，约 1 秒），
 * 否则跑完整的三轮周期（约 7 秒，重发对抗丢包）。
 */
function launchDlnaSearch(once: boolean): Promise<void> {
  const host = getOutputHost();
  const scanner = discovery;
  dlnaScansInFlight += 1;
  // 扫描状态跟随这个 flight，而不是靠 diagnostics 文案推断 ——
  // 否则扫描结束后刷新按钮会一直转圈。
  syncDlnaScanningState();
  const flight = (async () => {
    await scanStopFlight;
    if (!scanner || shuttingDown || !host?.wantsScan) return;
    await scanner.start();
    if (shuttingDown || !host.wantsScan) return;
    await scanner.search(once);
  })()
    .catch((error) => log.warn(`[Output] SSDP 启动失败: ${String(error)}`))
    .finally(() => {
      dlnaScansInFlight = Math.max(0, dlnaScansInFlight - 1);
      if (scanSearchFlight === flight) scanSearchFlight = null;
      syncDlnaScanningState();
      if (dlnaScansInFlight === 0) pushDlnaDevices();
    });
  scanSearchFlight = flight;
  return flight;
}

/**
 * 手动刷新：等当前扫描结束后立刻补一轮新的 M-SEARCH。
 *
 * `syncOutputScan()` 只在空闲时启动扫描，所以刷新按钮必须走这里才真的能
 * 重新搜索 —— 否则一轮跑完后连点刷新不会有任何网络动作。
 *
 * 注意这里不能先调 `syncOutputScan()`：那会在空闲时启动完整的 7 秒周期，
 * 于是一次刷新要先等完三轮再补一轮（约 8 秒）。刷新只需要一轮。
 */
export function rescanDlnaDevices(): Promise<void> {
  const host = getOutputHost();
  if (!host || !discovery || shuttingDown || !host.wantsScan) {
    pushDlnaDevices();
    return Promise.resolve();
  }
  ensureScanTimer();
  const inFlight = scanSearchFlight;
  // 先占位再等待：本轮结束时扫描还没结束，所以 searching 不会中途变 false。
  dlnaRescanQueued += 1;
  syncDlnaScanningState();
  return (inFlight ? inFlight.then(() => undefined) : Promise.resolve())
    .then(() => {
      const current = getOutputHost();
      if (!current?.wantsScan || shuttingDown || !discovery) return undefined;
      return launchDlnaSearch(true);
    })
    .finally(() => {
      dlnaRescanQueued = Math.max(0, dlnaRescanQueued - 1);
      syncDlnaScanningState();
      pushDlnaDevices();
    });
}

export function syncOutputScan(): void {
  const host = getOutputHost();
  if (!host || !discovery || shuttingDown) return;
  if (host.wantsScan) {
    if (!scanActiveLogged) {
      scanActiveLogged = true;
      log.info(`DLNA SSDP 扫描启动: echo-upnp=${upnpNative ? 'ready' : 'missing'}`);
    }
    // 边沿触发：只在「从不扫描到要扫描」这一次启动完整周期。
    // `wantsScan` 里含 `enabled`（网络播放开关），所以面板关闭时它往往仍为真；
    // 若每次 sync 都补一轮，关闭面板这种与搜索无关的操作也会触发一次 7 秒
    // 的 M-SEARCH 突发，并把 `searching` 重新点亮 7 秒。
    //
    // scanArmed 是一次性许可：进入扫描状态时置位，等到真的能发起扫描（当前没有
    // flight 在跑）才消费。否则「扫描中→关闭→再打开」这条路径会把许可白白用掉，
    // 停在 pending stop 之后的那次 sync 就再也发不出扫描。
    if (!scanWanted) {
      scanWanted = true;
      scanArmed = true;
    }
    if (scanArmed && !scanSearchFlight) {
      scanArmed = false;
      launchDlnaSearch(false);
    }
    ensureScanTimer();
    return;
  }
  scanWanted = false;
  scanArmed = false;
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (scanActiveLogged) {
    scanActiveLogged = false;
    log.info('DLNA SSDP 扫描停止');
  }
  dlnaDescriptionCache.clear();
  ignoredDlnaDeviceIds.clear();
  if (!scanStopFlight) {
    const scanner = discovery;
    const flight = (async () => {
      await scanSearchFlight;
      if (!shuttingDown && !host.wantsScan) await scanner.stop();
    })()
      .catch((error) => log.warn(`[Output] SSDP 停止失败: ${String(error)}`))
      .finally(() => {
        if (scanStopFlight === flight) {
          scanStopFlight = null;
          if (!shuttingDown && host.wantsScan) syncOutputScan();
        }
      });
    scanStopFlight = flight;
  }
}

export function initOutputRuntime(getController: () => PlayerController | null): void {
  if (shuttingDown || getOutputHost()) return;
  const bindHost = pickLanIpv4();
  const media = new MediaServer({
    bindHost,
    log: outputLog,
    onUpstreamStatus: (status) => getOutputHost()?.notifySourceStale(status),
  });
  const gena = new GenaReceiver({
    bindHost,
    log: outputLog,
    onLastChange: (_sid, change) => getOutputHost()?.ingestLastChange(change.raw),
  });
  discovery = createSsdpDiscovery({
    allowScan: () => getOutputHost()?.wantsScan === true,
    onDevice: handleDlnaDeviceChange,
    log: outputLog,
  });
  upnpNative = loadUpnp();
  initOutputHost({
    local: localTransport(getController),
    native: upnpNative,
    airplay: loadAirplay(),
    media,
    gena,
    subscribe: subscribeEvent,
    renew: renewEvent,
    unsubscribe: unsubscribeEvent,
    allowLoopbackRelay: false,
    runAirplayDiagnostics: () =>
      runMacAirplayBonjourDiagnostics((level, message) =>
        level === 'error'
          ? log.error(message)
          : level === 'warn'
            ? log.warn(message)
            : log.info(message),
      ),
    emitPlayer: (event, ...args) => publishPlayerEvent(event, args[0], args[1]),
    emitOutput: (event) => {
      const windows = [getMainWindow()];
      for (const window of windows) {
        if (!window || window.isDestroyed()) continue;
        window.webContents.send('output:event', event);
      }
    },
    log: outputLog,
  });
  stopReceivers = async () => {
    await Promise.allSettled([scanSearchFlight, scanStopFlight]);
    const results = await Promise.allSettled([discovery?.stop(), media.stop(), gena.stop()]);
    for (const result of results) {
      if (result.status === 'rejected') log.warn('[Output] 释放网络资源失败:', result.reason);
    }
  };
  app.once('before-quit', () => {
    void shutdownOutputRuntime().catch((error) => log.warn('[Output] 退出清理失败:', error));
  });
  log.info(`[Output] 发送会话已初始化，中转地址 ${bindHost}`);
}

/** 先结束连接/会话，再关闭它可能仍在启动的 HTTP 与 GENA 接收器。 */
export function shutdownOutputRuntime(): Promise<void> {
  if (shutdownFlight) return shutdownFlight;
  shuttingDown = true;
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  const hostShutdown = getOutputHost()?.shutdown();
  shutdownFlight = (async () => {
    try {
      await hostShutdown;
    } finally {
      await stopReceivers?.();
    }
  })();
  return shutdownFlight;
}
