<script setup lang="ts">
import Tooltip from '@/components/ui/Tooltip.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useSlots, watch } from 'vue';
import Sortable from 'sortablejs';
import Button from '@/components/ui/Button.vue';
import Badge from '@/components/ui/Badge.vue';
import { getPlayerBarBadgeTone } from './playerBarActions';
import Popover from '@/components/ui/Popover.vue';
import CastPopover from '@/components/player/CastPopover.vue';
import EffectPopover from '@/components/player/EffectPopover.vue';
import QualityPopover from '@/components/player/QualityPopover.vue';
import SleepTimerPopover from '@/components/player/SleepTimerPopover.vue';
import SpeedPopover from '@/components/player/SpeedPopover.vue';
import VolumePopover from '@/components/player/VolumePopover.vue';
import PlayerBarActionIcon from './PlayerBarActionIcon.vue';
import { iconChevronLeft, iconDots, iconSlidersHorizontal } from '@/icons';
import { useSettingStore } from '@/stores/setting';
import {
  emptyPlayerBarLayout,
  reorderPlayerBarLayout,
  setPlayerBarBadgeVisible,
  setPlayerBarActionPlacement,
  type PlayerBarPlacement,
  type ResolvedPlayerBarAction,
} from './playerBarActions';

interface PlayerBarBadgeControl {
  key: string;
  actionKeys?: string[];
  label: string;
  active: boolean;
  toggle: () => void;
}

const props = withDefaults(
  defineProps<{
    items: ResolvedPlayerBarAction[];
    menuItems: ResolvedPlayerBarAction[];
    badges?: PlayerBarBadgeControl[];
  }>(),
  {
    badges: () => [],
  },
);

const settings = useSettingStore();
const slots = useSlots();
const open = ref(false);
const editMode = ref(false);
const isSorting = ref(false);
const floatingAction = ref<ResolvedPlayerBarAction | null>(null);
const floatingActionStyle = ref<Record<string, string>>({});
const floatingActionRef = ref<HTMLElement | null>(null);
const moreTriggerRef = ref<HTMLElement | null>(null);
const boardRef = ref<HTMLElement | null>(null);
const editMenuRef = ref<HTMLElement | null>(null);
const lockedEditMenuHeight = ref<number | null>(null);
const visibleItems = computed(() => props.items.filter((item) => item.visible));
const visibleMenuItems = computed(() => props.menuItems.filter((item) => item.visible));
const popoverClass = computed(
  () => `playerbar-more-popover ${editMode.value ? 'is-editing' : 'is-using'}`,
);
const editMenuStyle = computed(() =>
  lockedEditMenuHeight.value === null
    ? undefined
    : { height: `${Math.ceil(lockedEditMenuHeight.value)}px` },
);

const closeFloatingPanels = () => {
  floatingAction.value = null;
};

const popoverComponents = new Set(['sleep-timer', 'volume', 'speed', 'quality', 'effect', 'cast']);

const openFloatingAction = (item: ResolvedPlayerBarAction, event: MouseEvent) => {
  const target = event.currentTarget as HTMLElement | null;
  const fallbackRect = target?.getBoundingClientRect();
  const rect = moreTriggerRef.value?.getBoundingClientRect() ?? fallbackRect;
  floatingActionStyle.value = {
    left: `${Math.round(rect?.left ?? window.innerWidth - 48)}px`,
    top: `${Math.round(rect?.top ?? window.innerHeight - 86)}px`,
    width: `${Math.round(rect?.width ?? 36)}px`,
    height: `${Math.round(rect?.height ?? 36)}px`,
  };
  open.value = false;
  editMode.value = false;
  floatingAction.value = item;
};

const activate = (item: ResolvedPlayerBarAction, event: MouseEvent) => {
  if (isSorting.value) return;
  if (item.disabled) return;
  if (item.component && (popoverComponents.has(item.component) || slots['floating-action'])) {
    openFloatingAction(item, event);
    return;
  }
  open.value = false;
  void item.onClick();
};

