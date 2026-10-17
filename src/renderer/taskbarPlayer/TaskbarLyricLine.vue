<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { LyricLinePayload } from '../../shared/lyrics';
import { hasWordByWordTiming } from '../../shared/lyrics';
import { computeLyricCharBackgroundPosition } from '@/composables/useLyricTimeline';
const props = defineProps<{
  text: string;
  line?: LyricLinePayload | null;
  timeMs: number;
  endTimeMs?: number;
  wordByWord?: boolean;
  anchor?: 'left' | 'right';
}>();
const emit = defineEmits<{ width: [number] }>();
const viewport = ref<HTMLElement>();
const content = ref<HTMLElement>();
const overflow = ref(0);
// 非逐字歌词整行直显：估算出来的字符时间轴只会让高亮进度与真实演唱脱节。
const chars = computed(() => {
  const line = props.line;
  if (!props.wordByWord || !line || !hasWordByWordTiming(line)) return [];
  return line.characters;
});
const scrollDistance = computed(() => {
  if (!overflow.value) return 0;
  if (!chars.value.length) {
    const start = (props.line?.time ?? 0) * 1000;
    const duration = (props.endTimeMs ?? start) - start;
    if (duration <= 0) return 0;
    // 切行前留出阅读尾句的时间；短句按比例保留，避免一开始就滚到底。
    const scrollDuration = duration - Math.min(2000, duration * 0.25);
    const progress = Math.min(1, Math.max(0, (props.timeMs - start) / scrollDuration));
    return overflow.value * progress;
  }
  // 随当前播放字平移，暂停时保持位置，不启动独立的无限跑马灯。
  const active = chars.value.findIndex((char) => char.endTime > props.timeMs);
  const ratio = active < 0 ? 1 : active / Math.max(1, chars.value.length - 1);
  return overflow.value * ratio;
});
const offset = computed(
  () => (props.anchor === 'right' ? overflow.value : 0) - scrollDistance.value,
);
// 只淡出尚被裁切的一端；滚到末尾后右边缘必须完全不透明。
const fade = computed(() => ({
  '--fade-left': `${Math.min(12, scrollDistance.value)}px`,
  '--fade-right': `${Math.min(12, overflow.value - scrollDistance.value)}px`,
}));
let observer: ResizeObserver | undefined;
let alive = true;
let measureFrame = 0;
let lastWidth = -1;
const measure = () => {
  // 保留小数像素，避免缩放后滚动距离少于文本的实际溢出宽度。
  const width = content.value?.getBoundingClientRect().width ?? 0;
  overflow.value = Math.max(0, width - (viewport.value?.getBoundingClientRect().width ?? 0));
  if (width !== lastWidth) {
    lastWidth = width;
    emit('width', width);
  }
};
const scheduleMeasure = () => {
  if (measureFrame) return;
  // Width reports resize the parent strip; keep that write outside the observer delivery.
  measureFrame = requestAnimationFrame(() => {
    measureFrame = 0;
    if (alive) measure();
  });
};
watch(
  () => [props.text, props.wordByWord],
  async () => {
    await nextTick();
    if (alive) scheduleMeasure();
  },
);
onMounted(() => {
  observer = new ResizeObserver(scheduleMeasure);
  if (viewport.value) observer.observe(viewport.value);
  if (content.value) observer.observe(content.value);
  void document.fonts.ready.then(() => {
    if (alive) scheduleMeasure();
  });
  measure();
});
onUnmounted(() => {
  alive = false;
  observer?.disconnect();
  if (measureFrame) cancelAnimationFrame(measureFrame);
});
</script>
<template>
  <div
    ref="viewport"
    class="lyric-line"
    :class="{ overflow: overflow > 0, right: anchor === 'right' }"
    :style="fade"
    :title="text"
  >
    <span ref="content" class="line-content" :style="{ transform: `translateX(${offset}px)` }">
      <template v-if="chars.length">
        <span
          v-for="(char, i) in chars"
          :key="i"
          class="character"
          :style="{
            backgroundPositionX: computeLyricCharBackgroundPosition(
              char.startTime,
              char.endTime,
              timeMs,
            ),
          }"
          >{{ char.text }}</span
        >
      </template>
      <template v-else>{{ text }}</template>
    </span>
  </div>
</template>
<style scoped>
.lyric-line {
  display: flex;
  min-width: 0;
  overflow: hidden;
  white-space: pre;
}
.lyric-line.overflow {
  mask-image: linear-gradient(
    to right,
    transparent,
    #000 var(--fade-left),
    #000 calc(100% - var(--fade-right)),
    transparent
  );
}
.lyric-line.right {
  justify-content: flex-end;
  text-align: right;
}
.line-content {
  display: inline-block;
  flex-shrink: 0;
  transition: transform 160ms linear;
}
.character {
  background: linear-gradient(
    to right,
    var(--accent-text) 50%,
    var(--lyric-unplayed, var(--fg)) 50%
  );
  background-size: 200% 100%;
  background-clip: text;
  color: transparent;
}
@media (prefers-reduced-motion: reduce) {
  .line-content {
    transition: none;
  }
}
@media (forced-colors: active) {
  .character {
    color: CanvasText;
    background: none;
  }
}
</style>
