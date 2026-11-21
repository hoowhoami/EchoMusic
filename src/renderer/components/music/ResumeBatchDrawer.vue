<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useVModel } from '@vueuse/core';
import Drawer from '@/components/ui/Drawer.vue';
import DrawerHeader from '@/components/ui/DrawerHeader.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Checkbox from '@/components/ui/Checkbox.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import { useToastStore } from '@/stores/toast';
import type { ResumeRow } from '@/components/music/resumeScopeTypes';
import { formatDuration } from '@/utils/format';
import { iconHeart, iconHeartFilled, iconList, iconMusic, iconTrash } from '@/icons';

interface Props {
  open?: boolean;
  rows: ResumeRow[];
  /** 类型名：专辑 / 有声 / 歌手 / 歌单，用于标题与提示文案。 */
  label: string;
  favoriteAdd: string;
  favoriteRemove: string;
  isFavorite: (row: ResumeRow) => boolean;
  applyFavorite: (row: ResumeRow, next: boolean) => Promise<boolean>;
  onRemove: (rows: ResumeRow[]) => void;
}

const props = withDefaults(defineProps<Props>(), { open: false });
const emit = defineEmits<{ 'update:open': [boolean] }>();

const open = useVModel(props, 'open', emit, { passive: true });
const toastStore = useToastStore();

const selectedKeys = ref<string[]>([]);
const busy = ref(false);
const showRemoveDialog = ref(false);

const selectedRows = computed(() =>
  props.rows.filter((row) => selectedKeys.value.includes(row.key)),
);
const selectedCount = computed(() => selectedRows.value.length);
const allSelected = computed(
  () => props.rows.length > 0 && props.rows.every((row) => selectedKeys.value.includes(row.key)),
);

const isSelected = (row: ResumeRow): boolean => selectedKeys.value.includes(row.key);

const toggleRow = (row: ResumeRow) => {
  if (busy.value) return;
  selectedKeys.value = isSelected(row)
    ? selectedKeys.value.filter((key) => key !== row.key)
    : [...selectedKeys.value, row.key];
};

const toggleAll = (value: boolean | 'indeterminate') => {
  selectedKeys.value = value === true ? props.rows.map((row) => row.key) : [];
};

const reset = () => {
  selectedKeys.value = [];
  showRemoveDialog.value = false;
};

const close = () => {
  if (busy.value) return;
  reset();
  open.value = false;
};

// 行数据变化（别处删了、搜索词变了）后，把已经消失的行从选中集合里剔掉，
// 免得计数说 3 条、实际只删到 2 条。
watch(
  () => props.rows,
  (rows) => {
    const alive = new Set(rows.map((row) => row.key));
    if (selectedKeys.value.some((key) => !alive.has(key))) {
      selectedKeys.value = selectedKeys.value.filter((key) => alive.has(key));
    }
  },
);

// 点遮罩 / 按 Esc 也会改 open，清理不能只挂在头部关闭按钮上。
watch(open, (value) => {
  if (!value) reset();
});

/** 批量收藏/取消收藏：只处理状态跟目标不一致的行，已经是对的就跳过。 */
const batchFavorite = async (next: boolean) => {
  const targets = selectedRows.value.filter((row) => props.isFavorite(row) !== next);
  if (targets.length === 0) {
    toastStore.info(next ? '选中的都已经收藏过了' : '选中的都还没收藏');
    return;
  }
  busy.value = true;
  let failed = 0;
  for (const row of targets) {
    const done = await props.applyFavorite(row, next);
    if (!done) failed += 1;
  }
  busy.value = false;
  if (failed > 0) {
    toastStore.actionFailed(next ? props.favoriteAdd : props.favoriteRemove);
    return;
  }
  if (next) toastStore.actionSucceeded(`批量${props.favoriteAdd}`);
  else toastStore.actionCompleted(`已批量${props.favoriteRemove}`);
  reset();
  open.value = false;
};

const confirmRemove = () => {
  const targets = selectedRows.value.slice();
  showRemoveDialog.value = false;
  if (targets.length === 0) return;
  props.onRemove(targets);
  toastStore.actionCompleted(`已删除 ${targets.length} 条续播记录`);
  reset();
  open.value = false;
};
</script>

