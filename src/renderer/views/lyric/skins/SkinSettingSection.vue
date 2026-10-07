<script setup lang="ts">
import { useId } from 'vue';

defineProps<{ title: string }>();
const titleId = useId();
</script>

<template>
  <section class="skin-section" :aria-labelledby="titleId">
    <h3 :id="titleId" class="skin-section-title">{{ title }}</h3>
    <div class="skin-section-body"><slot /></div>
    <div v-if="$slots.footer" class="skin-section-footer"><slot name="footer" /></div>
  </section>
</template>

<style scoped>
.skin-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.skin-section-title {
  margin: 0;
  padding: 0 2px;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  color: var(--color-text-secondary);
}

.skin-section-body {
  min-width: 0;
  border-radius: var(--radius-card);
  background: var(--content-panel-bg);
  box-shadow: inset 0 0 0 1px var(--border-strong);
}

.skin-section-body > :deep(:not(:first-child)) {
  border-top: 1px solid var(--border-strong);
}

.skin-section-footer {
  display: flex;
  justify-content: flex-end;
}
</style>
