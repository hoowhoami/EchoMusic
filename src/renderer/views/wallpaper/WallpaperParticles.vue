<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { parseHexColor, rgba } from './hexColor';
import { cancelScheduledFrame, scheduleDrawFrame, type FrameHandle } from '@/utils/frameBudget';

/**
 * 壁纸暗层上的浮尘粒子：随机分布、缓慢上浮。
 * 尺寸按屏幕短边缩放（以 1080 为基准），因此在 1080p / 2K / 4K 上观感一致；
 * 每个粒子带一层偏右下的柔和阴影，画面越暗越能看出体积。
 * 帧率上限 30，窗口不可见时完全停止绘制。
 */

interface Particle {
  x: number;
  y: number;
  radius: number;
  speed: number;
  drift: number;
  phase: number;
  alpha: number;
}

const props = withDefaults(
  defineProps<{
    /** 数量系数：1 = 默认密度。 */
    density?: number;
    /** 尺寸系数：1 = 默认大小。 */
    size?: number;
    /** 粒子颜色，跟随壁纸配色。 */
    color?: string;
    /** 冻结：暂停播放时停掉绘制循环，画面停在最后一帧。 */
    frozen?: boolean;
  }>(),
  { density: 1, size: 1, color: '#ffffff', frozen: false },
);

const canvasRef = ref<HTMLCanvasElement | null>(null);

const FPS_LIMIT = 30;
const FRAME_INTERVAL_MS = 1000 / FPS_LIMIT;
const AREA_PER_PARTICLE = 12222;
const MIN_PARTICLES = 80;
const MAX_PARTICLES = 320;
/** 尺寸基准短边：以 1080p 为基准，屏幕更大时粒子按比例放大。 */
const REFERENCE_SHORT_SIDE = 1080;
const SPRITE_SIZE = 96;

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
  shadow.addColorStop(0, 'rgba(0, 0, 0, 0.26)');
  shadow.addColorStop(0.35, 'rgba(0, 0, 0, 0.1)');
  shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = shadow;
  context.beginPath();
  context.arc(center, center, center * 0.9, 0, Math.PI * 2);
  context.fill();

  // 本体：中心实心，向外柔化到透明；颜色由壁纸配色决定
  const tint = parseHexColor(color, { r: 255, g: 255, b: 255 });
  const body = context.createRadialGradient(center, center, 0, center, center, center);
  body.addColorStop(0, rgba(tint, 1));
  body.addColorStop(0.28, rgba(tint, 0.98));
  body.addColorStop(0.5, rgba(tint, 0.72));
  body.addColorStop(0.78, rgba(tint, 0.26));
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
  const radius = (2 + Math.pow(Math.random(), 1.6) * 14) * sizeScale * sizeFactor;
  const sizeFade = 1 - Math.min(radius / (17 * sizeScale * sizeFactor), 0.4);
  return {
    x: Math.random() * width,
    y: anywhere ? Math.random() * height : height + random(4, 40) * sizeScale,
    radius,
    speed: (random(4, 26) * sizeScale) / (0.7 + radius * 0.25),
    drift: random(2, 12) * sizeScale,
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
  elapsed += delta;
  for (const particle of particles) {
    particle.y -= particle.speed * delta;
    particle.x += Math.sin(elapsed * 0.6 + particle.phase) * particle.drift * delta;
    if (particle.y < -particle.radius) {
      Object.assign(particle, createParticle(false));
    } else if (particle.x < -particle.radius) {
      particle.x = width + particle.radius;
    } else if (particle.x > width + particle.radius) {
      particle.x = -particle.radius;
    }
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
  if (lastFrameAt === 0) lastFrameAt = now;
  if (now - lastFrameAt < FRAME_INTERVAL_MS) return;
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
