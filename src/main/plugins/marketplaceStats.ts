import type { PluginMarketplaceStats } from '../../shared/plugins';

export type MarketplaceStatsIdentity = { sourceId: string; pluginId: string };
type Entry = { stats: PluginMarketplaceStats; fetchedAt: number };
export type MarketplaceStatsSnapshot = {
  endpoint: string;
  entries: [string, Entry][];
  failures: number;
  retryAt: number;
};

const TTL = 10 * 60_000;
const MAX_BACKOFF = 30 * 60_000;
const MAX_ENTRIES = 2_000;
export const marketplaceStatsKey = ({ sourceId, pluginId }: MarketplaceStatsIdentity) =>
  `${sourceId}:${pluginId}`;

/** One instance in the main process, shared by all windows and list callers. */
export const createMarketplaceStatsCache = (options: {
  fetch: (
    endpoint: string,
    plugins: MarketplaceStatsIdentity[],
  ) => Promise<Map<string, PluginMarketplaceStats>>;
  read: () => MarketplaceStatsSnapshot | null | undefined;
  write: (snapshot: MarketplaceStatsSnapshot) => void;
  onError: (error: unknown) => void;
  now?: () => number;
}) => {
  const now = options.now ?? Date.now;
  let state: MarketplaceStatsSnapshot | undefined;
  let entries = new Map<string, Entry>();
  let pending: { promise: Promise<void>; endpoint: string; keys: Set<string> } | undefined;

  const select = (endpoint: string) => {
    if (state?.endpoint === endpoint) return;
    const saved = options.read();
    state =
      saved?.endpoint === endpoint && Array.isArray(saved.entries)
        ? { ...saved }
        : { endpoint, entries: [], failures: 0, retryAt: 0 };
    entries = new Map(
      state.entries
        .slice(-MAX_ENTRIES)
        .filter(
          (row) =>
            Array.isArray(row) &&
            typeof row[0] === 'string' &&
            row[1]?.stats &&
            Number.isFinite(row[1].fetchedAt),
        ),
    );
    state.failures = Math.min(6, Math.max(0, Number(state.failures) || 0));
    state.retryAt = Math.min(now() + MAX_BACKOFF, Math.max(0, Number(state.retryAt) || 0));
  };
  const save = () => {
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    state!.entries = [...entries];
    try {
      options.write(state!);
    } catch (error) {
      options.onError(error);
    }
  };
  const put = (key: string, stats: PluginMarketplaceStats) => {
    entries.delete(key);
    entries.set(key, { stats, fetchedAt: now() });
  };

  return {
    async get(
      endpoint: string,
      plugins: MarketplaceStatsIdentity[],
      cachedOnly = false,
      forceRefresh = false,
    ) {
      // Endpoints are fixed in production. Serialize a switch too, so an old response
      // cannot populate a newly selected service's cache.
      const sharedKeys = new Set<string>();
      while (pending && (!cachedOnly || state?.endpoint !== endpoint)) {
        const active = pending;
        await active.promise;
        if (active.endpoint === endpoint) {
          for (const key of active.keys) sharedKeys.add(key);
        }
      }
      select(endpoint);
      const unique = [...new Map(plugins.map((p) => [marketplaceStatsKey(p), p])).values()];
      if (!cachedOnly) {
        const stale = unique.filter((p) => {
          const key = marketplaceStatsKey(p);
          // Concurrent manual refreshes share the same attempt, including failures.
          if (forceRefresh) return !sharedKeys.has(key);
          const entry = entries.get(key);
          return !entry || now() < entry.fetchedAt || now() - entry.fetchedAt >= TTL;
        });
        if (stale.length && (forceRefresh || now() >= state!.retryAt)) {
          const refresh = async () => {
            try {
              for (let i = 0; i < stale.length; i += 200) {
                const batch = stale.slice(i, i + 200);
                const before = new Map(
                  batch.map((p) => [marketplaceStatsKey(p), entries.get(marketplaceStatsKey(p))]),
                );
                const result = await options.fetch(endpoint, batch);
                if (batch.some((p) => !result.has(marketplaceStatsKey(p)))) {
                  throw new Error('插件统计响应不完整');
                }
                for (const p of batch) {
                  const key = marketplaceStatsKey(p);
                  // An install event may have updated this entry while the read was in flight.
                  if (entries.get(key) === before.get(key)) put(key, result.get(key)!);
                }
              }
              state!.failures = 0;
              state!.retryAt = 0;
            } catch (error) {
              state!.failures = Math.min(6, state!.failures + 1);
              state!.retryAt = now() + Math.min(MAX_BACKOFF, 60_000 * 2 ** (state!.failures - 1));
              options.onError(error);
            } finally {
              save();
            }
          };
          pending = {
            promise: refresh(),
            endpoint,
            keys: new Set(stale.map(marketplaceStatsKey)),
          };
          try {
            await pending.promise;
          } finally {
            pending = undefined;
          }
        }
      }
      return new Map(
        unique.flatMap((p) => {
          const key = marketplaceStatsKey(p);
          const entry = entries.get(key);
          return entry ? [[key, entry.stats] as const] : [];
        }),
      );
    },
    update(endpoint: string, plugin: MarketplaceStatsIdentity, stats: PluginMarketplaceStats) {
      if (pending && state?.endpoint !== endpoint) return;
      select(endpoint);
      put(marketplaceStatsKey(plugin), stats);
      save();
    },
  };
};
