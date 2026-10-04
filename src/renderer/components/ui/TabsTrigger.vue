<script setup lang="ts">
import { TabsTrigger, type TabsTriggerProps, useForwardProps } from 'reka-ui';

const props = defineProps<TabsTriggerProps & { class?: string }>();
const forwardedProps = useForwardProps(props);
</script>

<template>
  <TabsTrigger
    v-bind="forwardedProps"
    :class="[
      'tab-trigger relative h-full flex items-end pb-1 text-[15px] font-bold text-text-main opacity-60 cursor-pointer select-none focus-visible:outline-none data-[state=active]:opacity-100',
      props.class,
    ]"
  >
    <slot />
    <div class="active-line" aria-hidden="true"></div>
  </TabsTrigger>
</template>

<style scoped>
@reference "@/style.css";

.tab-trigger {
  transition:
    opacity var(--motion-duration-fast) var(--motion-ease-standard),
    color var(--motion-duration-fast) var(--motion-ease-standard);
}

.active-line {
  @apply absolute bottom-0 left-1/2 -translate-x-1/2 w-6 h-0.5 bg-primary rounded-full;
  opacity: 0;
  transform: scaleX(0.4);
  transition:
    transform var(--motion-duration-normal) var(--motion-ease-standard),
    opacity var(--motion-duration-fast) var(--motion-ease-standard);
}

.tab-trigger[data-state='active'] .active-line {
  opacity: 1;
  transform: scaleX(1);
}
@media (prefers-reduced-motion: reduce) {
  .tab-trigger,
  .active-line {
    transition: none;
  }
}
</style>