const updateOpen = (value: boolean) => {
  open.value = value;
  if (value) closeFloatingPanels();
  if (!value) {
    editMode.value = false;
    lockedEditMenuHeight.value = null;
  }
};

const handleDocumentMousedown = (event: MouseEvent) => {
  if (!floatingAction.value) return;
  // Slot panels own dismissal, including temporary closure during verification.
  if (!popoverComponents.has(floatingAction.value.component ?? '')) return;
  const target = event.target as Node;
  if (floatingActionRef.value?.contains(target)) return;
  if (target instanceof Element && target.closest('.echo-popover-content')) return;
  closeFloatingPanels();
};

const layoutZones: { value: PlayerBarPlacement; ariaLabel: string; label: string }[] = [
  { value: 'center', ariaLabel: '播放控制区按钮', label: '播放控制' },
  { value: 'left', ariaLabel: '歌曲信息区按钮', label: '歌曲信息' },
  { value: 'right', ariaLabel: '功能按钮区按钮', label: '功能按钮' },
  { value: 'more', ariaLabel: '更多菜单按钮', label: '更多' },
];
const previewLayoutZones = computed(() => layoutZones.filter((zone) => zone.value !== 'more'));
const moreLayoutZone = computed(() => layoutZones.find((zone) => zone.value === 'more'));

const groupedItems = computed<Record<PlayerBarPlacement, ResolvedPlayerBarAction[]>>(() => ({
  left: visibleItems.value.filter((item) => item.placement === 'left'),
  center: visibleItems.value.filter((item) => item.placement === 'center'),
  right: visibleItems.value.filter((item) => item.placement === 'right'),
  more: visibleItems.value.filter((item) => item.placement === 'more'),
}));

const actionBadgeOptions = computed<PlayerBarBadgeControl[]>(() =>
  visibleItems.value
    .filter((item) => String(item.badge ?? '').trim())
    .map((item) => ({
      key: `action:${item.key}`,
      actionKeys: [item.key],
      label: item.badgeTitle || item.title,
      active: item.isBadgeVisible,
      toggle: () => {
        settings.playerBarLayout = setPlayerBarBadgeVisible(
          settings.playerBarLayout,
          item.key,
          !item.isBadgeVisible,
        );
      },
    })),
);

const badgeOptions = computed(() => {
  const seen = new Set<string>();
  return [...props.badges, ...actionBadgeOptions.value].filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
});

const badgeControlForItem = (item: ResolvedPlayerBarAction) =>
  badgeOptions.value.find((option) => option.actionKeys?.includes(item.key));

const badgeControlLabel = (control: PlayerBarBadgeControl) =>
  `${control.active ? '隐藏' : '显示'}${control.label}徽标`;

let sortables: Sortable[] = [];
let dragOrigin: { item: HTMLElement; parent: Node; nextSibling: Node | null } | null = null;

const restoreDraggedItem = () => {
  if (!dragOrigin) return;
  const { item, parent, nextSibling } = dragOrigin;
  dragOrigin = null;
  // Restore Tooltip's fragment ownership before Vue removes or reorders it.
  parent.insertBefore(item, nextSibling?.parentNode === parent ? nextSibling : null);
};

const destroySortables = () => {
  restoreDraggedItem();
  sortables.forEach((sortable) => sortable.destroy());
  sortables = [];
};

const readBoardKeys = () => {
  const board = boardRef.value;
  if (!board) return [];
  return Array.from(board.querySelectorAll<HTMLElement>('[data-playerbar-key]'))
    .map((element) => element.dataset.playerbarKey)
    .filter((key): key is string => Boolean(key));
};

const saveBoardMove = (key: string, placement: PlayerBarPlacement, keys = readBoardKeys()) => {
  const ordered = keys.length ? keys : visibleItems.value.map((item) => item.key);
  const layout = reorderPlayerBarLayout(settings.playerBarLayout, props.items, ordered);
  settings.playerBarLayout = setPlayerBarActionPlacement(layout, key, placement);
};

const lockEditMenuHeight = () => {
  const rect = editMenuRef.value?.getBoundingClientRect();
  if (rect?.height) lockedEditMenuHeight.value = rect.height;
};

