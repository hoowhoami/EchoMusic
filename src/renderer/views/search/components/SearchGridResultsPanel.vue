<script setup lang="ts">
import VirtualGrid from '@/components/ui/VirtualGrid.vue';

defineProps<{
  active: boolean;
  emptyText?: string;
  gap: number;
  itemAspectRatio?: number;
  itemChromeHeight?: number;
  itemHeight?: number;
  itemMinWidth: number;
  items: Record<string, any>[];
  keyField: string;
  loading: boolean;
  stateMinHeight?: number;
}>();

defineSlots<{
  default(props: { item: Record<string, any> }): any;
}>();
</script>

<template>
  <VirtualGrid
    class="pb-6"
    :items="items"
    :loading="loading"
    :active="active"
    :itemMinWidth="itemMinWidth"
    :itemAspectRatio="itemAspectRatio"
    :itemChromeHeight="itemChromeHeight"
    :itemHeight="itemHeight"
    :gap="gap"
    :overscan="3"
    :stateMinHeight="stateMinHeight ?? 320"
    :emptyText="emptyText ?? '暂无搜索结果'"
    :keyField="keyField"
  >
    <template #default="{ item }">
      <slot :item="item" />
    </template>
  </VirtualGrid>
</template>
