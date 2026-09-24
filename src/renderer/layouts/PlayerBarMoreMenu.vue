<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Sortable from 'sortablejs';
import Button from '@/components/ui/Button.vue';
import Popover from '@/components/ui/Popover.vue';
import MvIcon from '@/components/ui/MvIcon.vue';
import CastPopover from '@/components/player/CastPopover.vue';
import EffectPopover from '@/components/player/EffectPopover.vue';
import QualityPopover from '@/components/player/QualityPopover.vue';
import SleepTimerPopover from '@/components/player/SleepTimerPopover.vue';
import SpeedPopover from '@/components/player/SpeedPopover.vue';
import VolumePopover from '@/components/player/VolumePopover.vue';
import PluginIcon from '@/plugins/PluginIcon.vue';
import { iconDots, iconSlidersHorizontal } from '@/icons';
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
  if (item.component && popoverComponents.has(item.component)) {
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
  const target = event.target as Node;
  if (floatingActionRef.value?.contains(target)) return;
  if (target instanceof Element && target.closest('.echo-popover-content')) return;
  closeFloatingPanels();
};

const layoutZones: { value: PlayerBarPlacement; label: string; hint: string }[] = [
  { value: 'center', label: '中上', hint: '播放控制区' },
  { value: 'left', label: '左下', hint: '歌曲信息下方' },
  { value: 'right', label: '右侧', hint: '功能按钮区' },
  { value: 'more', label: '更多', hint: '默认收纳' },
];

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

const saveOrder = (keys: string[]) => {
  settings.playerBarLayout = reorderPlayerBarLayout(settings.playerBarLayout, props.items, keys);
};

let sortables: Sortable[] = [];

