<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import TagInput from '@/components/ui/TagInput.vue';
import { parsePlaylistTags, serializePlaylistTags } from '@/utils/playlistTags';
import Textarea from '@/components/ui/Textarea.vue';
import Cover from '@/components/ui/Cover.vue';
import Skeleton from '@/components/ui/Skeleton.vue';
import type { PlaylistMeta } from '@/models/playlist';
import { useUserStore } from '@/stores/user';
import { usePlaylistStore } from '@/stores/playlist';
import { usePlaylistCoversStore } from '@/stores/playlistCovers';
import { useToastStore } from '@/stores/toast';
import {
  loadPlaylistEdit,
  savePlaylistEdit,
  validatePlaylistCoverFile,
  type PlaylistCoverFile,
  type PlaylistEditSnapshot,
} from '@/services/playlistEditing';

const props = defineProps<{ open: boolean; target: PlaylistMeta }>();
const emit = defineEmits<{
  (event: 'update:open', open: boolean): void;
  (event: 'saved', playlist: PlaylistMeta): void;
}>();
const user = useUserStore();
const playlists = usePlaylistStore();
const covers = usePlaylistCoversStore();
const toast = useToastStore();
const snapshot = shallowRef<PlaylistEditSnapshot | null>(null);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const name = ref('');
const tags = ref<string[]>([]);
const tagDraft = ref('');
const serializedTags = computed(() => serializePlaylistTags([...tags.value, tagDraft.value]));
const intro = ref('');
const coverInput = ref<HTMLInputElement | null>(null);
const selectedCover = shallowRef<(PlaylistCoverFile & { name: string }) | null>(null);
const coverPreviewUrl = ref('');
const selectingCover = ref(false);
let coverSelectionGeneration = 0;
const initialCoverUrl = ref('');
let generation = 0;
const dirty = computed(
  () =>
    !!snapshot.value &&
    (!!selectedCover.value ||
      name.value.trim() !== snapshot.value.playlist.name ||
      serializedTags.value !== snapshot.value.playlist.tags ||
      intro.value !== snapshot.value.playlist.intro),
);

function clearCoverSelection() {
  coverSelectionGeneration++;
  if (coverPreviewUrl.value) URL.revokeObjectURL(coverPreviewUrl.value);
  coverPreviewUrl.value = '';
  selectedCover.value = null;
  selectingCover.value = false;
}

async function selectCover(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || saving.value) return;
  const selection = ++coverSelectionGeneration;
  const currentGeneration = generation;
  const isCurrent = () =>
    props.open && generation === currentGeneration && selection === coverSelectionGeneration;
  let preview = '';
  selectingCover.value = true;
  error.value = '';
  try {
    validatePlaylistCoverFile(file);
    preview = URL.createObjectURL(file);
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('图片无法读取，请重新选择'));
      image.src = preview;
    });
    if (!isCurrent()) return;
    // 在客户端居中裁切并统一尺寸、格式，预览和上传使用同一份图片。
    const coverSize = 400;
    const cropSize = Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = coverSize;
    canvas.height = coverSize;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('图片处理失败，请重新选择');
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      image,
      (image.naturalWidth - cropSize) / 2,
      (image.naturalHeight - cropSize) / 2,
      cropSize,
      cropSize,
      0,
      0,
      coverSize,
      coverSize,
    );
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('图片转换失败'))),
        'image/png',
      );
    });
    if (png.size > 8 * 1024 * 1024) throw new Error('转换后的图片超过 8 MB，请选择较小的图片');
    const data = await png.arrayBuffer();
    if (!isCurrent()) return;
    URL.revokeObjectURL(preview);
    preview = URL.createObjectURL(png);
    if (coverPreviewUrl.value) URL.revokeObjectURL(coverPreviewUrl.value);
    selectedCover.value = { data, name: file.name };
    coverPreviewUrl.value = preview;
    preview = '';
  } catch (reason) {
    if (isCurrent()) error.value = reason instanceof Error ? reason.message : '图片选择失败';
  } finally {
    if (preview) URL.revokeObjectURL(preview);
    if (isCurrent()) selectingCover.value = false;
  }
}

async function load() {
  const currentGeneration = ++generation;
  const account = user.info?.userid;
  const isCurrent = () =>
    props.open && currentGeneration === generation && user.info?.userid === account;
  clearCoverSelection();
  snapshot.value = null;
  error.value = '';
  loading.value = true;
  try {
    const result = await loadPlaylistEdit(props.target, isCurrent);
    if (!isCurrent()) return;
    snapshot.value = result;
    name.value = result.playlist.name;
    tags.value = parsePlaylistTags(result.playlist.tags);
    tagDraft.value = '';
    intro.value = result.playlist.intro;
    initialCoverUrl.value = covers.coverFor(result.playlist, account);

    loading.value = false;
  } catch (reason) {
    if (isCurrent()) error.value = reason instanceof Error ? reason.message : '歌单加载失败';
  } finally {
    if (isCurrent()) loading.value = false;
  }
}

function close(value: boolean) {
  if (saving.value) return;
  emit('update:open', value);
}

