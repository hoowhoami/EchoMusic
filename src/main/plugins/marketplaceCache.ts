const CACHE_TTL_MS = 5 * 60_000;
const RETRY_INTERVAL_MS = 60_000;

export const shouldRefreshMarketplace = (
  fetchedAt: number,
  sources: { lastError?: string; lastFetchedAt?: number }[],
  force = false,
  now = Date.now(),
) => {
  if (sources.length === 0) return false;
  if (force || !fetchedAt || fetchedAt > now) return true;
  const ttl = sources.some((source) => source.lastError || !source.lastFetchedAt)
    ? RETRY_INTERVAL_MS
    : CACHE_TTL_MS;
  return now - fetchedAt >= ttl;
};
