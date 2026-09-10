<script setup lang="ts">
import PageStickyHeader from '@/components/ui/PageStickyHeader.vue';
import CustomTabBar from '@/components/ui/CustomTabBar.vue';

defineProps<{
  activeTabIndex: number;
  hasSearched: boolean;
  keyword: string;
  showPinnedTabs: boolean;
  tabs: string[];
}>();
const emit = defineEmits<{
  'update:activeTabIndex': [value: number];
}>();
</script>

<template>
  <PageStickyHeader v-if="showPinnedTabs" class="search-pinned-tabs sticky top-0 z-140">
    <div class="px-10 py-1.5">
      <CustomTabBar
        :model-value="activeTabIndex"
        :tabs="tabs"
        @update:model-value="emit('update:activeTabIndex', $event)"
      />
    </div>
  </PageStickyHeader>
  <div v-show="!showPinnedTabs" class="px-10 pt-4">
    <h1 class="text-[22px] font-semibold text-text-main tracking-tight break-words">
      {{ hasSearched && keyword ? `搜索「${keyword}」` : '搜索' }}
    </h1>
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
