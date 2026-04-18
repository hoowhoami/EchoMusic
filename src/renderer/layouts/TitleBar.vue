<script setup lang="ts">
import { computed, watch, ref, onMounted, onUnmounted, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getSearchSuggest } from '@/api/search';
import Button from '@/components/ui/Button.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import RefreshIcon from '@/components/ui/RefreshIcon.vue';
import {
  iconChevronLeft,
  iconChevronRight,
  iconMinus,
  iconSquare,
  iconX,
  iconSearch,
} from '@/icons';
import { useWindowDrag } from '@/utils/useWindowDrag';

const route = useRoute();
const router = useRouter();
const isMac = computed(() => window.electron.platform === 'darwin');
const titleBarRef = ref<HTMLElement | null>(null);

useWindowDrag(titleBarRef);

const canGoBack = ref(false);
const canGoForward = ref(false);

// 搜索状态
const isSearchExpanded = ref(false);
const searchQuery = ref('');
const searchInputRef = ref<HTMLInputElement | null>(null);
const searchContainerRef = ref<HTMLElement | null>(null);
const showSuggestions = ref(false);
const suggestions = ref<{ label: string; records: { text: string }[] }[]>([]);
const isLoadingSuggestions = ref(false);
let suggestTimer: number | null = null;

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

const handleControl = (action: 'minimize' | 'maximize' | 'close') => {
  window.electron.windowControl(action);
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

const expandSearch = async () => {
  isSearchExpanded.value = true;
  await nextTick();
  searchInputRef.value?.focus();
};

const collapseSearch = () => {
  showSuggestions.value = false;
  searchQuery.value = '';
  suggestions.value = [];
  isSearchExpanded.value = false;
};

const handleSearchInput = (value: string) => {
  if (suggestTimer) {
    window.clearTimeout(suggestTimer);
    suggestTimer = null;
  }
  if (!value.trim()) {
    suggestions.value = [];
    showSuggestions.value = false;
    return;
  }
  isLoadingSuggestions.value = true;
  suggestTimer = window.setTimeout(async () => {
    try {
      const res = await getSearchSuggest(value.trim());
      if (searchQuery.value.trim() !== value.trim()) return;
      suggestions.value = extractSuggestions(res);
      showSuggestions.value = suggestions.value.length > 0;
    } catch {
      suggestions.value = [];
    }
    isLoadingSuggestions.value = false;
  }, 280);
};

const submitSearch = (keyword?: string) => {
  const q = (keyword ?? searchQuery.value).trim();
  if (!q) return;
  collapseSearch();
  router.push({ name: 'search', query: { q } });
};

const handleSearchBlur = () => {
  // 延迟收起，给建议项点击留出时间
  window.setTimeout(() => {
    // 如果焦点仍在搜索区域内，不收起
    if (searchContainerRef.value?.contains(document.activeElement)) return;
    collapseSearch();
  }, 180);
};

const handleGlobalPointerDown = (e: PointerEvent) => {
  if (!isSearchExpanded.value) return;
  if (searchContainerRef.value?.contains(e.target as Node)) return;
  collapseSearch();
};

const handleSearchFocus = () => {
  if (searchQuery.value.trim() && suggestions.value.length > 0) {
    showSuggestions.value = true;
  }
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
    // 路由变化时收起搜索
    if (isSearchExpanded.value) collapseSearch();
  },
  { immediate: true },
);

onMounted(() => {
  window.addEventListener('popstate', updateNavState);
  document.addEventListener('pointerdown', handleGlobalPointerDown, true);
});

onUnmounted(() => {
  window.removeEventListener('popstate', updateNavState);
  document.removeEventListener('pointerdown', handleGlobalPointerDown, true);
  if (suggestTimer) window.clearTimeout(suggestTimer);
});
</script>

