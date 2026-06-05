<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@iconify/vue';
import { iconPlugin } from '@/icons';
import type { PluginIcon } from './registry';

const props = withDefaults(
  defineProps<{
    icon?: PluginIcon;
    width?: number | string;
    height?: number | string;
  }>(),
  {
    width: 18,
    height: 18,
  },
);

const resolvedIcon = computed<any>(() => props.icon || iconPlugin);
</script>

<template>
  <Icon :icon="resolvedIcon" :width="width" :height="height" />
</template>
