<script setup lang="ts">
import WindowControls from './WindowControls.vue';
import TitleBarMoreMenu from './TitleBarMoreMenu.vue';
import TitlebarActionButton from './TitlebarActionButton.vue';
import { useTitlebarSort } from './useTitlebarSort';
import { useResizeObserver } from '@vueuse/core';
import {
  createTitlebarApi,
  reorderTitlebarLayout,
  titlebarItems,
  resolveTitlebarLayout,
  partitionTitlebarActions,
} from '@/plugins/titlebar';
import { computed, watch, ref, onMounted, onUnmounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { PopoverRoot, PopoverAnchor, PopoverPortal, PopoverContent } from 'reka-ui';
import SearchDiscovery from '@/views/search/components/SearchDiscovery.vue';
import { extractHotCategories } from '@/views/search/searchHelpers';
import type { SearchHotCategory } from '@/views/search/types';
import { getSearchSuggest, getSearchDefault, getSearchHot } from '@/api/search';
import { useSettingStore } from '@/stores/setting';
import {
  dismissTaskEntry,
  getTaskStatusLabel,
  isManuallyDismissibleTask,
  taskPanelEntries,
  taskPanelOpen,
} from '@/plugins/taskPanel';
import Button from '@/components/ui/Button.vue';
import RefreshIcon from '@/components/ui/RefreshIcon.vue';
import Dialog from '@/components/ui/Dialog.vue';
import {
  iconChevronLeft,
  iconChevronRight,
  iconX,
  iconSearch,
  iconMicrophone,
  iconClipboardList,
  iconHeadphones,
} from '@/icons';

const route = useRoute();
const router = useRouter();
const isMac = computed(() => window.electron.platform === 'darwin');
const settingStore = useSettingStore();
const navStartClass = computed(() =>
  isMac.value && !settingStore.sidebarCollapseEnabled ? 'pl-6' : 'pl-4',
);

// 侧边栏折叠
const props = defineProps<{
  isSidebarCollapsed?: boolean;
}>();

const canGoBack = ref(false);
const canGoForward = ref(false);

// 搜索状态
const isSearchFocused = ref(false);
const searchQuery = ref('');
const searchInputRef = ref<HTMLInputElement | null>(null);
const searchContainerRef = ref<HTMLElement | null>(null);
const searchPanelRef = ref<HTMLElement | null>(null);
const hotSearchCategories = ref<SearchHotCategory[]>([]);
const isLoadingHot = ref(false);
let hotSearchLoaded = false;
const showSuggestions = ref(false);
const suggestions = ref<{ label: string; records: { text: string }[] }[]>([]);
const activeSuggestionIndex = ref(-1);
const suggestionGroups = computed(() => {
  let index = 0;
  return suggestions.value.map((category) => ({
    ...category,
    records: category.records.map((record) => ({ ...record, index: index++ })),
  }));
});
const flatSuggestions = computed(() => suggestionGroups.value.flatMap((group) => group.records));
const activeSuggestionId = computed(() =>
  isSearchFocused.value && showSuggestions.value && activeSuggestionIndex.value >= 0
    ? `search-suggestion-${activeSuggestionIndex.value}`
    : undefined,
);
const isLoadingSuggestions = ref(false);
const defaultKeyword = ref('');
const defaultAds = ref<{ mainTitle: string; subTitle: string; title: string }[]>([]);
let suggestTimer: number | null = null;
let suggestionRequest = 0;
let suggestionBlurTimer: number | null = null;

const toggleTaskPanel = () => {
  taskPanelOpen.value = !taskPanelOpen.value;
};

const titlebarRef = ref<HTMLElement | null>(null);
const navigationRef = ref<HTMLElement | null>(null);
const windowActionsRef = ref<HTMLElement | null>(null);
const toolbarCapacity = ref(0);
const managedActions = computed(() =>
  resolveTitlebarLayout(titlebarItems.value, settingStore.titlebarLayout),
);
const placedActions = computed(() =>
  partitionTitlebarActions(managedActions.value, toolbarCapacity.value),
);
const primaryActions = computed(() =>
  placedActions.value.toolbar.filter((item) => item.pluginId === null),
);
const pluginActions = computed(() =>
  placedActions.value.toolbar.filter((item) => item.pluginId !== null),
);
const primaryActionsRef = ref<HTMLElement | null>(null);
const pluginActionsRef = ref<HTMLElement | null>(null);
const saveToolbarOrder = (keys: string[]) => {
  settingStore.titlebarLayout = reorderTitlebarLayout(
    settingStore.titlebarLayout,
    managedActions.value,
    keys,
  );
};
useTitlebarSort(
  primaryActionsRef,
  () => primaryActions.value.map((item) => item.key),
  saveToolbarOrder,
  '.titlebar-action',
);
useTitlebarSort(
  pluginActionsRef,
  () => pluginActions.value.map((item) => item.key),
  saveToolbarOrder,
  '.titlebar-action',
);
const updateToolbarCapacity = () => {
  if (!titlebarRef.value || !navigationRef.value) return;
  const style = getComputedStyle(titlebarRef.value);
  const available =
    titlebarRef.value.clientWidth -
    parseFloat(style.paddingLeft || '0') -
    parseFloat(style.paddingRight || '0');
  // Reserve the search/navigation width, window controls, More, divider and a drag area.
  // Measure fixed space only, so moving overflow items cannot cause resize oscillation.
  const navigationWidth = parseFloat(getComputedStyle(navigationRef.value).flexBasis) || 410;
  const fixedWidth = navigationWidth + (windowActionsRef.value?.offsetWidth ?? 0) + 58 + 17 + 64;
  toolbarCapacity.value = Math.max(0, Math.floor((available - fixedWidth) / 38));
};
useResizeObserver([titlebarRef, windowActionsRef], updateToolbarCapacity);
const builtinDisposers: (() => void)[] = [];
const builtinApi = createTitlebarApi(
  null,
  (dispose) => builtinDisposers.push(dispose),
  (source, error) => console.error(source, error),
);
const registerBuiltinActions = () => {
  builtinApi.register({
    id: 'recognize',
    title: '听歌识曲',
    icon: iconMicrophone,
    defaultPlacement: 'toolbar',
    order: 10,
    onClick: async () => {
      await router.push({ name: 'recognize' });
    },
  });
  builtinApi.register({
    id: 'tasks',
    title: '任务中心',
    icon: iconClipboardList,
    defaultPlacement: 'toolbar',
    order: 20,
    onClick: toggleTaskPanel,
  });
  builtinApi.register({
    id: 'listen-together',
    title: '一起听',
    icon: iconHeadphones,
    order: 30,
    onClick: async () => {
      await router.push({ name: 'listen-together' });
    },
  });
};

// 进度条宽度钳制在 [0, 100]，防止插件注册的任务传入越界 percent
const clampPercent = (percent: number | undefined): number => {
  if (typeof percent !== 'number' || Number.isNaN(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
};

const updateNavState = () => {
  if (typeof window === 'undefined') return;
  const historyState = window.history.state as {
    back?: string | null;
    forward?: string | null;
  } | null;
  const skipCurrent = route.matched.some((record) => record.meta?.skipHistory === true);
  canGoBack.value = !skipCurrent && !!historyState?.back;
  canGoForward.value = !skipCurrent && !!historyState?.forward;
};

const goBack = () => {
  if (canGoBack.value) router.back();
};
const goForward = () => {
  if (canGoForward.value) router.forward();
};
const refresh = async () => {
  await router.replace({
    path: route.path,
    query: { ...route.query, _t: Date.now().toString() },
    hash: route.hash,
  });
};

// 搜索逻辑
const toRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null;

const extractSuggestions = (payload: unknown) => {
  const record = toRecord(payload);
  const list = Array.isArray(record?.data) ? record.data : [];
  return list
    .map((item) => toRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      label: String(item.LableName ?? '').trim() || '综合',
      records: (Array.isArray(item.RecordDatas) ? item.RecordDatas : [])
        .map((r) => toRecord(r))
        .filter((r): r is Record<string, unknown> => Boolean(r))
        .map((r) => ({ text: String(r.HintInfo ?? '') }))
        .filter((r) => r.text.length > 0),
    }))
    .filter((c) => c.records.length > 0 && c.label !== 'MV');
};

const suggestionParts = (text: string) => {
  const keyword = searchQuery.value.trim();
  const index = text.toLocaleLowerCase().indexOf(keyword.toLocaleLowerCase());
  if (!keyword || index < 0) return [{ text, matched: false }];
  return [
    { text: text.slice(0, index), matched: false },
    { text: text.slice(index, index + keyword.length), matched: true },
    { text: text.slice(index + keyword.length), matched: false },
  ].filter((part) => part.text);
};

const loadHotSearches = async () => {
  if (hotSearchLoaded || isLoadingHot.value) return;
  isLoadingHot.value = true;
  try {
    hotSearchCategories.value = extractHotCategories(await getSearchHot());
    hotSearchLoaded = true;
  } catch {
    hotSearchCategories.value = [];
  } finally {
    isLoadingHot.value = false;
  }
};

const cancelSuggestionBlur = () => {
  if (suggestionBlurTimer !== null) window.clearTimeout(suggestionBlurTimer);
  suggestionBlurTimer = null;
};

const collapseSearch = () => {
  activeSuggestionIndex.value = -1;
  cancelSuggestionBlur();
  if (suggestTimer !== null) window.clearTimeout(suggestTimer);
  suggestTimer = null;
  suggestionRequest++;
  isSearchFocused.value = false;
  showSuggestions.value = false;
  isLoadingSuggestions.value = false;
};

const fetchSuggestions = async (keyword: string) => {
  const request = ++suggestionRequest;
  isLoadingSuggestions.value = true;
  try {
    const result = await getSearchSuggest(keyword);
    if (request !== suggestionRequest || searchQuery.value.trim() !== keyword) return;
    suggestions.value = extractSuggestions(result);
    activeSuggestionIndex.value = -1;
    showSuggestions.value = isSearchFocused.value && suggestions.value.length > 0;
  } catch {
    if (request !== suggestionRequest) return;
    suggestions.value = [];
    showSuggestions.value = false;
  } finally {
    if (request === suggestionRequest) isLoadingSuggestions.value = false;
  }
};

const handleSearchInput = (value: string) => {
  activeSuggestionIndex.value = -1;
  cancelSuggestionBlur();
  isSearchFocused.value = true;
  suggestionRequest++;
  if (suggestTimer !== null) window.clearTimeout(suggestTimer);
  suggestTimer = null;
  suggestions.value = [];
  showSuggestions.value = false;
  isLoadingSuggestions.value = false;
  if (!value.trim()) return;
  isLoadingSuggestions.value = true;
  suggestTimer = window.setTimeout(() => {
    suggestTimer = null;
    void fetchSuggestions(value.trim());
  }, 280);
};

const submitSearch = (keyword?: string) => {
  const q = (keyword ?? searchQuery.value).trim() || defaultKeyword.value;
  if (!q) return;
  searchQuery.value = q;
  suggestions.value = [];
  collapseSearch();
  searchInputRef.value?.blur();
  if (route.name === 'search' && route.query.q === q) {
    // 同词再次提交也要真正执行，使用现有页面刷新机制而非重复导航。
    const revision = String(Math.max(Date.now(), Number(route.query._t || 0) + 1));
    void router.replace({ name: 'search', query: { q, _t: revision } });
  } else {
    void router.push({ name: 'search', query: { q } });
  }
};

const handleSearchBlur = () => {
  cancelSuggestionBlur();
  suggestionBlurTimer = window.setTimeout(() => {
    if (
      searchContainerRef.value?.contains(document.activeElement) ||
      searchPanelRef.value?.contains(document.activeElement)
    )
      return;
    collapseSearch();
  }, 180);
};

const handleGlobalPointerDown = (e: PointerEvent) => {
  if (!isSearchFocused.value) return;
  if (
    searchContainerRef.value?.contains(e.target as Node) ||
    searchPanelRef.value?.contains(e.target as Node)
  )
    return;
  collapseSearch();
};

const handleNativePointerDown = (point?: unknown) => {
  if (!isSearchFocused.value) return;
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
    // 原生通知异步到达，只处理拖动层；历史按钮等普通区域仍由 DOM 事件判断，
    // 避免删除历史后原位置的节点变化被误判为外部点击。
    const target = document.elementFromPoint(point.x, point.y);
    if (!target?.closest('.native-titlebar .drag-region')) return;
  }
  collapseSearch();
  searchInputRef.value?.blur();
};

