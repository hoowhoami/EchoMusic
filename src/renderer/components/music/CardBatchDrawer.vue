<script setup lang="ts">
import { computed, ref } from 'vue';
import { useVModel } from '@vueuse/core';
import Drawer from '@/components/ui/Drawer.vue';
import DrawerHeader from '@/components/ui/DrawerHeader.vue';
import Button from '@/components/ui/Button.vue';
import Checkbox from '@/components/ui/Checkbox.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import { useToastStore } from '@/stores/toast';
import { iconHeart, iconList, iconMusic } from '@/icons';

interface CardBatchItem {
  key: string;
  name: string;
  subtitle?: string;
  cover?: string;
}

interface Props {
  open?: boolean;
  items: CardBatchItem[];
  /** 类型名：歌手 / 用户 / 专辑 / 有声/长专 / 视频，用于空态与提示文案。 */
  label: string;
  /** 批量动作名：取消关注 / 取消收藏，用于按钮与提示文案。 */
  actionLabel: string;
  /** 执行批量动作，返回失败条数。 */
  onConfirm: (keys: string[]) => Promise<number>;
}

const props = withDefaults(defineProps<Props>(), { open: false });
const emit = defineEmits<{ 'update:open': [boolean] }>();

const open = useVModel(props, 'open', emit, { passive: true });
const toastStore = useToastStore();

const selectedKeys = ref<string[]>([]);
const busy = ref(false);

const selectedCount = computed(() => selectedKeys.value.length);
const allSelected = computed(
  () => props.items.length > 0 && selectedKeys.value.length === props.items.length,
);
const isSelected = (item: CardBatchItem) => selectedKeys.value.includes(item.key);

const toggleRow = (item: CardBatchItem) => {
  if (busy.value) return;
  selectedKeys.value = isSelected(item)
    ? selectedKeys.value.filter((key) => key !== item.key)
    : [...selectedKeys.value, item.key];
};

const toggleAll = () => {
  if (busy.value) return;
  selectedKeys.value = allSelected.value ? [] : props.items.map((item) => item.key);
};

const close = () => {
  if (busy.value) return;
  open.value = false;
};

const reset = () => {
  selectedKeys.value = [];
  busy.value = false;
};

const run = async () => {
  if (busy.value || selectedKeys.value.length === 0) return;
  busy.value = true;
  try {
    const failed = await props.onConfirm(selectedKeys.value.slice());
    if (failed > 0) {
      toastStore.actionFailed(`批量${props.actionLabel}`);
      return;
    }
    toastStore.actionCompleted(`已批量${props.actionLabel}`);
    reset();
    open.value = false;
  } finally {
    busy.value = false;
  }
};
</script>

<template>
  <Drawer
    v-model:open="open"
    side="right"
    title="批量操作"
    overlayClass="card-batch-overlay"
    panelClass="card-batch-drawer"
  >
    <DrawerHeader class="card-batch-header" :close-disabled="busy" @close="close">
      <template #leading>
        <span class="card-batch-heading-icon">
          <Icon :icon="iconList" width="22" height="22" />
        </span>
      </template>
      <template #title><h2 class="card-batch-title">批量操作</h2></template>
    </DrawerHeader>

    <div class="card-batch-selection">
      <label class="card-batch-select">
        <Checkbox
          :model-value="allSelected"
          :disabled="busy || items.length === 0"
          :aria-label="allSelected ? '取消全选' : '全选'"
          @update:model-value="toggleAll"
        />
        <span class="card-batch-count" aria-live="polite">
          {{ selectedCount }}/{{ items.length }}
        </span>
      </label>
    </div>

    <div class="card-batch-list">
      <Scrollbar class="flex-1 min-h-0" :scrollbar-inset="4">
        <div v-if="items.length === 0" class="card-batch-empty">暂无可操作的{{ label }}</div>
        <div v-else class="card-batch-list-inner">
          <div
            v-for="item in items"
            :key="item.key"
            class="card-batch-row"
            :class="{ 'is-selected': isSelected(item) }"
            @click="toggleRow(item)"
          >
            <div class="card-batch-leading" @click.stop>
              <Checkbox
                :model-value="isSelected(item)"
                :disabled="busy"
                :aria-label="`选择 ${item.name}`"
                @update:model-value="toggleRow(item)"
              />
            </div>
            <div class="card-batch-cover">
              <img v-if="item.cover" :src="item.cover" alt="" />
              <Icon v-else :icon="iconMusic" width="16" height="16" />
            </div>
            <div class="card-batch-text">
              <span class="card-batch-name">{{ item.name }}</span>
              <span v-if="item.subtitle" class="card-batch-meta">{{ item.subtitle }}</span>
            </div>
          </div>
        </div>
      </Scrollbar>
    </div>

    <div class="card-batch-footer">
      <div class="card-batch-actions">
        <Button
          variant="danger"
          size="default"
          :disabled="busy || selectedCount === 0"
          @click="run"
        >
          <Icon :icon="iconHeart" width="16" height="16" />
          {{ actionLabel }}
        </Button>
      </div>
    </div>
  </Drawer>
</template>

<style scoped>
@reference "@/style.css";

.card-batch-header {
  flex-shrink: 0;
}

.card-batch-heading-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  color: var(--text-main);
  background: var(--control-hover-bg);
}

.card-batch-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-main);
}

.card-batch-selection {
  flex-shrink: 0;
  padding: 0 18px 8px;
}

.card-batch-select {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.card-batch-count {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.card-batch-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 0 10px;
}

.card-batch-list-inner {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 4px 12px;
}

.card-batch-empty {
  padding: 32px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary);
}

.card-batch-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 10px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.card-batch-row:hover {
  background: var(--control-hover-bg);
}

.card-batch-row.is-selected {
  background: var(--row-selected-bg);
}

.card-batch-leading {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.card-batch-cover {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  overflow: hidden;
  border-radius: 8px;
  color: var(--text-secondary);
  background: var(--control-hover-bg);
}

.card-batch-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.card-batch-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.card-batch-name {
  font-size: 13px;
  color: var(--text-main);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.card-batch-meta {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.card-batch-footer {
  flex-shrink: 0;
  padding: 10px 18px 16px;
  border-top: 1px solid var(--border-subtle);
}

.card-batch-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
</style>
