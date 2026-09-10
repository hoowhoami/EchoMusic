<script setup lang="ts">
import WindowControls from './WindowControls.vue';
import TitleBarMoreMenu from './TitleBarMoreMenu.vue';
import { computed, watch, ref, onMounted, onUnmounted } from 'vue';
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
const isLoadingSuggestions = ref(false);
const defaultKeyword = ref('');
const defaultAds = ref<{ mainTitle: string; subTitle: string; title: string }[]>([]);
let suggestTimer: number | null = null;
let suggestionRequest = 0;
let suggestionBlurTimer: number | null = null;

const toggleTaskPanel = () => {
  taskPanelOpen.value = !taskPanelOpen.value;
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
      label: String(item.LableName ?? ''),
      records: (Array.isArray(item.RecordDatas) ? item.RecordDatas : [])
        .map((r) => toRecord(r))
        .filter((r): r is Record<string, unknown> => Boolean(r))
        .map((r) => ({ text: String(r.HintInfo ?? '') }))
        .filter((r) => r.text.length > 0),
    }))
    .filter((c) => c.records.length > 0 && c.label !== 'MV');
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
  cancelSuggestionBlur();
  isSearchFocused.value = true;
  suggestionRequest++;
  if (suggestTimer !== null) window.clearTimeout(suggestTimer);
  suggestTimer = null;
  suggestions.value = [];
  showSuggestions.value = false;
  isLoadingSuggestions.value = false;
  if (!value.trim()) return;
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
  if (e.key === 'Escape') {
    collapseSearch();
  }
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
  window.addEventListener('popstate', updateNavState);
  document.addEventListener('pointerdown', handleGlobalPointerDown, true);
  // 获取默认搜索词
  if (settingStore.searchDefaultEnabled) {
    fetchDefaultSearch();
  }
});

onUnmounted(() => {
  window.removeEventListener('popstate', updateNavState);
  document.removeEventListener('pointerdown', handleGlobalPointerDown, true);
  collapseSearch();
});
</script>

<template>
  <header
    class="native-titlebar title-bar flex items-center shrink-0 select-none transition-colors duration-300 z-200 bg-transparent relative"
  >
    <!-- 拖动层：绝对定位铺满标题栏 -->
    <div class="drag-region"></div>

    <!-- 1. 左侧：导航按钮 -->
    <div
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
                class="tb-search-input"
                :placeholder="defaultKeyword || '搜索音乐、歌手、专辑'"
                @input="handleSearchInput(searchQuery)"
                @keydown.enter.prevent="submitSearch()"
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
              <div v-else-if="isLoadingSuggestions" class="tb-search-status" role="status">
                正在查找建议…
              </div>
              <div v-else-if="showSuggestions" class="tb-suggestions-inner">
                <div v-for="category in suggestions" :key="category.label" class="tb-suggest-group">
                  <div class="tb-suggest-title">{{ category.label }}</div>
                  <Button
                    v-for="record in category.records"
                    :key="`${category.label}-${record.text}`"
                    variant="unstyled"
                    size="none"
                    class="tb-suggest-item"
                    @mousedown.prevent
                    @click="submitSearch(record.text)"
                  >
                    <Icon :icon="iconSearch" width="13" height="13" class="tb-suggest-item-icon" />
                    <span class="truncate">{{ record.text }}</span>
                  </Button>
                </div>
              </div>
              <Button
                v-if="searchQuery.trim()"
                variant="unstyled"
                size="none"
                class="tb-suggest-item"
                @click="submitSearch()"
              >
                <Icon :icon="iconSearch" width="14" height="14" />
                <span class="truncate">搜索「{{ searchQuery.trim() }}」</span>
              </Button>
            </div>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>
    </div>

    <!-- 听歌识曲 -->
    <Button
      variant="unstyled"
      size="none"
      class="nav-btn group no-drag relative z-10"
      tooltip="听歌识曲"
      @click="router.push({ name: 'recognize' })"
    >
      <Icon
        :icon="iconMicrophone"
        width="16"
        height="16"
        style="stroke-width: 3"
        class="text-text-main opacity-60 group-hover:opacity-100 transition-opacity tb-icon-bold"
      />
    </Button>

    <!-- 任务中心 -->
    <Button
      variant="unstyled"
      size="none"
      class="nav-btn group no-drag relative z-10"
      tooltip="任务中心"
      @click="toggleTaskPanel"
    >
      <Icon
        :icon="iconClipboardList"
        width="18"
        height="18"
        class="text-text-main opacity-60 group-hover:opacity-100 transition-opacity"
      />
      <span v-if="taskPanelEntries.length > 0" class="task-badge" />
    </Button>

    <!-- 2. 中间：拖拽区域 -->
    <div class="flex-1 h-full"></div>

    <div class="titlebar-tools no-drag">
      <TitleBarMoreMenu />
    </div>
    <span class="titlebar-window-divider" aria-hidden="true"></span>
    <WindowControls show-mini-player />
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

.tb-suggestions-inner {
  padding: 6px 0;
}

.tb-suggest-group + .tb-suggest-group {
  margin-top: 4px;
}

.tb-suggest-group + .tb-suggest-group .tb-suggest-title {
  border-top: 0.5px solid var(--border-subtle);
  padding-top: 8px;
  margin-top: 2px;
}

.tb-suggest-title {
  padding: 6px 14px 4px;
  font-size: 10px;
  font-weight: 700;
  color: var(--color-primary-text);
  opacity: 0.7;
  letter-spacing: 0.3px;
  text-transform: uppercase;
}

.tb-suggest-item {
  width: calc(100% - 12px);
  margin: 0 6px;
  padding: 7px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-main);
  transition: all 0.15s ease;
  text-align: left;
}

.tb-suggest-item:hover {
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  color: var(--color-primary-text);
}

:global(.dark) .tb-suggest-item:hover {
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
}

.tb-suggest-item-icon {
  flex-shrink: 0;
  opacity: 0.4;
}

.tb-suggest-item-desc {
  margin-left: auto;
  font-size: 11px;
  opacity: 0.45;
  flex-shrink: 1;
  min-width: 0;
}

.task-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-primary);
  box-shadow: 0 0 4px color-mix(in srgb, var(--color-primary) 60%, transparent);
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
