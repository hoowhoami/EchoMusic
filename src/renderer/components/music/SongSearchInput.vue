<script setup lang="ts">
import { computed, useAttrs } from 'vue';
import Button from '@/components/ui/Button.vue';
import { iconSearch, iconX } from '@/icons';

const model = defineModel<string>({ default: '' });

const props = withDefaults(
  defineProps<{
    placeholder?: string;
    ariaLabel?: string;
    inputClass?: string;
  }>(),
  {
    placeholder: '搜索歌曲...',
    inputClass: 'w-52',
  },
);

const attrs = useAttrs();
const resolvedAriaLabel = computed(() => {
  const fromAttr = attrs['aria-label'];
  const attrLabel = typeof fromAttr === 'string' ? fromAttr : '';
  return props.ariaLabel || attrLabel || props.placeholder;
});

const clear = () => {
  model.value = '';
};
</script>

<template>
  <div class="relative">
    <input
      v-model="model"
      type="text"
      :placeholder="placeholder"
      :aria-label="resolvedAriaLabel"
      :class="[
        'song-search-input h-9 pl-8 pr-8 rounded-lg text-text-main placeholder:text-text-main/50 outline-none text-[12px] transition-all',
        inputClass,
      ]"
    />
    <Icon
      class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-main/60"
      :icon="iconSearch"
      width="14"
      height="14"
    />
    <Button
      v-if="model"
      variant="unstyled"
      size="none"
      class="song-search-clear"
      aria-label="清除搜索"
      @mousedown.prevent
      @click="clear"
    >
      <Icon :icon="iconX" width="12" height="12" />
    </Button>
  </div>
</template>
