<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { Primitive, type PrimitiveProps } from 'reka-ui';

interface Props extends PrimitiveProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'unstyled';
  size?: 'none' | 'xs' | 'sm' | 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
  class?: HTMLAttributes['class'];
}

const props = withDefaults(defineProps<Props>(), {
  as: 'button',
  variant: 'primary',
  size: 'md',
});

const variants = {
  primary: 'bg-primary text-white shadow-lg shadow-primary/20 hover:opacity-90',
  secondary:
    'bg-black/[0.03] dark:bg-white/[0.03] text-text-main hover:bg-black/[0.05] dark:hover:bg-white/[0.05]',
  ghost: 'bg-transparent text-text-main hover:bg-black/[0.05] dark:hover:bg-white/[0.05]',
  outline:
    'border border-border-light bg-transparent hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
  danger: 'bg-red-500 text-white hover:bg-red-500/90',
  unstyled: '',
};

const sizes = {
  none: '',
  xs: 'h-8 px-3 text-[12px] rounded-lg font-black',
  sm: 'h-10 px-4 text-xs rounded-xl font-black',
  md: 'h-14 px-6 text-[15px] rounded-2xl font-black',
  lg: 'h-16 px-8 text-lg rounded-[24px] font-black',
};
</script>

<template>
  <Primitive
    :as="as"
    :as-child="asChild"
    :disabled="disabled || loading"
    :class="[
      props.variant === 'unstyled' || props.size === 'none'
        ? 'app-focus-ring-soft transition-all active:scale-[0.98] disabled:opacity-60 disabled:active:scale-100 disabled:cursor-not-allowed'
        : 'app-focus-ring-soft inline-flex items-center justify-center transition-all active:scale-[0.98] disabled:opacity-60 disabled:active:scale-100 disabled:cursor-not-allowed',
      variants[variant],
      sizes[size],
      props.class,
    ]"
  >
    <div
      v-if="loading"
      class="mr-2 w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"
    ></div>
    <slot />
  </Primitive>
</template>
