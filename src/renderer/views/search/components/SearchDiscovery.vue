<script setup lang="ts">
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { iconClock, iconTrash, iconX } from '@/icons';
import type { SearchHotCategory } from '../types';

defineProps<{
  hotSearchCategories: SearchHotCategory[];
  isLoadingHot: boolean;
  searchHistory: string[];
}>();

const emit = defineEmits<{
  clearHistory: [];
  pickKeyword: [keyword: string];
  removeHistory: [keyword: string];
}>();
</script>

<template>
  <div class="search-discovery px-10 pt-4">
    <div v-if="isLoadingHot" class="search-discovery-skeleton" aria-busy="true">
      <div v-for="card in 2" :key="card" class="search-hot-card">
        <Skeleton variant="text" width="80px" height="20px" />
        <div class="search-hot-list" style="--hot-rows: 3; --hot-rows-two: 5">
          <Skeleton v-for="item in 9" :key="item" variant="text" width="100%" height="40px" />
        </div>
      </div>
    </div>
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

      <div class="search-hot-cards">
        <section
          v-for="(category, categoryIndex) in hotSearchCategories"
          :key="`${category.name}-${categoryIndex}`"
          class="search-hot-card"
          :aria-label="category.name"
        >
          <h3 class="search-hot-card-title">{{ category.name }}</h3>
          <ol
            v-if="category.keywords.length"
            class="search-hot-list"
            :style="{
              '--hot-rows': Math.ceil(category.keywords.length / 3),
              '--hot-rows-two': Math.ceil(category.keywords.length / 2),
            }"
          >
            <li v-for="(item, index) in category.keywords" :key="`${item.keyword}-${index}`">
              <Button
                variant="unstyled"
                size="none"
                type="button"
                class="search-hot-item"
                :class="{ 'is-leading': index < 3 }"
                @click="emit('pickKeyword', item.keyword)"
              >
                <span class="search-hot-number" aria-hidden="true">{{ index + 1 }}</span>
                <span class="search-hot-keyword">{{ item.keyword }}</span>
                <span
                  v-if="item.reason && item.reason !== item.keyword && item.reason.length <= 2"
                  class="search-hot-badge"
                  >{{ item.reason }}</span
                >
              </Button>
            </li>
          </ol>
          <div v-else class="search-hot-empty">暂无热门搜索</div>
        </section>
        <div v-if="!hotSearchCategories.length" class="search-hot-empty">暂无热门搜索</div>
      </div>
    </template>
  </div>
</template>

<style scoped src="../searchView.css"></style>