<template>
  <header
    ref="titleBarRef"
    class="title-bar flex items-center shrink-0 select-none transition-colors duration-300 z-[200] bg-transparent relative"
  >
    <!-- 1. 左侧：导航按钮 -->
    <div class="flex items-center gap-1 no-drag pl-6">
      <Button
        variant="unstyled"
        size="none"
        @click="goBack"
        class="nav-btn group"
        :disabled="!canGoBack"
        title="后退"
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
        title="前进"
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
      <Button variant="unstyled" size="none" @click="refresh" class="nav-btn group" title="刷新">
        <RefreshIcon
          width="18"
          height="18"
          class="text-text-main opacity-60 group-hover:opacity-100 transition-opacity"
        />
      </Button>

      <!-- 搜索 -->
      <div ref="searchContainerRef" class="tb-search" :class="{ 'is-expanded': isSearchExpanded }">
        <!-- 收起状态：搜索图标按钮 -->
        <Button
          v-if="!isSearchExpanded"
          variant="unstyled"
          size="none"
          class="tb-search-trigger"
          title="搜索"
          @click="expandSearch"
        >
          <Icon :icon="iconSearch" width="16" height="16" />
          <span class="tb-search-trigger-text">搜索</span>
        </Button>

        <!-- 展开状态：搜索输入框 -->
        <div v-else class="tb-search-expanded">
          <div class="tb-search-input-wrap">
            <Icon :icon="iconSearch" width="15" height="15" class="tb-search-icon" />
            <input
              ref="searchInputRef"
              v-model="searchQuery"
              type="text"
              class="tb-search-input"
              placeholder="搜索音乐、歌手、专辑"
              @input="handleSearchInput(searchQuery)"
              @keydown.enter.prevent="submitSearch()"
              @keydown="handleSearchKeydown"
              @focus="handleSearchFocus"
              @blur="handleSearchBlur"
            />
            <Button
              v-if="searchQuery"
              variant="unstyled"
              size="none"
              class="tb-search-clear"
              @mousedown.prevent
              @click="
                searchQuery = '';
                suggestions = [];
                showSuggestions = false;
                searchInputRef?.focus();
              "
            >
              <Icon :icon="iconX" width="14" height="14" />
            </Button>
          </div>

          <!-- 搜索建议下拉 -->
          <Scrollbar v-if="showSuggestions" class="tb-suggestions">
            <div class="tb-suggestions-inner">
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
          </Scrollbar>
        </div>
      </div>
    </div>

    <!-- 2. 中间：拖拽区域 -->
    <div class="flex-1 h-full"></div>

    <!-- 3. 右侧：窗口控制 -->
    <div v-if="!isMac" class="window-controls flex items-center no-drag h-full">
      <Button variant="unstyled" size="none" @click="handleControl('minimize')" class="control-btn">
        <Icon :icon="iconMinus" width="14" height="14" />
      </Button>
      <Button variant="unstyled" size="none" @click="handleControl('maximize')" class="control-btn">
        <Icon :icon="iconSquare" width="13" height="13" />
      </Button>
      <Button
        variant="unstyled"
        size="none"
        @click="handleControl('close')"
        class="control-btn hover:bg-red-500 hover:text-white"
      >
        <Icon :icon="iconX" width="14" height="14" />
      </Button>
    </div>
  </header>
</template>

<style scoped>
.title-bar {
  height: 46px;
}

.nav-btn {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition: all 0.2s;
  background: transparent;
  border: none;
}

.nav-btn:hover {
  background-color: rgba(0, 0, 0, 0.04);
}

.dark .nav-btn:hover {
  background-color: rgba(255, 255, 255, 0.04);
}

.nav-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.nav-btn:disabled:hover {
  background-color: transparent;
}

.control-btn {
  width: 48px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-main);
  background: transparent;
  border: none;
  transition: all 0.2s;
}

.control-btn:hover {
  background-color: rgba(0, 0, 0, 0.05);
}

.dark .control-btn:hover {
  background-color: rgba(255, 255, 255, 0.1);
}

.control-btn:hover.hover\:bg-red-500 {
  background-color: #ff3b30 !important;
}

/* 搜索区域 */
.tb-search {
  position: relative;
}

.tb-search-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.05);
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 500;
  transition: all 0.2s ease;
}

.dark .tb-search-trigger {
  background: rgba(255, 255, 255, 0.06);
}

.tb-search-trigger:hover {
  background: rgba(0, 0, 0, 0.08);
  color: var(--color-text-main);
}

.dark .tb-search-trigger:hover {
  background: rgba(255, 255, 255, 0.1);
}

.tb-search-trigger-text {
  line-height: 1;
}

.tb-search-expanded {
  position: relative;
  width: 320px;
  animation: tb-search-expand 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes tb-search-expand {
  from {
    width: 80px;
    opacity: 0.6;
  }
  to {
    width: 320px;
    opacity: 1;
  }
}

.tb-search-input-wrap {
  display: flex;
  align-items: center;
  height: 34px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.06);
  padding: 0 4px 0 10px;
  transition: all 0.2s ease;
  border: 1px solid transparent;
}

.dark .tb-search-input-wrap {
  background: rgba(255, 255, 255, 0.08);
}

.tb-search-input-wrap:focus-within {
  background: var(--color-bg-card);
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.12);
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
  background: rgba(0, 0, 0, 0.06);
}

.dark .tb-search-clear:hover {
  background: rgba(255, 255, 255, 0.1);
}

/* 搜索建议下拉 */
.tb-suggestions {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  width: 100%;
  max-height: 360px;
  border-radius: 12px;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border-light);
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.12),
    0 2px 6px rgba(0, 0, 0, 0.06);
  padding: 6px 0;
  z-index: 500;
}

.tb-suggestions-inner {
  padding: 6px 0;
}

.tb-suggest-group + .tb-suggest-group {
  margin-top: 4px;
}

.tb-suggest-group + .tb-suggest-group .tb-suggest-title {
  border-top: 0.5px solid var(--color-border-light);
  padding-top: 8px;
  margin-top: 2px;
}

.tb-suggest-title {
  padding: 6px 14px 4px;
  font-size: 10px;
  font-weight: 700;
  color: var(--color-primary);
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
  background: rgba(0, 113, 227, 0.08);
  color: var(--color-primary);
}

.dark .tb-suggest-item:hover {
  background: rgba(0, 113, 227, 0.14);
}

.tb-suggest-item-icon {
  flex-shrink: 0;
  opacity: 0.4;
}
</style>
