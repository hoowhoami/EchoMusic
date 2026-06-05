<script setup lang="ts">
defineOptions({ name: 'plugin-page' });
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { getPluginPage } from './registry';

const route = useRoute();

const pluginId = computed(() => String(route.params.pluginId ?? ''));
const pageId = computed(() => String(route.params.pageId ?? ''));
const page = computed(() => getPluginPage(pluginId.value, pageId.value));
</script>

<template>
  <div class="plugin-page-host h-full min-h-0 overflow-hidden">
    <component v-if="page" :is="page.component" />
    <div v-else class="h-full flex items-center justify-center text-text-secondary text-[13px]">
      插件页面不可用
    </div>
  </div>
</template>
