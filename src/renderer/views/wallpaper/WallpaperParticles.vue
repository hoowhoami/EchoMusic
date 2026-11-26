<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { parseHexColor, rgba } from './hexColor';
import { cancelScheduledFrame, scheduleDrawFrame, type FrameHandle } from '@/utils/frameBudget';

/**
 * 壁纸暗层上的浮尘粒子：像真实灰尘一样没有固定方向，各自缓缓飘动、不断改向，飘出画面就从另一侧回来。
 * 尺寸按屏幕短边缩放（以 1080 为基准），因此在 1080p / 2K / 4K 上观感一致；
 * 每个粒子带一层偏右下的柔和阴影，画面越暗越能看出体积。
 * 帧率跟着壁纸帧率设置走（再由屏幕刷新率封顶），窗口不可见时完全停止绘制。
 */

interface Particle {
  x: number;
  y: number;
  radius: number;
  /** 飘动速度（px/s）。 */
  speed: number;
  /** 初始方向（弧度），每颗粒子任意。 */
  angle: number;
  /** 改向快慢（rad/s），值越大越像被风吹得乱飘。 */
  swayFreq: number;
  phase: number;
  alpha: number;
}

const props = withDefaults(
  defineProps<{
    /** 数量系数：1 = 默认密度。 */
    density?: number;
    /** 尺寸系数：1 = 默认大小。 */
    size?: number;
    /** 速度系数（1 = 默认）：0 静止，1 已是原先的 1.5 倍，2 为 3 倍。 */
    speed?: number;
    /** 粒子颜色，跟随壁纸配色。 */
    color?: string;
    /** 冻结：暂停播放时停掉绘制循环，画面停在最后一帧。 */
    frozen?: boolean;
  }>(),
  { density: 1, size: 1, speed: 1, color: '#ffffff', frozen: false },
);

const canvasRef = ref<HTMLCanvasElement | null>(null);

const AREA_PER_PARTICLE = 12222;
const MIN_PARTICLES = 80;
const MAX_PARTICLES = 320;
/** 尺寸基准短边：以 1080p 为基准，屏幕更大时粒子按比例放大。 */
const REFERENCE_SHORT_SIDE = 1080;
/** 速度系数 1（界面上的 100%）对应的实际倍数：默认档就是原先的 4 倍，再按系数线性放大。 */
const SPEED_GAIN_AT_DEFAULT = 4;
/** 尺寸系数 1（界面上的 100%）对应的实际放大：默认档比最早那版大 1.3 倍。 */
const SIZE_GAIN_AT_DEFAULT = 1.3;
const SPRITE_SIZE = 96;
/** 方向摆动的最大幅度（弧度）：1.1 约等于 ±63°，飘起来才有"没有固定方向"的感觉。 */
const WANDER_RAD = 1.1;
/** 实芯半径占比：0.5 就是中间五成是实的，外面留一段更长的柔化带，颗粒是圆点但边缘不硬。 */
const SPRITE_CORE_RATIO = 0.5;

let frame: FrameHandle | null = null;
let running = false;
let lastFrameAt = 0;
let elapsed = 0;
let width = 0;
let height = 0;
let sizeScale = 1;
let particles: Particle[] = [];
let sprite: HTMLCanvasElement | null = null;
let spriteColor = '';
let ctx: CanvasRenderingContext2D | null = null;

const random = (min: number, max: number) => min + Math.random() * (max - min);

/** 预渲染一张带阴影的柔和光点，绘制时按粒子大小拉伸。 */
const createSprite = (color: string): HTMLCanvasElement | null => {
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE_SIZE;
  canvas.height = SPRITE_SIZE;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const center = SPRITE_SIZE / 2;

  // 阴影：偏右下一点的暗晕，颗粒在暗背景上也立得住
  const shadow = context.createRadialGradient(
    center + SPRITE_SIZE * 0.05,
    center + SPRITE_SIZE * 0.06,
    0,
    center + SPRITE_SIZE * 0.05,
    center + SPRITE_SIZE * 0.06,
    center,
  );
  shadow.addColorStop(0, 'rgba(0, 0, 0, 0.18)');
  shadow.addColorStop(0.35, 'rgba(0, 0, 0, 0.06)');
  shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = shadow;
  context.beginPath();
  context.arc(center, center, center * 0.82, 0, Math.PI * 2);
  context.fill();

  // 本体：中心实心，向外柔化到透明；颜色由壁纸配色决定
  const tint = parseHexColor(color, { r: 255, g: 255, b: 255 });
  const body = context.createRadialGradient(center, center, 0, center, center, center);
  body.addColorStop(0, rgba(tint, 1));
  body.addColorStop(SPRITE_CORE_RATIO, rgba(tint, 0.96));
  body.addColorStop(0.68, rgba(tint, 0.72));
  body.addColorStop(0.84, rgba(tint, 0.34));
  body.addColorStop(0.94, rgba(tint, 0.12));
  body.addColorStop(1, rgba(tint, 0));
  context.fillStyle = body;
  context.beginPath();
  context.arc(center, center, center, 0, Math.PI * 2);
  context.fill();

  return canvas;
};

