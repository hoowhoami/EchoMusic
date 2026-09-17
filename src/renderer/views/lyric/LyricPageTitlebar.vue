<script setup lang="ts">
import OverlayHeader from '@/layouts/OverlayHeader.vue';
import Button from '@/components/ui/Button.vue';
import { iconChevronDown } from '@/icons';

defineEmits<{ close: [] }>();
</script>

<template>
  <OverlayHeader show-mini-player-control>
    <template #left>
      <Button
        variant="unstyled"
        size="none"
        type="button"
        class="close-btn no-drag"
        tooltip="返回"
        aria-label="关闭歌词页"
        @click="$emit('close')"
      >
        <Icon :icon="iconChevronDown" width="20" height="20" />
      </Button>
    </template>
  </OverlayHeader>
</template>

<style scoped>
.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: var(--window-action-color, rgba(255, 255, 255, 0.7));
  transition: all 0.2s ease;
}
.close-btn:hover {
  color: var(--window-action-hover-color, #fff);
  background: rgba(255, 255, 255, 0.1);
}
</style>
