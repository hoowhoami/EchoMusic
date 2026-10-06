<script setup lang="ts">
import Tooltip from '@/components/ui/Tooltip.vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Sortable from 'sortablejs';
import Button from '@/components/ui/Button.vue';
import Cover from '@/components/ui/Cover.vue';
import Popover from '@/components/ui/Popover.vue';
import { iconEye, iconEyeOff, iconSlidersHorizontal } from '@/icons';
import PluginIcon from '@/plugins/PluginIcon.vue';
import type { PluginIcon as PluginIconValue } from '@/plugins/registry';
import { useSettingStore } from '@/stores/setting';
import {
  resetSidebarMenus,
  reorderSidebarItems,
  reorderSidebarSections,
  setSidebarItemHidden,
  setSidebarSectionHidden,
  type ResolvedSidebarLayoutSection,
  type SidebarLayoutItem,
} from './sidebarLayout';

interface SidebarEditorItem extends SidebarLayoutItem {
  layoutIcon?: PluginIconValue;
  layoutCover?: string;
}

const props = defineProps<{
  sections: ResolvedSidebarLayoutSection<SidebarEditorItem>[];
  collapsed?: boolean;
}>();

const settings = useSettingStore();
const open = ref(false);
const sectionListRef = ref<HTMLElement | null>(null);
let sortables: Sortable[] = [];

const popoverAlign = computed(() => (props.collapsed ? 'end' : 'start'));

const destroySortables = () => {
  sortables.forEach((sortable) => sortable.destroy());
  sortables = [];
};

const readSectionIds = () => {
  const list = sectionListRef.value;
  if (!list) return [];
  return Array.from(
    list.querySelectorAll<HTMLElement>(
      ':scope > [data-sidebar-section-id]:not([data-sidebar-order-locked="true"])',
    ),
  )
    .map((element) => element.dataset.sidebarSectionId)
    .filter((id): id is string => Boolean(id));
};

const saveSectionOrder = () => {
  settings.sidebarLayout = reorderSidebarSections(
    settings.sidebarLayout,
    props.sections,
    readSectionIds(),
  );
};

const readItemKeys = (sectionId: string) => {
  const list = sectionListRef.value?.querySelector<HTMLElement>(
    `[data-sidebar-item-list="${CSS.escape(sectionId)}"]`,
  );
  if (!list) return [];
  return Array.from(list.querySelectorAll<HTMLElement>('[data-sidebar-item-key]'))
    .map((element) => element.dataset.sidebarItemKey)
    .filter((key): key is string => Boolean(key));
};

const sectionVisualItem = (section: ResolvedSidebarLayoutSection<SidebarEditorItem>) =>
  section.items.find((item) => item.layoutCover || item.layoutIcon) ?? section.items[0];

const saveItemOrder = (section: ResolvedSidebarLayoutSection<SidebarEditorItem>) => {
  settings.sidebarLayout = reorderSidebarItems(
    settings.sidebarLayout,
    section.id,
    section.items,
    readItemKeys(section.id),
  );
};

const setupSortables = async () => {
  destroySortables();
  if (!open.value) return;
  await nextTick();
  const list = sectionListRef.value;
  if (!list) return;
  sortables.push(
    new Sortable(list, {
      draggable: '[data-sidebar-section-id]:not([data-sidebar-order-locked="true"])',
      dataIdAttr: 'data-sidebar-section-id',
      handle: '.sidebar-layout-section-handle',
      animation: 150,
      forceFallback: true,
      fallbackTolerance: 5,
      ghostClass: 'sidebar-layout-sort-ghost',
      chosenClass: 'sidebar-layout-sort-chosen',
      onMove: (event) => event.related.dataset.sidebarOrderLocked !== 'true',
      onEnd: () => {
        saveSectionOrder();
      },
    }),
  );

  for (const section of props.sections) {
    if (section.items.every((item) => item.lockedOrder)) continue;
    const itemList = list.querySelector<HTMLElement>(
      `[data-sidebar-item-list="${CSS.escape(section.id)}"]`,
    );
    if (!itemList) continue;
    sortables.push(
      new Sortable(itemList, {
        draggable: '[data-sidebar-item-key]:not([data-sidebar-order-locked="true"])',
        dataIdAttr: 'data-sidebar-item-key',
        handle: '.sidebar-layout-item-handle',
        animation: 150,
        forceFallback: true,
        fallbackTolerance: 5,
        ghostClass: 'sidebar-layout-sort-ghost',
        chosenClass: 'sidebar-layout-sort-chosen',
        onEnd: () => {
          saveItemOrder(section);
        },
      }),
    );
  }
};

