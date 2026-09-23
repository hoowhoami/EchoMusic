/**
 * EchoMusic DLNA SSDP 主动搜索 + 被动监听（design §5）。
 *
 * - M-SEARCH 多目标：ssdp:all / MediaRenderer:1/2 / AVTransport:1（兼容不响应通用目标的设备）。
 * - 监听响应并维护争取 upnp:rootdevice USN 键控缓存；接收 NOTIFY ssdp:alive / ssdp:byebye。
 * - 缓存过期遵循 Cache-Control: max-age（缺省 1800s）；byebye 即时移除；多网卡去重合并。
 * - 结果仅作为“网络上有哪些可达端点”的候选；端点可达性/服务解析/防探针校验留给 dlnaAdapter。
 * - 事件/轮询/搜索共享同一时钟；配合 allowScan 门控：开网络播放开关或开设备面板时扫描。
 *
 * 为可测性，socket 与定时器可注入；本文件无 Electron 依赖。
 */
import dgram from 'node:dgram';
import os from 'node:os';

export const SSDP_ADDR = '239.255.255.250';
export const SSDP_PORT = 1900;

export const SEARCH_TARGETS = [
  'ssdp:all',
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:device:MediaRenderer:2',
  'urn:schemas-upnp-org:service:AVTransport:1',
];

export interface SsdpDeviceEntry {
  usn: string;
  st: string;
  location: string;
  server: string;
  maxAgeSec: number;
  interface: string;
  firstSeen: number;
  lastSeen: number;
  expiresAt: number;
}

export interface SsdpDiscoveryOptions {
  /** 扫描门控：true 才允许发送 M-SEARCH / 维持监听。默认恒 true。 */
  allowScan?: () => boolean;
  /** 已发现候选变化回调（add/update/remove）。 */
  onDevice?: (device: SsdpDeviceEntry) => void;
  /** 默认缓存有效期秒（缺省 1800）。 */
  defaultMaxAge?: number;
  maxDevices?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 测试注入 socket 工厂。 */
  socketFactory?: () => dgram.Socket;
  now?: () => number;
}

export interface SsdpHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  search(once?: boolean): Promise<void>;
  list(): SsdpDeviceEntry[];
  get(usn: string): SsdpDeviceEntry | undefined;
  get socket(): dgram.Socket | null;
  /** 测试注入：直接把收到的报文送入既有消息处理路径（真实 socket 走同一路径）。 */
  feedForTest(text: string, rinfo?: Partial<dgram.RemoteInfo>): void;
  get cachedUsnCount(): number;
}

const STALE_CHECK_MS = 15_000;

function parseMaxAge(cacheControl: string | undefined, fallbackMs: number): number {
  if (!cacheControl) return fallbackMs;
  const match = /max-age\s*=\s*(\d+)/i.exec(cacheControl);
  if (!match) return fallbackMs;
  const sec = Number(match[1]);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : fallbackMs;
}

