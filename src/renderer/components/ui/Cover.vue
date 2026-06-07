<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { normalizeCoverUrl, resolveCoverDisplayUrl } from '@/utils/cover';
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

const primaryUrl = computed(() => normalizeCoverUrl(props.url, props.size));
const failedPrimaryUrl = ref('');
const useFallback = ref(false);
const status = ref<'loading' | 'success' | 'error'>('loading');
const fallbackUrl = computed(() =>
  resolveCoverDisplayUrl(props.url, props.size, {
    reason: primaryUrl.value ? 'error' : 'empty',
    scope: 'cover',
    alt: props.alt,
    failedUrl: failedPrimaryUrl.value,
  }),
);
const processedUrl = computed(() => {
  if (primaryUrl.value && !useFallback.value) return primaryUrl.value;
  return fallbackUrl.value;
});

watch(primaryUrl, () => {
  failedPrimaryUrl.value = '';
  useFallback.value = false;
});

watch(
  processedUrl,
  (newUrl) => {
    status.value = newUrl ? 'loading' : 'error';
  },
  { immediate: true },
);

const handleLoad = () => {
  status.value = 'success';
};

const handleError = () => {
  if (primaryUrl.value && !useFallback.value) {
    failedPrimaryUrl.value = primaryUrl.value;
    useFallback.value = true;
    status.value = 'loading';
    return;
  }
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
      'cover-container relative overflow-hidden bg-[var(--control-muted-bg)] flex items-center justify-center',
      showShadow ? 'shadow-xl shadow-black/20' : '',
      props.class,
    ]"
    :style="containerStyle"
  >
    <!-- 1. 加载中占位 -->
    <div
      v-if="status === 'loading'"
      class="absolute inset-0 flex items-center justify-center bg-[var(--control-muted-bg)]"
    >
      <Icon :icon="iconMusic" width="40%" height="40%" class="opacity-10" />
    </div>

    <!-- 2. 图片主体 -->
    <img
      v-if="processedUrl"
      :src="processedUrl"
      :alt="alt"
      loading="lazy"
      decoding="async"
      draggable="false"
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
      class="absolute inset-0 flex items-center justify-center bg-[var(--control-muted-bg)]"
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
