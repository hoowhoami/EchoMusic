<script setup lang="ts">
import Button from '@/components/ui/Button.vue';
import { useToastStore } from '@/stores/toast';

const toastStore = useToastStore();

const toneClassMap = {
  info: 'toast-card is-info',
  success: 'toast-card is-success',
  warning: 'toast-card is-warning',
  danger: 'toast-card is-danger',
} as const;
</script>

<template>
  <div class="toast-viewport pointer-events-none fixed right-5 top-5 z-[5000] flex w-[min(360px,calc(100vw-24px))] flex-col gap-2">
    <transition-group name="toast-slide">
      <div
        v-for="item in toastStore.items"
        :key="item.id"
        :class="toneClassMap[item.tone]"
        class="pointer-events-auto"
      >
        <div class="toast-message">{{ item.message }}</div>
        <Button variant="unstyled" size="none" class="toast-close" @click="toastStore.remove(item.id)">×</Button>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.toast-card {
  @apply flex items-start gap-3 rounded-2xl border px-4 py-3 shadow-lg backdrop-blur-md;
  background: color-mix(in srgb, var(--color-bg-card) 92%, transparent);
  border-color: color-mix(in srgb, var(--color-border-light) 78%, transparent);
}

.toast-card.is-info {
  color: var(--color-text-main);
}

.toast-card.is-success {
  border-color: color-mix(in srgb, #10b981 32%, transparent);
}

.toast-card.is-warning {
  border-color: color-mix(in srgb, #f59e0b 38%, transparent);
}

.toast-card.is-danger {
  border-color: color-mix(in srgb, #ef4444 36%, transparent);
}

.toast-message {
  @apply min-w-0 flex-1 text-[13px] leading-6;
  color: var(--color-text-main);
  word-break: break-word;
}

.toast-close {
  @apply h-6 w-6 rounded-full text-base leading-none opacity-60 transition;
}

.toast-close:hover {
  @apply opacity-100;
}

.toast-slide-enter-active,
.toast-slide-leave-active {
  transition: all 0.22s ease;
}

.toast-slide-enter-from,
.toast-slide-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}
</style>
