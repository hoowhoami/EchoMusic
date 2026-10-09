<script setup lang="ts">
import { computed } from 'vue';
import Avatar from '@/components/ui/Avatar.vue';

const props = withDefaults(
  defineProps<{
    src?: string;
    size?: number;
    identityIcon?: string;
    identityLabel?: string;
    identityInset?: number;
    errorClass?: string;
  }>(),
  { size: 36, identityIcon: '', identityLabel: '达人', identityInset: 1 },
);
const sizeStyle = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  '--identity-inset': `${props.identityInset}px`,
}));
</script>

<template>
  <span class="user-avatar" :style="sizeStyle">
    <Avatar :src="src" class="w-full h-full rounded-full" :error-class="errorClass" />
    <img
      v-if="identityIcon"
      class="user-avatar-identity"
      :src="identityIcon"
      :alt="identityLabel"
      :title="identityLabel"
    />
  </span>
</template>

<style scoped>
.user-avatar {
  position: relative;
  display: inline-flex;
  flex: none;
  overflow: visible;
}
.user-avatar-identity {
  position: absolute;
  right: var(--identity-inset);
  bottom: var(--identity-inset);
  width: 16px;
  height: 16px;
  object-fit: contain;
  pointer-events: none;
  z-index: 1;
  user-select: none;
}
</style>
