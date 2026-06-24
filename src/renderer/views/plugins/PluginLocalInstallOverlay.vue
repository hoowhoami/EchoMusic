<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { iconArrowBarDown, iconRefreshCw } from '@/icons';

defineProps<{
  dragging: boolean;
  installing: boolean;
  title: string;
  description: string;
}>();
</script>

<template>
  <div
    v-if="dragging || installing"
    class="plugin-local-install-overlay"
    :class="{ 'is-installing': installing }"
  >
    <div class="plugin-local-install-panel">
      <div class="plugin-local-install-icon">
        <Icon
          :icon="installing ? iconRefreshCw : iconArrowBarDown"
          width="28"
          height="28"
          :class="{ 'animate-spin': installing }"
        />
      </div>
      <strong>{{ title }}</strong>
      <span>{{ description }}</span>
    </div>
  </div>
</template>