const unlockEditMenuHeight = () => {
  lockedEditMenuHeight.value = null;
};

const setupSortables = async () => {
  destroySortables();
  await nextTick();
  const board = boardRef.value;
  if (!board) return;
  const lists = board.querySelectorAll<HTMLElement>('[data-playerbar-placement-list]');
  lists.forEach((list) => {
    sortables.push(
      new Sortable(list, {
        group: 'playerbar-layout-zones',
        draggable: '[data-playerbar-key]',
        dataIdAttr: 'data-playerbar-key',
        handle: '.playerbar-layout-chip',
        animation: 150,
        forceFallback: true,
        fallbackTolerance: 5,
        ghostClass: 'playerbar-sort-ghost',
        chosenClass: 'playerbar-sort-chosen',
        onStart: (event) => {
          const parent = event.item.parentNode;
          if (parent)
            dragOrigin = { item: event.item, parent, nextSibling: event.item.nextSibling };
          lockEditMenuHeight();
          isSorting.value = true;
        },
        onEnd: (event) => {
          const key = event.item.dataset.playerbarKey;
          const placement = event.to.dataset.playerbarPlacementList as
            PlayerBarPlacement | undefined;
          const keys = readBoardKeys();
          restoreDraggedItem();
          if (key && placement) saveBoardMove(key, placement, keys);
          window.setTimeout(() => {
            isSorting.value = false;
            void nextTick(unlockEditMenuHeight);
          }, 0);
        },
      }),
    );
  });
};

const reorderByKeyboard = (
  event: KeyboardEvent,
  item: ResolvedPlayerBarAction,
  placement: PlayerBarPlacement,
  index: number,
) => {
  if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const zoneItems = groupedItems.value[placement];
  const target = index + (event.key === 'ArrowUp' ? -1 : 1);
  if (target < 0 || target >= zoneItems.length) return;
  const zoneKeys = zoneItems.map((entry) => entry.key);
  const [key] = zoneKeys.splice(index, 1);
  zoneKeys.splice(target, 0, key);
  const changed = new Set(zoneKeys);
  const keys = readBoardKeys().map((current) =>
    changed.has(current) ? zoneKeys.shift()! : current,
  );
  const layout = reorderPlayerBarLayout(settings.playerBarLayout, props.items, keys);
  settings.playerBarLayout = setPlayerBarActionPlacement(layout, item.key, placement);
};

watch(
  () => [
    boardRef.value,
    visibleItems.value.map((item) => `${item.key}:${item.placement}`).join('|'),
    open.value,
    editMode.value,
  ],
  () => {
    if (open.value && editMode.value) void setupSortables();
    else destroySortables();
  },
  { flush: 'post' },
);

onMounted(() => {
  document.addEventListener('mousedown', handleDocumentMousedown);
});

onBeforeUnmount(() => {
  destroySortables();
  document.removeEventListener('mousedown', handleDocumentMousedown);
});
</script>

