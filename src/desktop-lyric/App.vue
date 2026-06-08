<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import DesktopLyricView from '@/desktopLyric/DesktopLyricView.vue';
import { onPluginRuntimeReloadRequested, refreshPlugins } from '@/plugins/runtime';

let disposePluginRuntimeReload: (() => void) | null = null;

onMounted(() => {
  disposePluginRuntimeReload = onPluginRuntimeReloadRequested(() => {
    void refreshPlugins({ desktopLyric: true, reloadActive: true });
  });
  void refreshPlugins({ desktopLyric: true });
});

onUnmounted(() => {
  disposePluginRuntimeReload?.();
  disposePluginRuntimeReload = null;
});
</script>

<template>
  <DesktopLyricView />
</template>
