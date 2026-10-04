<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Sortable from 'sortablejs';
import { Icon } from '@iconify/vue';
import {
  iconSparkles,
  iconCompass,
  iconVinyl,
  iconRadio,
  iconCalendar,
  iconShoppingBag,
  iconHeadphones,
  iconPlus,
  iconMinus,
  iconX,
  iconLock,
  iconArrowsSort,
} from '@/icons';
import PluginIcon from '@/plugins/PluginIcon.vue';
import { pluginShortcuts, pluginPages, type PluginIcon as IconValue } from '@/plugins/registry';
import Dialog from '@/components/ui/Dialog.vue';
import Avatar from '@/components/ui/Avatar.vue';
import Cover from '@/components/ui/Cover.vue';
import Tooltip from '@/components/ui/Tooltip.vue';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import { useHistoryStore } from '@/stores/historyStore';
import { usePlaylistStore } from '@/stores/playlist';
import { usePlaylistCoversStore } from '@/stores/playlistCovers';
import { useUserStore } from '@/stores/user';
import { getArtistDetail } from '@/api/artist';
import { extractFirstObject } from '@/utils/extractors';
import { mapArtistDetailMeta } from '@/utils/mappers';
import {
  frequentArtistShortcuts,
  recentPlaylistShortcuts,
  resolvePlaylistShortcut,
  resourceShortcutKey,
  resourceShortcutPath,
  selectedShortcutResources,
  type SidebarShortcutResource,
} from './sidebarShortcutResources';
import {
  DEFAULT_SHORTCUT_KEYS,
  REQUIRED_SHORTCUT_KEYS,
  normalizeShortcutKeys,
  reorderShortcutKeys,
} from './sidebarLayout';
const props = defineProps<{ collapsed?: boolean }>();
const SHORTCUT_ICON_SIZE = 20;
const settings = useSettingStore(),
  router = useRouter(),
  route = useRoute(),
  toast = useToastStore(),
  history = useHistoryStore(),
  playlists = usePlaylistStore(),
  playlistCovers = usePlaylistCoversStore(),
  user = useUserStore();
void playlistCovers.hydrate();
const open = ref(false),
  historyLoading = ref(false),
  container = ref<HTMLElement | null>(null);
