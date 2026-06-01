<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import type { SearchPaginationState } from '../types';

defineProps<{
  activePagination: SearchPaginationState;
  hasItems: boolean;
  setSentinelRef: (
    el: Element | ComponentPublicInstance | null,
    refs?: Record<string, unknown>,
  ) => void;
}>();
</script>

<template>
  <div
    v-if="activePagination.loadingMore || activePagination.hasMore"
    :ref="setSentinelRef"
    class="search-load-more-status"
  >
    {{ activePagination.loadingMore ? '加载更多中...' : '继续下滑加载更多' }}
  </div>
  <div v-else-if="hasItems" class="search-load-more-status search-load-more-status--end">
    没有更多结果了
  </div>
</template>

<style scoped src="../searchView.css"></style>