/** 解析 SSDP 响应头为小写键映射。 */
function parseHeaders(headers: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of headers.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

/** 宽松 UUID 形态：uuid:xxx[::...]（厂商常含字母/数字/点/下划线，非纯 hex）。 */
const UUID_RE = /^uuid:[A-Za-z0-9._:-]{1,64}(?:::[A-Za-z0-9._-]+)?$/;
const VALID_LOCATION_RE = /^https?:\/\/[^\s/]+(?::\d{0,5})?\/?[^\s]*$/i;

function candidateUsn(usn: string | undefined): string | null {
  if (!usn) return null;
  const trimmed = usn.trim().toLowerCase();
  if (!UUID_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function createSsdpDiscovery(options: SsdpDiscoveryOptions = {}): SsdpHandle {
  const log = options.log ?? (() => {});
  const allowScan = options.allowScan ?? (() => true);
  const now = options.now ?? (() => Date.now());
  const defaultMaxAgeMs = (options.defaultMaxAge ?? 1800) * 1000;
  const maxDevices = options.maxDevices ?? 64;

  const devices = new Map<string, SsdpDeviceEntry>();
  let socket: dgram.Socket | null = null;
  let staleTimer: NodeJS.Timeout | null = null;
  let started = false;

  function acceptDevice(headers: Record<string, string>, rinfo: dgram.RemoteInfo): void {
    const usn = candidateUsn(headers['usn']);
    const location = headers['location'];
    if (!usn || !location) return;
    if (!VALID_LOCATION_RE.test(location)) {
      log('warn', `[SSDP] 忽略不可信 Location: ${location.slice(0, 64)}`);
      return;
    }
    const nowMs = now();
    const expiresAt = Math.min(
      nowMs + parseMaxAge(headers['cache-control'], defaultMaxAgeMs),
      nowMs + 24 * 60 * 60 * 1000,
    );
    const existing = devices.get(usn);
    if (existing) {
      if (existing.location === location) {
        existing.lastSeen = nowMs;
        existing.expiresAt = expiresAt;
        existing.st = headers['st'] ?? existing.st;
      } else {
        // 端点变化（如 IP 变更）→ 视为新设备，旧端点随会话结束清理。
        devices.set(usn, {
          usn,
          st: headers['st'] ?? existing.st,
          location,
          server: headers['server'] ?? existing.server,
          maxAgeSec: expiresAt ? Math.round((expiresAt - nowMs) / 1000) : defaultMaxAgeMs / 1000,
          interface: rinfo.address,
          firstSeen: existing.firstSeen,
          lastSeen: nowMs,
          expiresAt,
        });
      }
      options.onDevice?.(devices.get(usn)!);
      return;
    }
    if (devices.size >= maxDevices) {
      // 限制候选上限，避免海量响应占据内存。
      evictExpired(nowMs);
      if (devices.size >= maxDevices) return;
    }
    const entry: SsdpDeviceEntry = {
      usn,
      st: headers['st'] ?? '',
      location,
      server: headers['server'] ?? '',
      maxAgeSec: Math.round((expiresAt - nowMs) / 1000),
      interface: rinfo.address,
      firstSeen: nowMs,
      lastSeen: nowMs,
      expiresAt,
    };
    devices.set(usn, entry);
    log('info', `[SSDP] found ${usn} @ ${location}`);
    options.onDevice?.(entry);
  }

  function handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    const text = msg.toString('utf8');
    if (text.startsWith('HTTP/1.1') || text.startsWith('HTTP/1.0')) {
      const headers = parseHeaders(text.split('\r\n\r\n')[0] ?? '');
      acceptDevice(headers, rinfo);
      return;
    }
    // NOTIFY
    const match = /^NOTIFY [^\r\n]+/i.exec(text);
    if (!match) return;
    const headers = parseHeaders(text.split('\r\n\r\n')[0] ?? '');
    const nts = (headers['nts'] ?? '').toLowerCase();
    const usn = candidateUsn(headers['usn']);
    if (!usn) return;
    if (nts === 'ssdp:alive') {
      acceptDevice(headers, rinfo);
    } else if (nts === 'ssdp:byebye') {
      const removed = devices.delete(usn);
      if (removed) {
        log('info', `[SSDP] byebye ${usn}`);
        // 通知外层（若有订阅）。
        options.onDevice?.({
          usn,
          st: headers['nt'] ?? '',
          location: '',
          server: '',
          maxAgeSec: 0,
          interface: rinfo.address,
          firstSeen: now(),
          lastSeen: now(),
          expiresAt: 0,
        });
      }
    }
  }

  function evictExpired(nowMs: number): void {
    for (const [key, entry] of devices.entries()) {
      if (entry.expiresAt <= nowMs) {
        devices.delete(key);
        log('info', `[SSDP] expire ${key}`);
      }
    }
  }

  async function openSocket(): Promise<dgram.Socket> {
    if (socket) return socket;
    socket = (
      options.socketFactory
        ? options.socketFactory()
        : dgram.createSocket({ type: 'udp4', reuseAddr: true })
    ) as dgram.Socket;
    socket.on('message', handleMessage);
    socket.on('error', (err) => {
      log('error', `[SSDP] socket error: ${err.message}`);
    });
    socket.bind(SSDP_PORT);
    await new Promise<void>((resolve) => {
      socket!.once('listening', () => resolve());
      socket!.once('error', () => resolve());
    });
    try {
      socket.addMembership(SSDP_ADDR);
    } catch (err) {
      log('warn', `[SSDP] join multicast: ${String(err)}`);
    }
    return socket;
  }

  async function sendSearch(st: string): Promise<void> {
    const sock = await openSocket();
    const request =
      `M-SEARCH * HTTP/1.1\r\n` +
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
      `MAN: "ssdp:discover"\r\n` +
      `MX: 2\r\n` +
      `ST: ${st}\r\n` +
      `USER-AGENT: EchoMusic/1.0 UPnP/1.1\r\n` +
      `\r\n`;
    const data = Buffer.from(request, 'utf8');
    // 组播地址发送 + 各 IPv4 接口多播（覆盖多网卡/单播响应习惯）。
    sock.send(data, 0, data.length, SSDP_PORT, SSDP_ADDR);
    for (const iface of listIpv4s()) {
      try {
        sock.send(data, 0, data.length, SSDP_PORT, iface);
      } catch {
        // 部分系统不允许对单播地址 send M-SEARCH；忽略。
      }
    }
  }

  async function searchOnce(): Promise<void> {
    for (const target of SEARCH_TARGETS) {
      try {
        // MX=2；连续发送亦属规范内的“staggered”重试。
        await sendSearch(target);
        await new Promise((resolve) => setTimeout(resolve, 120));
      } catch (err) {
        log('warn', `[SSDP] M-SEARCH ${target} 失败: ${String(err)}`);
      }
    }
  }

  function startStaleTimer(): void {
    if (staleTimer) return;
    staleTimer = setInterval(() => {
      if (!allowScan()) return;
      evictExpired(now());
    }, STALE_CHECK_MS);
  }

  const handle: SsdpHandle = {
    get socket() {
      return socket;
    },
    async start() {
      if (started) return;
      started = true;
      await openSocket();
      startStaleTimer();
    },
    async stop() {
      started = false;
      if (staleTimer) {
        clearInterval(staleTimer);
        staleTimer = null;
      }
      if (socket) {
        await new Promise<void>((resolve) => {
          const s = socket!;
          socket = null;
          try {
            s.removeAllListeners('message');
            s.close(() => resolve());
          } catch {
            resolve();
          }
        });
      }
      devices.clear();
    },
    async search(once = false) {
      if (!allowScan()) return;
      try {
        if (once) {
          await searchOnce();
          return;
        }
        // 周期内重发以对抗丢包；保持监听常驻于活跃会话。
        await searchOnce();
        await new Promise((resolve) => setTimeout(resolve, 1800));
        if (allowScan()) await searchOnce();
        await new Promise((resolve) => setTimeout(resolve, 3600));
        if (allowScan()) await searchOnce();
      } finally {
        // no-op
      }
    },
    list() {
      evictExpired(now());
      return [...devices.values()].sort((a, b) => a.firstSeen - b.firstSeen);
    },
    get(usn) {
      evictExpired(now());
      return devices.get(usn.trim().toLowerCase());
    },
    feedForTest(text, rinfo = {}) {
      const sock = socket;
      if (!sock) return;
      sock.emit('message', Buffer.from(text, 'utf8'), {
        address: rinfo.address ?? '127.0.0.1',
        family: 'IPv4',
        port: rinfo.port ?? 1900,
        size: 0,
      });
    },
    get cachedUsnCount() {
      return devices.size;
    },
  };
  return handle;
}

function listIpv4s(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces() ?? {})) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}
