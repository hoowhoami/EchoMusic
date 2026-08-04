<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useVModel } from '@vueuse/core';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import {
  iconCheckMark,
  iconCloudUpload,
  iconFolderOpen,
  iconLoader2,
  iconUpload,
  iconX,
} from '@/icons';
import { uploadToCloud } from '@/api/user';
import {
  explainCloudUploadMatchRejection,
  findBestMatch,
  isCloudUploadMatchAcceptable,
  matchThinkDelay,
  normalizePositiveNumericId,
} from '@/utils/songMatching';
import { useToastStore } from '@/stores/toast';
import { useUserStore } from '@/stores/user';
import logger from '@/utils/logger';

interface Props {
  open?: boolean;
}
const props = withDefaults(defineProps<Props>(), { open: false });
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();
const open = useVModel(props, 'open', emit, { defaultValue: false });

const userStore = useUserStore();
const toastStore = useToastStore();

type PickMode = 'file' | 'folder';
type MatchStatus = 'pending' | 'linked' | 'not_found' | 'low_score' | 'no_cloud_ids' | 'failed';

interface UploadItem {
  name: string;
  path: string;
  /** 标签解析出的歌名（用于上传显示名） */
  title?: string;
  /** 标签解析出的歌手 */
  artist?: string;
  /** 标签解析出的时长（秒） */
  duration?: number;
  size: number;
  extension: string;
  modifiedAt: number;
  status: 'pending' | 'matching' | 'uploading' | 'success' | 'failed';
  /** 匹配到的歌曲 audio_id（未匹配时为 undefined，上游传 0） */
  audioId?: string | number;
  /** 匹配到的歌曲 album_audio_id */
  albumAudioId?: string | number;
  /** 曲库关联匹配状态 */
  matchStatus: MatchStatus;
  /** 曲库关联匹配说明，写入日志用于排查 */
  matchReason?: string;
  /** 秒传（服务端已存在相同 MD5 的文件） */
  isSecondUpload?: boolean;
  error?: string;
}

const step = ref<'pick' | 'uploading' | 'done'>('pick');
const items = ref<UploadItem[]>([]);
const canceled = ref(false);
const picking = ref(false);

/** 匹配并发数（复用导入歌单防风控节奏） */
const MATCH_CONCURRENCY = 2;

const doneCount = computed(() => items.value.filter((i) => i.status === 'success').length);
const failedCount = computed(() => items.value.filter((i) => i.status === 'failed').length);
const progressRatio = computed(() => {
  if (items.value.length === 0) return 0;
  const done = items.value.filter((i) => i.status === 'success' || i.status === 'failed').length;
  return done / items.value.length;
});
const isUploading = computed(() => step.value === 'uploading');

const formatBytes = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
};

const clearPickedUploadFiles = () => {
  void window.electron.cloud.clearUploadFiles().catch(() => undefined);
};

const reset = () => {
  step.value = 'pick';
  items.value = [];
  canceled.value = false;
};

const handleClose = (value: boolean) => {
  if (value === false && isUploading.value) return;
  if (value === false) {
    clearPickedUploadFiles();
    reset();
  }
  open.value = value;
};

const closeDialog = () => {
  handleClose(false);
};

/**
 * 匹配单个文件：复用导入歌单的搜索机制，获取 audio_id / album_audio_id
 * 云盘写入曲库 ID 采用更保守的匹配门槛，误关联比不关联更难清理。
 */