const pickerPosition = ref({ left: '250px', width: '520px' });
let sidebarObserver: ResizeObserver | null = null;
function positionPicker() {
  const sidebar = container.value?.closest('aside');
  const edge =
    sidebar?.getBoundingClientRect().right ?? container.value?.getBoundingClientRect().right ?? 230;
  const available = window.innerWidth - edge - 20;
  const left = available >= 340 ? edge + 8 : 12;
  pickerPosition.value = {
    left: `${left}px`,
    width: `${Math.max(0, Math.min(520, window.innerWidth - left - 12))}px`,
  };
}
interface Entry {
  key: string;
  title: string;
  icon?: IconValue;
  path?: string;
  onClick?: () => void | Promise<void>;
  source?: string;
  disabled?: boolean;
  resource?: SidebarShortcutResource;
}
const builtin: Entry[] = [
  { key: 'home', title: '为您推荐', icon: iconSparkles, path: '/main/home' },
  { key: 'explore', title: '探索发现', icon: iconCompass, path: '/main/explore' },
  { key: 'discover-flow', title: '刷歌', icon: iconVinyl, path: '/main/discover-flow' },
  { key: 'personal-fm', title: '私人 FM', icon: iconRadio, path: '/main/personal-fm' },
  { key: 'recommend', title: '每日推荐', icon: iconCalendar, path: '/main/recommend' },
  { key: 'ranking', title: '排行榜', icon: iconArrowsSort, path: '/main/ranking' },
  { key: 'purchased', title: '已购音乐', icon: iconShoppingBag, path: '/main/purchased' },
  { key: 'listen-together', title: '一起听', icon: iconHeadphones, path: '/main/listen-together' },
];
const flag = (value: boolean | (() => boolean) | undefined, fallback: boolean) => {
  try {
    return typeof value === 'function' ? value() : (value ?? fallback);
  } catch {
    return fallback;
  }
};
const functions = computed<Entry[]>(() => [
  ...builtin,
  ...pluginShortcuts.value
    .filter(
      (e) =>
        flag(e.visible, true) &&
        (!e.pageId ||
          pluginPages.value.some((page) => page.pluginId === e.pluginId && page.id === e.pageId)),
    )
    .map((e) => ({
      key: e.key,
      title: e.title,
      icon: e.icon,
      source: e.pluginId,
      path: e.pageId
        ? `/main/plugin/${encodeURIComponent(e.pluginId)}/${encodeURIComponent(e.pageId)}`
        : undefined,
      onClick: e.onClick,
      disabled: flag(e.disabled, false),
    })),
]);
const artistPortraits = ref<Record<string, string>>({});
const portraitRequests = new Set<string>();
const resourceEntry = (snapshot: SidebarShortcutResource): Entry => {
  const resource = resolvePlaylistShortcut(snapshot, playlists.userPlaylists, (playlist) =>
    playlistCovers.coverFor(playlist, user.info?.userid),
  );
  return {
    key: resourceShortcutKey(resource),
    title: resource.title,
    path: resourceShortcutPath(resource),
    resource:
      resource.kind === 'artist' && !resource.image && artistPortraits.value[resource.id]
        ? { ...resource, image: artistPortraits.value[resource.id] }
        : resource,
  };
};
const frequentArtists = computed(() => frequentArtistShortcuts(history.entries));
const artistCandidates = computed(() => frequentArtists.value.map(resourceEntry));
const playlistCandidates = computed(() =>
  recentPlaylistShortcuts(playlists.playbackQueues, playlists.userPlaylists).map(resourceEntry),
);
const catalogue = computed(() => [
  ...functions.value,
  ...(settings.sidebarLayout.shortcutResources ?? []).map(resourceEntry),
  ...artistCandidates.value,
  ...playlistCandidates.value,
]);
const keys = computed(() => normalizeShortcutKeys(settings.sidebarLayout.shortcutKeys));
const visible = computed(() =>
  keys.value.flatMap((key) => {
    const entry = catalogue.value.find((e) => e.key === key);
    return entry ? [entry] : [];
  }),
);
const busy = ref<string | null>(null);
let sortable: Sortable | null = null,
  skipClick = false;
