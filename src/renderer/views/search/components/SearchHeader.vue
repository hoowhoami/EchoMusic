<script setup lang="ts">
import { ref } from 'vue';
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import CustomTabBar from '@/components/ui/CustomTabBar.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import { iconChevronRight, iconSearch, iconX } from '@/icons';
import type { SearchSuggestionCategory } from '../types';

const props = defineProps<{
  activeTabIndex: number;
  defaultKeyword: string;
  hasSearched: boolean;
  isLoadingSuggestions: boolean;
  searchInput: string;
  showPinnedTabs: boolean;
  showSuggestions: boolean;
  suggestionCategories: SearchSuggestionCategory[];
  tabs: string[];
}>();

const emit = defineEmits<{
  blur: [];
  clear: [];
  focus: [];
  pickSuggestion: [keyword: string];
  submit: [];
  'update:activeTabIndex': [value: number];
  'update:searchInput': [value: string];
}>();

const inputRef = ref<HTMLInputElement | null>(null);

defineExpose({ inputRef });
</script>

<template>
  <div v-if="showPinnedTabs" class="search-pinned-tabs sticky top-0 z-140">
    <div class="px-10 py-1.5">
      <CustomTabBar
        :model-value="activeTabIndex"
        :tabs="tabs"
        @update:model-value="emit('update:activeTabIndex', $event)"
      />
    </div>
  </div>

  <div v-show="!showPinnedTabs" class="px-10 pt-4">
    <div class="text-[22px] font-semibold text-text-main tracking-tight">搜索</div>

    <div class="search-input-shell mt-6" :class="{ 'has-suggestions': showSuggestions }">
      <div class="search-input-wrap">
        <Icon :icon="iconSearch" width="18" height="18" class="search-input-icon" />
        <input
          ref="inputRef"
          :value="searchInput"
          type="text"
          class="search-input"
          :placeholder="defaultKeyword ? `搜索: ${defaultKeyword}` : '搜索音乐、歌手、专辑'"
          @focus="emit('focus')"
          @blur="emit('blur')"
          @input="emit('update:searchInput', ($event.target as HTMLInputElement).value)"
          @keydown.enter.prevent="emit('submit')"
        />
        <Button
          v-if="searchInput"
          variant="unstyled"
          size="none"
          type="button"
          class="search-clear-btn"
          @mousedown.prevent
          @click="emit('clear')"
        >
          <Icon :icon="iconX" width="16" height="16" />
        </Button>
        <Button
          variant="unstyled"
          size="none"
          type="button"
          class="search-submit-btn"
          @click="emit('submit')"
        >
          搜索
        </Button>
      </div>

      <div v-if="showSuggestions" class="search-suggestions-panel">
        <div
          v-if="isLoadingSuggestions && suggestionCategories.length === 0"
          class="search-suggestions-empty"
        >
          加载中...
        </div>
        <div v-else-if="suggestionCategories.length === 0" class="search-suggestions-empty">
          暂无建议
        </div>
        <Scrollbar v-else class="search-suggestions-list">
          <div class="search-suggestions-list-inner">
            <div
              v-for="category in suggestionCategories"
              :key="category.label"
              class="search-suggestion-group"
            >
              <div class="search-suggestion-title">{{ category.label }}</div>
              <Button
                v-for="record in category.records"
                :key="`${category.label}-${record.text}`"
                variant="unstyled"
                size="none"
                type="button"
                class="search-suggestion-item"
                @mousedown.prevent
                @click="emit('pickSuggestion', record.text)"
              >
                <span class="search-suggestion-leading">
                  <Icon :icon="iconSearch" width="14" height="14" class="opacity-60" />
                </span>
                <span class="search-suggestion-text truncate">{{ record.text }}</span>
                <span class="search-suggestion-trailing">
                  <Icon :icon="iconChevronRight" width="13" height="13" />
                </span>
              </Button>
            </div>
          </div>
        </Scrollbar>
      </div>
    </div>

    <div v-if="hasSearched" class="mt-6">
      <CustomTabBar
        :model-value="activeTabIndex"
        :tabs="tabs"
        @update:model-value="emit('update:activeTabIndex', $event)"
      />
    </div>
  </div>
</template>

<style scoped src="../searchView.css"></style>
