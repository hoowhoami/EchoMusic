<script setup lang="ts">
import { onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue';
import { FluidBackgroundRenderer } from './fluidBackgroundRenderer';

const props = defineProps<{ coverUrl: string; enabled: boolean }>();
const emit = defineEmits<{ ready: [value: boolean] }>();
const canvas = ref<HTMLCanvasElement | null>(null);
const ready = ref(false);
const FRAME_INTERVAL = 1000 / 30;
const COVER_SETTLE_MS = 180;
let renderer: FluidBackgroundRenderer | null = null;
let mounted = false;
let active = true;
let contextLost = false;
let frame = 0;
let loadTimer: number | null = null;
let image: HTMLImageElement | null = null;
let sequence = 0;
let loadedUrl = '';
let elapsedSeconds = 0;
let lastDraw: number | null = null;
let layoutDirty = false;

const setReady = (value: boolean) => {
  if (ready.value === value) return;
  ready.value = value;
  emit('ready', value);
};
const canRun = () => mounted && active && props.enabled && !document.hidden && !contextLost;
const stopFrames = () => {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  lastDraw = null;
};
const cancelLoad = () => {
  sequence++;
  if (loadTimer !== null) window.clearTimeout(loadTimer);
  loadTimer = null;
  if (image) {
    image.onload = image.onerror = null;
    image.src = '';
    image = null;
  }
};
const releaseRenderer = () => {
  stopFrames();
  renderer?.dispose();
  renderer = null;
  loadedUrl = '';
  setReady(false);
};
const fail = () => {
  cancelLoad();
  releaseRenderer();
};
const tick = (timestamp: number) => {
  frame = 0;
  if (!canRun() || !renderer || !loadedUrl) return;
  const delta = lastDraw === null ? FRAME_INTERVAL : timestamp - lastDraw;
  if (delta >= FRAME_INTERVAL - 0.1) {
    if (lastDraw !== null) elapsedSeconds += Math.min(delta, 250) / 1000;
    lastDraw = timestamp;
    try {
      if (layoutDirty) resize();
      if (!renderer) return;
      renderer.draw(elapsedSeconds);
      setReady(true);
    } catch {
      fail();
      return;
    }
  }
  frame = requestAnimationFrame(tick);
};
const startFrames = () => {
  if (!frame && canRun() && renderer && loadedUrl) frame = requestAnimationFrame(tick);
};
const resize = () => {
  if (!renderer || !canRun()) return;
  try {
    // Same overscan as the original fluid layer; never multiply by screen DPR.
    renderer.resize(window.innerWidth + 150, window.innerHeight + 150);
    layoutDirty = false;
  } catch {
    fail();
  }
};
const scheduleResize = () => {
  layoutDirty = true;
  startFrames();
};
const reconcile = () => {
  cancelLoad();
  if (!mounted) return;
  if (!props.enabled || !props.coverUrl || !canvas.value) {
    releaseRenderer();
    return;
  }
  if (!canRun()) {
    stopFrames();
    return;
  }
  if (!renderer) {
    try {
      renderer = new FluidBackgroundRenderer(canvas.value);
      resize();
    } catch {
      fail();
      return;
    }
  } else resize();
  if (!renderer) return;
  startFrames();
  if (loadedUrl === props.coverUrl) return;
  const request = sequence,
    url = props.coverUrl;
  loadTimer = window.setTimeout(() => {
    loadTimer = null;
    if (!canRun() || request !== sequence) return;
    const pending = new Image();
    image = pending;
    pending.crossOrigin = 'anonymous';
    const releaseImage = () => {
      pending.onload = pending.onerror = null;
      pending.src = '';
      if (image === pending) image = null;
    };
    pending.onload = () => {
      if (request !== sequence || image !== pending || !canRun() || !renderer) {
        releaseImage();
        return;
      }
      try {
        renderer.setCover(pending, url);
        loadedUrl = url;
        startFrames();
      } catch {
        fail();
      } finally {
        releaseImage();
      }
    };
    pending.onerror = () => {
      if (request === sequence && image === pending) fail();
      releaseImage();
    };
    pending.src = url;
  }, COVER_SETTLE_MS);
};
const handleContextLost = (event: Event) => {
  if (!mounted || event.currentTarget !== canvas.value || !props.enabled) return;
  event.preventDefault();
  contextLost = true;
  cancelLoad();
  stopFrames();
  // The browser owns lost GPU resources. Drop references and use the static cover.
  renderer = null;
  loadedUrl = '';
  setReady(false);
};
const handleContextRestored = (event: Event) => {
  if (!mounted || event.currentTarget !== canvas.value) return;
  contextLost = false;
  reconcile();
};

watch(
  () => [props.enabled, props.coverUrl],
  ([enabled], [wasEnabled]) => {
    // A toggled-on canvas has a fresh context, including after a previous failure.
    if (enabled && !wasEnabled && canvas.value) contextLost = false;
    reconcile();
  },
  { flush: 'post' },
);
onMounted(() => {
  mounted = true;
  reconcile();
  document.addEventListener('visibilitychange', reconcile);
  window.addEventListener('resize', scheduleResize);
});
onActivated(() => {
  active = true;
  reconcile();
});
onDeactivated(() => {
  active = false;
  cancelLoad();
  stopFrames();
});
onUnmounted(() => {
  mounted = false;
  cancelLoad();
  releaseRenderer();
  document.removeEventListener('visibilitychange', reconcile);
  window.removeEventListener('resize', scheduleResize);
});
</script>

<template>
  <canvas
    v-if="enabled"
    ref="canvas"
    v-show="ready"
    class="lyric-fluid-bg"
    width="1"
    height="1"
    aria-hidden="true"
    @webglcontextlost="handleContextLost"
    @webglcontextrestored="handleContextRestored"
  />
</template>

<style scoped>
.lyric-fluid-bg {
  position: absolute;
  left: -150px;
  top: -150px;
  z-index: 1;
  width: calc(100% + 150px);
  height: calc(100% + 150px);
  pointer-events: none;
}
</style>
