<script setup lang="ts">
import { TabsTrigger, type TabsTriggerProps, useForwardProps } from 'reka-ui';

const props = defineProps<TabsTriggerProps & { class?: string }>();
const forwardedProps = useForwardProps(props);
</script>

<template>
  <TabsTrigger
    v-bind="forwardedProps"
    :class="[
      'tab-trigger relative h-full flex items-end pb-1 text-[15px] font-bold text-text-main opacity-60 transition-all cursor-pointer select-none focus-visible:outline-none data-[state=active]:opacity-100',
      props.class
    ]"
  >
    <slot />
    <div class="active-line"></div>
  </TabsTrigger>
</template>

<style scoped>
@reference "@/style.css";

.active-line {
  @apply absolute bottom-0 left-1/2 -translate-x-1/2 w-0 h-0.5 bg-primary rounded-full transition-all duration-300;
}

.tab-trigger[data-state=active] .active-line {
  @apply w-6;
}
</style>