const matchItem = async (item: UploadItem) => {
  const title = item.title || item.name.replace(/\.[^.]+$/, '');
  item.status = 'matching';
  try {
    const matchInput = {
      file: item.name,
      title,
      artist: item.artist || '',
      duration: item.duration,
    };
    const result = await findBestMatch(
      {
        title,
        artist: item.artist || '',
        duration: item.duration,
      },
      {
        pageSize: 3,
        maxKeywords: 3,
        delayBetweenSearches: true,
        shouldStopEarly: isCloudUploadMatchAcceptable,
      },
    );
    if (!result) {
      item.matchStatus = 'not_found';
      item.matchReason = 'search returned no candidates';
      logger.debug('CloudUpload', 'match not found', matchInput);
    } else if (!isCloudUploadMatchAcceptable(result)) {
      item.matchStatus = 'low_score';
      item.matchReason = explainCloudUploadMatchRejection(result);
      logger.debug('CloudUpload', 'match score too low', {
        ...matchInput,
        score: result.score,
        scoreDetails: result.scoreDetails,
        searchText: result.searchText,
        candidate: {
          name: result.song.name,
          artist: result.song.artist,
          album: result.song.albumName || result.song.album,
          audioId: result.audioId ?? result.song.fileId,
          albumAudioId: result.albumAudioId ?? result.song.mixSongId,
        },
      });
    } else {
      // audio_id 采用匹配歌曲的 Auditoid/audio_id/fileId，album_audio_id 采用 mixsongid。
      // （注意与 song.id 不同：song.id 是 MixSongID，不能用作 audio_id）
      const audioId = normalizePositiveNumericId(result.audioId ?? result.song.fileId);
      if (audioId) {
        item.audioId = audioId;
      }
      const albumAudioId = normalizePositiveNumericId(result.albumAudioId ?? result.song.mixSongId);
      if (albumAudioId) {
        item.albumAudioId = albumAudioId;
      }
      const logPayload = {
        ...matchInput,
        score: result.score,
        scoreDetails: result.scoreDetails,
        searchText: result.searchText,
        matched: {
          name: result.song.name,
          artist: result.song.artist,
          album: result.song.albumName || result.song.album,
          audioId: item.audioId,
          albumAudioId: item.albumAudioId,
        },
      };
      if (item.audioId || item.albumAudioId) {
        item.matchStatus = 'linked';
        item.matchReason = undefined;
        logger.debug('CloudUpload', 'match linked', logPayload);
      } else {
        item.matchStatus = 'no_cloud_ids';
        item.matchReason = 'matched candidate has no audio_id or album_audio_id';
        logger.debug('CloudUpload', 'match has no cloud ids', logPayload);
      }
    }
  } catch (error) {
    item.matchStatus = 'failed';
    item.matchReason = String(error);
    logger.debug('CloudUpload', 'match failed', {
      file: item.name,
      title,
      artist: item.artist || '',
      error: String(error),
    });
    // 匹配失败不影响上传，降级为不关联
  }
  // 每个文件匹配后暂停一段抖动时间，避免稳定 QPS 触发风控
  await matchThinkDelay();
  item.status = 'pending';
};

/** 阶段一：并发匹配所有文件 */
const runMatching = async () => {
  let nextIdx = 0;
  const worker = async () => {
    while (true) {
      if (canceled.value) return;
      const i = nextIdx++;
      if (i >= items.value.length) return;
      await matchItem(items.value[i]);
    }
  };
  await Promise.all(Array.from({ length: MATCH_CONCURRENCY }, () => worker()));
};

const handlePick = async (mode: PickMode) => {
  if (!userStore.isLoggedIn || picking.value) return;
  picking.value = true;
  try {
    const result = await window.electron.cloud.pickUploadFiles(mode);
    if (result.canceled) return;

    if (result.files.length === 0) {
      toastStore.warning(result.errors?.[0] || '没有可上传的音频文件');
      return;
    }
    if (result.errors?.length) {
      toastStore.warning(`${result.errors.length} 个文件被跳过（超出大小限制或读取失败）`);
    }

    items.value = result.files.map((f) => ({
      name: f.name,
      path: f.path,
      title: f.title,
      artist: f.artist,
      duration: f.duration,
      size: f.size,
      extension: f.extension,
      modifiedAt: f.modifiedAt,
      status: 'pending' as const,
      matchStatus: 'pending',
    }));
    step.value = 'uploading';
    canceled.value = false;
    // 阶段一：并发匹配获取 audio_id / album_audio_id
    await runMatching();
    // 阶段二：串行上传
    await runUpload();
  } catch (error) {
    toastStore.danger(`选择文件失败：${(error as Error)?.message || String(error)}`);
  } finally {
    picking.value = false;
  }
};

