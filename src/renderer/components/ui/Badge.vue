<script setup lang="ts">
interface Props {
  count?: number | string;
  tone?: 'neutral' | 'accent' | 'muted';
  placement?: 'inline' | 'floating';
  class?: string;
}

const props = withDefaults(defineProps<Props>(), {
  tone: 'neutral',
  placement: 'inline',
});
</script>

<template>
  <span
    v-if="count !== undefined"
    :class="['badge ui-badge', `badge-${tone}`, `badge-${placement}`, props.class]"
  >
    {{ count }}
  </span>
</template>

<style scoped>
.badge {
  user-select: none;
  pointer-events: none;
}

.badge-floating {
  position: absolute;
  top: 0;
  right: 0;
  transform: translate(35%, -28%);
}
</style>
