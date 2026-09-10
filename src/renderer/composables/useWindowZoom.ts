import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  MAX_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  normalizeZoomLevel,
  zoomLevelToFactor,
} from '../../shared/window-zoom';

export function useWindowZoom() {
  const level = ref(0);
  let disposed = false;
  let receivedUpdate = false;
  const apply = (value: unknown) => {
    if (!disposed && typeof value === 'number') level.value = normalizeZoomLevel(value);
  };
  const changed = (value: unknown) => {
    receivedUpdate = true;
    apply(value);
  };
  onMounted(() => {
    window.electron.ipcRenderer.on('window:zoom-changed', changed);
    void window.electron.ipcRenderer
      .invoke('window:zoom-get')
      .then((value: unknown) => {
        if (!receivedUpdate) apply(value);
      })
      .catch(() => {});
  });
  onUnmounted(() => {
    disposed = true;
    window.electron.ipcRenderer.off('window:zoom-changed', changed);
  });
  const set = async (value: number) => {
    // The published event is authoritative, including rapid concurrent actions.
    await window.electron.ipcRenderer.invoke('window:zoom-set', value);
  };
  return {
    level,
    percent: computed(() => Math.round(zoomLevelToFactor(level.value) * 100)),
    zoomIn: () => set(level.value + 1),
    zoomOut: () => set(level.value - 1),
    reset: () => set(0),
    canZoomIn: computed(() => level.value < MAX_ZOOM_LEVEL),
    canZoomOut: computed(() => level.value > MIN_ZOOM_LEVEL),
  };
}
