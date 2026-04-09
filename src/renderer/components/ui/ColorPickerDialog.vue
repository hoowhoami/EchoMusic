<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useVModel } from '@vueuse/core';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import { iconCheck } from '@/icons';

interface Props {
  open?: boolean;
  title?: string;
  value: string;
  presets?: string[];
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
  title: '选择颜色',
  presets: () => [],
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'update:value', value: string): void;
  (e: 'confirm', value: string): void;
}>();

const open = useVModel(props, 'open', emit, { defaultValue: false });
const draft = ref(props.value);

const normalizedDraft = computed(() => {
  const raw = String(draft.value ?? '').trim();
  if (!raw) return '#31cfa1';
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    const [, r, g, b] = raw;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return '#31cfa1';
});

watch(
  () => props.value,
  (value) => {
    draft.value = value;
  },
  { immediate: true },
);

watch(open, (value) => {
  if (value) {
    draft.value = props.value;
  }
});

const applyPreset = (color: string) => {
  draft.value = color;
};

const confirm = () => {
  const color = normalizedDraft.value;
  emit('update:value', color);
  emit('confirm', color);
  emit('update:open', false);
};
</script>

<template>
  <Dialog
    v-model:open="open"
    :title="props.title"
    contentClass="color-picker-dialog"
    :contentStyle="{ maxWidth: '420px' }"
    showClose
  >
    <div class="color-picker-body">
      <div class="color-picker-preview-row">
        <div class="color-picker-preview" :style="{ backgroundColor: normalizedDraft }"></div>
        <input v-model="draft" class="color-picker-native" type="color" />
        <Input v-model="draft" inputClass="!h-11 !rounded-xl !pl-4 !pr-4 !text-[14px] font-mono" />
      </div>

      <div v-if="props.presets.length" class="color-picker-presets">
        <button
          v-for="color in props.presets"
          :key="color"
          type="button"
          class="color-picker-swatch"
          :class="{ active: normalizedDraft === color.toLowerCase() }"
          :style="{ backgroundColor: color }"
          @click="applyPreset(color)"
        >
          <Icon
            v-if="normalizedDraft === color.toLowerCase()"
            :icon="iconCheck"
            width="14"
            height="14"
          />
        </button>
      </div>

      <div class="color-picker-actions">
        <Button variant="ghost" @click="open = false">取消</Button>
        <Button @click="confirm">确定</Button>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

.color-picker-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 0 14px 14px;
}

.color-picker-preview-row {
  display: grid;
  grid-template-columns: 52px 56px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
}

.color-picker-preview {
  width: 52px;
  height: 52px;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, var(--color-text-main) 10%, transparent);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22);
}

.color-picker-native {
  width: 56px;
  height: 44px;
  padding: 0;
  border: none;
  border-radius: 14px;
  background: transparent;
  cursor: pointer;
}

.color-picker-native::-webkit-color-swatch-wrapper {
  padding: 0;
}

.color-picker-native::-webkit-color-swatch {
  border: 1px solid color-mix(in srgb, var(--color-text-main) 10%, transparent);
  border-radius: 14px;
}

.color-picker-presets {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
}

.color-picker-swatch {
  width: 100%;
  aspect-ratio: 1;
  border: none;
  border-radius: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: white;
  cursor: pointer;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.28),
    0 6px 18px rgba(0, 0, 0, 0.1);
}

.color-picker-swatch.active {
  transform: scale(1.04);
}

.color-picker-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
