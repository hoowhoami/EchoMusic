<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useVModel } from '@vueuse/core';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import CustomTabBar from '@/components/ui/CustomTabBar.vue';

export interface PickerOption {
  id: string;
  name: string;
  group?: string;
}

interface Props {
  open: boolean;
  title: string;
  options: PickerOption[];
  selectedId?: string;
  maxWidth?: number;
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
  options: () => [],
  selectedId: '',
  maxWidth: 500,
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'select', option: PickerOption): void;
}>();

const open = useVModel(props, 'open', emit, { defaultValue: false });

const groupedOptions = computed(() => {
  const groups = new Map<string, PickerOption[]>();
  props.options.forEach((opt) => {
    const key = opt.group ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(opt);
  });
  return Array.from(groups.entries());
});

const tabs = computed(() => groupedOptions.value.map(([key]) => key).filter((key) => key !== ''));
const hasTabs = computed(() => tabs.value.length > 1);
const activeTabIndex = ref(0);

const activeOptions = computed(() => {
  if (!hasTabs.value) return props.options;
  const key = tabs.value[activeTabIndex.value];
  const group = groupedOptions.value.find(([groupKey]) => groupKey === key);
  return group ? group[1] : props.options;
});

const handleSelect = (option: PickerOption) => {
  emit('select', option);
  emit('update:open', false);
};

watch(
  () => open.value,
  (open) => {
    if (!open) return;
    if (!hasTabs.value) return;
    const selectedOption = props.options.find((opt) => opt.id === props.selectedId);
    if (!selectedOption?.group) return;
    const index = tabs.value.findIndex((tab) => tab === selectedOption.group);
    activeTabIndex.value = index >= 0 ? index : 0;
  },
);
</script>

<template>
  <Dialog
    v-model:open="open"
    :title="props.title"
    contentClass="custom-picker-dialog"
    :contentStyle="{ maxWidth: `${props.maxWidth}px` }"
    showClose
  >
    <div v-if="hasTabs" class="custom-picker-tabs">
      <CustomTabBar v-model="activeTabIndex" :tabs="tabs" />
    </div>
    <div class="custom-picker-options">
      <Button
        v-for="opt in activeOptions"
        :key="opt.id"
        type="button"
        class="custom-picker-option"
        :class="{ active: opt.id === props.selectedId }"
        variant="ghost"
        size="xs"
        @click="handleSelect(opt)"
      >
        {{ opt.name }}
      </Button>
    </div>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

:deep(.custom-picker-dialog) {
  width: min(520px, 92vw);
  border-radius: 24px !important;
  padding: 18px 2px 16px 18px !important;
}

.custom-picker-tabs {
  margin-bottom: 12px;
}

.custom-picker-options {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 0 14px 14px;
  max-height: 320px;
  overflow-y: auto;
}

.custom-picker-option {
  @apply px-4 py-2 rounded-[10px] text-[12px] font-semibold transition-all;
  color: var(--color-text-main);
  border: 1px solid color-mix(in srgb, var(--color-text-main) 8%, transparent);
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
}

.custom-picker-option.active {
  border-color: var(--color-primary);
  background: var(--color-primary);
  color: #ffffff;
}

.dark .custom-picker-option.active {
  color: #000000;
}

.custom-picker-option:hover {
  border-color: color-mix(in srgb, var(--color-primary) 60%, transparent);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}
</style>