<template>
  <Popover
    :trigger="editMode ? 'click' : 'hover'"
    side="top"
    align="end"
    :side-offset="10"
    :delay="80"
    :duration="160"
    :show-arrow="true"
    :content-class="popoverClass"
    :open="open"
    @update:open="updateOpen"
    @open-auto-focus.prevent
  >
    <template #trigger>
      <span ref="moreTriggerRef" class="playerbar-more-anchor">
        <Button
          variant="unstyled"
          size="none"
          type="button"
          class="playback-action playerbar-more-trigger hover:scale-110 active:scale-90"
          aria-label="更多"
        >
          <Icon :icon="iconDots" width="20" height="20" />
        </Button>
      </span>
    </template>

    <div v-if="!editMode" class="playerbar-more-menu" aria-label="播放栏更多功能">
      <div class="playerbar-more-heading">
        <span>更多功能</span>
        <div class="playerbar-more-heading-actions">
          <Tooltip content="编辑播放栏布局">
            <template #trigger>
              <button
                type="button"
                class="action-icon playerbar-edit-entry app-focus-ring-soft"
                aria-label="编辑播放栏布局"
                @click="editMode = true"
              >
                <Icon :icon="iconSlidersHorizontal" width="16" height="16" />
              </button>
            </template>
          </Tooltip>
        </div>
      </div>

      <div v-if="visibleMenuItems.length" class="playerbar-use-grid">
        <Tooltip
          v-for="item in visibleMenuItems"
          :key="item.key"
          :content="item.tooltip && item.tooltip !== item.title ? item.tooltip : undefined"
        >
          <template #trigger>
            <button
              type="button"
              class="playerbar-use-item app-focus-ring-soft"
              :class="{ disabled: item.disabled }"
              :disabled="item.disabled"
              :aria-label="item.tooltip && item.tooltip !== item.title ? item.tooltip : item.title"
              @click="activate(item, $event)"
            >
              <span
                class="playerbar-use-icon"
                :class="{ 'is-favorite': item.key === 'favorite' && item.active }"
              >
                <PlayerBarActionIcon :item="item" :width="19" :height="19" />
              </span>
              <span class="playerbar-use-title">{{ item.title }}</span>
              <Badge
                v-if="item.visibleBadge"
                :count="item.visibleBadge"
                :tone="getPlayerBarBadgeTone(item.key, item.visibleBadge)"
                :title="item.visibleBadge"
                class="playerbar-more-badge"
              />
            </button>
          </template>
        </Tooltip>
      </div>

      <p v-else class="playerbar-more-empty">暂无收纳功能</p>
    </div>

    <div
      v-else
      ref="editMenuRef"
      class="playerbar-more-menu playerbar-layout-editor"
      :style="editMenuStyle"
      aria-label="编辑播放栏布局"
    >
      <div class="playerbar-more-heading">
        <div class="playerbar-more-heading-actions">
          <Button
            variant="ghost"
            size="none"
            class="playerbar-edit-entry"
            aria-label="返回更多功能"
            tooltip="返回更多功能"
            @click="editMode = false"
          >
            <Icon :icon="iconChevronLeft" width="17" height="17" />
          </Button>
          <span>编辑布局</span>
        </div>
        <div class="playerbar-more-heading-actions">
          <button
            type="button"
            class="playerbar-reset soft-secondary-action app-focus-ring-soft"
            @click="settings.playerBarLayout = emptyPlayerBarLayout()"
          >
            恢复默认
          </button>
        </div>
      </div>

      <p class="playerbar-layout-hint">拖动按钮调整位置，上方复选框控制徽标显示。</p>

      <div ref="boardRef" class="playerbar-layout-board" aria-label="播放栏按钮布局">
        <div class="playerbar-layout-preview">
          <div class="playerbar-skeleton-left" aria-hidden="true">
            <span class="playerbar-skeleton-cover"></span>
            <span class="playerbar-skeleton-lines">
              <span></span>
              <span></span>
            </span>
          </div>
          <div class="playerbar-skeleton-center" aria-hidden="true">
            <span class="playerbar-skeleton-controls">
              <span></span>
              <span></span>
              <span></span>
            </span>
            <span class="playerbar-skeleton-progress"></span>
          </div>
          <div class="playerbar-skeleton-right" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <template v-for="zone in previewLayoutZones" :key="zone.value">
            <div class="playerbar-layout-zone" :class="`zone-${zone.value}`">
              <span class="playerbar-layout-zone-label">{{ zone.label }}</span>
              <div
                class="playerbar-layout-zone-list"
                :data-playerbar-placement-list="zone.value"
                :aria-label="zone.ariaLabel"
              >
                <Tooltip
                  v-for="(item, index) in groupedItems[zone.value]"
                  :key="item.key"
                  :content="item.tooltip && item.tooltip !== item.title ? item.tooltip : item.title"
                >
                  <template #trigger>
                    <div
                      role="button"
                      tabindex="0"
                      class="playerbar-layout-chip app-focus-ring-soft"
                      :class="{ disabled: item.disabled }"
                      :data-playerbar-key="item.key"
                      :aria-label="item.title"
                      @keydown="reorderByKeyboard($event, item, zone.value, index)"
                    >
                      <span
                        class="playerbar-chip-icon"
                        :class="{ 'is-favorite': item.key === 'favorite' && item.active }"
                      >
                        <PlayerBarActionIcon :item="item" :width="18" :height="18" />
                      </span>
                      <span class="playerbar-chip-title">{{ item.title }}</span>
                      <Tooltip
                        v-if="badgeControlForItem(item)"
                        :content="badgeControlLabel(badgeControlForItem(item)!)"
                      >
                        <template #trigger>
                          <button
                            type="button"
                            class="playerbar-chip-badge-check app-focus-ring-soft"
                            :class="{ active: badgeControlForItem(item)?.active }"
                            :aria-pressed="badgeControlForItem(item)?.active"
                            :aria-label="badgeControlLabel(badgeControlForItem(item)!)"
                            @pointerdown.stop
                            @mousedown.stop
                            @click.stop="badgeControlForItem(item)?.toggle()"
                          >
                            <span class="playerbar-chip-check-box" aria-hidden="true"></span>
                            <span class="playerbar-chip-badge-label">徽标</span>
                          </button>
                        </template>
                      </Tooltip>
                    </div>
                  </template>
                </Tooltip>
                <span
                  v-if="!groupedItems[zone.value].length"
                  class="playerbar-layout-empty"
                  aria-hidden="true"
                ></span>
              </div>
            </div>
          </template>
        </div>
        <div class="playerbar-layout-more-shelf">
          <span class="playerbar-layout-more-title">更多</span>
          <div class="playerbar-layout-zone zone-more" :aria-label="moreLayoutZone?.ariaLabel">
            <div
              class="playerbar-layout-zone-list"
              data-playerbar-placement-list="more"
              aria-label="更多菜单按钮"
            >
              <Tooltip
                v-for="(item, index) in groupedItems.more"
                :key="item.key"
                :content="item.tooltip && item.tooltip !== item.title ? item.tooltip : item.title"
              >
                <template #trigger>
                  <div
                    role="button"
                    tabindex="0"
                    class="playerbar-layout-chip app-focus-ring-soft"
                    :class="{ disabled: item.disabled }"
                    :data-playerbar-key="item.key"
                    :aria-label="item.title"
                    @keydown="reorderByKeyboard($event, item, 'more', index)"
                  >
                    <span
                      class="playerbar-chip-icon"
                      :class="{ 'is-favorite': item.key === 'favorite' && item.active }"
                    >
                      <PlayerBarActionIcon :item="item" :width="18" :height="18" />
                    </span>
                    <span class="playerbar-chip-title">{{ item.title }}</span>
                    <Tooltip
                      v-if="badgeControlForItem(item)"
                      :content="badgeControlLabel(badgeControlForItem(item)!)"
                    >
                      <template #trigger>
                        <button
                          type="button"
                          class="playerbar-chip-badge-check app-focus-ring-soft"
                          :class="{ active: badgeControlForItem(item)?.active }"
                          :aria-pressed="badgeControlForItem(item)?.active"
                          :aria-label="badgeControlLabel(badgeControlForItem(item)!)"
                          @pointerdown.stop
                          @mousedown.stop
                          @click.stop="badgeControlForItem(item)?.toggle()"
                        >
                          <span class="playerbar-chip-check-box" aria-hidden="true"></span>
                          <span class="playerbar-chip-badge-label">徽标</span>
                        </button>
                      </template>
                    </Tooltip>
                  </div>
                </template>
              </Tooltip>
              <span
                v-if="!groupedItems.more.length"
                class="playerbar-layout-empty"
                aria-hidden="true"
              ></span>
            </div>
          </div>
        </div>
      </div>

      <p v-if="!visibleItems.length" class="playerbar-more-empty">暂无可用操作</p>
    </div>
  </Popover>

  <Teleport to="body">
    <Transition name="popover-fade">
      <div
        v-if="floatingAction"
        ref="floatingActionRef"
        class="playerbar-action-popover-proxy"
        :style="floatingActionStyle"
        @mousedown.stop
      >
        <CastPopover
          v-if="floatingAction.component === 'cast'"
          :open="true"
          :show-arrow="true"
          hover-close
          @update:open="!$event && closeFloatingPanels()"
        />
        <SleepTimerPopover
          v-else-if="floatingAction.component === 'sleep-timer'"
          :open="true"
          :show-arrow="true"
          @update:open="!$event && closeFloatingPanels()"
        />
        <VolumePopover
          v-else-if="floatingAction.component === 'volume'"
          :open="true"
          :show-arrow="true"
          @update:open="!$event && closeFloatingPanels()"
        />
        <SpeedPopover
          v-else-if="floatingAction.component === 'speed'"
          :open="true"
          :show-arrow="true"
          @update:open="!$event && closeFloatingPanels()"
        />
        <QualityPopover
          v-else-if="floatingAction.component === 'quality'"
          :open="true"
          :show-arrow="true"
          @update:open="!$event && closeFloatingPanels()"
        />
        <EffectPopover
          v-else-if="floatingAction.component === 'effect'"
          :open="true"
          :show-arrow="true"
          @update:open="!$event && closeFloatingPanels()"
        />
        <slot v-else name="floating-action" :item="floatingAction" :close="closeFloatingPanels" />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.playerbar-more-trigger {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--icon-main);
  transition:
    color var(--motion-duration-fast) var(--motion-ease-standard),
    scale var(--motion-duration-fast) var(--motion-ease-standard);
}