let disposed = false;
async function loadArtistPortrait(resource: SidebarShortcutResource) {
  if (resource.image || artistPortraits.value[resource.id] || portraitRequests.has(resource.id))
    return;
  portraitRequests.add(resource.id);
  try {
    const response = await getArtistDetail(resource.id);
    if (disposed) return;

    const raw = extractFirstObject(response);
    const artist = raw && mapArtistDetailMeta(raw);
    if (artist?.pic && String(artist.id) === resource.id)
      artistPortraits.value[resource.id] = artist.pic;
  } catch {
    // Keep a visible artist placeholder when a portrait cannot be loaded.
  } finally {
    portraitRequests.delete(resource.id);
  }
}
watch(
  () => [open.value, frequentArtists.value, settings.sidebarLayout.shortcutResources] as const,
  () => {
    const resources = [
      ...(open.value ? frequentArtists.value : []),
      ...(settings.sidebarLayout.shortcutResources ?? []).filter((e) => e.kind === 'artist'),
    ];
    for (const resource of resources) void loadArtistPortrait(resource);
  },
  { immediate: true },
);
const save = (value: string[], added?: SidebarShortcutResource) => {
  const next = normalizeShortcutKeys(value);
  settings.sidebarLayout = {
    ...settings.sidebarLayout,
    shortcutKeys: next,
    shortcutResources: selectedShortcutResources(
      next,
      settings.sidebarLayout.shortcutResources ?? [],
      added,
    ),
  };
};
const remove = (entry: Entry, focusAfter = true) => {
  if (REQUIRED_SHORTCUT_KEYS.includes(entry.key)) return;
  const index = visible.value.findIndex((item) => item.key === entry.key);
  save(keys.value.filter((key) => key !== entry.key));
  if (!focusAfter) return;
  void nextTick(() => {
    if (disposed) return;
    const cards = container.value?.querySelectorAll<HTMLButtonElement>('.shortcut-activate');
    const target = cards?.[Math.min(index, cards.length - 1)];
    (target ?? container.value?.querySelector<HTMLButtonElement>('.shortcut-add'))?.focus();
  });
};
const toggle = (entry: Entry) => {
  if (
    REQUIRED_SHORTCUT_KEYS.includes(entry.key) ||
    (entry.disabled && !keys.value.includes(entry.key))
  )
    return;
  if (keys.value.includes(entry.key)) remove(entry, false);
  else save([...keys.value, entry.key], entry.resource);
};
const activate = async (entry: Entry) => {
  if (skipClick || entry.disabled || busy.value) return;
  try {
    busy.value = entry.key;
    if (entry.onClick) await entry.onClick();
    else if (entry.path) await router.push(entry.path);
  } catch (error) {
    toast.warning(error instanceof Error ? error.message : '无法打开功能');
  } finally {
    busy.value = null;
  }
};
const move = (key: string, offset: number) => {
  const shown = visible.value.map((e) => e.key),
    from = shown.indexOf(key),
    to = from + offset;
  if (to < 0 || to >= shown.length) return;
  [shown[from], shown[to]] = [shown[to], shown[from]];
  save(
    reorderShortcutKeys(
      keys.value,
      visible.value.map((e) => e.key),
      shown,
    ),
  );
};
async function setupSort() {
  await nextTick();
  if (disposed) return;
  sortable?.destroy();
  skipClick = false;
  if (!container.value) return;
  sortable = Sortable.create(container.value, {
    animation: 160,
    draggable: '.shortcut-card',
    filter: '.shortcut-add, .shortcut-remove',
    preventOnFilter: false,
    onStart: () => {
      skipClick = true;
    },
    onEnd: (event) => {
      const ordered = Array.from(
        container.value?.querySelectorAll<HTMLElement>('[data-shortcut-key]') ?? [],
      ).map((el) => el.dataset.shortcutKey!);
      const oldIndex = event.oldDraggableIndex ?? 0;
      const siblings = Array.from(
        container.value?.querySelectorAll<HTMLElement>('[data-shortcut-key]') ?? [],
      ).filter((el) => el !== event.item);
      if (event.item.parentElement === container.value)
        container.value?.insertBefore(
          event.item,
          siblings[oldIndex] ?? container.value.querySelector('.shortcut-add'),
        ); // Restore DOM before Vue applies the saved order.
      const next = reorderShortcutKeys(
        keys.value,
        visible.value.map((e) => e.key),
        ordered,
      );
      save(next);
      void nextTick(() => {
        skipClick = false;
      });
    },
  });
}
onMounted(() => {
  void setupSort();
  window.addEventListener('resize', positionPicker);
  sidebarObserver = new ResizeObserver(positionPicker);
  const sidebar = container.value?.closest('aside') ?? container.value;
  if (sidebar) sidebarObserver.observe(sidebar);
});
watch(open, async (value) => {
  if (!value) {
    await nextTick();
    if (
      !disposed &&
      (document.activeElement === document.body ||
        document.activeElement?.closest('.shortcut-picker'))
    )
      container.value?.querySelector<HTMLButtonElement>('.shortcut-add')?.focus();
    return;
  }
  positionPicker();
  historyLoading.value = true;
  await history.hydrate();
  if (!disposed) historyLoading.value = false;
});
watch(() => [visible.value.map((e) => e.key).join('|'), props.collapsed], setupSort);
onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener('resize', positionPicker);
  sidebarObserver?.disconnect();
  sortable?.destroy();
});
</script>
<template>
  <div class="sidebar-shortcuts" :class="{ 'is-collapsed': collapsed }">
    <div ref="container" class="shortcut-grid" aria-label="常用功能">
      <Tooltip
        v-for="entry in visible"
        :key="entry.key"
        :content="entry.title"
        side="right"
        :disabled="!collapsed"
      >
        <template #trigger
          ><div class="shortcut-card" :data-shortcut-key="entry.key">
            <button
              type="button"
              class="shortcut-activate"
              :aria-label="entry.title"
              :aria-current="route.path === entry.path ? 'page' : undefined"
              :disabled="entry.disabled || busy === entry.key"
              @click="activate(entry)"
              @keydown.alt.left.prevent="move(entry.key, -1)"
              @keydown.alt.up.prevent="move(entry.key, -1)"
              @keydown.alt.right.prevent="move(entry.key, 1)"
              @keydown.alt.down.prevent="move(entry.key, 1)"
            >
              <Avatar
                v-if="entry.resource?.kind === 'artist'"
                :src="entry.resource.image"
                :alt="entry.title"
                :size="SHORTCUT_ICON_SIZE"
                :show-skeleton="false"
                error-class="!opacity-50"
                class="shortcut-icon rounded-full"
              />
              <Cover
                v-else-if="entry.resource"
                :url="entry.resource.image"
                :alt="entry.title"
                :width="SHORTCUT_ICON_SIZE"
                :height="SHORTCUT_ICON_SIZE"
                :border-radius="5"
                class="shortcut-icon"
              />
              <PluginIcon
                v-else
                :icon="entry.icon"
                :width="SHORTCUT_ICON_SIZE"
                :height="SHORTCUT_ICON_SIZE"
                class="shortcut-icon"
              /><span class="shortcut-label">{{ entry.title }}</span>
            </button>
            <Tooltip
              v-if="!collapsed && !REQUIRED_SHORTCUT_KEYS.includes(entry.key)"
              :content="`移除${entry.title}`"
              side="right"
            >
              <template #trigger>
                <button
                  type="button"
                  class="shortcut-remove"
                  :aria-label="`移除${entry.title}卡片`"
                  @pointerdown.stop
                  @click.stop="remove(entry)"
                >
                  <Icon :icon="iconX" :width="13" :height="13" />
                </button>
              </template>
            </Tooltip></div
        ></template>
      </Tooltip>
      <button
        type="button"
        class="shortcut-add"
        :class="{ 'is-wide': visible.length % 2 === 0 }"
        aria-label="添加快捷卡片"
        aria-haspopup="dialog"
        :aria-expanded="open"
        @pointerdown.stop
        @focusin.stop
        @click="open = !open"
      >
        <Icon :icon="iconPlus" :width="25" :height="25" />
      </button>
      <Dialog
        v-model:open="open"
        title="添加卡片"
        show-close
        :modal="false"
        content-class="shortcut-picker"
        :content-style="pickerPosition"
      >
        <div class="shortcut-functions-heading">
          <h3>常用功能</h3>
          <button type="button" class="shortcut-reset" @click="save([...DEFAULT_SHORTCUT_KEYS])">
            恢复默认
          </button>
        </div>
        <div class="shortcut-candidates">
          <button
            v-for="entry in functions"
            :key="entry.key"
            type="button"
            :disabled="
              REQUIRED_SHORTCUT_KEYS.includes(entry.key) ||
              (entry.disabled && !keys.includes(entry.key))
            "
            :aria-label="`${REQUIRED_SHORTCUT_KEYS.includes(entry.key) ? '必留' : keys.includes(entry.key) ? '移除' : '添加'}${entry.title}`"
            :aria-pressed="keys.includes(entry.key)"
            @click="toggle(entry)"
          >
            <PluginIcon :icon="entry.icon" :width="23" :height="23" />
            <span
              >{{ entry.title }}<small v-if="entry.source">{{ entry.source }}</small></span
            >
            <Icon
              :icon="
                REQUIRED_SHORTCUT_KEYS.includes(entry.key)
                  ? iconLock
                  : keys.includes(entry.key)
                    ? iconMinus
                    : iconPlus
              "
              :width="18"
              :height="18"
            />
          </button>
        </div>
        <section class="shortcut-picker-section" aria-labelledby="shortcut-artists-heading">
          <h3 id="shortcut-artists-heading">常听艺人</h3>
          <div v-if="artistCandidates.length" class="shortcut-artists">
            <button
              v-for="entry in artistCandidates"
              :key="entry.key"
              type="button"
              :aria-label="`${keys.includes(entry.key) ? '移除' : '添加'}艺人${entry.title}`"
              :aria-pressed="keys.includes(entry.key)"
              @click="toggle(entry)"
            >
              <Icon
                class="shortcut-resource-action"
                :icon="keys.includes(entry.key) ? iconMinus : iconPlus"
                :width="18"
                :height="18"
              />
              <Avatar
                :src="entry.resource?.image"
                :alt="entry.title"
                :size="64"
                :show-skeleton="false"
                error-class="!opacity-50"
                class="shortcut-artist-avatar rounded-full"
              />
              <span class="shortcut-resource-label">{{ entry.title }}</span>
            </button>
          </div>
          <p v-else class="shortcut-picker-empty">
            {{
              historyLoading
                ? '正在加载播放记录…'
                : history.hydrated
                  ? '播放歌曲后，常听艺人会出现在这里'
                  : '暂时无法加载播放记录，请稍后重试'
            }}
          </p>
        </section>
        <section class="shortcut-picker-section" aria-labelledby="shortcut-playlists-heading">
          <h3 id="shortcut-playlists-heading">最近常听</h3>
          <div v-if="playlistCandidates.length" class="shortcut-playlists">
            <button
              v-for="entry in playlistCandidates"
              :key="entry.key"
              type="button"
              :aria-label="`${keys.includes(entry.key) ? '移除' : '添加'}歌单${entry.title}`"
              :aria-pressed="keys.includes(entry.key)"
              @click="toggle(entry)"
            >
              <Cover
                :url="entry.resource?.image"
                :alt="entry.title"
                :width="36"
                :height="36"
                :border-radius="5"
              />
              <span>{{ entry.title }}</span>
              <Icon
                :icon="keys.includes(entry.key) ? iconMinus : iconPlus"
                :width="18"
                :height="18"
              />
            </button>
          </div>
          <p v-else class="shortcut-picker-empty">播放过的歌单会出现在这里</p>
        </section>
      </Dialog>
    </div>
  </div>
