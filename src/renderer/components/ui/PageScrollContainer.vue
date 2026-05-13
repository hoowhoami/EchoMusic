<script setup lang="ts">
import { ref, computed, useAttrs, onActivated, nextTick } from 'vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import BackToTop from '@/components/ui/BackToTop.vue';
import { provideScrollContainer } from '@/composables/usePageScroll';

defineOptions({
  inheritAttrs: false,
});

interface Props {
  hideScrollbar?: boolean;
  hideBackToTop?: boolean;
  backToTopThreshold?: number;
}

withDefaults(defineProps<Props>(), {
  hideScrollbar: false,
  hideBackToTop: false,
  backToTopThreshold: 300,
});

const attrs = useAttrs();
const scrollbarRef = ref<InstanceType<typeof Scrollbar> | null>(null);
const scrollContainerEl = ref<HTMLElement | null>(null);
let savedScrollTop = 0;

// 当 Scrollbar 组件挂载后，获取其内部的滚动 DOM 元素
const onScrollbarMounted = () => {
  scrollContainerEl.value = scrollbarRef.value?.wrapRef ?? null;
};

// 监听 Scrollbar 内部 wrapRef 变化
const contentProps = computed(() => ({
  ref: (el: HTMLElement | null) => {
    scrollContainerEl.value = el;
  },
}));

// 实时追踪滚动位置（DOM 移到离屏容器时 scrollTop 会被重置，所以不能在 onDeactivated 时读取）
const handleScroll = () => {
  if (scrollContainerEl.value) {
    savedScrollTop = scrollContainerEl.value.scrollTop;
  }
};

// 向子组件提供滚动容器引用
provideScrollContainer(scrollContainerEl);

// KeepAlive activated 时恢复滚动位置
onActivated(() => {
  nextTick(() => {
    if (scrollContainerEl.value && savedScrollTop > 0) {
      scrollContainerEl.value.scrollTop = savedScrollTop;
    }
  });
});

const scrollTo = (options: ScrollToOptions) => {
  scrollbarRef.value?.scrollTo(options);
};

const setScrollTop = (value: number) => {
  scrollbarRef.value?.setScrollTop(value);
};

defineExpose({
  scrollContainerEl,
  scrollTo,
  setScrollTop,
});
</script>

<template>
  <div class="page-scroll-container" v-bind="attrs">
    <Scrollbar
      ref="scrollbarRef"
      class="page-scroll-area"
      :hide-scrollbar="hideScrollbar"
      :content-props="contentProps"
      @vue:mounted="onScrollbarMounted"
      @scroll="handleScroll"
    >
      <slot />
    </Scrollbar>
    <BackToTop
      v-if="!hideBackToTop"
      :scroll-container="scrollContainerEl"
      :threshold="backToTopThreshold"
    />
  </div>
</template>

<style scoped>
.page-scroll-container {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.page-scroll-area {
  flex: 1;
  min-height: 0;
  min-width: 0;
}
</style>
