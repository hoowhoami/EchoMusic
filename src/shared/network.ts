export interface NetworkSettings {
  kugouApiProxyUrl: string;
  kugouApiTimeoutSecs: number;
  mpvHttpProxyUrl: string;
  mpvNetworkTimeoutSecs: number;
}

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  kugouApiProxyUrl: '',
  kugouApiTimeoutSecs: 0,
  mpvHttpProxyUrl: '',
  mpvNetworkTimeoutSecs: 60,
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

export const normalizeProxyUrl = (value: unknown): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
};

export const normalizeNetworkSettings = (
  value: Partial<NetworkSettings> | Record<string, unknown> | null | undefined,
): NetworkSettings => ({
  kugouApiProxyUrl: normalizeProxyUrl(value?.kugouApiProxyUrl),
  kugouApiTimeoutSecs: clampNumber(
    value?.kugouApiTimeoutSecs,
    DEFAULT_NETWORK_SETTINGS.kugouApiTimeoutSecs,
    0,
    300,
  ),
  mpvHttpProxyUrl: normalizeProxyUrl(value?.mpvHttpProxyUrl),
  mpvNetworkTimeoutSecs: clampNumber(
    value?.mpvNetworkTimeoutSecs,
    DEFAULT_NETWORK_SETTINGS.mpvNetworkTimeoutSecs,
    1,
    300,
  ),
});
