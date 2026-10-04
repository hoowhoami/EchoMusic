<script setup lang="ts">
import { ref, watch } from 'vue';
import { iconImage } from '@/icons';
import { isCurrentImageEvent } from '@/utils/imageLoadEvent';

interface Props {
  src?: string;
  alt?: string;
  class?: string;
  skeletonClass?: string;
  showSkeleton?: boolean;
  loading?: 'eager' | 'lazy';
  decoding?: 'async' | 'sync' | 'auto';
}

const props = withDefaults(defineProps<Props>(), {
  src: '',
  alt: '',
  class: 'w-full h-full object-cover',
  showSkeleton: true,
  loading: 'lazy',
  decoding: 'async',
});

const status = ref<'loading' | 'success' | 'error'>('loading');
const imageRef = ref<HTMLImageElement | null>(null);

watch(
  () => props.src,
  (newSrc) => {
    if (newSrc) status.value = 'loading';
    else status.value = 'error';
  },
  { immediate: true },
);

const handleLoad = (event: Event) => {
  if (isCurrentImageEvent(event, imageRef.value, props.src)) status.value = 'success';
};
const handleError = (event: Event) => {
  if (isCurrentImageEvent(event, imageRef.value, props.src)) status.value = 'error';
};
</script>

<template>
  <div :class="['relative overflow-hidden', props.class]">
    <!-- 1. Skeleton Loading -->
    <div
      v-if="status === 'loading' && showSkeleton"
      :class="[
        'absolute inset-0 bg-[var(--control-hover-bg)] motion-safe:animate-pulse z-10',
        skeletonClass,
      ]"
    ></div>

    <!-- 2. Image -->
    <img
      v-if="src"
      :key="src"
      ref="imageRef"
      :src="src"
      :alt="alt"
      :loading="loading"
      :decoding="decoding"
      @load="handleLoad"
      @error="handleError"
      :class="[
        'w-full h-full object-cover motion-image-feedback',
        status === 'success' ? 'opacity-100' : 'opacity-0',
      ]"
    />

    <!-- 3. Error State -->
    <div
      v-if="status === 'error' || (!src && status !== 'loading')"
      class="absolute inset-0 flex items-center justify-center bg-[var(--control-muted-bg)] z-20"
    >
      <Icon :icon="iconImage" width="24" height="24" class="opacity-10" />
    </div>
  </div>
</template>