.playerbar-more-anchor {
  display: inline-flex;
}

.playerbar-more-trigger:hover,
.playerbar-more-trigger[aria-expanded='true'] {
  color: var(--color-primary-text);
}
</style>

<style>
.playerbar-more-popover.echo-popover-content {
  width: 280px;
  max-width: calc(100vw - 24px);
  overflow: visible;
  padding: 8px;
  border: 1px solid var(--surface-outline);
}

.playerbar-more-popover.echo-popover-content.is-editing {
  width: 860px;
}

.playerbar-more-popover.echo-popover-content > div:first-child {
  max-height: min(520px, calc(100vh - 24px), var(--reka-popover-content-available-height, 520px));
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.playerbar-more-popover.echo-popover-content.is-editing > div:first-child {
  max-height: min(620px, calc(100vh - 24px), var(--reka-popover-content-available-height, 620px));
}

.playerbar-more-menu {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--color-text-main);
}

.playerbar-layout-editor {
  min-height: 0;
  overflow: hidden;
}

.playerbar-more-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 36px;
  padding: 0 4px 8px 8px;
  margin-bottom: 2px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 13px;
  font-weight: 600;
}

.playerbar-more-heading-actions {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.playerbar-reset {
  min-height: 28px;
  padding: 4px 8px;
  border-radius: var(--radius-control);
  font-size: 12px;
  font-weight: 500;
}

.playerbar-edit-entry {
  display: inline-flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-control);
  color: var(--color-text-secondary);
}

