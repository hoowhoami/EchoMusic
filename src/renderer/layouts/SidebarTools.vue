<script setup lang="ts">
import { vTooltip } from '@/components/ui/tooltip';
import { Icon } from '@iconify/vue';
import circleChevronLeft from '@iconify/icons-tabler/circle-chevron-left';
import circleChevronRight from '@iconify/icons-tabler/circle-chevron-right';
import { iconSettings, iconShirt } from '@/icons';
import { useRouter } from 'vue-router';
const toggle = () => window.dispatchEvent(new Event('echo:toggle-sidebar'));
const props = defineProps<{ collapsed?: boolean }>();
const router = useRouter();
</script>
<template>
  <div class="sidebar-app-tools" :class="{ 'is-rail': props.collapsed }">
    <button
      v-tooltip="collapsed ? '展开侧栏' : '折叠侧栏'"
      class="action-icon sidebar-app-tool echo-button-sized echo-button-icon"
      type="button"
      :aria-label="collapsed ? '展开侧栏' : '折叠侧栏'"
      @click="toggle"
    >
      <Icon :icon="collapsed ? circleChevronRight : circleChevronLeft" :width="21" />
    </button>
    <template v-if="!collapsed">
      <slot />
      <button
        v-tooltip="'设置'"
        class="action-icon sidebar-app-tool echo-button-sized echo-button-icon"
        type="button"
        aria-label="设置"
        @click="router.push('/main/settings')"
      >
        <Icon :icon="iconSettings" :width="21" />
      </button>
      <button
        v-tooltip="'主题中心'"
        class="action-icon sidebar-app-tool echo-button-sized echo-button-icon"
        type="button"
        aria-label="主题中心"
        @click="router.push('/main/themes')"
      >
        <Icon :icon="iconShirt" :width="21" />
      </button>
    </template>
  </div>
</template>
<style scoped>
.sidebar-app-tools {
  display: flex;
  justify-content: space-evenly;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  color: var(--icon-main);
}
.sidebar-app-tools :deep(.sidebar-app-tool) {
  display: grid;
  place-items: center;
  border-radius: var(--radius-control);
  cursor: pointer;
}
.sidebar-app-tools :deep(.sidebar-app-tool:hover) {
  background: var(--control-hover-bg);
  color: var(--text-main);
}
.sidebar-app-tools.is-rail {
  flex-direction: column;
  padding: 8px;
}
</style>