const uploadSingleItem = async (item: UploadItem) => {
  const title = item.title || item.name.replace(/\.[^.]+$/, '');
  item.status = 'uploading';
  try {
    const dataResult = await window.electron.cloud.readUploadFileData(item.path);
    if (!dataResult.ok) throw new Error(dataResult.error);
    const res = await uploadToCloud(dataResult.data, {
      name: title,
      extendname: item.extension.replace(/^\./, ''),
      authorName: item.artist,
      audioId: item.audioId,
      albumAudioId: item.albumAudioId,
    });
    item.isSecondUpload = !res?.uploadInfo?.upload_id;
    item.status = 'success';
    logger.debug('CloudUpload', 'upload success', {
      file: item.name,
      title,
      artist: item.artist || '',
      secondUpload: item.isSecondUpload,
      matchStatus: item.matchStatus,
      matchReason: item.matchReason,
      audioId: item.audioId ?? 0,
      albumAudioId: item.albumAudioId ?? 0,
    });
  } catch (error) {
    item.status = 'failed';
    item.error = (error as Error)?.message || String(error);
    logger.debug('CloudUpload', 'upload failed', {
      file: item.name,
      title,
      artist: item.artist || '',
      matchStatus: item.matchStatus,
      matchReason: item.matchReason,
      audioId: item.audioId ?? 0,
      albumAudioId: item.albumAudioId ?? 0,
      error: item.error,
    });
  }
};

const runUpload = async () => {
  for (let i = 0; i < items.value.length; i++) {
    if (canceled.value) break;
    await uploadSingleItem(items.value[i]);
  }
  step.value = 'done';
  clearPickedUploadFiles();

  if (canceled.value) {
    toastStore.info('已取消上传');
  } else if (failedCount.value === 0) {
    const secondCount = items.value.filter((i) => i.isSecondUpload).length;
    toastStore.success(
      secondCount > 0
        ? `上传完成：${doneCount.value} 首（其中 ${secondCount} 首秒传）`
        : `上传完成：${doneCount.value} 首`,
    );
  } else {
    toastStore.warning(`上传完成：成功 ${doneCount.value} 首，失败 ${failedCount.value} 首`);
  }
};

const handleCancel = () => {
  canceled.value = true;
  const uploading = items.value.find((i) => i.status === 'uploading' || i.status === 'matching');
  if (uploading) uploading.status = 'pending';
};

const statusLabel = (item: UploadItem) => {
  if (item.status === 'matching') return '匹配中';
  if (item.status === 'uploading') return '上传中';
  if (item.status === 'success') {
    const uploadLabel = item.isSecondUpload ? '秒传成功' : '成功';
    const linkLabel = item.audioId || item.albumAudioId ? '已关联曲库' : '云端自动匹配';
    return `${uploadLabel} · ${linkLabel}`;
  }
  if (item.status === 'failed') return '失败';
  return '等待中';
};
</script>

<template>
  <Dialog
    :open="open"
    title="上传到云盘"
    :close-on-interact-outside="!isUploading"
    :close-on-escape="!isUploading"
    content-class="cloud-upload-dialog"
    body-class="cloud-upload-dialog-body"
    no-scroll
    @update:open="handleClose"
  >
    <template #title>
      <span class="flex items-center gap-2">
        <Icon :icon="iconCloudUpload" width="18" height="18" class="text-primary" />
        上传到云盘
      </span>
    </template>

    <template v-if="step === 'pick'">
      <div class="cloud-upload-pick-body">
        <button class="cloud-upload-option" :disabled="picking" @click="handlePick('file')">
          <div class="cloud-upload-option-icon">
            <Icon :icon="iconUpload" width="20" height="20" />
          </div>
          <div class="min-w-0 flex-1 text-left">
            <div class="text-[13px] font-semibold text-text-main">上传单曲</div>
            <div class="text-[11px] text-text-secondary/75">支持多选，单文件不超过 100MB</div>
          </div>
        </button>
        <button class="cloud-upload-option" :disabled="picking" @click="handlePick('folder')">
          <div class="cloud-upload-option-icon">
            <Icon :icon="iconFolderOpen" width="20" height="20" />
          </div>
          <div class="min-w-0 flex-1 text-left">
            <div class="text-[13px] font-semibold text-text-main">上传文件夹</div>
            <div class="text-[11px] text-text-secondary/75">自动收集文件夹内所有音频文件</div>
          </div>
        </button>
      </div>
    </template>

    <template v-else>
      <div class="cloud-upload-progress-body">
        <div class="cloud-upload-progress-title text-[12px] font-semibold text-text-main">
          <span>{{ isUploading ? '正在匹配并上传...' : '上传完成' }}</span>
        </div>
        <Scrollbar
          class="cloud-upload-list"
          :scrollbar-inset="3"
          :content-props="{ class: 'cloud-upload-list-content' }"
        >
          <div class="flex flex-col">
            <div
              v-for="(item, idx) in items"
              :key="idx"
              class="cloud-upload-row"
              :class="'status-' + item.status"
            >
              <Icon
                v-if="item.status === 'uploading' || item.status === 'matching'"
                :icon="iconLoader2"
                width="14"
                height="14"
                class="cloud-upload-spinner text-primary"
              />
              <Icon
                v-else-if="item.status === 'success'"
                :icon="iconCheckMark"
                width="14"
                height="14"
                class="text-[#10b981]"
              />
              <Icon
                v-else-if="item.status === 'failed'"
                :icon="iconX"
                width="14"
                height="14"
                class="text-[#ef4444]"
              />
              <div class="min-w-0 flex-1">
                <div class="text-[13px] font-medium text-text-main truncate">
                  {{ item.title || item.name.replace(/\.[^.]+$/, '') }}
                </div>
                <div
                  v-if="item.status === 'failed' && item.error"
                  class="text-[11px] text-[#ef4444]/80 truncate"
                >
                  {{ item.error }}
                </div>
                <div v-else class="text-[11px] text-text-secondary/70 truncate">
                  {{
                    [item.artist, item.title ? item.name : ''].filter(Boolean).join(' · ') ||
                    formatBytes(item.size)
                  }}
                </div>
              </div>
              <span class="text-[11px] text-text-secondary/80 shrink-0">
                {{ statusLabel(item) }}
              </span>
            </div>
          </div>
        </Scrollbar>
      </div>
    </template>

    <template #footer>
      <template v-if="step === 'pick'">
        <Button variant="ghost" size="sm" :disabled="picking" @click="closeDialog">取消</Button>
      </template>
      <template v-else>
        <div class="cloud-upload-footer-content">
          <div class="cloud-upload-footer-progress">
            <div class="cloud-upload-progress-track">
              <div
                class="cloud-upload-progress-value"
                :style="{ width: `${progressRatio * 100}%` }"
              ></div>
            </div>
            <span class="text-[11px] font-semibold text-text-secondary/80 shrink-0">
              {{ doneCount + failedCount }} / {{ items.length }}
            </span>
          </div>
          <Button v-if="isUploading" variant="ghost" size="sm" @click="handleCancel">
            取消上传
          </Button>
          <Button v-else variant="primary" size="sm" @click="closeDialog">完成</Button>
        </div>
      </template>
    </template>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

