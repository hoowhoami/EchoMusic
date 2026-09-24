/**
 * 宿主侧 UPnP/GENA 辅助。不放宽插件 WebServer，也不把设备描述里的地址当成任意代理。
 */
import http from 'node:http';
import https from 'node:https';

export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function argsToXml(args: Record<string, string>): string {
  return Object.entries(args)
    .map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`)
    .join('');
}

export function parseActionResult(raw: unknown): Record<string, string> {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') out[key] = item;
    else if (typeof item === 'number' || typeof item === 'boolean') out[key] = String(item);
  }
  return out;
}

export function parseUpnpTime(value: string | undefined): number | null {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec((value ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes >= 60 || seconds >= 60) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function endpointAllowed(url: string, allowedHost: string): boolean {
  const host = hostOf(url);
  return Boolean(host) && host === allowedHost.replace(/^\[|\]$/g, '').toLowerCase();
}

function request(
  method: string,
  url: string,
  headers: Record<string, string>,
  allowedHost: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  if (!endpointAllowed(url, allowedHost)) {
    return Promise.reject(new Error('拒绝访问设备描述以外的地址'));
  }
  const parsed = new URL(url);
  const lib = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
        timeout: 8000,
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.end();
  });
}

export async function subscribeEvent(
  eventUrl: string,
  callbackUrl: string,
  allowedHost: string,
): Promise<{ sid: string; timeoutSec: number }> {
  const response = await request(
    'SUBSCRIBE',
    eventUrl,
    { CALLBACK: `<${callbackUrl}>`, NT: 'upnp:event', TIMEOUT: 'Second-300' },
    allowedHost,
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GENA 订阅失败（${response.status}）`);
  }
  const sid = String(response.headers.sid ?? '').trim();
  if (!sid) throw new Error('GENA 订阅没有返回 SID');
  return { sid, timeoutSec: 300 };
}

export async function renewEvent(
  eventUrl: string,
  sid: string,
  allowedHost: string,
): Promise<void> {
  const response = await request(
    'SUBSCRIBE',
    eventUrl,
    { SID: sid, TIMEOUT: 'Second-300' },
    allowedHost,
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`GENA 续订失败（${response.status}）`);
  }
}

export async function unsubscribeEvent(
  eventUrl: string,
  sid: string,
  allowedHost: string,
): Promise<void> {
  const response = await request('UNSUBSCRIBE', eventUrl, { SID: sid }, allowedHost);
  if (response.status >= 400 && response.status !== 412) {
    throw new Error(`GENA 退订失败（${response.status}）`);
  }
}

export function findService<T extends { serviceId: string; serviceType: string }>(
  services: T[],
  token: string,
): T | undefined {
  const needle = token.toLowerCase();
  return services.find(
    (service) =>
      service.serviceType.toLowerCase().includes(needle) ||
      service.serviceId.toLowerCase().includes(needle),
  );
}

export function isTransportOffline(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|timeout|econn|ehostunreach|enetunreach|econnreset|socket hang up|network/i.test(
    message,
  );
}
