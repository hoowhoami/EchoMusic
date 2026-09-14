<script setup lang="ts">
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import { iconMusic, iconRefreshCw } from '@/icons';

defineProps<{ resourceName: string; compact?: boolean }>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <section
    class="detail-page-error"
    :class="{ 'is-compact': compact }"
    role="status"
    aria-live="polite"
  >
    <div class="detail-page-error-icon" aria-hidden="true">
      <Icon :icon="iconMusic" width="24" height="24" />
    </div>
    <h2>暂时无法加载{{ resourceName }}</h2>
    <p>内容还没能加载出来，请稍后重试。</p>
    <Button
      variant="secondary"
      size="none"
      class="mt-5 inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium"
      @click="$emit('retry')"
    >
      <Icon :icon="iconRefreshCw" width="14" height="14" aria-hidden="true" />
      重新加载
    </Button>
  </section>
</template>

<style scoped>
.detail-page-error {
  display: flex;
  min-height: clamp(280px, 52vh, 440px);
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 24px;
  text-align: center;
}

.detail-page-error-icon {
  display: grid;
  width: 52px;
  height: 52px;
  margin-bottom: 20px;
  place-items: center;
  border: 1px solid var(--border-subtle);
  border-radius: 18px;
  background: var(--control-muted-bg);
  color: var(--color-text-secondary);
}

.detail-page-error h2 {
  color: var(--color-text-main);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
}

.detail-page-error p {
  margin-top: 6px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.75;
}

.detail-page-error.is-compact {
  min-height: 0;
}

.detail-page-error.is-compact .detail-page-error-icon {
  width: 40px;
  height: 40px;
  margin-bottom: 12px;
  border-radius: 14px;
}

.detail-page-error.is-compact h2 {
  font-size: 14px;
}
</style>
