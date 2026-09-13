<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import InputNumber from '@/components/ui/InputNumber.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import { useVirtualList } from '@/composables/useVirtualList';
import { usePlaylistStore } from '@/stores/playlist';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import { iconArrowUp, iconArrowDown } from '@/icons';
import {
  loadPlaylistOrder,
  persistPlaylistOrder,
  type PlaylistOrderSnapshot,
  type PlaylistOrderTarget,
} from '@/services/playlistOrdering';

const props = defineProps<{ open: boolean; target: PlaylistOrderTarget }>();
const emit = defineEmits<{ 'update:open': [value: boolean]; saved: [] }>();
const playlistStore = usePlaylistStore();
const userStore = useUserStore();
const toastStore = useToastStore();
const snapshot = shallowRef<PlaylistOrderSnapshot | null>(null);
const ids = ref<string[]>([]);
const selectedId = ref('');
const position = ref(1);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const draggedId = ref('');
const dropId = ref('');
const dragActive = ref(false);
const settling = ref(false);
const dragPreview = ref({ left: 0, top: 0, width: 0 });
const scrollbar = ref<InstanceType<typeof Scrollbar> | null>(null);
const scroller = computed(() => scrollbar.value?.wrapRef ?? null);
let generation = 0;
const account = computed(() => String(userStore.info?.userid ?? ''));
const targetKey = computed(() =>
  props.target.kind === 'tracks'
    ? `tracks:${props.target.listid}:${props.target.queryId}`
    : `playlists:${props.target.type}`,
);
const title = computed(() =>
  props.target.kind === 'tracks'
    ? '调整歌曲顺序'
    : props.target.type === 0
      ? '调整自建歌单顺序'
      : '调整收藏歌单顺序',
);
const originalIds = computed(
  () => snapshot.value?.items.filter((item) => !item.hidden).map((item) => item.id) ?? [],
);
const byId = computed(
  () =>
    new Map(
      snapshot.value?.items.filter((item) => !item.hidden).map((item) => [item.id, item]) ?? [],
    ),
);
const selectedIndex = computed(() => ids.value.indexOf(selectedId.value));
const dirty = computed(() => ids.value.some((id, index) => id !== originalIds.value[index]));
const busy = computed(() => loading.value || saving.value || settling.value);
const draggedItem = computed(() => byId.value.get(draggedId.value));
function rowOffset(index: number) {
  if (!dragActive.value || !dropId.value) return 0;
  const from = ids.value.indexOf(draggedId.value);
  const to = ids.value.indexOf(dropId.value);
  if (from < to && index > from && index <= to) return -52;
  if (from > to && index >= to && index < from) return 52;
  return 0;
}
const { containerRef, visibleStart, visibleEnd, totalSize, offset, scrollToIndex } = useVirtualList(
  {
    itemCount: () => ids.value.length,
    itemSize: 52,
    scrollContainer: scroller,
    active: () => props.open,
    overscan: 6,
  },
);
const visibleItems = computed(() =>
  ids.value.slice(visibleStart.value, visibleEnd.value).map((id, index) => ({
    ...byId.value.get(id)!,
    index: index + visibleStart.value,
  })),
);

async function load() {
  clearDrag();
  const operation = ++generation;
  const userId = account.value;
  const isCurrent = () => props.open && generation === operation && account.value === userId;
  loading.value = true;
  error.value = '';
  snapshot.value = null;
  ids.value = [];
  selectedId.value = '';
  try {
    if (!userId) throw new Error('请先登录');
    const result = await loadPlaylistOrder(props.target, isCurrent);
    if (!isCurrent()) return;
    snapshot.value = result;
    ids.value = originalIds.value.slice();
    selectedId.value = ids.value[0] ?? '';
    position.value = 1;
    await nextTick();
    scrollbar.value?.setScrollTop(0);
  } catch (err) {
    if (isCurrent()) error.value = err instanceof Error ? err.message : '加载失败，请重试';
  } finally {
    if (isCurrent()) loading.value = false;
  }
}

