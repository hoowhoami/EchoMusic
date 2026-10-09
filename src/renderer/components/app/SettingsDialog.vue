<script setup lang="ts">
import Dialog from '@/components/ui/Dialog.vue';
import Settings from '@/views/Settings.vue';
import { settingsDialogOpen, settingsDialogSection } from '@/composables/useSettingsDialog';
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
}
.global-settings-body {
  height: 100%;
  min-height: 0;
}
@media (max-width: 640px) {
  .dialog-content.global-settings-dialog {
    width: calc(100vw - 16px);
    height: calc(100dvh - 32px);
  }
}
</style>
