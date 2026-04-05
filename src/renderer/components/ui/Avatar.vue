<script setup lang="ts">
import { computed, type CSSProperties } from 'vue';
import { AvatarRoot, AvatarImage, AvatarFallback } from 'reka-ui';
import { iconUser } from '@/icons';

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
  <AvatarRoot :class="['relative flex overflow-hidden shrink-0', props.class]" :style="sizeStyle">
    <!-- 1. 图片主体 -->
    <AvatarImage
      v-if="src"
      :src="src"
      :alt="alt"
      class="h-full w-full object-cover transition-opacity duration-500"
    />

    <!-- 2. 加载中 & 失败占位 -->
    <AvatarFallback
      :delay-ms="delayMs"
      class="flex h-full w-full items-center justify-center bg-black/[0.03] dark:bg-white/[0.03]"
    >
      <!-- 加载中骨架屏 -->
      <div 
        v-if="showSkeleton"
        class="absolute inset-0 bg-black/[0.05] dark:bg-white/[0.05] animate-pulse z-10"
        :class="skeletonClass"
      ></div>
      
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
