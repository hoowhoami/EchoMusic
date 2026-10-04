/**
 * EchoMusic DLNA GENA 事件接收（design §5）。
 *
 * - 直接消费 AVTransport / RenderingControl 的 LastChange NOTIFY（UPnP-arch 事件订阅）。
 * - 只解析发送给宿主的受确订阅 SID，忽略无关事件与非法 XML。
 * - 暴露可订阅的本地 HOST:<port>/gena 入口，绑定选定网卡。
 * - 解析 LastChange 中的 TransportState / CurrentTrackDuration / AVTransportURI /
 *   Volume / Mute 等关键字段，落到单调时钟与 gate 模型（宿主消费）；解析失败不伪装成功。
 * - 对外部控制器“接管”远端 URI 的探测依赖 AVTransportURI 字段。
 *
 * 无 XML 依赖：用少而严谨的属性扫描，仅读取已知标签；结构未知假装没读到，不抛错。
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';

const MAX_EVENT_BYTES = 1024 * 1024;
interface SubscriptionGrant {
  sid: string;
}

export interface GenaLastChange {
  instanceId: string;
  /** 已识别的属性（键：LastChange XML 属性名） */
  fields: Record<string, string | undefined>;
  raw: string;
  receivedAt: number;
}

export interface GenaReceiverOptions {
  bindHost: string;
  /** 令牌参与回调路径，降低被无关请求撞中的概率。 */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  now?: () => number;
  /** 事件回调：sid + LastChange 字段。 */
  onLastChange?: (sid: string, change: GenaLastChange) => void;
  /** 订阅超时/过期通知（设备侧），宿主据此转为轮询或降级。 */
  onSubscriptionTimeout?: (sid: string) => void;
}

export class GenaReceiver {
  private readonly options: Required<Pick<GenaReceiverOptions, 'bindHost' | 'now'>> &
    Pick<GenaReceiverOptions, 'log' | 'onLastChange' | 'onSubscriptionTimeout'>;
  private server: http.Server | null = null;
  private boundPort = 0;
  private startFlight: Promise<number> | null = null;
  private stopFlight: Promise<void> | null = null;
  /** SID 的授权对象用于区分同名但已被替换的订阅。 */
  private activeSubscriptions = new Map<string, SubscriptionGrant>();

  constructor(options: GenaReceiverOptions) {
    this.options = { ...options, now: options.now ?? Date.now };
    this.options.log = options.log ?? (() => {});
  }

  get port(): number {
    return this.boundPort;
  }

  private armedTokens = new Map<string, SubscriptionGrant>();

  /** 在 SID 返回前允许带该 token 的首个 NOTIFY，避免订阅响应和初始事件竞争。 */
  armToken(token: string): void {
    if (token) this.armedTokens.set(token, { sid: '' });
  }

  /** 临时授权只用于 SUBSCRIBE 响应前的首个 SID，响应结束后必须撤销。 */
  disarmToken(token: string): void {
    this.armedTokens.delete(token);
  }

  /** 生成回调 URL。传入稳定 token 时，宿主可在订阅完成前 arm 它。 */
  callbackUrl(instance: string, token = this.randToken()): string {
    return `http://${this.options.bindHost}:${this.boundPort}/gena/${instance}/${encodeURIComponent(token)}`;
  }

  private randToken(): string {
    return randomBytes(8).toString('hex');
  }

  /** 登记宿主已成功订阅的 sid（供校验）。 */
  trackSubscription(sid: string): void {
    if (!sid || this.activeSubscriptions.has(sid)) return;
    const provisional = [...this.armedTokens.values()].find((grant) => grant.sid === sid);
    this.activeSubscriptions.set(sid, provisional ?? { sid });
    if (provisional) {
      for (const [token, grant] of this.armedTokens) {
        if (grant === provisional) this.armedTokens.delete(token);
      }
    }
  }

  untrackSubscription(sid: string): void {
    this.activeSubscriptions.delete(sid);
    for (const [token, grant] of this.armedTokens) {
      if (grant.sid === sid) this.armedTokens.delete(token);
    }
  }

  start(port = 0): Promise<number> {
    if (this.stopFlight) return this.stopFlight.then(() => this.start(port));
    if (this.startFlight) return this.startFlight;
    const flight = this.startNow(port).finally(() => {
      if (this.startFlight === flight) this.startFlight = null;
    });
    this.startFlight = flight;
    return flight;
  }

  private async startNow(port: number): Promise<number> {
    if (this.server) return this.boundPort;
    const server = http.createServer((req, res) => {
      if ((req.method ?? '') !== 'POST' && (req.method ?? '') !== 'NOTIFY') {
        res.statusCode = 405;
        res.end();
        return;
      }
      const sid = (req.headers['sid'] as string | undefined)?.trim() ?? '';
      const token = tokenFromPath(req.url);
      const grant = this.authorize(sid, token);
      if (!grant) {
        // 忽略未知订阅，同时避免对无关请求暴露信息。
        res.statusCode = 412;
        res.end();
        return;
      }
      this.consume(req, res, sid, token, grant, server);
    });
    this.server = server;
    server.on('clientError', (_err, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch {
        // 尽力
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        try {
          server.listen(port, this.options.bindHost);
        } catch (error) {
          server.off('error', onError);
          server.off('listening', onListening);
          reject(error);
        }
      });
      const address = server.address();
      this.boundPort = typeof address === 'object' && address ? address.port : 0;
      return this.boundPort;
    } catch (error) {
      if (this.server === server) this.server = null;
      this.boundPort = 0;
      server.close();
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopFlight) return this.stopFlight;
    this.activeSubscriptions.clear();
    this.armedTokens.clear();
    const flight = this.stopNow().finally(() => {
      if (this.stopFlight === flight) this.stopFlight = null;
    });
    this.stopFlight = flight;
    return flight;
  }