const destroySortables = () => {
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

const saveBoardMove = (key: string, placement: PlayerBarPlacement) => {
  const keys = readBoardKeys();
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
        onStart: () => {
          lockEditMenuHeight();
          isSorting.value = true;
        },
        onEnd: (event) => {
          const key = event.item.dataset.playerbarKey;
          const placement = event.to.dataset.playerbarPlacementList as
            | PlayerBarPlacement
            | undefined;
          if (key && placement) saveBoardMove(key, placement);
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
    trigger="hover"
    side="top"
    align="end"
    :side-offset="10"
    :delay="80"
    :duration="160"
    :show-arrow="true"
    :content-class="popoverClass"
    :open="open"
    @update:open="updateOpen"
  >
    <template #trigger>
      <span ref="moreTriggerRef" class="playerbar-more-anchor">
        <Button
          variant="unstyled"
          size="none"
          type="button"
          class="playerbar-more-trigger"
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
          <button
            type="button"
            class="playerbar-edit-entry app-focus-ring-soft"
            aria-label="编辑播放栏布局"
            title="编辑播放栏布局"
            @click="editMode = true"
          >
            <Icon :icon="iconSlidersHorizontal" width="16" height="16" />
          </button>
        </div>
      </div>

      <div v-if="visibleMenuItems.length" class="playerbar-use-grid">
        <button
          v-for="item in visibleMenuItems"
          :key="item.key"
          type="button"
          class="playerbar-use-item app-focus-ring-soft"
          :class="{ disabled: item.disabled }"
          :disabled="item.disabled"
          :title="item.tooltip && item.tooltip !== item.title ? item.tooltip : item.title"
          @click="activate(item, $event)"
        >
          <span class="playerbar-use-icon">
            <MvIcon v-if="item.key === 'mv'" class="w-[19px] h-[19px]" />
            <PluginIcon v-else :icon="item.icon" :width="19" :height="19" />
          </span>
          <span class="playerbar-use-title">{{ item.title }}</span>
          <span v-if="item.visibleBadge" class="playerbar-more-badge">{{ item.visibleBadge }}</span>
        </button>
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
        <span>编辑布局</span>
        <div class="playerbar-more-heading-actions">
          <button
            type="button"
            class="playerbar-reset app-focus-ring-soft"
            @click="settings.playerBarLayout = emptyPlayerBarLayout()"
          >
            恢复默认
          </button>
        </div>
      </div>

      <div ref="boardRef" class="playerbar-layout-board" aria-label="播放栏按钮布局">
        <div
          v-for="zone in layoutZones"
          :key="zone.value"
          class="playerbar-layout-zone"
          :class="`zone-${zone.value}`"
        >
          <div class="playerbar-layout-zone-title">
            <span>{{ zone.label }}</span>
            <small>{{ zone.hint }}</small>
          </div>
          <div
            class="playerbar-layout-zone-list"
            :data-playerbar-placement-list="zone.value"
            :aria-label="`${zone.label}按钮`"
          >
            <div
              v-for="(item, index) in groupedItems[zone.value]"
              :key="item.key"
              role="button"
              tabindex="0"
              class="playerbar-layout-chip app-focus-ring-soft"
              :class="{ disabled: item.disabled }"
              :data-playerbar-key="item.key"
              :aria-label="item.title"
              :title="item.tooltip && item.tooltip !== item.title ? item.tooltip : item.title"
              @keydown="reorderByKeyboard($event, item, zone.value, index)"
            >
              <span class="playerbar-chip-icon">
                <MvIcon v-if="item.key === 'mv'" class="w-[18px] h-[18px]" />
                <PluginIcon v-else :icon="item.icon" :width="18" :height="18" />
              </span>
              <span class="playerbar-chip-title">{{ item.title }}</span>
              <button
                v-if="badgeControlForItem(item)"
                type="button"
                class="playerbar-chip-badge-check app-focus-ring-soft"
                :class="{ active: badgeControlForItem(item)?.active }"
                :aria-pressed="badgeControlForItem(item)?.active"
                :aria-label="badgeControlLabel(badgeControlForItem(item)!)"
                :title="badgeControlLabel(badgeControlForItem(item)!)"
                @pointerdown.stop
                @mousedown.stop
                @click.stop="badgeControlForItem(item)?.toggle()"
              >
                <span class="playerbar-chip-check-box" aria-hidden="true"></span>
                <span class="playerbar-chip-badge-label">徽标</span>
              </button>
            </div>
            <span v-if="!groupedItems[zone.value].length" class="playerbar-layout-empty"
              >拖到这里</span
            >
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
  border-radius: 999px;
  color: color-mix(in srgb, var(--color-text-main) 56%, transparent);
  transition:
    background-color 0.12s ease,
    color 0.12s ease,
    transform 0.12s ease;
}

.playerbar-more-anchor {
  display: inline-flex;
}

.playerbar-more-trigger:hover,
.playerbar-more-trigger[aria-expanded='true'] {
  color: var(--color-primary-text);
  background: var(--control-hover-bg);
  transform: scale(1.08);
}
</style>

<style>
.playerbar-more-popover.echo-popover-content {
  width: 264px;
  max-width: calc(100vw - 24px);
  overflow: visible;
  padding: 9px;
  border: 1px solid color-mix(in srgb, var(--color-text-main) 10%, transparent);
}

.playerbar-more-popover.echo-popover-content.is-editing {
  width: 620px;
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
  padding: 4px 4px 6px 8px;
  font-size: 12px;
  font-weight: 700;
}

.playerbar-more-heading-actions {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.playerbar-reset {
  padding: 4px 7px;
  border-radius: 7px;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.playerbar-reset:hover {
  color: var(--color-primary-text);
  background: var(--control-hover-bg);
}

.playerbar-edit-entry {
  display: inline-flex;
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: var(--color-text-secondary);
}

.playerbar-edit-entry:hover {
  color: var(--color-primary-text);
  background: var(--control-hover-bg);
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
  height: 34px;
  align-items: center;
  gap: 9px;
  padding: 0 8px;
  border-radius: 8px;
  color: var(--color-text-main);
  font-size: 12px;
  font-weight: 700;
  text-align: left;
}

.playerbar-use-item:hover:not(:disabled),
.playerbar-use-item:focus-visible:not(:disabled) {
  color: var(--color-primary-text);
  background: var(--control-hover-bg);
}

.playerbar-use-item.disabled {
  opacity: 0.56;
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
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-areas:
    'center center'
    'left right'
    'more more';
  gap: 8px;
}

.playerbar-layout-zone {
  min-width: 0;
  padding: 8px;
  border: 1px solid color-mix(in srgb, var(--color-text-main) 9%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--control-muted-bg) 76%, transparent);
}

.playerbar-layout-zone.zone-center {
  grid-area: center;
}

.playerbar-layout-zone.zone-left {
  grid-area: left;
  justify-self: stretch;
  width: auto;
}

.playerbar-layout-zone.zone-right {
  grid-area: right;
  justify-self: stretch;
  width: auto;
}

.playerbar-layout-zone.zone-more {
  grid-area: more;
}

.playerbar-layout-zone-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 7px;
  color: var(--color-text-main);
  font-size: 12px;
  font-weight: 800;
}

.playerbar-layout-zone-title small {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.playerbar-layout-zone-list {
  display: flex;
  min-height: 42px;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 6px;
}

.playerbar-layout-zone.zone-center .playerbar-layout-zone-list {
  min-height: 72px;
}

.playerbar-layout-zone.zone-more .playerbar-layout-zone-list {
  min-height: 48px;
  max-height: 180px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.playerbar-layout-chip {
  display: inline-flex;
  max-width: 192px;
  min-width: 0;
  height: 30px;
  align-items: center;
  gap: 7px;
  padding: 0 8px;
  border-radius: 999px;
  color: var(--color-text-main);
  background: var(--floating-surface-bg);
  border: 1px solid color-mix(in srgb, var(--color-text-main) 8%, transparent);
  box-shadow: 0 1px 2px color-mix(in srgb, #000 7%, transparent);
  cursor: grab;
  font-size: 12px;
  font-weight: 700;
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
  color: var(--color-text-secondary);
}

.playerbar-chip-badge-check {
  display: inline-flex;
  flex: 0 0 auto;
  height: 22px;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-left: 1px;
  padding: 0 6px 0 5px;
  border: 1px solid color-mix(in srgb, var(--color-text-main) 10%, transparent);
  border-radius: 999px;
  color: color-mix(in srgb, var(--color-text-secondary) 82%, transparent);
  background: color-mix(in srgb, var(--control-muted-bg) 80%, transparent);
  cursor: pointer;
  font-size: 10px;
  font-weight: 800;
}

.playerbar-chip-check-box {
  position: relative;
  width: 11px;
  height: 11px;
  border: 1.5px solid currentColor;
  border-radius: 3px;
}

.playerbar-chip-badge-check.active {
  border-color: color-mix(in srgb, var(--color-primary) 36%, transparent);
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
  color: var(--color-primary-text);
}

.playerbar-chip-badge-check.active .playerbar-chip-check-box {
  border-color: var(--color-primary-text);
  background: var(--color-primary);
}

.playerbar-chip-badge-check.active .playerbar-chip-check-box::after {
  content: '';
  position: absolute;
  left: 2px;
  top: 0;
  width: 4px;
  height: 7px;
  border: solid var(--color-on-primary, #fff);
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}

.playerbar-chip-badge-check:hover {
  color: var(--color-primary-text);
  background: var(--control-hover-bg);
}

.playerbar-chip-badge-label {
  line-height: 1;
}

.playerbar-chip-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.playerbar-more-badge {
  flex-shrink: 0;
  max-width: 38px;
  padding: 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary) 16%, transparent);
  color: var(--color-primary-text);
  font-size: 10px;
  font-weight: 800;
  line-height: 16px;
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
  height: 30px;
  align-items: center;
  padding: 0 10px;
  border: 1px dashed color-mix(in srgb, var(--color-text-main) 16%, transparent);
  border-radius: 999px;
  color: color-mix(in srgb, var(--color-text-secondary) 76%, transparent);
  font-size: 11px;
  font-weight: 700;
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

@media (max-width: 420px) {
  .playerbar-more-popover.echo-popover-content {
    width: calc(100vw - 24px);
  }

  .playerbar-layout-board {
    grid-template-columns: 1fr;
    grid-template-areas:
      'center'
      'left'
      'right'
      'more';
  }

  .playerbar-layout-zone.zone-left,
  .playerbar-layout-zone.zone-right {
    justify-self: stretch;
    width: auto;
  }

  .playerbar-layout-zone.zone-left {
    grid-area: left;
  }

  .playerbar-layout-zone.zone-right {
    grid-area: right;
  }

  .playerbar-layout-zone.zone-more .playerbar-layout-zone-list {
    min-height: 72px;
    max-height: 140px;
  }
}
</style>
