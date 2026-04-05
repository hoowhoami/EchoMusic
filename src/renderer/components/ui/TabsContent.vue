<script setup lang="ts">
import { TabsContent, type TabsContentProps, useForwardProps } from 'reka-ui';

const props = defineProps<TabsContentProps & { class?: string }>();
const forwardedProps = useForwardProps(props);
</script>

<template>
  <TabsContent
    v-bind="forwardedProps"
    :class="['focus-visible:outline-none', props.class]"
  >
    <slot />
  </TabsContent>
</template>