const updateOpen = (value: boolean) => {
  open.value = value;
  if (!value) destroySortables();
};

const toggleSection = (section: ResolvedSidebarLayoutSection<SidebarEditorItem>) => {
  settings.sidebarLayout = setSidebarSectionHidden(
    settings.sidebarLayout,
    section.id,
    !section.isHidden,
  );
};

const toggleItem = (item: { key: string; isHidden: boolean }) => {
  settings.sidebarLayout = setSidebarItemHidden(settings.sidebarLayout, item.key, !item.isHidden);
};

watch(
  () =>
    props.sections
      .map(
        (section) =>
          `${section.id}:${section.isHidden}:${section.isRailVisible}:${section.items
            .map((item) => `${item.key}:${item.isHidden}`)
            .join(',')}`,
      )
      .join('|'),
  () => {
    if (open.value) void setupSortables();
  },
  { flush: 'post' },
);

watch(open, (value) => {
  if (value) void setupSortables();
});

onBeforeUnmount(destroySortables);
</script>

<template>
  <Popover
    trigger="click"
    side="right"
    :align="popoverAlign"
    :side-offset="8"
    :show-arrow="false"
    content-class="sidebar-layout-popover"
    :open="open"
    @update:open="updateOpen"
  >
    <template #trigger>
      <Button
        class="action-icon sidebar-app-tool sidebar-layout-entry"
        variant="unstyled"
        size="none"
        type="button"
        aria-label="编辑侧边栏"
        tooltip="编辑侧边栏"
        tooltip-side="top"
      >
        <Icon :icon="iconSlidersHorizontal" width="18" height="18" />
      </Button>
    </template>

    <div class="sidebar-layout-editor" aria-label="编辑侧边栏布局">
      <div class="sidebar-layout-heading">
        <div class="sidebar-layout-title">
          <span>菜单与歌单</span>
        </div>
        <Tooltip content="恢复菜单与歌单默认布局">
          <template #trigger>
            <button
              type="button"
              class="sidebar-layout-reset soft-secondary-action app-focus-ring-soft"
              aria-label="恢复默认"
              @click="settings.sidebarLayout = resetSidebarMenus(settings.sidebarLayout)"
            >
              恢复默认
            </button>
          </template>
        </Tooltip>
      </div>

      <div ref="sectionListRef" class="sidebar-layout-section-list">
        <section
          v-for="section in sections"
          :key="section.id"
          class="sidebar-layout-section"
          :class="{ 'is-hidden': section.isHidden }"
          :data-sidebar-section-id="section.id"
          :data-sidebar-order-locked="section.lockedOrder ? 'true' : undefined"
        >
          <div class="sidebar-layout-section-row">
            <Tooltip :content="section.lockedOrder ? '位置固定' : '拖动排序'">
              <template #trigger>
                <span
                  class="sidebar-layout-section-handle"
                  :class="{ 'is-fixed': section.lockedOrder }"
                >
                  <Cover
                    v-if="sectionVisualItem(section)?.layoutCover"
                    :url="sectionVisualItem(section)?.layoutCover"
                    :size="64"
                    :width="22"
                    :height="22"
                  />
                  <PluginIcon
                    v-else-if="sectionVisualItem(section)?.layoutIcon"
                    :icon="sectionVisualItem(section)?.layoutIcon"
                    :width="16"
                    :height="16"
                  />
                </span>
              </template>
            </Tooltip>
            <div class="sidebar-layout-section-copy">
              <span>{{ section.title }}</span>
              <small v-if="section.lockedOrder">位于自建歌单顶部</small>
              <small v-else>
                {{ section.items.filter((item) => !item.isHidden).length }} /
                {{ section.items.length }} 项
              </small>
            </div>
            <Tooltip :content="section.isHidden ? '显示分组' : '隐藏分组'">
              <template #trigger>
                <button
                  type="button"
                  class="action-icon sidebar-layout-icon-button app-focus-ring-soft"
                  :aria-pressed="!section.isHidden"
                  :aria-label="section.isHidden ? '显示分组' : '隐藏分组'"
                  @click="toggleSection(section)"
                >
                  <Icon :icon="section.isHidden ? iconEyeOff : iconEye" width="15" height="15" />
                </button>
              </template>
            </Tooltip>
          </div>

          <div class="sidebar-layout-item-list" :data-sidebar-item-list="section.id">
            <div
              v-for="item in section.items"
              :key="item.key"
              class="sidebar-layout-item-row"
              :class="{ 'is-hidden': item.isHidden }"
              :data-sidebar-item-key="item.key"
              :data-sidebar-order-locked="item.lockedOrder ? 'true' : undefined"
            >
              <Tooltip :content="item.lockedOrder ? '位置固定' : '拖动排序'">
                <template #trigger>
                  <span
                    class="sidebar-layout-item-handle"
                    :class="{ 'is-fixed': item.lockedOrder }"
                  >
                    <Cover
                      v-if="item.layoutCover"
                      :url="item.layoutCover"
                      :size="64"
                      :width="22"
                      :height="22"
                    />
                    <PluginIcon
                      v-else-if="item.layoutIcon"
                      :icon="item.layoutIcon"
                      :width="16"
                      :height="16"
                    />
                  </span>
                </template>
              </Tooltip>
              <span class="sidebar-layout-item-title">{{ item.title }}</span>
              <Tooltip :content="item.isHidden ? '显示入口' : '隐藏入口'">
                <template #trigger>
                  <button
                    type="button"
                    class="action-icon sidebar-layout-icon-button is-small app-focus-ring-soft"
                    :aria-pressed="!item.isHidden"
                    :aria-label="item.isHidden ? '显示入口' : '隐藏入口'"
                    @click="toggleItem(item)"
                  >
                    <Icon :icon="item.isHidden ? iconEyeOff : iconEye" width="14" height="14" />
                  </button>
                </template>
              </Tooltip>
            </div>
          </div>
        </section>
      </div>
    </div>
  </Popover>
