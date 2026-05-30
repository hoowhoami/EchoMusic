<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useVModel } from '@vueuse/core';
import Dialog from '@/components/ui/Dialog.vue';
import Input from '@/components/ui/Input.vue';
import { iconCheck, iconPalette } from '@/icons';

interface Props {
  open?: boolean;
  title?: string;
  value: string;
  presets?: string[];
  dynamicOption?: { label: string; value: string; color: string } | null;
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
  title: '选择颜色',
  presets: () => [],
  dynamicOption: null,
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'update:value', value: string): void;
  (e: 'confirm', value: string): void;
}>();

const open = useVModel(props, 'open', emit, { defaultValue: false });
const draft = ref(props.value);

const isDynamicDraft = computed(() => props.dynamicOption?.value === draft.value);
const displayValue = computed({
  get: () => (isDynamicDraft.value ? (props.dynamicOption?.label ?? '') : draft.value),
  set: (value) => {
    draft.value = String(value);
  },
});

const normalizedDraft = computed(() => {
  if (isDynamicDraft.value) return props.dynamicOption?.color ?? '#31cfa1';
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

const applyDynamic = () => {
  if (!props.dynamicOption) return;
  draft.value = props.dynamicOption.value;
};

const handleNativeInput = (event: Event) => {
  const target = event.target as HTMLInputElement;
  if (target?.value) draft.value = target.value;
};

const confirm = () => {
  const color = isDynamicDraft.value ? props.dynamicOption!.value : normalizedDraft.value;
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
          <Input
            v-model="displayValue"
            inputClass="!h-9 !rounded-lg !pl-3 !pr-3 !text-[13px] font-mono"
            :show-clear="!isDynamicDraft"
          />
        </div>
      </div>

      <!-- 预设色 -->
      <div v-if="props.presets.length" class="color-picker-presets">
        <button
          v-for="color in props.presets"
          :key="color"
          type="button"
          class="color-picker-swatch"
          :class="{ active: !isDynamicDraft && normalizedDraft === color.toLowerCase() }"
          :style="{ backgroundColor: color }"
          :title="color"
          @click="applyPreset(color)"
        >
          <Icon
            v-if="!isDynamicDraft && normalizedDraft === color.toLowerCase()"
            :icon="iconCheck"
            width="12"
            height="12"
          />
        </button>
      </div>

      <button
        v-if="props.dynamicOption"
        type="button"
        class="color-picker-dynamic"
        :class="{ active: isDynamicDraft }"
        @click="applyDynamic"
      >
        <span
          class="color-picker-dynamic-swatch"
          :style="{
            background:
              'linear-gradient(135deg, #ff5f6d 0%, #ffc371 28%, #24c6dc 60%, ' +
              props.dynamicOption.color +
              ' 100%)',
          }"
        >
          <Icon v-if="isDynamicDraft" :icon="iconCheck" width="12" height="12" />
          <Icon v-else :icon="iconPalette" width="12" height="12" />
        </span>
        <span class="color-picker-dynamic-text">
          <span class="color-picker-dynamic-title">{{ props.dynamicOption.label }}</span>
          <span class="color-picker-dynamic-subtitle">自动使用当前封面提取色</span>
        </span>
      </button>

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

.color-picker-dynamic {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.03);
  color: var(--color-text-main);
  cursor: pointer;
  transition:
    transform 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease;
}

.dark .color-picker-dynamic {
  border-color: rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
}

.color-picker-dynamic:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--color-primary) 40%, transparent);
}

.color-picker-dynamic.active {
  border-color: color-mix(in srgb, var(--color-primary) 60%, transparent);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.color-picker-dynamic-swatch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  color: white;
  flex-shrink: 0;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.28),
    0 8px 18px rgba(0, 0, 0, 0.14);
}

.color-picker-dynamic-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
}

.color-picker-dynamic-title {
  font-size: 13px;
  font-weight: 600;
}

.color-picker-dynamic-subtitle {
  font-size: 11px;
  color: var(--color-text-secondary);
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
