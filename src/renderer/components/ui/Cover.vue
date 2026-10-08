<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { normalizeCoverUrl, resolveCoverDisplayUrl } from '@/utils/cover';
import { iconMusic } from '@/icons';
import Skeleton from './Skeleton.vue';
import { isCurrentImageEvent } from '@/utils/imageLoadEvent';

interface Props {
  url?: string;
  size?: number;
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  showShadow?: boolean;
  /** Compatibility flag: keep a subtle boundary shadow instead of a painted border. */
  showBorder?: boolean;
  alt?: string;
  class?: string;
}

const props = withDefaults(defineProps<Props>(), {
  url: '',
  size: 400,
  borderRadius: 'var(--radius-media, 6px)',
  showShadow: false,
  showBorder: true,
  alt: 'cover',
  class: '',
});

const primaryUrl = computed(() => normalizeCoverUrl(props.url, props.size));
const failedPrimaryUrl = ref('');
const useFallback = ref(false);
const status = ref<'loading' | 'success' | 'error'>('loading');
const imageRef = ref<HTMLImageElement | null>(null);
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

watch(
  primaryUrl,
  () => {
    failedPrimaryUrl.value = '';
    useFallback.value = false;
  },
  { flush: 'sync' },
);

watch(
  processedUrl,
  (newUrl) => {
    status.value = newUrl ? 'loading' : 'error';
  },
  { immediate: true },
);

const handleLoad = (event: Event) => {
  if (!isCurrentImageEvent(event, imageRef.value, processedUrl.value)) return;
  status.value = 'success';
};

const handleError = (event: Event) => {
  if (!isCurrentImageEvent(event, imageRef.value, processedUrl.value)) return;
  if (primaryUrl.value && !useFallback.value) {
    failedPrimaryUrl.value = primaryUrl.value;
    useFallback.value = true;
    // The default cover (or a plugin fallback) may be the failed primary itself.
    status.value =
      processedUrl.value && processedUrl.value !== failedPrimaryUrl.value ? 'loading' : 'error';
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
      showBorder && !showShadow ? 'cover-boundary' : '',
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
      <div class="absolute inset-0">
        <Skeleton width="100%" height="100%" :radius="0" />
      </div>
      <Icon :icon="iconMusic" width="40%" height="40%" class="opacity-10" />
    </div>

    <!-- 2. 图片主体 -->
    <img
      v-if="processedUrl"
      :key="processedUrl"
      ref="imageRef"
      :src="processedUrl"
      :alt="alt"
      loading="lazy"
      decoding="async"
      draggable="false"
      @load="handleLoad"
      @error="handleError"
      :class="[
        'w-full h-full object-cover cover-img motion-image-feedback',
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
  backface-visibility: hidden;
}

/* A soft outer shadow keeps artwork separate from its surface without painting
 * over the image or changing its dimensions. Explicit shadows remain unchanged. */
.cover-boundary {
  box-shadow: var(--shadow-cover);
}
</style>
