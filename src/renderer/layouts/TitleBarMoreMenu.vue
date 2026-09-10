<script setup lang="ts">
import { useRouter } from 'vue-router';
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from 'reka-ui';
import { iconDots, iconHeadphones, iconClipboardList } from '@/icons';
import PluginIcon from '@/plugins/PluginIcon.vue';
import { pluginMoreMenuItems } from '@/plugins/moreMenu';
import { taskPanelOpen } from '@/plugins/taskPanel';
const router = useRouter();
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger class="more-trigger" aria-label="更多" title="更多">
      <Icon :icon="iconDots" width="20" height="20" />
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        class="titlebar-more-menu no-drag"
        align="end"
        :side-offset="8"
        position-strategy="fixed"
        :avoid-collisions="true"
        :collision-padding="12"
      >
        <DropdownMenuItem
          class="titlebar-more-item"
          @select="router.push({ name: 'listen-together' })"
        >
          <Icon :icon="iconHeadphones" width="18" height="18" />一起听
        </DropdownMenuItem>
        <DropdownMenuItem class="titlebar-more-item" @select="taskPanelOpen = true">
          <Icon :icon="iconClipboardList" width="18" height="18" />任务中心
        </DropdownMenuItem>
        <DropdownMenuSeparator v-if="pluginMoreMenuItems.length" class="titlebar-more-separator" />
        <DropdownMenuItem
          v-for="item in pluginMoreMenuItems"
          :key="`${item.pluginId}:${item.id}`"
          class="titlebar-more-item"
          :disabled="typeof item.disabled === 'function' ? item.disabled() : item.disabled"
          @select="item.onClick()"
        >
          <PluginIcon :icon="item.icon" />
          <span>{{ item.title }}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<style scoped>
.more-trigger {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: var(--color-text-secondary);
}
.more-trigger:hover,
.more-trigger[data-state='open'] {
  background: var(--control-hover-bg);
}
</style>

<!-- Portal 内容经过多层组件转发，用专属全局类保证实际弹层获得样式。 -->
<style>
.titlebar-more-menu {
  z-index: 9999;
  position: relative;
  box-sizing: border-box;
  min-width: 200px;
  max-width: min(
    320px,
    calc(100vw - 24px),
    var(--reka-dropdown-menu-content-available-width, 320px)
  );
  max-height: min(
    420px,
    calc(100vh - 24px),
    var(--reka-dropdown-menu-content-available-height, 420px)
  );
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  outline: none;
  -webkit-app-region: no-drag;
  padding: 6px;
  border-radius: 12px;
  background: var(--color-bg-elevated, var(--bg-elevated));
  color: var(--color-text-main);
  border: 1px solid color-mix(in srgb, var(--color-text-main) 12%, transparent);
  box-shadow:
    var(--shadow-elevated),
    0 0 0 1px color-mix(in srgb, var(--color-text-main) 3%, transparent);
}
.titlebar-more-menu .titlebar-more-item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 9px 10px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--color-text-main);
  outline: none;
  cursor: pointer;
}
.titlebar-more-menu .titlebar-more-item svg {
  flex-shrink: 0;
}
.titlebar-more-menu .titlebar-more-item span {
  overflow-wrap: anywhere;
}
.titlebar-more-menu .titlebar-more-item:not([data-disabled]):hover,
.titlebar-more-menu .titlebar-more-item[data-highlighted]:not([data-disabled]) {
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary-text);
}
.titlebar-more-menu .titlebar-more-item[data-disabled] {
  opacity: 0.4;
  cursor: default;
}
.titlebar-more-menu .titlebar-more-separator {
  height: 1px;
  margin: 6px;
  background: var(--border-subtle);
}
</style>
