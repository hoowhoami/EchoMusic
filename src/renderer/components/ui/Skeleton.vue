<script setup lang="ts">
import { computed, type CSSProperties } from 'vue';

interface Props {
  variant?: 'rect' | 'circle' | 'text';
  width?: string | number;
  height?: string | number;
  radius?: string | number;
  animated?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'rect',
  width: '100%',
  height: undefined,
  radius: undefined,
  animated: true,
});

const cssSize = (value: string | number | undefined) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return `${value}px`;
  if (/^\d+(\.\d+)?$/.test(value)) return `${value}px`;
  return value;
};

const skeletonStyle = computed<CSSProperties>(() => {
  const style: CSSProperties = {
    width: cssSize(props.width),
    height:
      cssSize(props.height) ??
      (props.variant === 'text' || props.variant === 'rect' ? '1em' : undefined),
  };
  const radius = props.radius;
  if (props.variant === 'circle') {
    style.borderRadius = '999px';
  } else if (radius !== undefined) {
    style.borderRadius = cssSize(radius);
  }
  return style;
});
</script>

<template>
  <span
    aria-hidden="true"
    :class="[
      'skeleton',
      `skeleton--${variant}`,
      animated ? 'skeleton--animated' : 'skeleton--still',
    ]"
    :style="skeletonStyle"
  />
</template>

<style scoped>
.skeleton {
  position: relative;
  display: block;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: 8px;
  background: var(--control-muted-bg);
  color: transparent;
  pointer-events: none;
  contain: paint;
}

.skeleton--text {
  border-radius: 999px;
}

.skeleton--circle {
  aspect-ratio: 1;
}

.skeleton--animated::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 200%;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--control-hover-bg) 72%, var(--color-bg-card) 28%),
    transparent
  );
  transform: translateX(-100%);
  animation: skeleton-shimmer 1.35s ease-in-out infinite;
}

.skeleton--still::before {
  display: none;
}

@keyframes skeleton-shimmer {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .skeleton--animated::before {
    animation: none;
    display: none;
  }
}
</style>
