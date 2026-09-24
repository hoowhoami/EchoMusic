import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { useSettingStore } from './setting';

export interface OutputTargetView {
  targetId: string;
  protocol: 'local' | 'dlna' | 'airplay';
  displayName: string;
  location?: string;
  addresses?: string[];
  manufacturer?: string;
  manufacturerUrl?: string;
  modelName?: string;
  modelDescription?: string;
  modelNumber?: string;
  modelUrl?: string;
  serialNumber?: string;
  udn?: string;
  upc?: string;
  presentationUrl?: string;
  note?: string;
  paired?: boolean;
  connection?: { connected?: boolean; available?: boolean; error?: string };
}

export interface OutputSessionView {
  protocol: 'local' | 'dlna' | 'airplay';
  targetId?: string | null;
  displayName: string;
  state: string;
  actualFormat: string | null;
  capabilities?: { dsp?: boolean; relayed?: boolean };
}

interface OutputView {
  snapshot?: OutputSessionView | null;
  targets?: OutputTargetView[];
  diagnostics?: string;
}

export const useOutputStore = defineStore('output', () => {
  const settingStore = useSettingStore();
  const targets = ref<OutputTargetView[]>([]);
  const snapshot = ref<OutputSessionView | null>(null);
  const diagnostics = ref('网络播放未开启');
  const error = ref('');
  const busy = ref(false);
  const refreshing = ref(false);
  const connectingTargetId = ref<string | null>(null);
  const switchingLocal = ref(false);
  const browsing = ref(false);
  const searching = computed(
    () => refreshing.value || diagnostics.value.startsWith('正在搜索投放设备'),
  );
  const visibleTargets = targets;
  let started = false;
  let browsingRequests = 0;
  let refreshFlight: Promise<void> | null = null;

  function apply(view: OutputView | null | undefined): void {
    if (!view) return;
    if (view.snapshot !== undefined) snapshot.value = view.snapshot;
    if (view.targets) targets.value = view.targets;
    if (typeof view.diagnostics === 'string') diagnostics.value = view.diagnostics;
  }

  function outputApi() {
    return window.electron?.output;
  }

  async function bind(): Promise<void> {
    if (started) return;
    const api = outputApi();
    if (!api) return;
    started = true;
    api.onEvent((event) => {
      if (event?.type === 'session-ended') {
        error.value = '设备已断开，已暂停并保留队列。不会自动改回本机播放';
      }
      if (event?.payload && typeof event.payload === 'object') apply(event.payload as OutputView);
    });
    watch(
      () => settingStore.networkPlaybackEnabled,
      (enabled) => {
        void api
          .setEnabled(Boolean(enabled))
          .then(apply)
          .catch((caught: unknown) => {
            diagnostics.value = caught instanceof Error ? caught.message : '网络播放开关未能同步';
          });
      },
      { immediate: true },
    );
  }

  async function refresh(): Promise<void> {
    if (refreshFlight) return refreshFlight;
    const api = outputApi();
    if (!api) return;
    refreshing.value = true;
    error.value = '';
    refreshFlight = (async () => {
      try {
        targets.value = await api.refresh();
        apply(await api.getSession());
      } catch (caught) {
        error.value = caught instanceof Error ? caught.message : '刷新设备失败';
      } finally {
        refreshing.value = false;
        refreshFlight = null;
      }
    })();
    return refreshFlight;
  }

  async function setBrowsing(open: boolean): Promise<void> {
    browsingRequests = Math.max(0, browsingRequests + (open ? 1 : -1));
    const nextBrowsing = browsingRequests > 0;
    const changed = browsing.value !== nextBrowsing;
    browsing.value = nextBrowsing;
    const api = outputApi();
    if (!api) return;
    if (!changed) {
      if (open && nextBrowsing) await refresh();
      return;
    }
    try {
      await api.setBrowsing(nextBrowsing);
      if (nextBrowsing) await refresh();
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : '无法开始搜索';
    }
  }

  async function connect(targetId: string, pin?: string): Promise<{ ok: boolean; error?: string }> {
    const api = outputApi();
    if (!api) return { ok: false, error: '输出接口不可用' };
    if (!targetId.startsWith('local:')) {
      const { useListenTogetherStore } = await import('./listenTogether');
      if (useListenTogetherStore().joined) {
        error.value = '一起听进行中，已禁用网络投放';
        return { ok: false, error: error.value };
      }
    }
    busy.value = true;
    connectingTargetId.value = targetId;
    error.value = '';
    try {
      const result = await api.connect(targetId, pin);
      if (!result.ok) error.value = result.error || '连接失败';
      apply(await api.getSession());
      return result;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : '连接失败';
      return { ok: false, error: error.value };
    } finally {
      busy.value = false;
      if (connectingTargetId.value === targetId) connectingTargetId.value = null;
    }
  }

  async function useLocal(): Promise<void> {
    const api = outputApi();
    if (!api) return;
    busy.value = true;
    switchingLocal.value = true;
    error.value = '';
    try {
      apply(await api.disconnect());
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : '切回本机失败';
    } finally {
      busy.value = false;
      switchingLocal.value = false;
    }
  }

  async function clearRecords(): Promise<void> {
    const api = outputApi();
    if (!api) return;
    apply(await api.clearRecords());
  }

  return {
    targets,
    visibleTargets,
    snapshot,
    diagnostics,
    error,
    busy,
    refreshing,
    connectingTargetId,
    switchingLocal,
    searching,
    browsing,
    bind,
    refresh,
    setBrowsing,
    connect,
    useLocal,
    clearRecords,
  };
});