function select(id: string) {
  selectedId.value = id;
  position.value = ids.value.indexOf(id) + 1;
}
function moveToPosition(event?: KeyboardEvent) {
  if (event?.isComposing) return;
  // InputNumber commits typed values on blur before the move reads the position.
  if (event?.target instanceof HTMLInputElement) event.target.blur();
  move(selectedId.value, position.value - 1, true);
}
function move(id: string, destination: number, scroll = false) {
  if (busy.value || !Number.isFinite(destination)) return;
  const from = ids.value.indexOf(id);
  if (from < 0) return;
  const to = Math.max(0, Math.min(ids.value.length - 1, Math.trunc(destination)));
  const next = ids.value.slice();
  next.splice(from, 1);
  next.splice(to, 0, id);
  ids.value = next;
  select(id);
  if (scroll) void nextTick(() => scrollToIndex(to));
}
let dragFrame = 0;
let dragPointer = -1;
let dragX = 0;
let dragY = 0;
let dragStartY = 0;
let dragMoved = false;
let dragGrabOffset = 0;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
function clearDrag() {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = null;
  settling.value = false;
  dragActive.value = false;
  if (dragFrame) cancelAnimationFrame(dragFrame);
  dragFrame = 0;
  dragPointer = -1;
  draggedId.value = '';
  dropId.value = '';
  document.removeEventListener('pointermove', pointerMove);
  document.removeEventListener('pointerup', pointerUp);
  document.removeEventListener('pointercancel', clearDrag);
  window.removeEventListener('blur', clearDrag);
}
function updateDropTarget() {
  const element = scroller.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  if (dragX < rect.left || dragX > rect.right || dragY < rect.top || dragY > rect.bottom) {
    dropId.value = '';
    return;
  }
  const index = Math.min(
    ids.value.length - 1,
    Math.floor((dragY - rect.top + element.scrollTop) / 52),
  );
  dropId.value = ids.value[index] ?? '';
}
function dragScroll() {
  dragFrame = 0;
  const element = scroller.value;
  if (!element || dragPointer < 0) return;
  const rect = element.getBoundingClientRect();
  if (dragMoved && dragX >= rect.left && dragX <= rect.right) {
    const delta = dragY < rect.top + 28 ? -8 : dragY > rect.bottom - 28 ? 8 : 0;
    if (delta) element.scrollBy({ top: delta, behavior: 'instant' });
    updateDropTarget();
  }
  dragFrame = requestAnimationFrame(dragScroll);
}
function pointerMove(event: PointerEvent) {
  if (event.pointerId !== dragPointer) return;
  dragX = event.clientX;
  dragY = event.clientY;
  dragMoved ||= Math.abs(dragY - dragStartY) > 4;
  if (dragMoved) {
    dragActive.value = true;
    dragPreview.value.top = dragY - dragGrabOffset;
    updateDropTarget();
  }
}
function pointerUp(event: PointerEvent) {
  if (event.pointerId !== dragPointer) return;
  pointerMove(event);
  if (!dragMoved || !dropId.value || !scroller.value) {
    clearDrag();
    return;
  }
  const id = draggedId.value;
  const destination = ids.value.indexOf(dropId.value);
  document.removeEventListener('pointermove', pointerMove);
  document.removeEventListener('pointerup', pointerUp);
  if (dragFrame) cancelAnimationFrame(dragFrame);
  dragFrame = 0;
  dragPointer = -1;
  settling.value = true;
  const element = scroller.value;
  dragPreview.value.top =
    element.getBoundingClientRect().top + destination * 52 - element.scrollTop;
  settleTimer = setTimeout(() => {
    settling.value = false;
    move(id, destination);
    clearDrag();
  }, 180);
}
function startDrag(event: PointerEvent, id: string) {
  if (busy.value || event.button !== 0) return;
  event.preventDefault();
  clearDrag();
  select(id);
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dragGrabOffset = event.clientY - rect.top;
  dragPreview.value = { left: rect.left, top: rect.top, width: rect.width };
  draggedId.value = id;
  dragPointer = event.pointerId;
  dragX = event.clientX;
  dragY = dragStartY = event.clientY;
  dragMoved = false;
  document.addEventListener('pointermove', pointerMove);
  document.addEventListener('pointerup', pointerUp);
  document.addEventListener('pointercancel', clearDrag);
  window.addEventListener('blur', clearDrag);
  dragFrame = requestAnimationFrame(dragScroll);
}
function updateOpen(open: boolean) {
  if (saving.value) return;
  emit('update:open', open);
}
async function save() {
  if (!snapshot.value || busy.value || !dirty.value) return;
  const operation = generation;
  const userId = account.value;
  const isCurrent = () => props.open && operation === generation && account.value === userId;
  const saved = snapshot.value;
  saving.value = true;
  error.value = '';
  try {
    await persistPlaylistOrder(saved, ids.value, isCurrent);
    if (!isCurrent()) return;
    if (saved.target.kind === 'tracks') {
      playlistStore.forgetPlaylistSongs(saved.target.listid);
      playlistStore.markPlaylistContentChanged(saved.target.listid, 'refresh');
      const liked = playlistStore.likedPlaylist;
      if (Number(liked?.listid ?? liked?.id) === saved.target.listid) {
        void playlistStore.fetchLikedPlaylistSongs(true);
      }
    } else {
      void playlistStore.fetchUserPlaylists();
    }
    toastStore.actionCompleted('顺序已保存到酷狗');
    emit('saved');
    emit('update:open', false);
  } catch (err) {
    if (isCurrent()) error.value = err instanceof Error ? err.message : '保存失败，请重试';
  } finally {
    saving.value = false;
  }
}
watch(
  () => [props.open, targetKey.value] as const,
  ([open]) => {
    if (open) void load();
    else {
      generation++;
      clearDrag();
      loading.value = false;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  clearDrag();
});
watch(account, () => {
  generation++;
  clearDrag();
  snapshot.value = null;
  ids.value = [];
  emit('update:open', false);
});
</script>

<template>
  <Dialog
    :open="open"
    :title="title"
    description="调整列表顺序并保存到酷狗"
    :content-style="{
      width: 'min(540px, calc(100vw - 48px))',
      height: 'min(480px, calc(100vh - 96px))',
      maxHeight: 'calc(100vh - 96px)',
    }"
    no-scroll
    :close-on-escape="!saving"
    :close-on-interact-outside="!saving"
    @update:open="updateOpen"
  >
    <div class="order-editor">
      <div class="order-description">
        <p v-if="target.kind === 'tracks'" class="order-playlist-name">{{ target.title }}</p>
        <p>
          拖动排序，或选中后移动到指定位置。<span v-if="target.kind === 'playlists'"
            >默认收藏和我喜欢保持置顶。</span
          >
        </p>
      </div>
      <div v-if="error" role="alert" class="order-error">
        <span>{{ error }}</span>
        <Button variant="ghost" size="xs" :disabled="busy" @click="load">重新加载</Button>
      </div>
      <div v-if="loading" class="order-loading" role="status" aria-label="正在加载并排序">
        <Skeleton height="44" radius="10" />
        <div class="order-loading-rows">
          <div v-for="row in 5" :key="row" class="order-loading-row">
            <Skeleton width="24" height="12" />
            <div class="flex-1 space-y-2">
              <Skeleton :width="row % 2 ? '58%' : '76%'" height="12" />
              <Skeleton width="32%" height="9" />
            </div>
          </div>
        </div>
      </div>
      <template v-else-if="snapshot">
        <div class="order-toolbar">
          <span class="order-count"
            >{{ ids.length }} {{ target.kind === 'tracks' ? '首歌曲' : '个歌单' }}</span
          >
          <div class="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="xs"
              class="order-icon-button"
              tooltip="上移"
              aria-label="上移"
              :disabled="busy || selectedIndex <= 0"
              @click="move(selectedId, selectedIndex - 1, true)"
            >
              <Icon :icon="iconArrowUp" width="16" />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              class="order-icon-button"
              tooltip="下移"
              aria-label="下移"
              :disabled="busy || selectedIndex < 0 || selectedIndex === ids.length - 1"
              @click="move(selectedId, selectedIndex + 1, true)"
            >
              <Icon :icon="iconArrowDown" width="16" />
            </Button>
            <span class="order-tool-divider" aria-hidden="true"></span>
            <label for="playlist-order-position" class="text-xs text-text-secondary">移到</label>
            <InputNumber
              id="playlist-order-position"
              :model-value="position"
              :min="1"
              :max="Math.max(1, ids.length)"
              :step="1"
              :disabled="busy || !ids.length"
              class="order-position"
              suffix="位"
              @update:model-value="position = Number($event)"
              @keydown.enter.prevent="moveToPosition"
            />
            <Button
              variant="secondary"
              size="xs"
              class="order-action-button"
              :disabled="busy || selectedIndex < 0"
              @click="moveToPosition()"
              >移动</Button
            >
          </div>
        </div>
        <Scrollbar ref="scrollbar" class="order-scroll">
          <div v-if="!ids.length" class="order-empty">没有可调整顺序的条目</div>
          <div
            ref="containerRef"
            :style="{ height: `${totalSize}px`, position: 'relative' }"
            role="list"
            aria-label="自定义顺序"
          >
            <div :style="{ transform: `translateY(${offset}px)` }">
              <div
                v-for="item in visibleItems"
                :key="item.id"
                class="order-row"
                :class="{
                  selected: selectedId === item.id,
                  dragging: dragActive && draggedId === item.id,
                  reordering: dragActive,
                }"
                :style="{ transform: `translateY(${rowOffset(item.index)}px)` }"
                role="listitem"
              >
                <button
                  type="button"
                  class="order-row-select"
                  @pointerdown="startDrag($event, item.id)"
                  @dragstart.prevent
                  :disabled="busy"
                  :aria-pressed="selectedId === item.id"
                  @click="select(item.id)"
                >
                  <span class="order-number">{{ item.index + 1 }}</span>
                  <span class="min-w-0 flex-1 text-left">
                    <span class="block truncate text-[13px] font-medium">{{ item.title }}</span>
                    <span
                      v-if="item.subtitle"
                      class="block truncate text-[11px] text-text-secondary"
                      >{{ item.subtitle }}</span
                    >
                  </span>
                  <span class="order-grip" aria-hidden="true"
                    ><span></span><span></span><span></span><span></span><span></span><span></span
                  ></span>
                </button>
              </div>
            </div>
          </div>
        </Scrollbar>
      </template>
      <div
        v-if="dragActive && draggedItem"
        class="order-drag-preview"
        :class="{ settling }"
        :style="{
          left: `${dragPreview.left}px`,
          top: `${dragPreview.top}px`,
          width: `${dragPreview.width}px`,
        }"
        aria-hidden="true"
      >
        <span class="order-number">{{ ids.indexOf(dropId || draggedId) + 1 }}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[13px] font-medium">{{ draggedItem.title }}</span>
          <span
            v-if="draggedItem.subtitle"
            class="block truncate text-[11px] text-text-secondary"
            >{{ draggedItem.subtitle }}</span
          >
        </span>
      </div>
    </div>
    <template #footer>
      <Button
        variant="ghost"
        size="xs"
        class="order-action-button"
        :disabled="busy || !dirty"
        @click="
          ids = originalIds.slice();
          select(ids[0] ?? '');
        "
        >还原顺序</Button
      >
      <div class="flex-1"></div>
      <span v-if="dirty" class="order-save-hint">有未保存的调整</span>
      <Button
        variant="secondary"
        size="xs"
        class="order-action-button"
        :disabled="saving"
        @click="updateOpen(false)"
        >取消</Button
      >
      <Button size="xs" class="order-action-button" :disabled="busy || !dirty" @click="save">{{
        saving ? '正在保存…' : '保存顺序'
      }}</Button>
    </template>
  </Dialog>
