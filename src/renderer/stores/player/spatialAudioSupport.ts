import { computed, ref, watch } from 'vue';
import type { SpatialAudioEffectEntry, DspProviderInspection } from '../../../shared/audio';
import type { PlayerAudioGraphSnapshot } from '../../../shared/player-audio-graph';
import {
  audioEffectSupport,
  parseAudioEffectManifest,
  type AudioEffectEngineSupport,
} from '../../../shared/audio-effect-support';

// Store-scoped rather than popover-scoped: capability reconciliation also runs
// while the panel is closed, during startup and after engine changes.
export function createSpatialAudioSupport(options: {
  providerPath: () => string | undefined;
  providerMode: () => 'headphone' | 'speaker';
  graph: () => PlayerAudioGraphSnapshot | null;
  selected: () => SpatialAudioEffectEntry | null;
  enabled: () => boolean;
  inspect: (path: string) => Promise<DspProviderInspection | null>;
  unsupported: (file: SpatialAudioEffectEntry, reason: string) => void;
}) {
  const started = ref(false);
  const inspection = ref<{
    path: string;
    mode: string;
    status: 'ready' | 'failed';
    info: DspProviderInspection | null;
  } | null>(null);
  let revision = 0;
  const refresh = async () => {
    const request = ++revision;
    inspection.value = null;
    const path = options.providerPath();
    const mode = options.providerMode();
    if (!started.value || !path) return;
    let info: DspProviderInspection | null = null;
    try {
      info = await options.inspect(path);
    } catch {
      // Completed inspection failure is not an indefinitely pending capability.
    }
    if (request === revision && path === options.providerPath() && mode === options.providerMode())
      inspection.value = { path, mode, status: info ? 'ready' : 'failed', info };
  };
  const providerInspection = computed(() => {
    const result = inspection.value;
    if (!result) return null;
    return result.path === options.providerPath() && result.mode === options.providerMode()
      ? result
      : null;
  });
  const engineSupport = computed<AudioEffectEngineSupport>(() => {
    if (!started.value) return { kind: 'checking' };
    const path = options.providerPath();
    if (!path) return { kind: 'builtin' };
    const graph = options.graph();
    if (
      graph?.providerPath === path &&
      graph.providerMode === options.providerMode() &&
      graph.providerId
    )
      return { kind: 'provider', manifest: parseAudioEffectManifest(graph.providerManifestJson) };
    const result = providerInspection.value;
    if (result)
      return {
        kind: 'provider',
        manifest: parseAudioEffectManifest(result.info?.manifestJson),
      };
    return { kind: 'checking' };
  });
  const support = (file: SpatialAudioEffectEntry) => audioEffectSupport(file, engineSupport.value);
  watch([options.providerPath, options.providerMode], () => void refresh(), { flush: 'sync' });
  watch(
    () => {
      const file = options.enabled() ? options.selected() : null;
      return file ? { file, support: support(file) } : null;
    },
    (selection) => {
      if (selection?.support.status === 'unsupported')
        options.unsupported(selection.file, selection.support.reason);
    },
    { flush: 'sync' },
  );
  return {
    support,
    engineSupport,
    providerInspection,
    async start() {
      started.value = true;
      await refresh();
    },
  };
}
