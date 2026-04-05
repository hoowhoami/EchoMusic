<script setup lang="ts">
import { TabsList, type TabsListProps, useForwardProps } from 'reka-ui';

const props = defineProps<TabsListProps & { class?: string }>();
const forwardedProps = useForwardProps(props);
</script>

<template>
  <TabsList
    v-bind="forwardedProps"
    :class="['flex items-center gap-3 h-9', props.class]"
  >
    <slot />
  </TabsList>
</template>

<style scoped>
@reference "@/style.css";
</style>
