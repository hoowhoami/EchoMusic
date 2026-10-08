<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@iconify/vue';
import { iconVolume1, iconVolume2, iconVolume3 } from '@/icons';
import { usePlayerStore } from '@/stores/player';

withDefaults(defineProps<{ width?: number | string; height?: number | string }>(), {
  width: 22,
  height: 22,
});
const player = usePlayerStore();
const icon = computed(() =>
  player.volume === 0 ? iconVolume3 : player.volume < 50 ? iconVolume1 : iconVolume2,
);
</script>

<template>
  <Icon :icon="icon" :width="width" :height="height" />
</template>
