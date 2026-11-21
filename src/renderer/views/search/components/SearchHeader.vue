<script setup lang="ts">
import PageStickyHeader from '@/components/ui/PageStickyHeader.vue';
import CustomTabBar from '@/components/ui/CustomTabBar.vue';
import ResumeDeck from '@/components/music/ResumeDeck.vue';
import type { ResumeEntryCard } from '../resumeCard';

defineProps<{
  activeTabIndex: number;
  hasSearched: boolean;
  keyword: string;
  showPinnedTabs: boolean;
  tabs: string[];
  resumeEntries?: ResumeEntryCard[];
}>();

const emit = defineEmits<{
  'update:activeTabIndex': [value: number];
  'open-resume': [entry: ResumeEntryCard];
  'delete-resume': [entry: ResumeEntryCard];
  'tab-pointer-down': [event: PointerEvent];
  'tab-dblclick': [event: MouseEvent];
}>();
</script>

<template>
  <PageStickyHeader v-if="showPinnedTabs" class="search-pinned-tabs sticky top-0 z-140">
    <div class="px-10 py-1.5">
      <CustomTabBar
        :model-value="activeTabIndex"
        :tabs="tabs"
        @update:model-value="emit('update:activeTabIndex', $event)"
        @pointerdown="emit('tab-pointer-down', $event)"
        @dblclick="emit('tab-dblclick', $event)"
      />
    </div>
  </PageStickyHeader>
  <div v-show="!showPinnedTabs" class="px-10 pt-1">
    <div class="flex items-center gap-6">
      <h1
        class="text-[22px] font-semibold text-text-main tracking-tight break-words flex-none max-w-[58%]"
      >
        {{ hasSearched && keyword ? `搜索「${keyword}」` : '搜索' }}
      </h1>
      <!-- 牌堆本身（叠放、滚轮换序、双击展开、右键删除）都在 ResumeDeck 里，和提示卡同一套 -->
      <ResumeDeck
        v-if="hasSearched && resumeEntries && resumeEntries.length"
        :entries="resumeEntries"
        :reset-key="keyword"
        deletable
        pin-on-scroll
        @open="emit('open-resume', $event)"
        @remove="emit('delete-resume', $event)"
      />
    </div>
    <div v-if="hasSearched" class="mt-1.5">
      <CustomTabBar
        :model-value="activeTabIndex"
        :tabs="tabs"
        @update:model-value="emit('update:activeTabIndex', $event)"
        @pointerdown="emit('tab-pointer-down', $event)"
        @dblclick="emit('tab-dblclick', $event)"
      />
    </div>
  </div>
</template>

<style scoped src="../searchView.css"></style>
