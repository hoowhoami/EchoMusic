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
        class="action-icon titlebar-icon-action close-btn no-drag"
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
  width: 34px;
  height: 34px;
  border-radius: var(--radius-control);
}
</style>
