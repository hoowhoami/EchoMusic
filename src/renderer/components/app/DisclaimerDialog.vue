<script setup lang="ts">
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import { DISCLAIMER_SECTIONS } from '@/constants/legal';

interface Props {
  open?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();
</script>

<template>
  <Dialog
    :open="props.open"
    title="免责声明"
    contentClass="legal-dialog"
    bodyClass="legal-dialog-body"
    :contentStyle="{ width: '620px', maxWidth: '92vw', maxHeight: 'min(560px, calc(100vh - 140px))' }"
    showClose
    @update:open="emit('update:open', $event)"
  >
    <div class="legal-content">
      <div v-for="section in DISCLAIMER_SECTIONS" :key="section.title" class="legal-section">
        <div class="legal-section-title">{{ section.title }}</div>
        <div class="legal-section-content">{{ section.content }}</div>
      </div>
    </div>

    <template #footer>
      <Button class="legal-button" variant="primary" size="sm" @click="emit('update:open', false)">
        我知道了
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

.legal-section {
  @apply flex gap-2 items-start;
}

.legal-content {
  @apply space-y-3;
}

.legal-section-title {
  @apply shrink-0 text-sm font-semibold text-text-main;
}

.legal-section-content {
  @apply text-sm leading-6 text-text-secondary;
}

.legal-button {
  @apply min-w-[96px] rounded-lg text-[13px] font-semibold;
}

:global(.legal-dialog) {
  @apply max-h-[min(560px,calc(100vh-140px))];
}

:global(.legal-dialog-body) {
  @apply pr-4 pb-1;
}

:global(.legal-dialog .dialog-scroll-area) {
  @apply overflow-y-auto min-h-0;
}
</style>