const handleSearchFocus = () => {
  void loadHotSearches();
  cancelSuggestionBlur();
  isSearchFocused.value = true;
  const keyword = searchQuery.value.trim();
  if (!keyword) return;
  if (suggestions.value.length > 0) showSuggestions.value = true;
  else if (!isLoadingSuggestions.value) void fetchSuggestions(keyword);
};

// 关闭由本组件的外部 pointerdown、延迟失焦和 Escape 统一管理。
// Reka 的 focusOutside 会跨 nextTick 检查旧事件；历史节点被删除后，
// 即使当前焦点已回到输入框，旧节点也会被误判为外部，不能再让它触发第二次关闭。
const handleSearchInteractOutside = (event: Event) => {
  event.preventDefault();
};

// 历史按钮可能随删除操作被卸载，先把焦点交回输入框，避免落到 body 触发关闭。
const clearSearchHistory = () => {
  searchInputRef.value?.focus({ preventScroll: true });
  cancelSuggestionBlur();
  settingStore.clearSearchHistory();
};

const removeSearchHistory = (keyword: string) => {
  searchInputRef.value?.focus({ preventScroll: true });
  cancelSuggestionBlur();
  settingStore.removeFromSearchHistory(keyword);
};

const handleSearchKeydown = (e: KeyboardEvent) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    collapseSearch();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    const selected =
      isSearchFocused.value && showSuggestions.value
        ? flatSuggestions.value[activeSuggestionIndex.value]
        : undefined;
    submitSearch(selected?.text);
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  if (!searchQuery.value.trim()) return;
  e.preventDefault();
  e.stopPropagation();
  if (!isSearchFocused.value) handleSearchFocus();
  const count = flatSuggestions.value.length;
  if (!count || isLoadingSuggestions.value) return;
  showSuggestions.value = true;
  const current = activeSuggestionIndex.value;
  activeSuggestionIndex.value =
    current < 0
      ? e.key === 'ArrowDown'
        ? 0
        : count - 1
      : (current + (e.key === 'ArrowDown' ? 1 : -1) + count) % count;
  void nextTick(() => {
    searchPanelRef.value
      ?.querySelector(`[data-suggestion-index="${activeSuggestionIndex.value}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
};

watch(
  () => route.fullPath,
  () => {
    updateNavState();
    // 路由变化时关闭搜索建议
    collapseSearch();
  },
  { immediate: true },
);

// 路由是已提交关键词的唯一来源，热搜、历史和前进后退共用此入口。
watch(
  () => [route.name, route.query.q] as const,
  ([name, keyword]) => {
    if (name !== 'search') return;
    collapseSearch();
    searchQuery.value = typeof keyword === 'string' ? keyword.trim() : '';
    suggestions.value = [];
  },
  { immediate: true },
);

watch(
  () => settingStore.searchDefaultEnabled,
  (enabled) => {
    if (enabled) {
      fetchDefaultSearch();
    } else {
      defaultKeyword.value = '';
      defaultAds.value = [];
    }
  },
);

const fetchDefaultSearch = () => {
  getSearchDefault()
    .then((res: any) => {
      const ads = res?.data?.ads ?? res?.ads ?? [];
      if (!Array.isArray(ads) || ads.length === 0) return;
      const first = ads[0];
      if (first?.main_title) {
        defaultKeyword.value = String(first.main_title).trim();
      }
      defaultAds.value = ads
        .filter((ad: any) => ad?.sub_title || ad?.main_title)
        .map((ad: any) => ({
          mainTitle: String(ad.main_title ?? '').trim(),
          subTitle: String(ad.sub_title ?? '').trim(),
          title: String(ad.title ?? '').trim(),
        }));
    })
    .catch(() => {});
};

onMounted(() => {
  registerBuiltinActions();
  updateToolbarCapacity();
  window.addEventListener('popstate', updateNavState);
  document.addEventListener('pointerdown', handleGlobalPointerDown, true);
  window.electron.ipcRenderer.on('window:native-pointerdown', handleNativePointerDown);
  // 获取默认搜索词
  if (settingStore.searchDefaultEnabled) {
    fetchDefaultSearch();
  }
});

onUnmounted(() => {
  builtinDisposers.forEach((dispose) => dispose());
  window.removeEventListener('popstate', updateNavState);
  document.removeEventListener('pointerdown', handleGlobalPointerDown, true);
  window.electron.ipcRenderer.off('window:native-pointerdown', handleNativePointerDown);
  collapseSearch();
});
</script>

<template>
  <header
    ref="titlebarRef"
    class="native-titlebar title-bar flex items-center shrink-0 select-none transition-colors duration-300 z-200 bg-transparent relative"
  >
    <!-- 拖动层：绝对定位铺满标题栏 -->
    <div class="drag-region"></div>

    <!-- 1. 左侧：导航按钮 -->
    <div
      ref="navigationRef"
      class="titlebar-nav flex items-center gap-1 no-drag relative z-10"
      :class="navStartClass"
      :style="
        isMac
          ? {
              paddingLeft: `max(${settingStore.sidebarCollapseEnabled ? 16 : 24}px, calc(var(--window-controls-left-inset, 0px) - ${props.isSidebarCollapsed ? 80 : 230}px))`,
            }
          : {
              paddingLeft: `max(16px, calc(var(--window-controls-left-inset, 0px) - ${props.isSidebarCollapsed ? 80 : 230}px + 16px))`,
            }
      "
    >
      <Button
        variant="unstyled"
        size="none"
        @click="goBack"
        class="nav-btn group"
        :disabled="!canGoBack"
        tooltip="后退"
      >
        <Icon
          :icon="iconChevronLeft"
          width="22"
          height="22"
          :class="[
            'text-text-main transition-opacity',
            canGoBack ? 'opacity-60 group-hover:opacity-100' : 'opacity-40',
          ]"
        />
      </Button>
      <Button
        variant="unstyled"
        size="none"
        @click="goForward"
        class="nav-btn group"
        :disabled="!canGoForward"
        tooltip="前进"
      >
        <Icon
          :icon="iconChevronRight"
          width="22"
          height="22"
          :class="[
            'text-text-main transition-opacity',
            canGoForward ? 'opacity-60 group-hover:opacity-100' : 'opacity-40',
          ]"
        />
      </Button>
      <Button variant="unstyled" size="none" @click="refresh" class="nav-btn group" tooltip="刷新">
        <RefreshIcon
          width="20"
          height="20"
          class="text-text-main opacity-60 group-hover:opacity-100 transition-opacity"
        />
      </Button>

      <!-- 输入框保持紧凑，发现面板独立展开并传送到顶层。 -->
      <PopoverRoot :open="isSearchFocused" @update:open="!$event && collapseSearch()">
        <PopoverAnchor as-child>
          <div ref="searchContainerRef" class="tb-search">
            <div class="tb-search-input-wrap">
              <Icon :icon="iconSearch" width="15" height="15" class="tb-search-icon" />
              <input
                ref="searchInputRef"
                v-model="searchQuery"
                type="text"
                aria-label="搜索音乐、歌手、专辑"
                role="combobox"
                aria-autocomplete="list"
                :aria-expanded="isSearchFocused && showSuggestions && !isLoadingSuggestions"
                :aria-controls="
                  showSuggestions && !isLoadingSuggestions ? 'search-suggestions-list' : undefined
                "
                :aria-activedescendant="activeSuggestionId"
                class="tb-search-input"
                :placeholder="defaultKeyword || '搜索音乐、歌手、专辑'"
                @input="handleSearchInput(searchQuery)"
                @keydown="handleSearchKeydown"
                @focus="handleSearchFocus"
                @click="handleSearchFocus"
                @blur="handleSearchBlur"
              />
              <Button
                v-if="searchQuery"
                variant="unstyled"
                size="none"
                class="tb-search-clear"
                aria-label="清除搜索"
                @mousedown.prevent
                @click="
                  searchQuery = '';
                  handleSearchInput('');
                  searchInputRef?.focus();
                "
              >
                <Icon :icon="iconX" width="14" height="14" />
              </Button>
            </div>
          </div>
        </PopoverAnchor>
        <PopoverPortal>
          <PopoverContent
            as-child
            align="start"
            side="bottom"
            :side-offset="8"
            :collision-padding="12"
            @open-auto-focus.prevent
            @close-auto-focus.prevent
            @escape-key-down="collapseSearch()"
            @interact-outside="handleSearchInteractOutside"
          >
            <div
              ref="searchPanelRef"
              class="tb-search-panel no-drag"
              :class="{ 'has-query': searchQuery.trim() }"
              aria-label="搜索建议与发现"
              @focusin="cancelSuggestionBlur"
              @focusout="handleSearchBlur"
              @pointerdown="cancelSuggestionBlur"
            >
              <template v-if="!searchQuery.trim()">
                <SearchDiscovery
                  class="tb-search-discovery"
                  :hot-search-categories="hotSearchCategories"
                  :is-loading-hot="isLoadingHot"
                  :search-history="settingStore.searchHistory ?? []"
                  @clear-history="clearSearchHistory"
                  @remove-history="removeSearchHistory($event)"
                  @pick-keyword="submitSearch($event)"
                />
                <div v-if="defaultAds.length" class="tb-search-recommendations">
                  <div class="tb-suggest-title">推荐搜索</div>
                  <div class="tb-search-chips">
                    <Button
                      v-for="(ad, index) in defaultAds"
                      :key="index"
                      variant="unstyled"
                      size="none"
                      class="tb-search-chip"
                      @click="submitSearch(ad.subTitle || ad.mainTitle)"
                    >
                      {{ ad.subTitle || ad.mainTitle }}
                    </Button>
                  </div>
                </div>
              </template>
              <div v-else class="tb-query-panel">
                <div
                  v-if="isLoadingSuggestions"
                  class="tb-query-loading"
                  role="status"
                  aria-live="polite"
                >
                  <span class="tb-search-status">正在查找建议…</span>
                  <div
                    v-for="row in 3"
                    :key="row"
                    class="tb-query-skeleton"
                    aria-hidden="true"
                  ></div>
                </div>
                <div
                  v-else-if="showSuggestions"
                  id="search-suggestions-list"
                  class="tb-suggestions-inner"
                  role="listbox"
                  aria-label="搜索建议"
                >
                  <section
                    v-for="category in suggestionGroups"
                    :key="category.label"
                    class="tb-suggest-group"
                    role="group"
                    :aria-label="category.label"
                  >
                    <h3 class="tb-suggest-heading">{{ category.label }}</h3>
                    <Button
                      v-for="record in category.records"
                      :key="`${category.label}-${record.text}`"
                      variant="unstyled"
                      size="none"
                      class="tb-suggest-item"
                      :class="{ 'is-active': activeSuggestionIndex === record.index }"
                      :id="`search-suggestion-${record.index}`"
                      :data-suggestion-index="record.index"
                      role="option"
                      :aria-selected="activeSuggestionIndex === record.index"
                      :tabindex="-1"
                      @pointermove="activeSuggestionIndex = record.index"
                      @mousedown.prevent
                      @click="submitSearch(record.text)"
                    >
                      <span class="tb-suggest-text"
                        ><span
                          v-for="(part, index) in suggestionParts(record.text)"
                          :key="index"
                          :class="{ 'tb-suggest-match': part.matched }"
                          >{{ part.text }}</span
                        ></span
                      >
                      <span class="tb-suggest-trailing" aria-hidden="true">↵</span>
                    </Button>
                  </section>
                </div>
                <div v-else class="tb-query-empty" role="status">
                  <span>暂无相关建议</span>
                </div>
                <div class="tb-query-footer">
                  <button
                    type="button"
                    class="tb-query-submit"
                    @mousedown.prevent
                    @click="submitSearch()"
                  >
                    搜索“{{ searchQuery.trim() }}”
                  </button>
                  <span class="tb-query-hint" aria-hidden="true">↑↓ 选择 · Enter 确认</span>
                </div>
              </div>
            </div>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>
    </div>

    <div
      v-if="primaryActions.length"
      ref="primaryActionsRef"
      class="titlebar-primary-actions no-drag"
    >
      <TitlebarActionButton
        v-for="item in primaryActions"
        :key="item.key"
        :action="item"
        :data-titlebar-key="item.key"
        :badge="item.id === 'tasks' && taskPanelEntries.length > 0"
      />
    </div>

    <!-- 2. 中间：拖拽区域 -->
    <div class="flex-1 h-full"></div>

    <div class="titlebar-tools no-drag">
      <div v-if="pluginActions.length" ref="pluginActionsRef" class="titlebar-primary-actions">
        <TitlebarActionButton
          v-for="item in pluginActions"
          :key="item.key"
          :action="item"
          :data-titlebar-key="item.key"
        />
      </div>
      <TitleBarMoreMenu :items="managedActions" />
    </div>
    <span class="titlebar-window-divider" aria-hidden="true"></span>
    <div ref="windowActionsRef" class="titlebar-window-actions">
      <WindowControls show-mini-player />
    </div>
  </header>

  <!-- 任务中心弹窗 -->
  <Dialog v-model:open="taskPanelOpen" content-class="task-panel-dialog" show-close>
    <template #title>任务中心 </template>

    <div
      v-if="taskPanelEntries.length === 0"
      class="py-2 text-[13px] text-text-secondary text-center"
    >
      空空如也~
    </div>
    <div v-else class="flex flex-col gap-3">
      <div v-for="task in taskPanelEntries" :key="task.id" class="task-item">
        <div class="task-item-header">
          <div class="task-item-heading">
            <span class="task-item-name">{{ task.name }}</span>
            <span class="task-item-status">{{
              task.progress?.label || getTaskStatusLabel(task.status)
            }}</span>
          </div>
          <div
            v-if="(task.actions && task.actions.length) || isManuallyDismissibleTask(task)"
            class="task-item-actions"
          >
            <button
              v-for="action in task.actions"
              :key="action.id"
              type="button"
              class="task-text-action"
              :class="{
                'is-primary': action.variant === 'primary',
                'is-danger': action.variant === 'danger',
              }"
              :disabled="action.disabled"
              @click="action.onClick()"
            >
              {{ action.label }}
            </button>
            <button
              v-if="isManuallyDismissibleTask(task)"
              type="button"
              class="task-text-action"
              @click="dismissTaskEntry(task.id, task.generation)"
            >
              关闭
            </button>
          </div>
        </div>
        <div v-if="task.progress && task.progress.percent != null" class="task-item-progress">
          <div
            class="task-item-progress-bar"
            :style="{ width: `${clampPercent(task.progress.percent)}%` }"
          />
        </div>
        <div v-if="task.items?.length" class="task-item-details">
          <div v-for="item in task.items" :key="item.id" class="task-detail-row">
            <div class="task-detail-text">
              <div class="task-detail-name">{{ item.name }}</div>
              <div v-if="item.description" class="task-detail-description">
                {{ item.description }}
              </div>
              <div v-if="item.error" class="task-detail-error">{{ item.error }}</div>
            </div>
            <span v-if="item.statusLabel" class="task-detail-description">{{
              item.statusLabel
            }}</span>
            <button
              v-for="action in item.actions"
              :key="action.id"
              type="button"
              class="task-text-action"
              :class="{
                'is-primary': action.variant === 'primary',
                'is-danger': action.variant === 'danger',
              }"
              :disabled="action.disabled"
              @click="action.onClick()"
            >
              {{ action.label }}
            </button>
          </div>
        </div>
        <div v-if="task.error" class="task-item-error">
          <span class="task-item-error-text">{{ task.error }}</span>
        </div>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.title-bar {
  height: max(46px, calc(35px / var(--window-zoom-factor, 1)));
}

.titlebar-nav {
  min-width: 0;
  flex: 0 1 410px;
  transition: padding-left 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}

.nav-btn {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  transition: all 0.2s;
  background: transparent;
  border: none;
}

.nav-btn:hover {
  background-color: var(--control-hover-bg);
}

.nav-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.nav-btn:disabled:hover {
  background-color: transparent;
}

/* 加粗图标（穿透到 SVG 内部） */
.tb-icon-bold :deep(path),
.tb-icon-bold :deep(line),
.tb-icon-bold :deep(circle),
.tb-icon-bold :deep(polyline) {
  stroke-width: 2.5 !important;
}

/* 搜索区域 */
.tb-search {
  flex: 1;
  min-width: 80px;
  max-width: 280px;
  margin: 0 8px;
  position: relative;
  display: flex;
  align-items: center;
}

.titlebar-window-divider {
  width: 1px;
  height: 20px;
  flex-shrink: 0;
  margin-right: 8px;
  background: color-mix(in srgb, var(--color-text-main) 24%, transparent);
  position: relative;
  z-index: 10;
}

.titlebar-primary-actions,
.titlebar-window-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 4px;
  position: relative;
  z-index: 10;
}
.titlebar-window-actions {
  height: 100%;
}

.titlebar-tools {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0 12px;
  position: relative;
  z-index: 10;
  flex-shrink: 0;
}

.tb-search-input-wrap {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  height: 30px;
  border-radius: 999px;
  background: var(--control-muted-bg);
  padding: 0 4px 0 10px;
  transition: all 0.2s ease;
  border: 1px solid transparent;
}

.tb-search-input-wrap:focus-within {
  background: var(--control-muted-bg);
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 12%, transparent);
}

.tb-search-icon {
  flex-shrink: 0;
  color: var(--color-text-secondary);
  opacity: 0.6;
}

.tb-search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  padding: 0 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-main);
}

.tb-search-input::placeholder {
  color: var(--color-text-secondary);
  opacity: 0.5;
}

.tb-search-clear {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  transition: all 0.15s ease;
}

.tb-search-clear:hover {
  color: var(--color-text-main);
  background: var(--control-hover-bg);
}

/* 搜索建议下拉 */
.tb-search-panel {
  position: relative;
  width: min(760px, calc(100vw - 24px));
  max-width: var(--reka-popover-content-available-width);
  max-height: min(520px, var(--reka-popover-content-available-height));
  overflow-y: auto;
  overscroll-behavior: contain;
  border-radius: 12px;
  background: var(--color-bg-elevated);
  color: var(--color-text-main);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-elevated);
  padding: 8px 0;
  z-index: 9999;
  outline: none;
}
.tb-search-discovery {
  padding: 14px 20px 20px;
}
.tb-search-recommendations {
  padding: 0 10px 12px;
}
.tb-search-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 10px;
}
.tb-search-chip {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 6px 10px;
  border-radius: 16px;
  font-size: 12px;
  background: var(--control-muted-bg);
}
.tb-search-chip:hover {
  background: var(--control-hover-bg);
}
.tb-search-status {
  padding: 16px;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.tb-search-panel.has-query {
  width: min(440px, calc(100vw - 24px));
  padding: 0;
  scroll-padding-block: 12px 48px;
}
.tb-query-footer {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 38px;
  padding: 6px 16px;
  border-top: 1px solid var(--border-subtle);
  background: var(--color-bg-elevated);
  font-size: 12px;
}
.tb-query-submit {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-primary-text);
  cursor: pointer;
  border-radius: 4px;
}
.tb-query-submit:focus-visible {
  outline: 2px solid var(--color-primary-text);
  outline-offset: 3px;
}
.tb-query-hint {
  font-size: 11px;
  margin-left: auto;
  flex-shrink: 0;
  color: var(--color-text-secondary);
}
.tb-suggestions-inner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
}
.tb-suggest-group + .tb-suggest-group {
  margin-top: 2px;
  padding-top: 6px;
  border-top: 1px solid var(--border-subtle);
}
.tb-suggest-heading {
  margin: 0;
  padding: 7px 10px 4px;
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  color: var(--color-text-secondary);
}
.tb-suggest-title {
  padding: 6px 14px 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}
.tb-suggest-item {
  width: 100%;
  min-height: 36px;
  padding: 7px 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 22px;
  font-weight: 400;
  color: var(--color-text-main);
  text-align: left;
  transition: background-color 0.15s ease;
}
.tb-suggest-item.is-active,
.tb-suggest-item:focus-visible {
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}
.tb-suggest-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tb-suggest-match {
  font-weight: 600;
}
.tb-suggest-trailing {
  flex-shrink: 0;
  width: 18px;
  text-align: center;
  font-size: 14px;
  color: var(--color-text-secondary);
  opacity: 0;
}
.tb-suggest-item.is-active .tb-suggest-trailing,
.tb-suggest-item:focus-visible .tb-suggest-trailing {
  opacity: 0.8;
}
.tb-query-loading {
  padding: 12px 22px 20px;
}
.tb-query-loading .tb-search-status {
  display: block;
  padding: 4px 0 14px;
}
.tb-query-skeleton {
  height: 12px;
  width: 70%;
  border-radius: 6px;
  background: var(--control-muted-bg);
  margin: 0 0 22px;
}
.tb-query-skeleton:nth-of-type(2) {
  width: 50%;
}
.tb-query-skeleton:last-child {
  width: 60%;
  margin-bottom: 0;
}
.tb-query-empty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 28px 20px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-secondary);
}
.tb-query-empty span + span {
  font-size: 12px;
  opacity: 0.7;
}

:global(.dialog-content.task-panel-dialog) {
  width: 420px;
  max-width: calc(100vw - 48px);
}

/* 任务项 */
.task-item {
  padding: 8px 0;
}

.task-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-item-heading {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow-wrap: anywhere;
}

.task-item-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-main);
  flex: 1;
  min-width: 0;
}

.task-item-status {
  font-size: 11px;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.task-item-progress {
  margin-top: 8px;
  height: 4px;
  border-radius: 999px;
  background: var(--control-muted-bg);
  overflow: hidden;
}

.task-item-progress-bar {
  height: 100%;
  border-radius: 999px;
  background: var(--color-primary);
  transition: width 0.3s ease;
}

.task-item-error {
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.task-item-error-text {
  font-size: 11px;
  color: var(--color-danger, #ef4444);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-item-details {
  margin-top: 10px;
  max-height: 260px;
  overflow-y: auto;
}
.task-detail-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid var(--control-muted-bg);
}
.task-detail-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.task-detail-name {
  font-size: 12px;
  color: var(--color-text-main);
}
.task-detail-description {
  font-size: 11px;
  color: var(--color-text-secondary);
}
.task-detail-error {
  font-size: 11px;
  color: var(--color-danger, #ef4444);
}
.task-item-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px 12px;
  max-width: 55%;
}
.task-text-action {
  appearance: none;
  background: transparent;
  border: 0;
  padding: 4px 0;
  min-height: 28px;
  font: inherit;
  font-size: 12px;
  color: var(--color-text-secondary);
  cursor: pointer;
  white-space: nowrap;
  border-radius: 3px;
}
.task-text-action.is-primary {
  color: var(--color-primary-text);
}
.task-text-action.is-danger {
  color: var(--color-danger, #ef4444);
}
.task-text-action:hover:not(:disabled) {
  opacity: 0.8;
}
.task-text-action:focus-visible {
  outline: 2px solid var(--color-primary-text);
  outline-offset: 3px;
}
.task-text-action:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