</template>

<style scoped>
.sidebar-layout-entry {
  display: flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-control);
  color: var(--icon-main);
  background: transparent;
  transition:
    color 0.18s ease,
    background-color 0.18s ease,
    transform 0.18s ease;
}

.sidebar-layout-entry:hover {
  color: var(--color-text-main);
  background: var(--control-hover-bg);
}
</style>

<style>
.sidebar-layout-popover {
  width: 368px;
  max-width: min(368px, calc(100vw - 24px));
  max-height: min(620px, calc(100vh - 24px));
  overflow: hidden;
  border-radius: var(--radius-popover);
  padding: 0;
  background: var(--floating-surface-bg);
  -webkit-backdrop-filter: var(--floating-surface-filter);
  backdrop-filter: var(--floating-surface-filter);
  color: var(--color-text-main);
  border: 1px solid color-mix(in srgb, var(--color-text-main) 12%, transparent);
  box-shadow:
    var(--shadow-elevated),
    0 0 0 1px color-mix(in srgb, var(--color-text-main) 3%, transparent);
}

.sidebar-layout-editor {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: min(620px, calc(100vh - 24px));
  padding: 12px 10px 10px;
  -webkit-user-select: none;
  user-select: none;
}

.sidebar-layout-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-shrink: 0;
}

