<script setup lang="ts">
import { ref, watch } from 'vue';
import { iconImage } from '@/icons';

interface Props {
  src?: string;
  alt?: string;
  class?: string;
  skeletonClass?: string;
  showSkeleton?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  src: '',
  alt: '',
  class: 'w-full h-full object-cover',
  showSkeleton: true,
});

const status = ref<'loading' | 'success' | 'error'>('loading');

watch(
  () => props.src,
  (newSrc) => {
    if (newSrc) status.value = 'loading';
    else status.value = 'error';
  },
  { immediate: true },
);

const handleLoad = () => (status.value = 'success');
const handleError = () => (status.value = 'error');
</script>

<template>
  <div :class="['relative overflow-hidden', props.class]">
    <!-- 1. Skeleton Loading -->
    <div
      v-if="status === 'loading' && showSkeleton"
      :class="[
        'absolute inset-0 bg-black/[0.05] dark:bg-white/[0.05] animate-pulse z-10',
        skeletonClass,
      ]"
    ></div>

    <!-- 2. Image -->
    <img
      v-if="src"
      :src="src"
      :alt="alt"
      @load="handleLoad"
      @error="handleError"
      :class="[
        'w-full h-full object-cover transition-opacity duration-500',
        status === 'success' ? 'opacity-100' : 'opacity-0',
      ]"
    />

    <!-- 3. Error State -->
    <div
      v-if="status === 'error' || (!src && status !== 'loading')"
      class="absolute inset-0 flex items-center justify-center bg-black/[0.02] dark:bg-white/[0.02] z-20"
    >
      <Icon :icon="iconImage" width="24" height="24" class="opacity-10" />
    </div>
  </div>
</template>
