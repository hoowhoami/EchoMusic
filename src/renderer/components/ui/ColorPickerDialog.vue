<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useVModel } from '@vueuse/core';
import Dialog from '@/components/ui/Dialog.vue';
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

const handleNativeInput = (event: Event) => {
  const target = event.target as HTMLInputElement;
  if (target?.value) draft.value = target.value;
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
    :contentStyle="{ maxWidth: '380px' }"
    showClose
  >
    <div class="color-picker-body">
      <!-- 顶部：原生色盘（美化为色块）+ hex 输入框 -->
      <div class="color-picker-top-row">
        <div class="color-picker-native-wrap">
          <input
            :value="normalizedDraft"
            type="color"
            class="color-picker-native"
            title="点击打开系统色盘"
            @input="handleNativeInput"
            @change="handleNativeInput"
          />
        </div>
        <div class="color-picker-input-wrap">
          <Input v-model="draft" inputClass="!h-9 !rounded-lg !pl-3 !pr-3 !text-[13px] font-mono" />
        </div>
      </div>

      <!-- 预设色 -->
      <div v-if="props.presets.length" class="color-picker-presets">
        <button
          v-for="color in props.presets"
          :key="color"
          type="button"
          class="color-picker-swatch"
          :class="{ active: normalizedDraft === color.toLowerCase() }"
          :style="{ backgroundColor: color }"
          :title="color"
          @click="applyPreset(color)"
        >
          <Icon
            v-if="normalizedDraft === color.toLowerCase()"
            :icon="iconCheck"
            width="12"
            height="12"
          />
        </button>
      </div>

      <!-- 操作按钮 -->
      <div class="color-picker-actions">
        <button type="button" class="color-picker-btn cancel" @click="open = false">取消</button>
        <button type="button" class="color-picker-btn confirm" @click="confirm">确定</button>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

.color-picker-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 0 12px 0;
}

.color-picker-top-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 原生 color input 美化为圆角色块 */
.color-picker-native-wrap {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid rgba(0, 0, 0, 0.08);
}

.dark .color-picker-native-wrap {
  border-color: rgba(255, 255, 255, 0.12);
}

.color-picker-native {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
}

.color-picker-native::-webkit-color-swatch-wrapper {
  padding: 0;
}

.color-picker-native::-webkit-color-swatch {
  border: none;
  border-radius: 0;
}

.color-picker-input-wrap {
  flex: 1 1 auto;
  min-width: 0;
}

/* 预设色网格 */
.color-picker-presets {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
}

.color-picker-swatch {
  width: 100%;
  aspect-ratio: 1;
  border: none;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: white;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25);
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease;
}

.color-picker-swatch:hover {
  transform: scale(1.06);
}

.color-picker-swatch.active {
  box-shadow:
    inset 0 0 0 1.5px rgba(255, 255, 255, 0.6),
    0 0 0 2px var(--color-text-main);
}

/* 底部按钮 */
.color-picker-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.color-picker-btn {
  height: 36px;
  padding: 0 18px;
  font-size: 13px;
  font-weight: 600;
  border-radius: 10px;
  border: none;
  cursor: pointer;
  transition: all 0.15s ease;
}

.color-picker-btn.cancel {
  background: rgba(0, 0, 0, 0.05);
  color: var(--color-text-main);
}

.color-picker-btn.cancel:hover {
  background: rgba(0, 0, 0, 0.08);
}

.dark .color-picker-btn.cancel {
  background: rgba(255, 255, 255, 0.08);
}

.dark .color-picker-btn.cancel:hover {
  background: rgba(255, 255, 255, 0.12);
}

.color-picker-btn.confirm {
  background: var(--color-primary);
  color: white;
}

.color-picker-btn.confirm:hover {
  opacity: 0.9;
}
</style>
