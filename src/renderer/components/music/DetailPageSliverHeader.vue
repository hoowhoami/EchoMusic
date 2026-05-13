<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, onActivated, watch } from 'vue';
import Cover from '@/components/ui/Cover.vue';
import { useScrollContainer } from '@/composables/usePageScroll';

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
const currentHeight = computed(() =>
  Math.max(props.collapsedHeight, props.expandedHeight - scrollY.value),
);

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

// 吸顶时封面垂直居中：paddingTop 从展开时的 10px 过渡到 (collapsedHeight - targetCoverSize) / 2
const expandedPaddingTop = 10;
const collapsedPaddingTop = (props.collapsedHeight - targetCoverSize) / 2;
const contentPaddingTop = computed(
  () => expandedPaddingTop + (collapsedPaddingTop - expandedPaddingTop) * progress.value,
);

// 右侧内容区高度：展开时与封面等高以实现上下对齐
const rightColumnHeight = computed(() => {
  return coverSize * coverScale.value;
});

defineExpose({ currentHeight });

const scrollContainerRef = useScrollContainer();

const handleScroll = (e: Event) => {
  const target = e.target as HTMLElement;
  scrollY.value = target.scrollTop;
};

const syncScrollPosition = () => {
  const scrollContainer = scrollContainerRef.value;
  if (scrollContainer) {
    scrollY.value = scrollContainer.scrollTop;
  }
};

const bindScroll = () => {
  const scrollContainer = scrollContainerRef.value;
  if (scrollContainer) {
    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    scrollY.value = scrollContainer.scrollTop;
  }
};

const unbindScroll = () => {
  const scrollContainer = scrollContainerRef.value;
  if (scrollContainer) {
    scrollContainer.removeEventListener('scroll', handleScroll);
  }
};

// 响应注入的滚动容器变化
watch(scrollContainerRef, (newEl, oldEl) => {
  if (oldEl) {
    oldEl.removeEventListener('scroll', handleScroll);
  }
  if (newEl) {
    newEl.addEventListener('scroll', handleScroll, { passive: true });
    scrollY.value = newEl.scrollTop;
  }
});

onMounted(() => {
  bindScroll();
});

// KeepAlive 激活时重新同步滚动位置
onActivated(() => {
  syncScrollPosition();
});

onUnmounted(() => {
  unbindScroll();
});
</script>

<template>
  <!-- 吸顶容器：始终保持 bg-bg-main 确保不透明 -->
  <div
    class="sliver-header-root sticky top-0 z-100 w-full bg-bg-main"
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
        paddingTop: `${contentPaddingTop}px`,
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
      <div
        class="flex-1 flex flex-col min-w-0 relative z-10 pointer-events-auto"
        :style="{ height: `${rightColumnHeight}px` }"
      >
        <!-- 标题行 -->
        <div class="flex items-center justify-between gap-3 shrink-0">
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

        <!-- 详情插槽：flex-1 占据中间剩余空间，上下 padding 让内容居中 -->
        <div
          class="flex flex-col flex-1 min-h-0 justify-center transition-all duration-75"
          :style="{
            opacity: detailsOpacity,
            transform: `translateY(${detailsTranslateY}px)`,
            pointerEvents: progress > 0.4 ? 'none' : 'auto',
            paddingTop: `${props.detailsMarginTop}px`,
            paddingBottom: `${props.detailsMarginTop}px`,
          }"
        >
          <slot name="details" />
        </div>

        <!-- 操作按钮行：贴底 -->
        <div
          class="shrink-0 transition-all duration-75"
          :style="{
            opacity: detailsOpacity,
            transform: `translateY(${detailsTranslateY}px)`,
            pointerEvents: progress > 0.4 ? 'none' : 'auto',
          }"
        >
          <slot name="actions" />
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