  private async stopNow(): Promise<void> {
    await this.startFlight?.catch(() => undefined);
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private authorize(sid: string, token: string): SubscriptionGrant | null {
    if (!sid) return null;
    const known = this.activeSubscriptions.get(sid);
    if (known) return known;
    const provisional = this.armedTokens.get(token);
    if (!provisional || (provisional.sid && provisional.sid !== sid)) return null;
    provisional.sid = sid;
    return provisional;
  }

  private isCurrentGrant(sid: string, token: string, grant: SubscriptionGrant): boolean {
    return this.activeSubscriptions.get(sid) === grant || this.armedTokens.get(token) === grant;
  }

  private consume(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sid: string,
    token: string,
    grant: SubscriptionGrant,
    server: http.Server,
  ): void {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    const tooLarge = () => {
      rejected = true;
      chunks.length = 0;
      res.statusCode = 413;
      res.setHeader('Connection', 'close');
      res.end();
      req.resume();
    };
    if (Number(req.headers['content-length']) > MAX_EVENT_BYTES) {
      tooLarge();
      return;
    }
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_EVENT_BYTES) tooLarge();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected || res.destroyed) return;
      // 授权在上传期间可能被退订或替换，SID 文本相同也不是同一会话。
      if (server !== this.server || !this.isCurrentGrant(sid, token, grant)) {
        chunks.length = 0;
        res.statusCode = 412;
        res.end();
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      chunks.length = 0;
      res.statusCode = 200;
      res.end();
      // 仅接受本 min/core 可识别的 XML。
      const fields = parseLastChange(body);
      if (!fields) return;
      const change: GenaLastChange = {
        instanceId: fields.instanceId,
        fields: fields.values,
        raw: body,
        receivedAt: this.options.now(),
      };
      this.options.onLastChange?.(sid, change);
      // 会话结束（TransportState=STOPPED 常伴随事件流空闲），暂不在此处直接判定。
    });
    req.on('error', () => {
      try {
        res.end();
      } catch {
        // 忽略
      }
    });
  }
}

function tokenFromPath(url: string | undefined): string {
  const match = /\/gena\/[^/]+\/([^/?#]+)/.exec(url ?? '');
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** 解析 LastChange XML 中的已知属性；返回 null 视为不可识别（不伪装）。 */
export function parseLastChange(
  raw: string,
): { instanceId: string; values: Record<string, string | undefined> } | null {
  const match = /<LastChange(?=\s|>)[^>]*>([\s\S]*?)<\/LastChange>/.exec(raw);
  const payload = match ? match[1] : raw;
  const body = match && /^\s*&lt;/.test(payload) ? decodeAmp(payload) : payload;
  if (!body) return null;

  // 单实例最简单：<InstanceID val="0"> ... </InstanceID>，多层属性嵌套。
  const instanceMatch = /<InstanceID\s+val="(\d+)"[\s\S]*?>([\s\S]*?)<\/InstanceID>/.exec(body);
  const instanceId = instanceMatch ? instanceMatch[1] : '0';
  const inner = instanceMatch ? instanceMatch[2] : body;

  const knownKeys = [
    'TransportState',
    'TransportStatus',
    'PlaybackStorageMedium',
    'RecordStorageMedium',
    'CurrentPlayMode',
    'TransportPlaySpeed',
    'AVTransportURI',
    'AVTransportURIMetaData',
    'NextAVTransportURI',
    'CurrentTrackURI',
    'CurrentTrackDuration',
    'CurrentTrackMetaData',
    'TrackNumber',
    'RelativeTimePosition',
    'AbsoluteTimePosition',
    'RelativeCounterPosition',
    'AbsoluteCounterPosition',
    'Volume',
    'Mute',
  ];
  const values: Record<string, string | undefined> = {};
  let found = false;
  for (const key of knownKeys) {
    const tagMatch = new RegExp(`<${key}(?=\\s|/?>)[^>]*\\sval="([^"]*)"`).exec(inner);
    if (tagMatch) {
      values[key] = decodeAmp(tagMatch[1]);
      found = true;
    } else if (new RegExp(`<${key}(?=\\s|/?>)[^>]*>`).test(inner)) {
      values[key] = undefined;
      found = true;
    }
  }
  if (!found) return null;
  return { instanceId, values };
}

function decodeAmp(value: string): string {
  const entities: Record<string, string> = { amp: '&', quot: '"', lt: '<', gt: '>', apos: "'" };
  return value.replace(/&(amp|quot|lt|gt|apos);/g, (_, entity: string) => entities[entity]);
}
