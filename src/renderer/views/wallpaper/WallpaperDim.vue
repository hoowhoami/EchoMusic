<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { parseHexColor, rgba } from './hexColor';

/**
 * 壁纸「仅歌词」的压暗层：中间几乎不压，越靠屏幕边缘越黑。
 * 只在挂载、窗口尺寸变化或参数变化时重画一次，不参与动画。
 */

const props = withDefaults(
  defineProps<{
    /** 压暗的起点（离屏幕中心的归一化距离）。 */
    edgeStart?: number;
    /** 贴边压暗的浓度。 */
    edgeDarkness?: number;
    /** 压暗用的底色，跟随壁纸配色。 */
    color?: string;
  }>(),
  {
    edgeStart: 0.5,
    edgeDarkness: 0.5,
    color: '#000000',
  },
);

const canvasRef = ref<HTMLCanvasElement | null>(null);

const MAX_PIXEL_RATIO = 1.5;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const draw = () => {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  const ratio = clamp(window.devicePixelRatio || 1, 1, MAX_PIXEL_RATIO);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const centerX = width / 2;
  const centerY = height / 2;
  const maxRadius = Math.hypot(centerX, centerY) || 1;
  const edgeStart = clamp(props.edgeStart, 0, 1);
  const darkness = clamp(props.edgeDarkness, 0, 1);
  const tint = parseHexColor(props.color);

  const vignette = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, maxRadius);
  vignette.addColorStop(0, rgba(tint, 0));
  vignette.addColorStop(clamp(edgeStart + 0.02, 0, 0.9), rgba(tint, 0));
  vignette.addColorStop(
    clamp(edgeStart + (1 - edgeStart) * 0.45, 0, 1),
    rgba(tint, 0.27 * darkness),
  );
  vignette.addColorStop(
    clamp(edgeStart + (1 - edgeStart) * 0.74, 0, 1),
    rgba(tint, 0.67 * darkness),
  );
  vignette.addColorStop(1, rgba(tint, darkness));
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);
};

onMounted(() => {
  draw();
  window.addEventListener('resize', draw);
});

watch(() => [props.edgeStart, props.edgeDarkness, props.color], draw);

onUnmounted(() => {
  window.removeEventListener('resize', draw);
});
</script>

<template>
  <canvas ref="canvasRef" class="wallpaper-dim" aria-hidden="true"></canvas>
</template>

<style scoped>
/* 盖在歌词之下、桌面之上的压暗层 */
.wallpaper-dim {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 1390;
  pointer-events: none;
}
</style>
