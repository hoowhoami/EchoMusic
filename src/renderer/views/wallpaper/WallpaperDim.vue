<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { parseHexColor, rgba } from './hexColor';

/**
 * 壁纸「仅歌词」的压暗层：中心一层很淡的压暗，越靠屏幕边缘越暗。
 * 只在挂载、窗口尺寸变化或参数变化时重画一次，不参与动画。
 *
 * 全屏只有这一层压暗：歌词页自己不再画渐变，参数全在这里。
 */

const props = withDefaults(
  defineProps<{
    /** 屏幕中心的不透明度（0~1），就是画面上的实际浓度。 */
    centerDim?: number;
    /** 屏幕边缘的不透明度（0~1）。 */
    edgeDim?: number;
    /** 过渡曲线（0~1）：越大则中间变化越小、靠边变暗越快。 */
    curve?: number;
    /** 压暗用的底色，跟随壁纸配色。 */
    color?: string;
  }>(),
  {
    centerDim: 0.15,
    edgeDim: 0.85,
    curve: 0.5,
    color: '#000000',
  },
);

const canvasRef = ref<HTMLCanvasElement | null>(null);

const MAX_PIXEL_RATIO = 1.5;

/** 渐变采样点数：够密就看不出折线，又不会拖慢重画。 */
const STOPS = 32;

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
  const edge = clamp(props.edgeDim, 0, 1);
  // 中心比边缘还浓时按较小的那个收敛，不出现「中间黑、四周亮」的倒挂。
  const center = Math.min(clamp(props.centerDim, 0, 1), edge);
  // 曲线只改过渡形状：0 是线性，越大越陡（靠边才迅速变暗）。
  const gamma = 2 ** (clamp(props.curve, 0, 1) * 2);
  const tint = parseHexColor(props.color);

  const vignette = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, maxRadius);
  for (let index = 0; index <= STOPS; index += 1) {
    const t = index / STOPS;
    const alpha = center + (edge - center) * t ** gamma;
    vignette.addColorStop(t, rgba(tint, alpha));
  }
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);
};

onMounted(() => {
  draw();
  window.addEventListener('resize', draw);
});

watch(() => [props.centerDim, props.edgeDim, props.curve, props.color], draw);

onUnmounted(() => {
  window.removeEventListener('resize', draw);
});
</script>

<template>
  <canvas ref="canvasRef" class="wallpaper-dim" aria-hidden="true"></canvas>
</template>

<style scoped>
/* 盖在底色层之上、歌词之下（歌词页为 1300，浮尘为 1400）的压暗层：
   歌词本身不能被压暗，否则亮部会被吃掉。 */
.wallpaper-dim {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 1295;
  pointer-events: none;
}
</style>
