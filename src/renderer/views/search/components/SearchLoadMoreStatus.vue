<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import Button from '@/components/ui/Button.vue';
import type { SearchPaginationState } from '../types';

defineProps<{
  activePagination: SearchPaginationState;
  hasItems: boolean;
  setSentinelRef: (
    el: Element | ComponentPublicInstance | null,
    refs?: Record<string, unknown>,
  ) => void;
}>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <div
    v-if="activePagination.error"
    class="search-load-more-status flex items-center justify-center gap-3"
    role="alert"
  >
    <span>{{ activePagination.error }}</span>
    <Button variant="secondary" size="sm" @click="$emit('retry')">重试加载</Button>
  </div>
  <div
    v-else-if="activePagination.loadingMore || activePagination.hasMore"
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
