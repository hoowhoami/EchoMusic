<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import Cover from '@/components/ui/Cover.vue';

interface Props {
  typeLabel: string;
  title: string;
  coverUrl: string;
  hasDetails?: boolean;
  expandedHeight?: number;
  collapsedHeight?: number;
  contentPaddingX?: number;
  contentGap?: number;
  coverBaseSize?: number;
  titleFontSize?: number;
  detailsGap?: number;
  detailsMarginTop?: number;
}

const props = withDefaults(defineProps<Props>(), {
  hasDetails: false,
  expandedHeight: 230,
  collapsedHeight: 56,
  contentPaddingX: 24,
  contentGap: 20,
  coverBaseSize: 150,
  titleFontSize: 24,
  detailsGap: 10,
  detailsMarginTop: 8,
});

const scrollY = ref(0);
const scrollThreshold = computed(() => props.expandedHeight - props.collapsedHeight);
const currentHeight = computed(() => Math.max(props.collapsedHeight, props.expandedHeight - scrollY.value));

// 计算收缩比例 (0 到 1)
const progress = computed(() => {
  return Math.min(1, Math.max(0, scrollY.value / (scrollThreshold.value || 1)));
});

// 封面变换逻辑 (150px -> 32px)
const coverSize = props.coverBaseSize;
const targetCoverSize = 32;
const coverScale = computed(() => 1 - progress.value * (1 - targetCoverSize / coverSize));

// 动态占位宽度
const currentCoverWidth = computed(() => {
  return coverSize - (coverSize - targetCoverSize) * progress.value;
});

// 标题缩放 (24px -> 17.5px)
const titleScale = computed(() => 1 - progress.value * (1 - 17.5 / props.titleFontSize));

// 详情内容的透明度和位移
const detailsOpacity = computed(() => Math.max(0, 1 - progress.value * 3.5));
const detailsTranslateY = computed(() => -progress.value * 30);

defineExpose({ currentHeight });

const handleScroll = (e: Event) => {
  const target = e.target as HTMLElement;
  scrollY.value = target.scrollTop;
};

onMounted(() => {
  const scrollContainer = document.querySelector('.view-port');
  if (scrollContainer) {
    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    scrollY.value = scrollContainer.scrollTop;
  }
});

onUnmounted(() => {
  const scrollContainer = document.querySelector('.view-port');
  if (scrollContainer) {
    scrollContainer.removeEventListener('scroll', handleScroll);
  }
});
</script>

<template>
  <!-- 吸顶容器：始终保持 bg-bg-main 确保不透明 -->
  <div
    class="sliver-header-root sticky top-0 z-[100] w-full bg-bg-main"
    :style="{ height: `${props.collapsedHeight}px` }"
  >
    <!-- 展开背景层：不再使用 opacity 变化，仅随滚动上移 -->
    <div
      class="absolute inset-0 bg-bg-main -z-10 origin-top"
      :style="{
        height: `${props.expandedHeight}px`,
        transform: `translateY(${-scrollY}px)`,
      }"
    ></div>

    <!-- 内容层 -->
    <div
      class="relative h-full items-start overflow-visible pointer-events-none flex"
      :style="{
        paddingLeft: `${props.contentPaddingX}px`,
        paddingRight: `${props.contentPaddingX}px`,
        gap: `${props.contentGap}px`,
        paddingTop: '10px',
      }"
    >
      <!-- 封面图 -->
      <div
        class="shrink-0 relative z-30 origin-top-left flex items-start overflow-visible pointer-events-auto"
        :style="{ width: `${currentCoverWidth}px` }"
      >
        <div
          class="origin-top-left transition-shadow duration-300 shrink-0"
          :style="{
            transform: `scale(${coverScale})`,
            borderRadius: `${16 - progress * 2}px`,
            overflow: 'hidden',
            width: `${coverSize}px`,
            height: `${coverSize}px`,
          }"
        >
          <Cover :url="coverUrl" :size="400" :width="coverSize" :height="coverSize" />
        </div>
      </div>

      <!-- 标题和详情 -->
      <div class="flex-1 flex flex-col min-w-0 relative z-10 pt-0.5 pointer-events-auto">
        <div class="flex items-center justify-between gap-3">
          <h1
            class="flex-1 min-w-0 font-bold text-text-main leading-tight truncate origin-left transition-all duration-75"
            :style="{ fontSize: `${props.titleFontSize}px`, transform: `scale(${titleScale})` }"
          >
            {{ title }}
          </h1>
          <div
            class="type-badge shrink-0 transition-opacity duration-200"
            :style="{ opacity: detailsOpacity }"
          >
            {{ typeLabel }}
          </div>
        </div>

        <!-- 详情插槽 -->
        <div
          class="flex flex-col transition-all duration-75"
          :style="{
            opacity: detailsOpacity,
            transform: `translateY(${detailsTranslateY}px)`,
            pointerEvents: progress > 0.4 ? 'none' : 'auto',
            gap: `${props.detailsGap}px`,
            marginTop: `${props.detailsMarginTop}px`,
          }"
        >
          <slot name="details" />
          <div class="mt-2.5">
            <slot name="actions" />
          </div>
        </div>
      </div>
    </div>

    <!-- 吸顶后的操作按钮 -->
    <div
      class="absolute right-5 top-0 h-full flex items-center gap-1 transition-all duration-300 z-30"
      :style="{
        opacity: progress > 0.85 ? (progress - 0.85) * 6.6 : 0,
        transform: `translateX(${(1 - progress) * 20}px)`,
        pointerEvents: progress > 0.9 ? 'auto' : 'none',
      }"
    >
      <slot name="collapsed-actions" />
    </div>
  </div>

  <div :style="{ height: `${props.expandedHeight - props.collapsedHeight}px` }"></div>
</template>

<style scoped>
@reference "@/style.css";

.type-badge {
  @apply px-2 py-0.5 rounded-full text-[10px] font-bold tracking-[1.2px] uppercase;
  background-color: color-mix(in srgb, var(--color-primary) 8%, transparent);
  color: var(--color-primary);
  border: 0.5px solid color-mix(in srgb, var(--color-primary) 20%, transparent);
}
</style>