.playerbar-edit-entry:hover {
  color: var(--color-primary-text);
  background: var(--control-hover-bg);
}

.playerbar-reset,
.playerbar-edit-entry,
.playerbar-chip-badge-check {
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease-standard),
    color var(--motion-duration-fast) var(--motion-ease-standard);
}

.playerbar-use-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 3px;
}

.playerbar-use-item {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 38px;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-item);
  color: var(--color-text-main);
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease-standard),
    color var(--motion-duration-fast) var(--motion-ease-standard);
}

.playerbar-use-item:hover:not(:disabled),
.playerbar-use-item:focus-visible:not(:disabled) {
  color: var(--color-primary-text);
  background: var(--control-hover-bg);
}

.playerbar-use-item.disabled {
  opacity: 0.56;
}

.playerbar-use-icon.is-favorite,
.playerbar-chip-icon.is-favorite {
  color: var(--state-danger);
}

.playerbar-use-icon {
  display: inline-flex;
  flex: 0 0 22px;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
}

.playerbar-use-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.playerbar-layout-board {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 9px;
  overflow-x: auto;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-card);
  background: var(--control-muted-bg);
  scrollbar-width: thin;
}

.playerbar-layout-preview {
  display: grid;
  grid-template-columns:
    minmax(0, 1fr)
    minmax(0, 1.4fr)
    minmax(0, 1fr);
  grid-template-areas:
    'left-skeleton center-skeleton right-skeleton'
    'left center right';
  grid-template-rows: 42px auto;
  align-items: center;
  gap: 7px 12px;
  min-width: 0;
  padding: 9px 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-card);
  background: color-mix(in srgb, var(--floating-surface-bg) 58%, transparent);
}

