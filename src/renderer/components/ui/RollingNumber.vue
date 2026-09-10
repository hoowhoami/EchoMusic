<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import NumberFlow, { NumberFlowGroup } from '@number-flow/vue';

// Adapt existing formatted integer statistics (e.g. "5 天 2 小时" or "10,095").
// NumberFlow owns digit animation, typography, layout transitions and motion preferences.
const props = defineProps<{ value: string | number }>();
const text = computed(() => String(props.value));
const parts = computed(() =>
  Array.from(text.value.matchAll(/(\d+(?:,\d{3})*)([^\d]*)/g), (match, index) => ({
    value: Number(match[1].replaceAll(',', '')),
    prefix: index === 0 ? text.value.slice(0, match.index) : '',
    suffix: match[2],
    format: { useGrouping: match[1].includes(',') },
  })),
);
const entered = ref(false);
let frame = 0;
const enter = () => {
  cancelAnimationFrame(frame);
  entered.value = false;
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      entered.value = true;
    });
  });
};
onMounted(enter);
onActivated(enter);
onDeactivated(() => cancelAnimationFrame(frame));
onBeforeUnmount(() => cancelAnimationFrame(frame));
</script>

<template>
  <span class="rolling-number">
    <template v-if="parts.length">
      <span class="sr-only">{{ text }}</span>
      <span aria-hidden="true">
        <NumberFlowGroup>
          <NumberFlow
            v-for="(part, index) in parts"
            :key="index"
            :value="entered ? part.value : 0"
            :prefix="part.prefix"
            :suffix="part.suffix"
            :format="part.format"
            locales="en-US"
          />
        </NumberFlowGroup>
      </span>
    </template>
    <template v-else>{{ text }}</template>
  </span>
</template>
