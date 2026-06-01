<script setup lang="ts">
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import { iconClock, iconTrash, iconX } from '@/icons';
import type { SearchHotCategory, SearchHotKeyword } from '../types';

defineProps<{
  currentHotKeywords: SearchHotKeyword[];
  hotSearchCategories: SearchHotCategory[];
  isLoadingHot: boolean;
  searchHistory: string[];
  selectedHotCategoryIndex: number;
}>();

const emit = defineEmits<{
  clearHistory: [];
  pickKeyword: [keyword: string];
  removeHistory: [keyword: string];
  'update:selectedHotCategoryIndex': [value: number];
}>();
</script>

<template>
  <div class="px-10 pt-4">
    <div v-if="isLoadingHot" class="search-placeholder">加载中...</div>
    <template v-else>
      <div v-if="searchHistory.length > 0" class="search-section">
        <div class="search-section-header">
          <div class="search-section-title">历史搜索</div>
          <Button
            variant="unstyled"
            size="none"
            type="button"
            class="search-history-clear"
            @click="emit('clearHistory')"
          >
            <Icon :icon="iconTrash" width="16" height="16" />
          </Button>
        </div>
        <div class="search-chip-wrap">
          <Button
            v-for="keyword in searchHistory"
            :key="keyword"
            variant="unstyled"
            size="none"
            type="button"
            class="history-chip"
            @click="emit('pickKeyword', keyword)"
          >
            <span class="history-chip-icon">
              <Icon :icon="iconClock" width="11" height="11" />
            </span>
            <span class="truncate">{{ keyword }}</span>
            <span class="history-chip-close" @click.stop="emit('removeHistory', keyword)">
              <Icon :icon="iconX" width="10" height="10" />
            </span>
          </Button>
        </div>
      </div>

      <div class="search-section">
        <div class="search-section-title">热门搜索</div>
        <div v-if="hotSearchCategories.length > 0" class="search-hot-tabs">
          <Button
            v-for="(category, index) in hotSearchCategories"
            :key="category.name"
            variant="unstyled"
            size="none"
            type="button"
            class="search-hot-tab"
            :class="{ active: selectedHotCategoryIndex === index }"
            @click="emit('update:selectedHotCategoryIndex', index)"
          >
            {{ category.name }}
          </Button>
        </div>
        <div class="search-chip-wrap mt-5">
          <Button
            v-for="item in currentHotKeywords"
            :key="`${item.keyword}-${item.reason}`"
            variant="unstyled"
            size="none"
            type="button"
            class="hot-chip"
            @click="emit('pickKeyword', item.keyword)"
          >
            <span>{{ item.keyword }}</span>
            <template v-if="item.reason && item.reason !== item.keyword">
              <span class="opacity-40">•</span>
              <span class="hot-chip-reason">{{ item.reason }}</span>
            </template>
          </Button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped src="../searchView.css"></style>
