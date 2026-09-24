/**
 * 原曲投放决策：设备直拉，或由宿主原样中转。
 * 不转码、不转封装；格式不被设备接受时明确拒绝。
 */
export type RelaySource =
  | { kind: 'file'; path: string }
  | { kind: 'http'; url: string; headers?: Record<string, string> };

export interface DeliveryRequest {
  url: string;
  headers?: Record<string, string> | null;
  mime?: string | null;
  /** ConnectionManager GetProtocolInfo 的 Sink。空表示未知，不据此拒绝。 */
  sinkProtocolInfo?: string | null;
}

export type DeliveryPlan =
  | { ok: true; mode: 'direct'; url: string; mime: string | null }
  | { ok: true; mode: 'relay'; source: RelaySource; mime: string | null }
  | { ok: false; reason: string };

const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-auth-token',
  'x-api-key',
  'proxy-authorization',
]);

const SHORT_LIVED_QUERY =
  /(?:^|[?&])(?:expires|expire|expiry|token|signature|sign|sig|auth_key|x-amz-signature|e)=/i;

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.wma': 'audio/x-ms-wma',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.ape': 'audio/x-ape',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
};

export function inferMime(url: string, explicit?: string | null): string | null {
  const given = explicit?.trim().toLowerCase();
  if (given) return given;
  const path = (() => {
    try {
      return url.includes('://') ? new URL(url).pathname : url;
    } catch {
      return url;
    }
  })();
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  return MIME_BY_EXT[path.slice(dot).toLowerCase()] ?? null;
}

function incompatible(mime: string | null): string {
  return `设备不支持当前格式（${mime ?? '未知格式'}），本次不会转码或转封装`;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function hasCredentials(headers?: Record<string, string> | null): boolean {
  if (!headers) return false;
  return Object.entries(headers).some(
    ([key, value]) => CREDENTIAL_HEADERS.has(key.toLowerCase()) && value.trim() !== '',
  );
}

/** 未知 MIME 不判失败；只有设备明确列出且不包含该类型时才拒绝。 */
export function sinkAccepts(sink: string | null | undefined, mime: string | null): boolean {
  if (!sink?.trim() || !mime) return true;
  const haystack = sink.toLowerCase();
  if (
    haystack.includes('*:*') ||
    haystack.includes('*/*') ||
    haystack.includes('audio/*') ||
    haystack.includes('http-get:*:*')
  ) {
    return true;
  }
  return haystack.includes(mime.toLowerCase());
}

function fileUrlToPath(url: string): string | null {
  if (!url.toLowerCase().startsWith('file:')) return null;
  try {
    const parsed = new URL(url);
    let pathname = decodeURIComponent(parsed.pathname);
    if (/^\/[a-zA-Z]:\//.test(pathname)) pathname = pathname.slice(1);
    return pathname || null;
  } catch {
    return null;
  }
}

export function decideMediaDelivery(input: DeliveryRequest): DeliveryPlan {
  const url = input.url?.trim() ?? '';
  if (!url) return { ok: false, reason: '没有可投放的音源地址' };
  const mime = inferMime(url, input.mime);
  if (!sinkAccepts(input.sinkProtocolInfo, mime)) {
    return { ok: false, reason: incompatible(mime) };
  }

  const filePath = fileUrlToPath(url);
  if (filePath) return { ok: true, mode: 'relay', source: { kind: 'file', path: filePath }, mime };
  if (url.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(url)) {
    return { ok: true, mode: 'relay', source: { kind: 'file', path: url }, mime };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: '无法把该音源原样交给设备，本次不会转码' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: '无法把该音源原样交给设备，本次不会转码' };
  }

  const relay =
    Boolean(parsed.username || parsed.password) ||
    isLoopback(parsed.hostname) ||
    hasCredentials(input.headers) ||
    SHORT_LIVED_QUERY.test(parsed.search);
  if (!relay) return { ok: true, mode: 'direct', url, mime };
  const headers = input.headers
    ? Object.fromEntries(Object.entries(input.headers).filter(([, value]) => value.trim() !== ''))
    : undefined;
  return {
    ok: true,
    mode: 'relay',
    source: {
      kind: 'http',
      url,
      headers: headers && Object.keys(headers).length ? headers : undefined,
    },
    mime,
  };
}
