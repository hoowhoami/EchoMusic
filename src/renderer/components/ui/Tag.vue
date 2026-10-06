<script setup lang="ts">
import { computed } from 'vue';
import { Primitive, type PrimitiveProps } from 'reka-ui';

interface Props extends PrimitiveProps {
  color?: string;
  tone?: 'neutral' | 'accent' | 'muted';
  variant?: 'soft' | 'outline' | 'solid';
  size?: 'xs' | 'sm';
  class?: string;
}

const props = withDefaults(defineProps<Props>(), {
  as: 'span',
  variant: 'soft',
  size: 'xs',
  tone: 'neutral',
});

const toneStyle = computed(() => (props.color ? { '--badge-tone': props.color } : undefined));
</script>

<template>
  <Primitive
    :as="as"
    :as-child="asChild"
    :class="[
      'ui-badge ui-tag',
      `badge-${tone}`,
      color && 'badge-custom',
      `badge-${variant}`,
      `badge-size-${size}`,
      props.class,
    ]"
    :style="toneStyle"
  >
    <slot />
  </Primitive>
</template>
