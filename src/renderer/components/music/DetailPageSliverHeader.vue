<script setup lang="ts">
import PageStickyHeader from '@/components/ui/PageStickyHeader.vue';
import { ref, computed, onMounted, onUnmounted, onActivated, watch } from 'vue';
import { useResizeObserver } from '@vueuse/core';
import Cover from '@/components/ui/Cover.vue';
import Button from '@/components/ui/Button.vue';
import { useScrollContainer } from '@/composables/usePageScroll';

interface Props {
  typeLabel: string;
  title: string;
  coverUrl: string;
  description?: string;
  hasDetails?: boolean;
  distributeDetails?: boolean;
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
  distributeDetails: false,
  description: '',
  expandedHeight: 230,
  collapsedHeight: 56,
  contentPaddingX: 24,
  contentGap: 20,
  coverBaseSize: 150,
  titleFontSize: 24,
  detailsGap: 10,
  detailsMarginTop: 8,
});

const emit = defineEmits<{ (e: 'description-click'): void }>();
const descriptionText = ref<HTMLElement | null>(null);
const descriptionOverflow = ref(false);
const updateDescriptionOverflow = () => {
  const text = descriptionText.value;
  const availableWidth = text?.parentElement?.parentElement?.clientWidth ?? 0;
  if (!text) {
    descriptionOverflow.value = false;
  } else if (availableWidth > 0) {
    // Compare against the full row, independent of the optional button's width.
    // Otherwise showing the button can itself create overflow and keep it visible.
    descriptionOverflow.value = text.scrollWidth > availableWidth;
  }
};
watch([() => props.description, descriptionText], updateDescriptionOverflow, { flush: 'post' });
useResizeObserver(descriptionText, updateDescriptionOverflow);
useResizeObserver(
  () => descriptionText.value?.parentElement?.parentElement,
  updateDescriptionOverflow,
);
// Intro previews belong to this header's flow and collapse with it, rather than
// creating a second scroll gap before the tabs.
const descriptionHeight = 28;
const expandedHeight = computed(
  () => props.expandedHeight + (props.description.trim() ? descriptionHeight : 0),
);
const scrollY = ref(0);
const scrollThreshold = computed(() => expandedHeight.value - props.collapsedHeight);
const currentHeight = computed(() =>
  Math.max(props.collapsedHeight, expandedHeight.value - scrollY.value),
);
const backgroundTranslateY = computed(() =>
  Math.min(scrollY.value, Math.max(0, scrollThreshold.value)),
);

// 计算收缩比例 (0 到 1)
const progress = computed(() => {
  return Math.min(1, Math.max(0, scrollY.value / (scrollThreshold.value || 1)));
});

// 带简介时封面和右侧信息使用同一高度，操作行与封面底部对齐。
const coverSize = computed(
  () => props.coverBaseSize + (props.description.trim() ? descriptionHeight : 0),
);
const targetCoverSize = 32;
const coverScale = computed(() => 1 - progress.value * (1 - targetCoverSize / coverSize.value));
// Keep the visible media radius constant while the artwork shrinks.
const coverRadius = computed(() => `calc(var(--radius-media, 6px) / ${coverScale.value})`);