</template>
<style scoped>
.sidebar-shortcuts {
  padding: 0 18px;
  flex-shrink: 0;
}
.shortcut-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.shortcut-card,
.shortcut-add {
  display: grid;
  place-items: center;
  height: 46px;
  min-height: 0;
  min-width: 0;
  padding: 8px;
  border-radius: 10px;
  background: var(--control-muted-bg);
  color: var(--text-secondary);
  cursor: pointer;
  border: 0;
}
.shortcut-card {
  position: relative;
  overflow: hidden;
  padding: 0;
  cursor: grab;
}
.shortcut-card:is(:hover, :focus-within) {
  background: var(--control-hover-bg);
}
.shortcut-card:active {
  cursor: grabbing;
}
.shortcut-activate {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 8px;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  cursor: inherit;
}
.shortcut-activate > * {
  grid-area: 1/1;
}
.shortcut-remove {
  position: absolute;
  top: 3px;
  right: 3px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  opacity: 0;
  pointer-events: none;
  cursor: pointer;
}
.shortcut-card:is(:hover, :focus-within) .shortcut-remove {
  opacity: 1;
  pointer-events: auto;
}
.shortcut-remove:hover {
  background: var(--control-active-bg);
  color: var(--text-main);
}
.shortcut-label {
  opacity: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-main);
  line-height: 1.35;
  text-align: center;
  overflow-wrap: anywhere;
}
.shortcut-card:is(:hover, :focus-within) .shortcut-label {
  opacity: 1;
}
.shortcut-card:is(:hover, :focus-within) .shortcut-icon {
  opacity: 0;
}
.shortcut-card:has(.shortcut-activate[aria-current='page']) {
  background: var(--control-active-bg);
  color: var(--color-primary-text);
}
.shortcut-add {
  background: transparent;
  border: 1px dashed var(--border-strong);
  color: var(--text-secondary);
}
.shortcut-add:hover {
  background: var(--control-hover-bg);
}
.shortcut-add {
  width: 100%;
}
.shortcut-add.is-wide {
  grid-column: 1/-1;
  aspect-ratio: auto;
  height: 28px;
  padding: 0;
}
.is-collapsed {
  padding: 0 10px;
}
.is-collapsed .shortcut-grid {
  grid-template-columns: 1fr;
}
.is-collapsed .shortcut-card,
.is-collapsed .shortcut-add {
  aspect-ratio: auto;
  height: 40px;
  border-radius: 10px;
}
.is-collapsed .shortcut-label {
  display: none;
}
.is-collapsed .shortcut-card:is(:hover, :focus-within) .shortcut-icon {
  opacity: 1;
}
.shortcut-activate:disabled {
  cursor: default;
  opacity: 0.5;
}
@media (hover: none) {
  .shortcut-remove {
    opacity: 1;
    pointer-events: auto;
  }
  .sidebar-shortcuts:not(.is-collapsed) .shortcut-label {
    opacity: 1;
  }
  .sidebar-shortcuts:not(.is-collapsed) .shortcut-icon {
    opacity: 0;
  }
}
</style>
<style>
.dialog-content.shortcut-picker {
  top: 12px;
  bottom: 12px;
  right: auto;
  height: calc(100vh - 24px);
  max-height: none;
  max-width: calc(100vw - 24px);
  margin: 0;
  padding: 24px 0 24px 24px;
}
.shortcut-reset {
  font-size: 12px;
  color: var(--text-secondary);
}
.shortcut-reset:hover {
  color: var(--text-main);
}
.shortcut-picker-section {
  margin-top: 30px;
}
.shortcut-picker-section h3 {
  margin-bottom: 16px;
  font-size: 17px;
  font-weight: 600;
}
.shortcut-functions-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  font-size: 17px;
  font-weight: 600;
}
.shortcut-artists {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.shortcut-artists button {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 30px 8px 14px;
  min-width: 0;
  border-radius: 12px;
  background: var(--control-muted-bg);
}
.shortcut-artists .shortcut-resource-label {
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}
.shortcut-resource-action {
  position: absolute;
  top: 12px;
  right: 12px;
  color: var(--text-secondary);
}
.shortcut-playlists {
  display: grid;
  gap: 4px;
}
.shortcut-playlists button {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 10px;
  border-radius: 10px;
  text-align: left;
}
.shortcut-playlists span {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shortcut-playlists .cover-container {
  flex-shrink: 0;
}
.shortcut-playlists button > svg {
  flex-shrink: 0;
  color: var(--text-secondary);
}
.shortcut-picker-empty {
  padding: 18px 0;
  color: var(--text-secondary);
  font-size: 13px;
}
.shortcut-picker button {
  cursor: pointer;
}
.shortcut-picker button:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.shortcut-picker :is(.shortcut-artists, .shortcut-playlists, .shortcut-candidates) button:hover {
  background: var(--control-hover-bg);
}
.shortcut-picker button[aria-pressed='true'] {
  color: var(--text-secondary);
}
.shortcut-candidates {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.shortcut-candidates button {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px;
  border-radius: 12px;
  background: var(--control-muted-bg);
  text-align: left;
}
.shortcut-candidates button span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.shortcut-candidates small {
  display: block;
  font-size: 11px;
  color: var(--text-secondary);
}
.shortcut-candidates button:disabled {
  color: var(--text-secondary);
  cursor: default;
}
</style>
