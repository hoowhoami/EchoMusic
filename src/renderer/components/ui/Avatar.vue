<script setup lang="ts">
import { computed, ref, watch, type CSSProperties } from 'vue';
import { AvatarRoot, AvatarImage, AvatarFallback, type AvatarImageEmits } from 'reka-ui';
import { iconUser } from '@/icons';
import Skeleton from './Skeleton.vue';

interface Props {
  src?: string;
  alt?: string;
  class?: string;
  skeletonClass?: string;
  errorClass?: string;
  showSkeleton?: boolean;
  delayMs?: number;
  size?: number | string;
}

const props = withDefaults(defineProps<Props>(), {
  src: '',
  alt: '',
  class: 'w-full h-full object-cover',
  skeletonClass: '',
  errorClass: '',
  showSkeleton: true,
  delayMs: 0,
});

// Each src keys a fresh Reka loading context, including when the address is cleared.
const loadingStatus = ref<AvatarImageEmits['loadingStatusChange'][0]>('idle');
const isLoading = computed(
  () => Boolean(props.src) && (loadingStatus.value === 'idle' || loadingStatus.value === 'loading'),
);

watch(
  () => props.src,
  (src) => {
    loadingStatus.value = src ? 'loading' : 'error';
  },
  { immediate: true, flush: 'sync' },
);

const sizeStyle = computed<CSSProperties | undefined>(() => {
  if (props.size === undefined || props.size === null || props.size === '') {
    return undefined;
  }

  const sizeValue =
    typeof props.size === 'number' || /^\d+(\.\d+)?$/.test(props.size)
      ? `${props.size}px`
      : props.size;

  return {
    width: sizeValue,
    height: sizeValue,
  };
});
</script>

<template>
  <AvatarRoot
    :key="src"
    :class="['relative flex overflow-hidden shrink-0', props.class]"
    :style="sizeStyle"
  >
    <!-- 1. 图片主体 -->
    <AvatarImage
      v-if="src"
      :src="src"
      :alt="alt"
      @loading-status-change="loadingStatus = $event"
      class="h-full w-full object-cover motion-image-feedback"
    />

    <!-- 2. 加载中 & 失败占位 -->
    <AvatarFallback
      :delay-ms="delayMs > 0 ? delayMs : undefined"
      class="flex h-full w-full items-center justify-center bg-[var(--control-muted-bg)]"
    >
      <!-- 加载中骨架屏 -->
      <div v-if="showSkeleton && isLoading" class="absolute inset-0 z-10" :class="skeletonClass">
        <Skeleton width="100%" height="100%" :radius="0" />
      </div>

      <!-- 失败图标 (用户头像占位) -->
      <Icon
        :icon="iconUser"
        width="60%"
        height="60%"
        class="opacity-10 text-text-main z-20"
        :class="errorClass"
      />
    </AvatarFallback>
  </AvatarRoot>
</template>
