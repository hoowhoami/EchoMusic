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
} from './outputHost';
import { runMacAirplayBonjourDiagnostics } from './airplayBonjourDiagnostics';

const nativeRequire = createRequire(path.join(process.cwd(), 'package.json'));

let discovery: SsdpHandle | null = null;
let scanTimer: NodeJS.Timeout | null = null;
let scanSearchFlight: Promise<void> | null = null;
let shuttingDown = false;
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
  }
>();

function isRendererSearchTarget(st: string): boolean {
  const lower = st.toLowerCase();
  return lower.includes('mediarenderer') || lower.includes('avtransport');
}

function shouldPublishDlnaDevice(device: SsdpDeviceEntry): boolean {
  const description = dlnaDescriptionCache.get(device.usn);
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
    connect: (id, pin) => addon.connect(id, pin ?? ''),
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
    pending: undefined as Promise<void> | undefined,
  };
  dlnaDescriptionCache.set(device.usn, record);
  log.info(`DLNA 加载设备描述: id=${device.usn}, location=${device.location}`);
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
      log.info(
        `DLNA 设备描述完成: id=${device.usn}, name=${loaded.friendlyName || '-'}, manufacturer=${loaded.manufacturer || '-'}, model=${loaded.modelName || '-'}, modelNumber=${loaded.modelNumber || '-'}, serial=${loaded.serialNumber || '-'}, udn=${loaded.udn || '-'}, type=${loaded.deviceType || '-'}, services=${loaded.services.length}`,
      );
      pushDlnaDevices();
    })
    .catch((error) => {
      log.warn(
        `DLNA 设备描述失败: id=${device.usn}, location=${device.location}, error=${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      const latest = dlnaDescriptionCache.get(device.usn);
      if (latest === record) record.pending = undefined;
    });
}

function pushDlnaDevices(): void {
  const host = getOutputHost();
  if (!host || !discovery) return;
  const entries = [];
  for (const device of discovery.list()) {
    scheduleDlnaDescriptionLoad(device);
    if (!shouldPublishDlnaDevice(device)) {
      const description = dlnaDescriptionCache.get(device.usn);
      if (description && description.location === device.location && !description.pending) {
        host.removeDlnaDevice(device.usn);
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
}

function handleDlnaDeviceChange(device: SsdpDeviceEntry): void {
  const host = getOutputHost();
  if (!host || !discovery) return;
  if (!device.location) {
    dlnaDescriptionCache.delete(device.usn);
    host.removeDlnaDevice(device.usn);
    return;
  }
  scheduleDlnaDescriptionLoad(device);
  pushDlnaDevices();
}

export function syncOutputScan(): void {
  const host = getOutputHost();
  if (!host || !discovery || shuttingDown) return;
  if (host.wantsScan) {
    if (!scanActiveLogged) {
      scanActiveLogged = true;
      log.info(`DLNA SSDP 扫描启动: echo-upnp=${upnpNative ? 'ready' : 'missing'}`);
    }
    void discovery
      .start()
      .then(() => {
        if (scanSearchFlight) return scanSearchFlight;
        scanSearchFlight = (discovery?.search() ?? Promise.resolve()).finally(() => {
          scanSearchFlight = null;
        });
        return scanSearchFlight;
      })
      .catch((error) => log.warn(`[Output] SSDP 启动失败: ${String(error)}`));
    if (!scanTimer) scanTimer = setInterval(pushDlnaDevices, 4000);
    return;
  }
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (scanActiveLogged) {
    scanActiveLogged = false;
    log.info('DLNA SSDP 扫描停止');
  }
  scanSearchFlight = null;
  dlnaDescriptionCache.clear();
  ignoredDlnaDeviceIds.clear();
  void discovery.stop().catch(() => undefined);
}

export function initOutputRuntime(getController: () => PlayerController | null): void {
  if (getOutputHost()) return;
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
  app.once('before-quit', () => {
    shuttingDown = true;
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
    void getOutputHost()?.shutdown();
    void discovery?.stop();
    void media.stop();
    void gena.stop();
  });
  log.info(`[Output] 发送会话已初始化，中转地址 ${bindHost}`);
}
