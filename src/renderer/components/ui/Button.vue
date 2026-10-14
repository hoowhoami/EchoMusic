<script setup lang="ts">
import { getCurrentInstance, type HTMLAttributes } from 'vue';
import { Primitive, useForwardExpose, type PrimitiveProps } from 'reka-ui';
import Tooltip from './Tooltip.vue';
import type { ControlSize } from './controlSizes';

defineOptions({ inheritAttrs: false });
const { forwardRef } = useForwardExpose();
// Tooltip's portal makes its root a fragment. Preserve the caller's scoped CSS
// on the actual button instead of relying on Vue's single-root propagation.
const callerScopeId = getCurrentInstance()?.vnode.scopeId;
const callerScopeAttrs = callerScopeId ? { [callerScopeId]: '' } : {};

interface Props extends PrimitiveProps {
  variant?:
    | 'primary'
    | 'soft-primary'
    | 'soft-secondary'
    | 'solid-primary'
    | 'secondary'
    | 'ghost'
    | 'outline'
    | 'danger'
    | 'unstyled';
  /** Shared action sizes; custom controls can own their geometry with none. */
  size?: ControlSize | 'icon' | 'none' | 'xs' | 'sm' | 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
  class?: HTMLAttributes['class'];
  tooltip?: string;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}

const props = withDefaults(defineProps<Props>(), {
  as: 'button',
  variant: 'primary',
  size: 'default',
});

const variants = {
  primary: 'soft-accent-action',
  'solid-primary':
    'bg-primary text-on-primary hover:bg-primary-hover hover:text-[var(--color-on-primary-hover)] active:bg-[var(--color-primary-pressed)] active:text-[var(--color-on-primary-pressed)]',
  'soft-primary': 'soft-accent-action',
  'soft-secondary': 'soft-neutral-action',
  secondary: 'soft-secondary-action',
  ghost: 'bg-transparent text-text-main hover:bg-[var(--control-hover-bg)]',
  outline: 'soft-secondary-action',
  danger: 'soft-danger-action',
  unstyled: '',
};

const standardSize = 'echo-button-sized echo-button-standard';
const sizes = {
  none: '',
  default: standardSize,
  compact: `${standardSize} echo-button-compact`,
  small: `${standardSize} echo-button-small`,
  icon: 'echo-button-sized echo-button-icon',
  large: `${standardSize} echo-button-large`,
  // Plugins also consume this component; xs keeps their compact action role.
  xs: `${standardSize} echo-button-compact`,
  sm: standardSize,
  md: standardSize,
  lg: standardSize,
};
</script>

<template>
  <Tooltip :content="tooltip" :side="tooltipSide" :disabled="!tooltip">
    <template #trigger>
      <Primitive
        :ref="forwardRef"
        :aria-label="tooltip || undefined"
        v-bind="{ ...callerScopeAttrs, ...$attrs }"
        :as="as"
        :as-child="asChild"
        :disabled="disabled || loading"
        :class="[
          props.variant === 'unstyled' || props.size === 'none'
            ? 'app-focus-ring-soft echo-button-motion active:scale-[0.98] disabled:opacity-60 disabled:active:scale-100 disabled:cursor-not-allowed'
            : 'app-focus-ring-soft inline-flex items-center justify-center echo-button-motion active:scale-[0.98] disabled:opacity-60 disabled:active:scale-100 disabled:cursor-not-allowed',
          variants[variant],
          sizes[size],
          variant !== 'unstyled' ? `echo-button-control echo-button-${variant}` : '',
          props.class,
        ]"
      >
        <div
          v-if="loading"
          :class="[
            'shrink-0 w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin',
            size === 'none' ? 'mr-2' : '',
          ]"
        ></div>
        <slot v-if="!loading || size !== 'icon'" />
      </Primitive>
    </template>
  </Tooltip>
</template>

<style>
@layer components {
  .echo-button-motion {
    transition-property:
      background-color, border-color, color, opacity, box-shadow, transform, scale;
    transition-duration: var(--motion-duration-fast);
    transition-timing-function: var(--motion-ease-standard);
  }
}

@media (prefers-reduced-motion: reduce) {
  .echo-button-motion {
    transition: none;
  }
  .echo-button-motion:active {
    scale: 1;
  }
}
</style>