.playerbar-skeleton-left,
.playerbar-skeleton-center,
.playerbar-skeleton-right {
  min-width: 0;
  border-radius: var(--radius-card);
  opacity: 0.72;
  pointer-events: none;
}

.playerbar-skeleton-left {
  grid-area: left-skeleton;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 8px;
}

.playerbar-skeleton-cover {
  width: 34px;
  height: 34px;
  border-radius: var(--radius-media);
  background: color-mix(in srgb, var(--color-text-secondary) 18%, transparent);
}

.playerbar-skeleton-lines {
  display: grid;
  flex: 1 1 auto;
  gap: 6px;
  min-width: 0;
}

.playerbar-skeleton-lines span {
  height: 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text-secondary) 16%, transparent);
}

.playerbar-skeleton-lines span:first-child {
  width: 76%;
}

.playerbar-skeleton-lines span:last-child {
  width: 48%;
}

.playerbar-skeleton-center {
  grid-area: center-skeleton;
  display: grid;
  align-content: center;
  gap: 9px;
  padding: 0 18px;
}

.playerbar-skeleton-controls {
  display: flex;
  justify-content: center;
  gap: 16px;
}

.playerbar-skeleton-controls span {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text-secondary) 17%, transparent);
}

.playerbar-skeleton-controls span:nth-child(2) {
  width: 28px;
  height: 28px;
  margin-top: -5px;
  background: color-mix(in srgb, var(--color-primary) 16%, transparent);
}

.playerbar-skeleton-progress {
  height: 4px;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--color-primary) 28%, transparent) 0 38%,
    color-mix(in srgb, var(--color-text-secondary) 15%, transparent) 38% 100%
  );
}

.playerbar-skeleton-right {
  grid-area: right-skeleton;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 9px;
  padding: 0 8px;
}

.playerbar-skeleton-right span {
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text-secondary) 15%, transparent);
}

.playerbar-layout-zone {
  position: relative;
  min-width: 0;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-item);
  background: var(--floating-surface-bg);
}

.playerbar-layout-zone.zone-center {
  grid-area: center;
  background: var(--floating-surface-bg);
}

.playerbar-layout-zone.zone-left {
  grid-area: left;
}

.playerbar-layout-zone.zone-right {
  grid-area: right;
}

.playerbar-layout-zone.zone-more {
  min-width: 0;
}

.playerbar-layout-more-shelf {
  position: relative;
  min-width: 0;
  padding: 24px 10px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-card);
  background: color-mix(in srgb, var(--control-muted-bg) 54%, transparent);
}

.playerbar-layout-more-title {
  position: absolute;
  left: 13px;
  top: 8px;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 800;
  line-height: 1;
}

.playerbar-layout-zone-list {
  display: flex;
  min-height: 64px;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  overflow-y: hidden;
  padding-top: 28px;
  scrollbar-width: none;
}

.playerbar-layout-zone-list::-webkit-scrollbar {
  display: none;
}

.playerbar-layout-zone.zone-center .playerbar-layout-zone-list {
  justify-content: flex-start;
}

.playerbar-layout-zone.zone-more .playerbar-layout-zone-list {
  justify-content: flex-start;
}

