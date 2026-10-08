<script setup lang="ts">
import PluginIcon from '@/plugins/PluginIcon.vue';
import type { PlayerBarAction } from './playerBarActions';

withDefaults(
  defineProps<{
    item: Pick<PlayerBarAction, 'icon' | 'iconComponent'>;
    width?: number | string;
    height?: number | string;
  }>(),
  { width: 20, height: 20 },
);
</script>

<template>
  <component v-if="item.iconComponent" :is="item.iconComponent" :width="width" :height="height" />
  <PluginIcon v-else :icon="item.icon" :width="width" :height="height" />
</template>
