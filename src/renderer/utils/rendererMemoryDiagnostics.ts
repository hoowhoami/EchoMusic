import { watch } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { pluginRuntimeState } from '@/plugins/runtime';
import { logger } from '@/utils/logger';
import type { DiagnosticsMemorySnapshot } from '../../shared/diagnostics';

const MEMORY_DIAGNOSTICS_INTERVAL_MS = 30_000;

let timer: number | null = null;
let lastActive = false;
let suspendedForRelaunch = false;

const stopTimer = () => {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
};

const getDomSummary = () => ({
  nodes: document.querySelectorAll('*').length,
  images: document.images.length,
  canvases: document.querySelectorAll('canvas').length,
  iframes: document.querySelectorAll('iframe').length,
});

const getLocationSummary = () => ({
  pathname: window.location.pathname,
  search: window.location.search,
  hash: window.location.hash,
});

const normalizeImageSrcForDiagnostics = (src: string) => {
  if (!src) return '';
  try {
    const url = new URL(src, window.location.href);
    return `${url.origin}${url.pathname}`.slice(0, 180);
  } catch {
    return src.slice(0, 180);
  }
};

const getImageDiagnosticsSummary = () => {
  const images = Array.from(document.images);
  const sourceCounts = new Map<string, number>();
  const hostCounts = new Map<string, number>();

  for (const image of images) {
    const src = normalizeImageSrcForDiagnostics(image.currentSrc || image.src);
    if (!src) continue;
    sourceCounts.set(src, (sourceCounts.get(src) ?? 0) + 1);
    try {
      const host = new URL(src).host || 'inline';
      hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
    } catch {
      hostCounts.set('inline', (hostCounts.get('inline') ?? 0) + 1);
    }
  }

  const topSources = Array.from(sourceCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([src, count]) => ({ src, count }));

  const topHosts = Array.from(hostCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([host, count]) => ({ host, count }));

  const largestRendered = images
    .map((image) => ({
      src: normalizeImageSrcForDiagnostics(image.currentSrc || image.src),
      complete: image.complete,
      natural: `${image.naturalWidth}x${image.naturalHeight}`,
      rendered: `${Math.round(image.clientWidth)}x${Math.round(image.clientHeight)}`,
      naturalPixels: image.naturalWidth * image.naturalHeight,
    }))
    .filter((item) => item.src && item.naturalPixels > 0)
    .sort((a, b) => b.naturalPixels - a.naturalPixels)
    .slice(0, 8)
    .map(({ naturalPixels: _naturalPixels, ...item }) => item);

  return {
    uniqueSources: sourceCounts.size,
    loaded: images.filter((image) => image.complete && image.naturalWidth > 0).length,
    pending: images.filter((image) => !image.complete).length,
    topHosts,
    topSources,
    largestRendered,
  };
};

const getCanvasDiagnosticsSummary = () => {
  const canvases = Array.from(document.querySelectorAll('canvas'));
  const items = canvases
    .map((canvas) => {
      const rect = canvas.getBoundingClientRect();
      const backingPixels = canvas.width * canvas.height;
      return {
        id: canvas.id || '',
        className:
          typeof canvas.className === 'string'
            ? canvas.className.slice(0, 120)
            : String(canvas.className || '').slice(0, 120),
        backing: `${canvas.width}x${canvas.height}`,
        rendered: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
        backingPixels,
      };
    })
    .sort((a, b) => b.backingPixels - a.backingPixels);
  const totalBackingPixels = items.reduce((sum, item) => sum + item.backingPixels, 0);

  return {
    count: canvases.length,
    totalBackingPixels,
    estimatedBackingMb: Math.round(((totalBackingPixels * 4) / 1024 / 1024) * 10) / 10,
    largest: items.slice(0, 8).map(({ backingPixels: _backingPixels, ...item }) => item),
  };
};

const getPluginSummary = () =>
  pluginRuntimeState.records
    .filter((record) => record.status === 'active')
    .map((record) => ({
      id: record.descriptor.id,
      version: record.descriptor.manifest.version || '',
      capabilities: record.descriptor.manifest.capabilities ?? {},
    }));

const logSnapshot = (snapshot: DiagnosticsMemorySnapshot, reason: string) => {
  const rendererProcess =
    snapshot.appProcesses.find((item) => item.pid === snapshot.rendererPid) ??
    snapshot.appProcesses.find((item) => item.type === 'Tab');
  logger.info('MemoryDiagnostics', {
    reason,
    label: snapshot.label,
    rendererPid: snapshot.rendererPid,
    renderer: snapshot.renderer,
    rendererProcess,
    rendererNode: snapshot.rendererNode,
    performance: snapshot.performance,
    resources: snapshot.resources,
    location: getLocationSummary(),
    dom: getDomSummary(),
    images: getImageDiagnosticsSummary(),
    canvases: getCanvasDiagnosticsSummary(),
    activePlugins: getPluginSummary(),
  });
};

const sampleMemory = async (reason: string) => {
  if (suspendedForRelaunch) return;
  if (!window.electron?.diagnostics?.getMemory) return;
  try {
    const snapshot = await window.electron.diagnostics.getMemory(reason);
    logSnapshot(snapshot, reason);
  } catch (error) {
    logger.warn('MemoryDiagnostics', 'Failed to sample renderer memory', error);
  }
};

const setActive = (active: boolean) => {
  if (active === lastActive && (active ? timer !== null : timer === null)) return;
  lastActive = active;
  stopTimer();
  if (!active || suspendedForRelaunch) return;

  void sampleMemory('diagnostic:start');
  timer = window.setInterval(
    () => void sampleMemory('diagnostic:interval'),
    MEMORY_DIAGNOSTICS_INTERVAL_MS,
  );
};

export const suspendRendererMemoryDiagnosticsForRelaunch = () => {
  suspendedForRelaunch = true;
  stopTimer();
};

export const startRendererMemoryDiagnostics = () => {
  const settingStore = useSettingStore();
  watch(
    () => settingStore.logDiagnosticUntil,
    (diagnosticUntil) => setActive(diagnosticUntil > Date.now()),
    { immediate: true },
  );
};
