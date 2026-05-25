<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { getCoverUrl } from '@/utils/cover';
import { iconMusic } from '@/icons';

interface Props {
  url?: string;
  size?: number;
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  showShadow?: boolean;
  alt?: string;
  class?: string;
}

const props = withDefaults(defineProps<Props>(), {
  url: '',
  size: 400,
  borderRadius: 12,
  showShadow: false,
  alt: 'cover',
  class: '',
});

const processedUrl = computed(() => getCoverUrl(props.url, props.size));

const status = ref<'loading' | 'success' | 'error'>('loading');

watch(
  () => props.url,
  (newUrl) => {
    if (newUrl) status.value = 'loading';
    else status.value = 'error';
  },
  { immediate: true },
);

const handleLoad = () => {
  status.value = 'success';
};

const handleError = () => {
  status.value = 'error';
};

// 样式计算
const containerStyle = computed(() => {
  const style: any = {};
  if (props.width) style.width = typeof props.width === 'number' ? `${props.width}px` : props.width;
  if (props.height)
    style.height = typeof props.height === 'number' ? `${props.height}px` : props.height;
  style.borderRadius =
    typeof props.borderRadius === 'number' ? `${props.borderRadius}px` : props.borderRadius;
  return style;
});
</script>

<template>
  <div
    :class="[
      'cover-container relative overflow-hidden bg-black/3 dark:bg-white/3 flex items-center justify-center',
      showShadow ? 'shadow-xl shadow-black/20' : '',
      props.class,
    ]"
    :style="containerStyle"
  >
    <!-- 1. 加载中占位 -->
    <div v-if="status === 'loading'" class="absolute inset-0 flex items-center justify-center">
      <Icon :icon="iconMusic" width="40%" height="40%" class="opacity-10" />
    </div>

    <!-- 2. 图片主体 -->
    <img
      v-if="url || processedUrl"
      :src="processedUrl"
      :alt="alt"
      loading="lazy"
      decoding="async"
      @load="handleLoad"
      @error="handleError"
      :class="[
        'w-full h-full object-cover cover-img',
        status === 'success' ? 'opacity-100' : 'opacity-0',
      ]"
    />

    <!-- 3. 错误占位 -->
    <div
      v-if="status === 'error'"
      class="absolute inset-0 flex items-center justify-center bg-black/2 dark:bg-white/2"
    >
      <Icon :icon="iconMusic" width="40%" height="40%" class="opacity-10" />
    </div>
  </div>
</template>

<style scoped>
.cover-container {
  -webkit-mask-image: -webkit-radial-gradient(white, black);
  backface-visibility: hidden;
}

.cover-img {
  transition: opacity 0.2s ease;
}
</style>
