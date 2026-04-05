<script setup lang="ts">
import { computed } from 'vue';
import { Primitive, type PrimitiveProps } from 'reka-ui';

interface Props extends PrimitiveProps {
  color?: string;
  variant?: 'soft' | 'outline' | 'solid';
  size?: 'xs' | 'sm';
  class?: string;
}

const props = withDefaults(defineProps<Props>(), {
  as: 'span',
  variant: 'soft',
  size: 'xs',
});

const sizes = {
  xs: 'text-[9px] px-1.5 py-[1.5px] rounded-[6px]',
  sm: 'text-[10px] px-2 py-0.5 rounded-md',
};

const parseHex = (value: string) => {
  if (!value.startsWith('#')) return null;
  const hex = value.length === 4
    ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
    : value;
  if (hex.length !== 7) return null;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
};

const toneStyle = computed(() => {
  if (!props.color) return undefined;
  const rgb = parseHex(props.color);
  const rgba = (alpha: number) =>
    rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})` : props.color;

  if (props.variant === 'solid') {
    return {
      color: '#FFFFFF',
      backgroundColor: props.color,
      borderColor: props.color,
    };
  }

  if (props.variant === 'outline') {
    return {
      color: props.color,
      borderColor: rgba(0.4),
    };
  }

  return {
    color: props.color,
    backgroundColor: rgba(0.12),
    borderColor: rgba(0.4),
  };
});
</script>

<template>
  <Primitive
    :as="as"
    :as-child="asChild"
    :class="[
      'inline-flex items-center border font-semibold leading-[1.2] tracking-[0.3px] select-none whitespace-nowrap',
      sizes[size],
      props.class,
    ]"
    :style="toneStyle"
  >
    <slot />
  </Primitive>
</template>
