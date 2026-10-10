<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { LyricLinePayload } from '../../shared/lyrics';
import { computeLyricCharBackgroundPosition } from '@/composables/useLyricTimeline';
const props = defineProps<{
  text: string;
  line?: LyricLinePayload | null;
  timeMs: number;
  endTimeMs?: number;
  wordByWord?: boolean;
}>();
const emit = defineEmits<{ width: [number] }>();
const viewport = ref<HTMLElement>();
const content = ref<HTMLElement>();
const overflow = ref(0);
const chars = computed(() =>
  props.wordByWord && props.line?.characters?.some((char) => char.endTime > char.startTime)
    ? props.line.characters
    : [],
);
const offset = computed(() => {
  if (!overflow.value) return 0;
  if (!chars.value.length) {
    const start = (props.line?.time ?? 0) * 1000;
    const duration = (props.endTimeMs ?? start) - start;
    return duration > 0
      ? -Math.round(overflow.value * Math.min(1, Math.max(0, (props.timeMs - start) / duration)))
      : 0;
  }
  // 随当前播放字平移，暂停时保持位置，不启动独立的无限跑马灯。
  const active = chars.value.findIndex((char) => char.endTime > props.timeMs);
  const ratio = active < 0 ? 1 : active / Math.max(1, chars.value.length - 1);
  return -Math.round(overflow.value * ratio);
});
let observer: ResizeObserver | undefined;
let alive = true;
let measureFrame = 0;
let lastWidth = -1;
const measure = () => {
  const width = content.value?.scrollWidth ?? 0;
  overflow.value = Math.max(0, width - (viewport.value?.clientWidth ?? 0));
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
  <div ref="viewport" class="lyric-line" :class="{ overflow: overflow > 0 }" :title="text">
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
  min-width: 0;
  overflow: hidden;
  white-space: pre;
}
.lyric-line.overflow {
  mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 12px), transparent);
}
.line-content {
  display: inline-block;
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