const createParticle = (anywhere: boolean): Particle => {
  // 大小分层：多数是细尘，少数是明显颗粒；半径已按屏幕短边缩放
  const sizeFactor = Math.max(props.size, 0.01);
  const radius =
    (2 + Math.pow(Math.random(), 1.6) * 14) * sizeScale * sizeFactor * SIZE_GAIN_AT_DEFAULT;
  // 分母同样乘基准放大：只把颗粒放大，亮度分布保持原样。
  const sizeFade = 1 - Math.min(radius / (17 * sizeScale * sizeFactor * SIZE_GAIN_AT_DEFAULT), 0.4);
  return {
    x: Math.random() * width,
    // 新颗粒也从画面外侧进场，避免在视线里凭空出现
    y: anywhere ? Math.random() * height : -random(20, 120) * sizeScale,
    radius,
    speed: random(8, 30) * sizeScale,
    angle: random(0, Math.PI * 2),
    swayFreq: random(0.12, 0.45),
    phase: random(0, Math.PI * 2),
    alpha: random(0.14, 0.52) * sizeFade,
  };
};

const buildParticles = () => {
  // 数量或尺寸调到 0 就是不要粒子，连绘制都省掉
  if (props.density <= 0 || props.size <= 0) {
    particles = [];
    return;
  }
  const target = Math.round(
    ((width * height) / (AREA_PER_PARTICLE * sizeScale * sizeScale)) * props.density,
  );
  const count = Math.min(
    Math.max(20, Math.round(MAX_PARTICLES * props.density)),
    Math.max(Math.max(20, Math.round(MIN_PARTICLES * props.density)), target),
  );
  particles = Array.from({ length: count }, () => createParticle(true));
};

const draw = (delta: number) => {
  if (!ctx || !sprite) return;
  ctx.clearRect(0, 0, width, height);
  const gain = Math.max(0, props.speed) * SPEED_GAIN_AT_DEFAULT;
  // 相位和时间一起缩放：速度调低时左右飘也跟着变慢，不会只剩下落变慢。
  elapsed += delta * gain;
  const margin = 60 * sizeScale;
  for (const particle of particles) {
    // 方向本身在缓慢摆动：粒子走的是一条不断改向的曲线，而不是直线飘
    const angle =
      particle.angle + Math.sin(elapsed * particle.swayFreq + particle.phase) * WANDER_RAD;
    particle.x += Math.cos(angle) * particle.speed * delta * gain;
    particle.y += Math.sin(angle) * particle.speed * delta * gain;
    // 四面都环绕，飘出去就从对面回来，画面里始终均匀有粒子
    if (particle.x < -margin) particle.x = width + margin;
    else if (particle.x > width + margin) particle.x = -margin;
    if (particle.y < -margin) particle.y = height + margin;
    else if (particle.y > height + margin) particle.y = -margin;
    ctx.globalAlpha = particle.alpha;
    ctx.drawImage(
      sprite,
      particle.x - particle.radius,
      particle.y - particle.radius,
      particle.radius * 2,
      particle.radius * 2,
    );
  }
  ctx.globalAlpha = 1;
};

// 用预算调度器排下一帧：预算直接压住「要不要一帧」，而不是只跳过绘制。
const scheduleNext = () => {
  if (!running) return;
  frame = scheduleDrawFrame('particles', tick);
};

const tick = (now: number) => {
  frame = null;
  if (!running) return;
  scheduleNext();
  // 不再自己限帧：帧预算已经按壁纸设置的帧率（再看屏幕刷新率）发帧，这里只负责把时间差交给动画。
  if (lastFrameAt === 0) {
    lastFrameAt = now;
    return;
  }
  const delta = Math.min((now - lastFrameAt) / 1000, 0.1);
  lastFrameAt = now;
  draw(delta);
};

const start = () => {
  if (running) return;
  running = true;
  lastFrameAt = 0;
  scheduleNext();
};

const stop = () => {
  running = false;
  cancelScheduledFrame(frame);
  frame = null;
};

const resize = () => {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  width = canvas.clientWidth || window.innerWidth;
  height = canvas.clientHeight || window.innerHeight;
  sizeScale = Math.min(Math.max(Math.min(width, height) / REFERENCE_SHORT_SIDE, 0.75), 3);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (!sprite || spriteColor !== props.color) {
    sprite = createSprite(props.color);
    spriteColor = props.color;
  }
  buildParticles();
  draw(0);
};

const handleVisibility = () => {
  if (document.hidden) {
    stop();
  } else {
    resize();
    start();
  }
};

watch(
  () => [props.density, props.size, props.color],
  () => {
    resize();
  },
);

// 冻结时彻底停掉绘制循环：暂停中的壁纸不该占用任何 CPU
watch(
  () => props.frozen,
  (frozen) => {
    if (frozen) stop();
    else start();
  },
);

onMounted(() => {
  resize();
  if (!props.frozen) start();
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', handleVisibility);
});

onUnmounted(() => {
  stop();
  window.removeEventListener('resize', resize);
  document.removeEventListener('visibilitychange', handleVisibility);
  particles = [];
  sprite = null;
  spriteColor = '';
  ctx = null;
});
</script>

<template>
  <canvas ref="canvasRef" class="wallpaper-particles" aria-hidden="true"></canvas>
</template>

<style scoped>
/* 位于歌词之上的一层浮尘：只做气氛，不挡内容 */
.wallpaper-particles {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 1400;
  pointer-events: none;
}
</style>