<template>
  <Drawer
    v-model:open="open"
    side="right"
    title="批量操作"
    overlayClass="resume-batch-overlay"
    panelClass="resume-batch-drawer"
  >
    <DrawerHeader class="resume-batch-header" :close-disabled="busy" @close="close">
      <template #leading>
        <span class="resume-batch-heading-icon">
          <Icon :icon="iconList" width="22" height="22" />
        </span>
      </template>
      <template #title><h2 class="resume-batch-title">批量操作</h2></template>
    </DrawerHeader>

    <div class="resume-batch-selection">
      <label class="resume-batch-select">
        <Checkbox
          :model-value="allSelected"
          :disabled="busy || rows.length === 0"
          :aria-label="allSelected ? '取消全选' : '全选'"
          @update:model-value="toggleAll"
        />
        <span class="resume-batch-count" aria-live="polite">
          {{ selectedCount }}/{{ rows.length }}
        </span>
      </label>
    </div>

    <div class="resume-batch-list">
      <Scrollbar class="flex-1 min-h-0" :scrollbar-inset="4">
        <div v-if="rows.length === 0" class="resume-batch-empty">暂无可操作的{{ label }}</div>
        <div v-else class="resume-batch-list-inner">
          <div
            v-for="row in rows"
            :key="row.key"
            class="resume-batch-row"
            :class="{ 'is-selected': isSelected(row) }"
            @click="toggleRow(row)"
          >
            <div class="resume-batch-leading" @click.stop>
              <Checkbox
                :model-value="isSelected(row)"
                :disabled="busy"
                :aria-label="`选择 ${row.name}`"
                @update:model-value="toggleRow(row)"
              />
            </div>
            <div class="resume-batch-cover">
              <img v-if="row.cover" :src="row.cover" alt="" />
              <Icon v-else :icon="iconMusic" width="16" height="16" />
            </div>
            <div class="resume-batch-text">
              <span class="resume-batch-name">{{ row.name }}</span>
              <span class="resume-batch-meta">
                {{ row.hint }} · {{ formatDuration(row.position) }} /
                {{ row.duration > 0 ? formatDuration(row.duration) : '—' }}
              </span>
            </div>
          </div>
        </div>
      </Scrollbar>
    </div>

    <div class="resume-batch-footer">
      <div class="resume-batch-actions">
        <Button
          variant="secondary"
          size="default"
          :disabled="busy || selectedCount === 0"
          @click="batchFavorite(true)"
        >
          <Icon :icon="iconHeartFilled" width="16" height="16" class="resume-batch-fav-icon" />
          {{ favoriteAdd }}
        </Button>
        <Button
          variant="secondary"
          size="default"
          :disabled="busy || selectedCount === 0"
          @click="batchFavorite(false)"
        >
          <Icon :icon="iconHeart" width="16" height="16" class="resume-batch-fav-icon" />
          {{ favoriteRemove }}
        </Button>
        <Button
          variant="danger"
          size="default"
          class="resume-batch-danger"
          :disabled="busy || selectedCount === 0"
          @click="showRemoveDialog = true"
        >
          <Icon :icon="iconTrash" width="16" height="16" />
          删除
        </Button>
      </div>
    </div>

    <Dialog
      v-model:open="showRemoveDialog"
      title="删除"
      :description="`确认删除选中的 ${selectedCount} 条？此操作不可撤销。`"
    >
      <template #footer>
        <div class="flex justify-end gap-3">
          <Button variant="danger" size="default" @click="confirmRemove"> 确认删除 </Button>
          <Button variant="outline" size="default" @click="showRemoveDialog = false"> 取消 </Button>
        </div>
      </template>
    </Dialog>
  </Drawer>
</template>

<style scoped>
:global(.drawer-panel.resume-batch-drawer) {
  padding: 0;
  box-shadow: var(--shadow-dialog);
  width: min(420px, calc(100vw - 24px));
  top: var(--drawer-safe-top);
  right: 12px;
  bottom: var(--drawer-safe-bottom);
  border-radius: var(--radius-popover);
  overflow: hidden;
}

.resume-batch-header {
  flex-shrink: 0;
  padding: 16px 20px;
}

.resume-batch-heading-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--primary, #22c55e) 14%, transparent);
  color: var(--color-primary-text);
}

.resume-batch-title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--text-main);
}

.resume-batch-selection {
  flex-shrink: 0;
  margin: 0 20px 10px;
  padding: 10px 8px 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.resume-batch-select {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.resume-batch-count {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.resume-batch-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 0 0 8px 20px;
}

.resume-batch-list-inner {
  padding-right: 20px;
}

.resume-batch-empty {
  padding: 48px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-secondary);
}

.resume-batch-row {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 56px;
  padding: 0 8px 0 0;
  border-radius: 10px;
  cursor: pointer;
  transition: background-color 0.16s ease;
}

.resume-batch-row:hover {
  background: var(--row-hover-bg);
}

.resume-batch-row.is-selected {
  background: var(--row-selected-bg);
}

.resume-batch-leading {
  display: flex;
  align-items: center;
}

.resume-batch-cover {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: var(--radius-media, 8px);
  background: var(--surface-muted, transparent);
  overflow: hidden;
  color: var(--text-secondary);
}

.resume-batch-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.resume-batch-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.resume-batch-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main);
}

.resume-batch-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-secondary);
}

.resume-batch-footer {
  flex-shrink: 0;
  padding: 16px 20px;
  border-top: 1px solid var(--border-subtle);
}

.resume-batch-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.resume-batch-danger {
  margin-left: auto;
}

/* 收藏 / 取消收藏两颗爱心都用红色，和续播表里的爱心同一套配色。 */
.resume-batch-fav-icon {
  color: #ef4444;
}
</style>
