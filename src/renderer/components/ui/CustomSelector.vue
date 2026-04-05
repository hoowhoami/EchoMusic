<script setup lang="ts">
import { iconChevronDown } from '@/icons';
import Button from '@/components/ui/Button.vue';

interface Props {
  label: string;
  class?: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'click'): void;
}>();

const handleClick = () => {
  emit('click');
};
</script>

<template>
  <Button variant="unstyled" size="none" type="button" class="custom-selector" :class="props.class" @click="handleClick">
    <span class="custom-selector-label">{{ label }}</span>
    <Icon :icon="iconChevronDown" width="14" height="14" class="custom-selector-icon" />
  </Button>
</template>

<style scoped>
@reference "@/style.css";

.custom-selector {
  @apply inline-flex items-center gap-2 h-9 px-[14px] rounded-[10px] text-text-main text-[13px] font-semibold transition-all;
  border: 1px solid color-mix(in srgb, var(--color-text-main) 8%, transparent);
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
}

.custom-selector:hover {
  border-color: color-mix(in srgb, var(--color-text-main) 12%, transparent);
  background: color-mix(in srgb, var(--color-text-main) 8%, transparent);
}

.custom-selector-label {
  @apply truncate;
}

.custom-selector-icon {
  @apply text-text-secondary/70;
}
</style>