.sidebar-layout-heading {
  padding: 4px 6px 12px;
}

.sidebar-layout-title {
  display: flex;
  min-width: 0;
}

.sidebar-layout-title span {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.2;
}

.sidebar-layout-section-copy small {
  font-size: 11px;
  color: var(--color-text-secondary);
}

.sidebar-layout-icon-button {
  border: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--color-text-secondary);
  background: transparent;
  cursor: pointer;
  transition:
    color 0.16s ease,
    background-color 0.16s ease,
    opacity 0.16s ease;
}

.sidebar-layout-reset {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius-control);
  font-size: 12px;
  font-weight: 650;
}

.sidebar-layout-icon-button {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-control);
}

.sidebar-layout-icon-button.is-small {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-control);
}

.sidebar-layout-icon-button:hover,
.sidebar-layout-icon-button.active {
  color: var(--color-text-main);
  background: color-mix(in srgb, var(--color-text-main) 8%, transparent);
}

.sidebar-layout-section-list {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 1px 2px 1px 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
  scrollbar-width: thin;
}

.sidebar-layout-section {
  border-radius: var(--radius-card);
  background: color-mix(in srgb, var(--color-bg-main) 64%, transparent);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--color-text-main) 7%, transparent),
    0 1px 0 color-mix(in srgb, var(--color-text-main) 4%, transparent);
  padding: 8px;
  transition:
    background-color 0.16s ease,
    box-shadow 0.16s ease;
}

.sidebar-layout-section.is-hidden {
  background: color-mix(in srgb, var(--color-bg-main) 38%, transparent);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--color-text-main) 10%, transparent),
    inset 3px 0 0 color-mix(in srgb, var(--color-text-main) 20%, transparent);
}

.sidebar-layout-item-row.is-hidden {
  color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-text-main) 3%, transparent);
}

.sidebar-layout-section-row,
.sidebar-layout-item-row {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.sidebar-layout-section-row {
  min-height: 34px;
  padding-right: 0;
}

.sidebar-layout-section-handle,
.sidebar-layout-item-handle {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: grab;
  color: var(--icon-main);
  border-radius: var(--radius-item);
  background: color-mix(in srgb, var(--color-text-main) 5%, transparent);
}

.sidebar-layout-section-handle:active,
.sidebar-layout-item-handle:active {
  cursor: grabbing;
}

.sidebar-layout-section-handle.is-fixed,
.sidebar-layout-item-handle.is-fixed {
  cursor: default;
}

.sidebar-layout-section-copy {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.sidebar-layout-section-copy span,
.sidebar-layout-item-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-layout-section-copy span {
  font-size: 13px;
  font-weight: 650;
}

.sidebar-layout-item-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 6px;
  padding-left: 33px;
  position: relative;
}

.sidebar-layout-item-list::before {
  content: '';
  position: absolute;
  left: 13px;
  top: 4px;
  bottom: 4px;
  width: 1px;
  border-radius: var(--radius-micro);
  background: color-mix(in srgb, var(--color-text-main) 8%, transparent);
}

.sidebar-layout-item-row {
  min-height: 32px;
  border-radius: var(--radius-item);
  padding: 2px 0 2px 3px;
  color: var(--color-text-main);
}

.sidebar-layout-item-row:hover {
  background: color-mix(in srgb, var(--color-text-main) 5%, transparent);
}

.sidebar-layout-item-title {
  flex: 1;
  font-size: 12.5px;
}

.sidebar-layout-sort-ghost {
  opacity: 0.36;
}

.sidebar-layout-sort-chosen {
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}
</style>
