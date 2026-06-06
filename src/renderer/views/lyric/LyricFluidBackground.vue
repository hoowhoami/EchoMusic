<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

interface Props {
  coverUrl: string;
  enabled: boolean;
}

const props = defineProps<Props>();

const canvas1 = ref<HTMLCanvasElement | null>(null);
const canvas2 = ref<HTMLCanvasElement | null>(null);
const canvas3 = ref<HTMLCanvasElement | null>(null);
const canvas4 = ref<HTMLCanvasElement | null>(null);
const viewWidth = ref(0);
const viewHeight = ref(0);
const fluidSeed = ref(0);

const hashString = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
};

const canvasSize = computed(() => Math.max(viewWidth.value, viewHeight.value) * 0.707);

const canvasStyle = (index: number) => {
  const size = canvasSize.value;
  const x = index % 2;
  const y = Math.floor(index / 2);
  const signX = x === 0 ? -1 : 1;
  const signY = y === 0 ? -1 : 1;

  return {
    width: `${size}px`,
    height: `${size}px`,
    left: `${viewWidth.value / 2 + signX * size * 0.35 - size / 2}px`,
    top: `${viewHeight.value / 2 + signY * size * 0.35 - size / 2}px`,
  };
};

const updateCanvasLayout = () => {
  viewWidth.value = window.innerWidth;
  viewHeight.value = window.innerHeight;
};

const drawCanvas = (
  canvas: HTMLCanvasElement | null,
  image: HTMLImageElement,
  sx: number,
  sy: number,
) => {
  if (!canvas) return;
  const context = canvas.getContext('2d');
  if (!context) return;

  canvas.width = 100;
  canvas.height = 100;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.filter = 'blur(5px)';
  context.drawImage(image, sx, sy, image.width / 2, image.height / 2, 0, 0, 100, 100);
};

const refreshCanvases = () => {
  if (!props.enabled || !props.coverUrl) return;

  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    drawCanvas(canvas1.value, image, 0, 0);
    drawCanvas(canvas2.value, image, image.width / 2, 0);
    drawCanvas(canvas3.value, image, 0, image.height / 2);
    drawCanvas(canvas4.value, image, image.width / 2, image.height / 2);
    fluidSeed.value = hashString(props.coverUrl) % 1000;
  };
  image.src = props.coverUrl;
};

watch(
  () => [props.enabled, props.coverUrl],
  () => {
    updateCanvasLayout();
    requestAnimationFrame(refreshCanvases);
  },
  { immediate: true },
);

onMounted(() => {
  updateCanvasLayout();
  refreshCanvases();
  window.addEventListener('resize', updateCanvasLayout);
});

onUnmounted(() => {
  window.removeEventListener('resize', updateCanvasLayout);
});
</script>

<template>
  <template v-if="enabled">
    <svg width="0" height="0" class="lyric-fluid-filter-svg" aria-hidden="true">
      <filter
        id="lyric-fluid-filter"
        x="-20%"
        y="-20%"
        width="140%"
        height="140%"
        filterUnits="objectBoundingBox"
        primitiveUnits="userSpaceOnUse"
        color-interpolation-filters="sRGB"
      >
        <feTurbulence type="fractalNoise" baseFrequency="0.005" numOctaves="1" :seed="fluidSeed" />
        <feDisplacementMap in="SourceGraphic" scale="400" />
      </filter>
    </svg>
    <div class="lyric-fluid-bg">
      <div class="lyric-fluid-bg-rect">
        <canvas
          ref="canvas1"
          class="lyric-fluid-bg-canvas"
          :style="canvasStyle(0)"
          width="100"
          height="100"
        ></canvas>
        <canvas
          ref="canvas2"
          class="lyric-fluid-bg-canvas"
          :style="canvasStyle(1)"
          width="100"
          height="100"
        ></canvas>
        <canvas
          ref="canvas3"
          class="lyric-fluid-bg-canvas"
          :style="canvasStyle(2)"
          width="100"
          height="100"
        ></canvas>
        <canvas
          ref="canvas4"
          class="lyric-fluid-bg-canvas"
          :style="canvasStyle(3)"
          width="100"
          height="100"
        ></canvas>
      </div>
    </div>
  </template>
</template>

<style scoped>
.lyric-fluid-filter-svg {
  position: absolute;
  width: 0;
  height: 0;
}

.lyric-fluid-bg {
  position: absolute;
  left: -150px;
  top: -150px;
  z-index: 1;
  width: calc(100% + 150px);
  height: calc(100% + 150px);
  overflow: hidden;
}

.lyric-fluid-bg::before {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  content: '';
  background: rgba(0, 0, 0, 0.24);
}

.lyric-fluid-bg::after {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  content: '';
  backdrop-filter: blur(64px);
}

.lyric-fluid-bg-rect {
  position: relative;
  top: calc(50% - 50vh);
  left: calc(50% - 50vw);
  width: max(100vw, 100vh);
  height: max(100vw, 100vh);
  filter: saturate(1.3) brightness(1.5) url('#lyric-fluid-filter');
  animation: lyric-fluid-container-rotate 150s linear infinite;
  will-change: transform;
}

.lyric-fluid-bg-canvas {
  position: absolute;
  opacity: 1;
  animation: lyric-fluid-block-rotate 60s linear infinite;
  will-change: transform;
}

.lyric-fluid-bg-canvas:nth-child(2) {
  animation-delay: -5s;
}

.lyric-fluid-bg-canvas:nth-child(3) {
  animation-delay: -10s;
}

.lyric-fluid-bg-canvas:nth-child(4) {
  animation-delay: -15s;
}

@keyframes lyric-fluid-block-rotate {
  0% {
    transform: rotate(0deg);
  }

  100% {
    transform: rotate(360deg);
  }
}

@keyframes lyric-fluid-container-rotate {
  0% {
    transform: scale(1.2) rotate(0deg);
  }

  100% {
    transform: scale(1.2) rotate(-360deg);
  }
}
</style>
