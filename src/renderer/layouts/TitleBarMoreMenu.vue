<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { PopoverRoot, PopoverTrigger, PopoverPortal, PopoverContent } from 'reka-ui';
import { iconDots, iconPinned } from '@/icons';
import Button from '@/components/ui/Button.vue';
import PluginIcon from '@/plugins/PluginIcon.vue';
import {
  emptyTitlebarLayout,
  reorderTitlebarLayout,
  type ResolvedTitlebarAction,
} from '@/plugins/titlebar';
import { useSettingStore } from '@/stores/setting';
import { useTitlebarSort } from './useTitlebarSort';
const props = defineProps<{ items: ResolvedTitlebarAction[] }>();
const settings = useSettingStore();
const open = ref(false);
const handleNativePointerDown = (point?: unknown) => {
  if (!open.value) return;
  if (point !== undefined) {
    if (
      !point ||
      typeof point !== 'object' ||
      !('x' in point) ||
      !('y' in point) ||
      typeof point.x !== 'number' ||
      typeof point.y !== 'number' ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y)
    )
      return;
    // 与搜索弹层一致：只补充原生拖动层点击，普通按钮由 Popover 处理。
    // 不把延迟到达的图钉/触发按钮点击当成外部点击。
    const target = document.elementFromPoint(point.x, point.y);
    if (!target?.closest('.native-titlebar .drag-region')) return;
  }
  open.value = false;
};
onMounted(() => {
  window.electron.ipcRenderer.on('window:native-pointerdown', handleNativePointerDown);
});
onUnmounted(() => {
  window.electron.ipcRenderer.off('window:native-pointerdown', handleNativePointerDown);
});
const listRef = ref<HTMLElement | null>(null);
const visibleItems = computed(() => props.items.filter((item) => item.isVisible));
const saveOrder = (keys: string[]) => {
  settings.titlebarLayout = reorderTitlebarLayout(settings.titlebarLayout, props.items, keys);
};
useTitlebarSort(
  listRef,
  () => visibleItems.value.map((item) => item.key),
  saveOrder,
  '.titlebar-drag-handle',
);
const togglePin = (item: ResolvedTitlebarAction) => {
  settings.titlebarLayout = {
    placements: {
      ...settings.titlebarLayout?.placements,
      [item.key]: item.placement === 'toolbar' ? 'more' : 'toolbar',
    },
    order: settings.titlebarLayout?.order ?? [],
  };
};
const activate = (item: ResolvedTitlebarAction) => {
  if (item.isDisabled) return;
  open.value = false;
  void item.onClick();
};
const reorderByKeyboard = (event: KeyboardEvent, index: number) => {
  if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const target = index + (event.key === 'ArrowUp' ? -1 : 1);
  if (target < 0 || target >= visibleItems.value.length) return;
  const keys = visibleItems.value.map((item) => item.key);
  const [key] = keys.splice(index, 1);
  keys.splice(target, 0, key);
  saveOrder(keys);
};
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        variant="unstyled"
        size="none"
        class="more-trigger"
        tooltip="更多"
        tooltip-side="bottom"
        aria-label="更多"
      >
        <Icon :icon="iconDots" width="20" height="20" />
      </Button>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        as-child
        align="end"
        :side-offset="8"
        position-strategy="fixed"
        :avoid-collisions="true"
        :collision-padding="12"
      >
        <div class="titlebar-more-menu no-drag" aria-label="更多应用">
          <div class="titlebar-more-heading">
            <span>更多应用</span>
            <button
              type="button"
              class="titlebar-reset app-focus-ring-soft"
              @click="settings.titlebarLayout = emptyTitlebarLayout()"
            >
              恢复默认
            </button>
          </div>
          <div ref="listRef">
            <div
              v-for="(item, index) in visibleItems"
              :key="item.key"
              :data-titlebar-key="item.key"
              class="titlebar-more-row"
            >
              <Button
                variant="unstyled"
                size="none"
                class="titlebar-more-item"
                :disabled="item.isDisabled"
                :tooltip="item.tooltip !== item.title ? item.tooltip : undefined"
                tooltip-side="left"
                :aria-label="item.title"
                @click="activate(item)"
                @keydown="reorderByKeyboard($event, index)"
              >
                <span class="titlebar-drag-handle"><PluginIcon :icon="item.icon" /></span>
                <span>{{ item.title }}</span>
              </Button>
              <Button
                variant="unstyled"
                size="none"
                class="titlebar-pin"
                :class="{ pinned: item.placement === 'toolbar' }"
                :aria-pressed="item.placement === 'toolbar'"
                :aria-label="`${item.placement === 'toolbar' ? '取消固定' : '固定'}${item.title}`"
                :tooltip="item.placement === 'toolbar' ? '取消固定，收进更多' : '固定到顶栏'"
                tooltip-side="left"
                @click.stop="togglePin(item)"
              >
                <Icon :icon="iconPinned" width="18" height="18" />
              </Button>
            </div>
          </div>
          <p v-if="!visibleItems.length" class="titlebar-more-empty">暂无可用操作</p>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
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
  -webkit-user-select: none;
  user-select: none;
  z-index: 9999;
  position: relative;
  box-sizing: border-box;
  width: 280px;
  min-width: 200px;
  max-width: min(320px, calc(100vw - 24px), var(--reka-popover-content-available-width, 320px));
  max-height: min(420px, calc(100vh - 24px), var(--reka-popover-content-available-height, 420px));
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
  /* 与歌曲右键菜单一致，隔离 hover 重绘；定位由 Reka 外层容器负责。 */
  contain: paint;
  isolation: isolate;
  transform: translateZ(0);
  backface-visibility: hidden;
}
body.echo-surface-translucent .titlebar-more-menu.titlebar-more-menu {
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  background: var(--surface-elevated-base);
}
.titlebar-more-menu .titlebar-more-item {
  display: flex;
  flex: 1;
  min-width: 0;
  text-align: left;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 9px 10px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--color-text-main);
  outline: none;
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    color 0.12s ease;
}
.titlebar-more-menu .titlebar-more-item svg {
  flex-shrink: 0;
}
.titlebar-more-menu .titlebar-more-item span {
  overflow-wrap: anywhere;
}
.titlebar-more-menu .titlebar-more-item:not(:disabled):hover,
.titlebar-more-menu .titlebar-more-item:focus-visible:not(:disabled) {
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary-text);
}
.titlebar-more-menu .titlebar-more-item:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>

<style>
.titlebar-more-row {
  display: flex;
  align-items: center;
  gap: 2px;
  border-radius: 7px;
}
.titlebar-more-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px 10px;
  font-size: 13px;
  font-weight: 600;
}

.titlebar-pin {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  border-radius: 7px;
  color: var(--color-text-secondary);
}
.titlebar-pin:hover {
  background: var(--control-hover-bg);
}
.titlebar-pin.pinned {
  color: var(--color-primary-text);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}
.titlebar-drag-handle {
  display: flex;
  cursor: grab;
  touch-action: none;
}
.titlebar-drag-handle:active {
  cursor: grabbing;
}
.titlebar-sort-ghost {
  opacity: 0.25;
  background: var(--control-hover-bg);
}
.titlebar-sort-chosen {
  cursor: grabbing;
}
.titlebar-reset {
  flex-shrink: 0;
  padding: 4px 6px;
  margin-right: -6px;
  font-weight: 400;
  border-radius: 7px;
  font-size: 12px;
  text-align: left;
  color: var(--color-text-secondary);
  background: transparent;
  border: 0;
  cursor: pointer;
}
.titlebar-reset:hover {
  color: var(--color-primary-text);
}
.titlebar-more-empty {
  padding: 12px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
</style>