// 动态占位宽度
const currentCoverWidth = computed(() => {
  return coverSize.value - (coverSize.value - targetCoverSize) * progress.value;
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

const rightColumnHeight = computed(() => coverSize.value * coverScale.value);

defineExpose({ currentHeight });

const scrollContainerRef = useScrollContainer();

const setScrollPosition = (scrollTop: number) => {
  // Past the collapsed range the header is stationary; keep its entire subtree
  // out of Vue's scroll updates, including cover/details slots.
  scrollY.value = Math.min(Math.max(0, scrollTop), Math.max(0, scrollThreshold.value));
};

const handleScroll = (e: Event) => {
  const target = e.target as HTMLElement;
  setScrollPosition(target.scrollTop);
};

const syncScrollPosition = () => {
  const scrollContainer = scrollContainerRef.value;
  if (scrollContainer) {
    setScrollPosition(scrollContainer.scrollTop);
  }
};

const bindScroll = () => {
  const scrollContainer = scrollContainerRef.value;
  if (scrollContainer) {
    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    setScrollPosition(scrollContainer.scrollTop);
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
    setScrollPosition(newEl.scrollTop);
  }
});

watch(scrollThreshold, syncScrollPosition);

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
  <!-- 吸顶容器：背景层由全局 surface 规则控制，支持自定义背景透出 -->
  <PageStickyHeader
    :flow-height="props.collapsedHeight"
    :visual-height="() => currentHeight"
    class="sliver-header-root sticky top-0 z-100 w-full bg-bg-main"
    :style="{ height: `${props.collapsedHeight}px` }"
  >
    <div
      class="sliver-header-shell w-full"
      :style="{ '--sliver-background-height': `${currentHeight}px` }"
    >
      <!-- 展开背景层：不再使用 opacity 变化，仅随滚动上移 -->
      <div
        class="sliver-header-background absolute inset-0 z-0 pointer-events-none bg-bg-main origin-top"
        :style="{
          height: `${expandedHeight}px`,
          transform: `translateY(${-backgroundTranslateY}px)`,
        }"
      ></div>

      <!-- 内容层 -->
      <div
        class="relative z-10 h-full items-start overflow-visible pointer-events-none flex"
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
              borderRadius: coverRadius,
              overflow: 'hidden',
              width: `${coverSize}px`,
              height: `${coverSize}px`,
            }"
          >
            <slot name="cover" :expanded="progress < 0.9" :border-radius="coverRadius">
              <Cover
                :url="coverUrl"
                :size="400"
                :width="coverSize"
                :height="coverSize"
                :border-radius="coverRadius"
              />
            </slot>
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
              class="flex-1 min-w-0 font-bold text-text-main leading-tight truncate origin-left"
              :style="{ fontSize: `${props.titleFontSize}px`, transform: `scale(${titleScale})` }"
            >
              {{ title }}
            </h1>
            <div class="type-badge shrink-0" :style="{ opacity: detailsOpacity }">
              {{ typeLabel }}
            </div>
          </div>

          <!-- 详情页逐行均匀分布元信息，操作行保持在封面底部。 -->
          <div
            class="sliver-header-details flex flex-col flex-1 min-h-0"
            :style="{
              justifyContent: props.distributeDetails ? 'space-evenly' : 'center',
              gap: props.distributeDetails ? '0' : '8px',
              opacity: detailsOpacity,
              transform: `translateY(${detailsTranslateY}px)`,
              pointerEvents: progress > 0.4 ? 'none' : 'auto',
              paddingTop: props.distributeDetails ? '0' : `${props.detailsMarginTop}px`,
              paddingBottom: props.distributeDetails ? '0' : `${props.detailsMarginTop}px`,
            }"
          >
            <slot name="details" />

            <div
              v-if="props.description.trim()"
              class="sliver-header-description flex shrink-0 min-w-0 items-center gap-2"
              :inert="progress > 0.4 || undefined"
              :style="{ width: 'fit-content', maxWidth: '100%' }"
            >
              <p
                ref="descriptionText"
                class="min-w-0 truncate text-[12px] leading-5 text-text-secondary"
              >
                {{ props.description }}
              </p>
              <Button
                v-if="descriptionOverflow"
                variant="unstyled"
                size="none"
                type="button"
                class="shrink-0 text-[11px] font-semibold text-primary-text"
                aria-label="查看完整简介"
                @click="emit('description-click')"
              >
                查看详情
              </Button>
            </div>
          </div>

          <!-- 操作按钮行：贴底 -->
          <div
            class="shrink-0"
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
        class="sliver-collapsed-actions absolute right-5 top-0 h-full flex items-center gap-1 z-30"
        :style="{
          opacity: progress > 0.85 ? (progress - 0.85) * 6.6 : 0,
          transform: `translateX(${(1 - progress) * 20}px)`,
          pointerEvents: progress > 0.9 ? 'auto' : 'none',
        }"
      >
        <slot name="collapsed-actions" />
      </div>
    </div>
  </PageStickyHeader>

  <div
    class="sliver-header-spacer relative w-full"
    :style="{ height: `${expandedHeight - props.collapsedHeight}px` }"
  ></div>
</template>

<style scoped>
@reference "@/style.css";

/* Compact actions must not size themselves from each caller's icon and padding. */
.sliver-collapsed-actions :deep(.action-icon) {
  display: inline-flex;
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  padding: 0;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-control);
}

.sliver-collapsed-actions :deep(.action-icon > svg) {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
}

.type-badge {
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
</style>