.cloud-upload-option {
  @apply flex items-center gap-3 p-3.5 rounded-[10px] border transition-all active:scale-[0.98] select-none;
  border-color: var(--border-subtle);
  background: var(--control-muted-bg);
}

:global(.dialog-content.cloud-upload-dialog .cloud-upload-dialog-body) {
  padding-right: 0 !important;
}

.cloud-upload-pick-body {
  @apply flex flex-col gap-3 pr-4;
}

.cloud-upload-option:hover {
  border-color: color-mix(in srgb, var(--color-primary) 40%, var(--border-subtle));
  background: color-mix(in srgb, var(--color-primary) 5%, var(--control-muted-bg));
}

.cloud-upload-option:disabled {
  opacity: 0.5;
  pointer-events: none;
}

.cloud-upload-option-icon {
  @apply flex items-center justify-center w-10 h-10 rounded-[8px] shrink-0;
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary);
}

.cloud-upload-progress-body {
  @apply flex min-h-0 flex-col gap-3;
}

.cloud-upload-progress-title {
  margin-right: 16px;
}

.cloud-upload-progress-track {
  width: min(180px, 48%);
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--control-track-bg);
}

.cloud-upload-progress-value {
  height: 100%;
  border-radius: inherit;
  background: var(--color-primary);
  transition: width 0.3s ease;
}

.cloud-upload-list {
  height: clamp(180px, calc(100vh - 340px), 320px);
  min-height: 0;
}

:global(.cloud-upload-list-content) {
  padding-right: 16px;
}

.cloud-upload-footer-content {
  @apply flex w-full items-center justify-between gap-4;
}

.cloud-upload-footer-progress {
  @apply flex min-w-0 flex-1 items-center gap-3;
}

.cloud-upload-row {
  @apply flex items-center gap-2.5 px-2 py-2 rounded-[8px];
}

.cloud-upload-row:hover {
  background: var(--control-hover-bg);
}

.cloud-upload-spinner {
  animation: cloud-upload-spin 0.9s linear infinite;
}

@keyframes cloud-upload-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

:global(.dialog-content.cloud-upload-dialog) {
  width: 460px;
  max-width: calc(100vw - 32px);
  max-height: min(560px, calc(100vh - 64px));
}
</style>