async function save() {
  if (!snapshot.value || saving.value || selectingCover.value || !dirty.value) return;
  const currentGeneration = generation;
  const account = user.info?.userid;
  const isCurrent = () =>
    props.open && generation === currentGeneration && user.info?.userid === account;
  saving.value = true;
  error.value = '';
  try {
    const result = await savePlaylistEdit(
      snapshot.value,
      {
        draft: { name: name.value, tags: serializedTags.value, intro: intro.value },
        ...(selectedCover.value ? { cover: selectedCover.value } : {}),
      },
      isCurrent,
    );
    if (!isCurrent()) return;
    playlists.userPlaylists = playlists.userPlaylists.map((item) =>
      Number(item.listid ?? item.id) === snapshot.value?.listid &&
      (item.type ?? 0) === snapshot.value.type
        ? { ...item, ...result }
        : item,
    );
    if (selectedCover.value) await covers.setManualCover(result, account, isCurrent);
    if (!isCurrent()) return;
    emit('saved', result);
    toast.actionCompleted('歌单已更新');
    emit('update:open', false);
  } catch (reason) {
    if (isCurrent())
      error.value = reason instanceof Error ? reason.message : '保存失败，修改内容已保留';
  } finally {
    saving.value = false;
  }
}

watch(
  // 保存会替换 target 对象；只监听身份字段，避免重新加载打断保存后的关闭流程。
  [() => props.open, () => props.target.listid ?? props.target.id, () => props.target.type],
  () => {
    if (props.open) void load();
    else {
      generation++;
      clearCoverSelection();
    }
  },
  { immediate: true },
);
watch(
  () => user.info?.userid,
  () => {
    generation++;
    emit('update:open', false);
  },
);
onBeforeUnmount(() => {
  generation++;
  clearCoverSelection();
});
</script>

<template>
  <Dialog
    :open="open"
    title="编辑歌单"
    :content-style="{ width: 'min(480px, calc(100vw - 48px))', maxHeight: 'calc(100vh - 96px)' }"
    :close-on-escape="!saving"
    :close-on-interact-outside="!saving"
    @update:open="close"
  >
    <div v-if="loading" class="edit-fields">
      <Skeleton height="36" /><Skeleton height="36" /><Skeleton height="100" />
    </div>
    <fieldset v-else-if="snapshot" :disabled="saving" class="edit-fields">
      <div class="edit-cover-preview">
        <img
          v-if="coverPreviewUrl"
          :src="coverPreviewUrl"
          alt="所选封面预览"
          class="h-24 w-24 shrink-0 rounded-xl object-cover"
        />
        <Cover v-else :url="initialCoverUrl" :width="96" :height="96" :border-radius="12" />
        <div class="edit-cover-options">
          <span>支持 JPG、PNG、WebP，最大 8 MB</span>
          <span class="text-[var(--state-warning)]">保存后仅可更换，无法恢复自动封面</span>
          <div class="flex w-full min-w-0 items-center gap-2">
            <Button
              variant="secondary"
              size="xs"
              class="shrink-0"
              :disabled="selectingCover || saving"
              @click="coverInput?.click()"
            >
              {{ selectingCover ? '正在读取…' : '更换封面' }}
            </Button>
            <span v-if="selectedCover" class="edit-cover-name" :title="selectedCover.name">{{
              selectedCover.name
            }}</span>
          </div>
        </div>
      </div>
      <input
        ref="coverInput"
        type="file"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        class="hidden"
        aria-label="选择歌单封面"
        @change="selectCover"
      />
      <label class="edit-field"
        ><span>名称</span><Input v-model="name" :show-clear="false"
      /></label>
      <div class="edit-field">
        <span>标签</span>
        <TagInput v-model="tags" :disabled="saving" @update:draft="tagDraft = $event" />
      </div>
      <label class="edit-field"
        ><span>简介</span
        ><Textarea v-model="intro" :rows="3" placeholder="写一点关于这个歌单的介绍"
      /></label>
    </fieldset>
    <p v-if="error" class="edit-error" role="alert">{{ error }}</p>
    <template #footer>
      <Button v-if="error" variant="ghost" size="xs" :disabled="saving || loading" @click="load"
        >重新加载</Button
      >
      <div class="flex-1" />
      <Button variant="secondary" size="xs" :disabled="saving" @click="close(false)">取消</Button>
      <Button size="xs" :disabled="loading || saving || selectingCover || !dirty" @click="save">{{
        saving ? '正在保存…' : '保存'
      }}</Button>
    </template>
  </Dialog>
</template>

<style scoped>
.edit-fields {
  display: flex;
  flex-direction: column;
  gap: 14px;
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.edit-field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.edit-field :deep(input:not(.tag-input-control)) {
  height: 36px;
  padding: 0 12px;
  font-size: 13px;
  border-radius: 8px;
}
.edit-field :deep(textarea) {
  min-height: 88px;
  border-radius: 8px;
}
.edit-cover-preview {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.edit-cover-options {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}
.edit-cover-name {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-main);
}
.edit-cover-preview :deep(.cover-container) {
  flex-shrink: 0;
}
.edit-message,
.edit-error {
  font-size: 12px;
  margin: 10px 0 0;
  color: var(--color-text-secondary);
}
.edit-error {
  color: var(--color-error, #e35d6a);
}
</style>