</template>

<style scoped>
.order-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  height: 100%;
}
.order-description {
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.7;
}
.order-playlist-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 2px;
  color: var(--color-text-main);
  font-weight: 500;
}
.order-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px 6px 12px;
  border-radius: 10px;
  background: var(--control-muted-bg);
}
.order-loading {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}
.order-loading-rows {
  flex: 1;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
}
.order-loading-row {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 52px;
  padding: 0 14px;
}
.order-count {
  color: var(--color-text-secondary);
  font-size: 12px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.order-icon-button {
  width: 30px;
  height: 30px;
  padding: 0;
  border-radius: 7px;
}
.order-action-button {
  font-weight: 500;
}
.order-tool-divider {
  width: 1px;
  height: 16px;
  margin: 0 5px;
  background: var(--control-border);
}
.order-position.input-number {
  width: 92px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 8px;
  background: var(--color-bg-dialog);
}
.order-position :deep(.input-number-field) {
  padding-left: 10px;
  font-size: 12px;
  font-weight: 500;
  line-height: 30px;
}
.order-position :deep(.input-number-suffix) {
  font-size: 11px;
  font-weight: 400;
}
.order-position :deep(.input-number-controls) {
  width: 22px;
}
.order-save-hint {
  align-self: center;
  color: var(--color-text-secondary);
  font-size: 11px;
}
.order-scroll {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
}
.order-row {
  height: 52px;
  border-top: 2px solid transparent;
  color: var(--color-text-main);
  transition: background-color 120ms ease;
}
.order-row:hover {
  background: var(--control-hover-bg);
}
.order-row.selected {
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  box-shadow: inset 2px 0 var(--color-primary);
}
.order-row.selected .order-number {
  color: var(--color-primary);
}
.order-row.dragging {
  visibility: hidden;
}
.order-row.reordering {
  transition:
    transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
    background-color 120ms ease;
}
.order-drag-preview {
  position: fixed;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 52px;
  padding: 0 12px;
  border: 1px solid color-mix(in srgb, var(--color-primary) 28%, var(--control-border));
  border-radius: 10px;
  background: var(--color-bg-dialog);
  color: var(--color-text-main);
  box-shadow: 0 8px 24px rgb(0 0 0 / 14%);
  pointer-events: none;
  transform: scale(1.015);
}
.order-drag-preview.settling {
  transform: scale(1);
  box-shadow: none;
  transition:
    top 160ms ease-out,
    transform 160ms ease-out,
    box-shadow 160ms ease-out;
}
@media (prefers-reduced-motion: reduce) {
  .order-row.reordering,
  .order-drag-preview.settling {
    transition: none;
  }
}
.order-row-select {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 100%;
  padding: 0 12px;
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.order-row-select:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}
.order-grip {
  display: grid;
  grid-template-columns: repeat(2, 2px);
  gap: 3px;
  padding: 6px 2px 6px 10px;
  flex-shrink: 0;
  color: var(--color-text-secondary);
  opacity: 0.4;
}
.order-grip span {
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: currentColor;
}
.order-row:hover .order-grip,
.order-row.selected .order-grip {
  opacity: 0.8;
}
.order-number {
  width: 34px;
  flex-shrink: 0;
  text-align: right;
  font-size: 12px;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}
.order-empty {
  padding: 48px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-secondary);
}
.order-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--color-text-main);
  padding: 8px 12px;
  background: var(--control-hover-bg);
  border-radius: 10px;
}
</style>
