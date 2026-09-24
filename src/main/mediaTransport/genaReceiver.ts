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
  /** sid → { subscriptionId, validTill } 仅作校验用；宿主回调同时收到 sid。 */
  private activeSubscriptions = new Set<string>();

  constructor(options: GenaReceiverOptions) {
    this.options = { ...options, now: options.now ?? Date.now };
    this.options.log = options.log ?? (() => {});
  }

  get port(): number {
    return this.boundPort;
  }

  private armedTokens = new Set<string>();

  /** 在 SID 返回前允许带该 token 的首个 NOTIFY，避免订阅响应和初始事件竞争。 */
  armToken(token: string): void {
    if (token) this.armedTokens.add(token);
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
    this.activeSubscriptions.add(sid);
  }

  untrackSubscription(sid: string): void {
    this.activeSubscriptions.delete(sid);
  }

  async start(port = 0): Promise<number> {
    if (this.server) return this.boundPort;
    this.server = http.createServer((req, res) => {
      if ((req.method ?? '') !== 'POST' && (req.method ?? '') !== 'NOTIFY') {
        res.statusCode = 405;
        res.end();
        return;
      }
      const sid = (req.headers['sid'] as string | undefined)?.trim() ?? '';
      const token = tokenFromPath(req.url);
      const known = Boolean(sid) && this.activeSubscriptions.has(sid);
      const armed = Boolean(token) && this.armedTokens.has(token);
      if (!known && !armed) {
        // 忽略未知订阅，同时避免对无关请求暴露信息。
        res.statusCode = 412;
        res.end();
        return;
      }
      if (sid) this.trackSubscription(sid);
      this.consume(req, res, sid || token);
    });
    this.server.on('clientError', (_err, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch {
        // 尽力
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, this.options.bindHost, () => resolve());
    });
    const address = this.server.address();
    this.boundPort = typeof address === 'object' && address ? address.port : 0;
    return this.boundPort;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.activeSubscriptions.clear();
    this.armedTokens.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private consume(req: http.IncomingMessage, res: http.ServerResponse, sid: string): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
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
  const match = /<LastChange[^>]*>([\s\S]*?)<\/LastChange>/.exec(raw);
  const body = match ? match[1] : raw;
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
    const tagMatch = new RegExp(`<${key}[^>]*\\sval="([^"]*)"`).exec(inner);
    if (tagMatch) {
      values[key] = decodeAmp(tagMatch[1]);
      found = true;
    } else if (new RegExp(`<${key}[^>]*>`).test(inner)) {
      values[key] = undefined;
      found = true;
    }
  }
  if (!found) return null;
  return { instanceId, values };
}

function decodeAmp(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}