.playerbar-layout-chip {
  display: inline-flex;
  position: relative;
  flex: 0 0 34px;
  width: 34px;
  height: 34px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: var(--radius-item);
  color: var(--color-text-main);
  background: var(--control-muted-bg);
  border: 1px solid transparent;
  transition:
    background-color var(--motion-duration-fast) var(--motion-ease-standard),
    border-color var(--motion-duration-fast) var(--motion-ease-standard),
    color var(--motion-duration-fast) var(--motion-ease-standard);
  cursor: grab;
}

.playerbar-layout-chip:hover:not(.disabled),
.playerbar-layout-chip:focus-visible:not(.disabled) {
  color: var(--color-primary-text);
  background: var(--control-hover-bg);
}

.playerbar-layout-chip:active {
  cursor: grabbing;
}

.playerbar-layout-chip.disabled {
  opacity: 0.56;
}

.playerbar-chip-icon {
  display: inline-flex;
  flex: 0 0 18px;
  align-items: center;
  justify-content: center;
  color: currentColor;
}

.playerbar-chip-badge-check {
  display: inline-flex;
  position: absolute;
  top: -28px;
  left: 50%;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--radius-control);
  color: var(--color-text-secondary);
  background: transparent;
  cursor: pointer;
  font-size: 10px;
  font-weight: 800;
  transform: translateX(-50%);
  z-index: 2;
}

.playerbar-chip-check-box {
  position: relative;
  width: 14px;
  height: 14px;
  border: 1px solid var(--control-checkbox-border);
  background: var(--control-checkbox-bg);
  border-radius: var(--radius-micro);
}

.playerbar-chip-badge-check.active {
  color: var(--color-primary-text);
}

.playerbar-chip-badge-check.active .playerbar-chip-check-box {
  border-color: var(--control-checkbox-active-border);
  background: var(--color-primary);
}

.playerbar-chip-badge-check.active .playerbar-chip-check-box::after {
  content: '';
  position: absolute;
  left: 3px;
  top: 1px;
  width: 4.5px;
  height: 8px;
  border: solid var(--control-checkbox-indicator);
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}

.playerbar-chip-badge-check:hover {
  color: var(--color-primary-text);
  background: var(--control-hover-bg);
}

.playerbar-chip-badge-label {
  display: none;
}

.playerbar-chip-title {
  display: none;
}

.playerbar-more-badge {
  margin-inline-start: 0;
  max-width: 64px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.playerbar-action-popover-proxy {
  position: fixed;
  z-index: 70;
  width: 36px;
  height: 36px;
  pointer-events: none;
}

.playerbar-action-popover-proxy > * {
  pointer-events: auto;
}

.playerbar-action-popover-proxy .echo-popover-trigger {
  width: 100% !important;
  height: 100% !important;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}

.playerbar-action-popover-proxy .echo-popover-trigger > * {
  pointer-events: none;
}

.playerbar-layout-empty {
  display: inline-flex;
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  border: 1px dashed color-mix(in srgb, var(--color-text-main) 16%, transparent);
  border-radius: var(--radius-card);
  color: var(--color-text-secondary);
  pointer-events: none;
}

.playerbar-more-empty {
  padding: 14px 8px 10px;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.playerbar-sort-ghost {
  opacity: 0.45;
}

.playerbar-sort-chosen {
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
}

.playerbar-layout-hint {
  margin: 0;
  padding: 0 8px 6px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.playerbar-layout-zone-label {
  display: block;
  font-size: 12px;
  line-height: 18px;
  color: var(--color-text-secondary);
}

@media (max-width: 640px) {
  .playerbar-layout-preview {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'left' 'center' 'right';
    grid-template-rows: auto;
    padding: 8px;
    gap: 8px;
  }
  .playerbar-skeleton-left,
  .playerbar-skeleton-center,
  .playerbar-skeleton-right {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .playerbar-use-item,
  .playerbar-layout-chip,
  .playerbar-reset,
  .playerbar-edit-entry,
  .playerbar-chip-badge-check,
  .playerbar-more-trigger {
    transition: none;
  }
}

@media (max-width: 420px) {
  .playerbar-more-popover.echo-popover-content {
    width: calc(100vw - 24px);
  }
}
</style>
