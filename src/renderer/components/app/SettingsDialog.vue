<script setup lang="ts">
import { defineAsyncComponent } from 'vue';
import Dialog from '@/components/ui/Dialog.vue';
import { settingsDialogOpen, settingsDialogSection } from '@/composables/useSettingsDialog';

const Settings = defineAsyncComponent(() => import('@/views/Settings.vue'));
</script>

<template>
  <Dialog
    v-model:open="settingsDialogOpen"
    no-scroll
    flush-body
    content-class="global-settings-dialog"
    body-class="global-settings-body"
  >
    <Settings
      v-if="settingsDialogOpen"
      embedded
      :initial-section="settingsDialogSection"
      @close="settingsDialogOpen = false"
    />
  </Dialog>
</template>

<style>
.dialog-content.global-settings-dialog {
  width: min(820px, calc(100vw - 48px));
  max-width: none;
  height: min(620px, calc(100dvh - 96px));
  max-height: calc(100dvh - 48px);
  padding: 0;
  overflow: hidden;
  border-radius: 20px;
}
.global-settings-body {
  height: 100%;
  min-height: 0;
}
@media (max-width: 640px) {
  .dialog-content.global-settings-dialog {
    width: calc(100vw - 16px);
    height: calc(100dvh - 32px);
    border-radius: 14px;
  }
}
</style>
