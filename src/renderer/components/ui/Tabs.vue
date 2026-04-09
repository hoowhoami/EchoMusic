<script setup lang="ts">
import {
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsContent,
  type TabsRootProps,
  type TabsRootEmits,
  useForwardPropsEmits,
} from 'reka-ui';
import { computed } from 'vue';

const props = defineProps<TabsRootProps & { class?: string }>();
const emits = defineEmits<TabsRootEmits>();

const forwarded = useForwardPropsEmits(props, emits);
</script>

<template>
  <TabsRoot v-bind="forwarded" :class="props.class">
    <slot />
  </TabsRoot>
</template>
