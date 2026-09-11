import type { EchoPluginDescriptor } from '../../shared/plugins';

/** Disk discovery is explicit and asynchronous; lookups never perform I/O or refresh on a miss. */
export const createPluginMetadataRegistry = (
  scan: () => Promise<EchoPluginDescriptor[]>,
  onRevoke: (pluginIds: string[]) => void,
) => {
  let records = new Map<string, EchoPluginDescriptor>();
  let enabled: Record<string, boolean> = {};
  let safeMode = true; // Deny access until startup has loaded persisted state.
  let revision = 0;
  let refreshing: Promise<void> | undefined;
  const mutations = new Set<string>();
  const withEnabled = (plugin: EchoPluginDescriptor) => ({
    ...plugin,
    enabled: !plugin.invalid && plugin.compatibility.compatible && Boolean(enabled[plugin.id]),
  });

  return {
    get: (id: string) => records.get(id) ?? null,
    list: () => [...records.values()],
    getEnabled: () => ({ ...enabled }),
    getSafeMode: () => safeMode,
    isCurrent: (plugin: EchoPluginDescriptor) =>
      !safeMode && records.get(plugin.id) === plugin && plugin.enabled,

    setEnabled(state: Record<string, boolean>) {
      enabled = { ...state };
      const revoked: string[] = [];
      for (const [id, previous] of records) {
        const next = withEnabled(previous);
        if (next.enabled === previous.enabled) continue;
        records.set(id, next);
        if (!next.enabled) revoked.push(id);
      }
      if (revoked.length) onRevoke(revoked);
    },

    setSafeMode(value: boolean) {
      const changed = safeMode !== value;
      safeMode = value;
      if (changed && value) {
        records = new Map([...records].map(([id, plugin]) => [id, { ...plugin }]));
        onRevoke([...records.keys()]);
      }
    },

    /** Invalidate before touching files. A failed mutation stays absent until a fresh scan. */
    beginMutation(id: string) {
      if (mutations.has(id)) throw new Error('插件正在更新，请稍后重试');
      mutations.add(id);
      revision++;
      records.delete(id);
      onRevoke([id]);
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        mutations.delete(id);
        revision++;
      };
    },

    refresh(): Promise<void> {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        for (;;) {
          const startedAtRevision = revision;
          let plugins: EchoPluginDescriptor[];
          try {
            plugins = await scan();
          } catch (error) {
            if (startedAtRevision !== revision) continue;
            const ids = [...records.keys()];
            records.clear();
            onRevoke(ids);
            throw error;
          }
          // A scan started before an install/uninstall/rollback must never republish old metadata.
          if (startedAtRevision !== revision) continue;
          const next = new Map<string, EchoPluginDescriptor>();
          const duplicateIds = new Set<string>();
          for (const plugin of plugins) {
            if (mutations.has(plugin.id) || duplicateIds.has(plugin.id)) continue;
            if (next.has(plugin.id)) {
              duplicateIds.add(plugin.id);
              next.delete(plugin.id); // Ambiguous IDs must not acquire another directory's access.
              continue;
            }
            const candidate = withEnabled(plugin);
            const previous = records.get(plugin.id);
            next.set(
              plugin.id,
              previous && JSON.stringify(previous) === JSON.stringify(candidate)
                ? previous
                : candidate,
            );
          }
          const revoked = [...records]
            .filter(([id, value]) => next.get(id) !== value)
            .map(([id]) => id);
          records = next;
          if (revoked.length) onRevoke(revoked);
          return;
        }
      })().finally(() => {
        refreshing = undefined;
      });
      return refreshing;
    },
  };
};
