<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { useVModel } from '@vueuse/core';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import { CheckboxIndicator, CheckboxRoot } from 'reka-ui';
import {
  iconCheckMark,
  iconCloudUpload,
  iconFolderOpen,
  iconLoader2,
  iconSearch,
  iconUpload,
  iconX,
} from '@/icons';
import { search } from '@/api/search';
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
import { useSettingStore } from '@/stores/setting';
import { useCloudUploadStore, type CloudUploadItem } from '@/stores/cloudUpload';
import logger from '@/utils/logger';

interface Props {
  open?: boolean;
}
const props = withDefaults(defineProps<Props>(), { open: false });
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();
const open = useVModel(props, 'open', emit, { defaultValue: false });

const userStore = useUserStore();
const toastStore = useToastStore();
const settingStore = useSettingStore();
const cloudUploadStore = useCloudUploadStore();

type PickMode = 'file' | 'folder';

const step = ref<'pick' | 'manual-search' | 'uploading' | 'done'>('pick');
const items = ref<CloudUploadItem[]>([]);
const canceled = ref(false);
const picking = ref(false);

/** 后台上传确认弹窗 */
const showBackgroundConfirm = ref(false);
const neverShowBackgroundConfirm = ref(false);

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
const shouldAbort = () => canceled.value || cloudUploadStore.abortRequested;

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
  manualFile.value = null;
  manualSearchTitle.value = '';
  manualSearchArtist.value = '';
  manualSearchAlbum.value = '';
  manualResults.value = [];
  manualSearchDone.value = false;
};

const resetForNewUpload = () => {
  if (cloudUploadStore.status === 'completed') {
    cloudUploadStore.dismiss();
  }
  reset();
};

const closeDialog = () => {
  open.value = false;
};

watch(open, (v) => {
  if (!v) {
    // 上传进行中：拦截关闭，弹出后台运行确认（除非已 dismiss）
    if (step.value === 'uploading' && cloudUploadStore.status === 'running') {
      if (settingStore.cloudUploadBackgroundConfirmDismissed) {
        // 跳过确认弹窗时同样转入后台：与确认后行为一致，任务面板可查看/中止
        enterBackgroundMode();
        step.value = 'pick';
        return;
      }
      showBackgroundConfirm.value = true;
      // 同步回弹，Vue 批量更新后不会渲染关闭态
      open.value = true;
      return;
    }
    // 非上传中关闭：后台任务运行期间不清 allow-list，避免打断正在进行的读取
    if (cloudUploadStore.status !== 'running') {
      clearPickedUploadFiles();
    }
    // 查看结果页关闭（完成/X/遮罩）：同步清理任务中心条目
    if (step.value === 'done' && cloudUploadStore.status === 'completed') {
      cloudUploadStore.dismiss();
    }
    window.setTimeout(reset, 200);
  } else {
    if (cloudUploadStore.status === 'running') {
      resumeFromStore();
    } else if (
      cloudUploadStore.status === 'completed' &&
      cloudUploadStore.openRequestMode === 'detail'
    ) {
      resumeFromStoreCompleted();
    } else {
      resetForNewUpload();
    }
  }
});

// 任务面板「查看结果」触发的重开：仅在 openRequested 增量且已完成时恢复结果页，
// 普通打开（如侧边栏发起新上传）仍进选择页
let lastOpenRequested = 0;
watch(
  () => cloudUploadStore.openRequested,
  (val) => {
    if (val === lastOpenRequested || val <= 0) return;
    lastOpenRequested = val;
    if (cloudUploadStore.openRequestMode === 'start' && open.value) {
      if (cloudUploadStore.status !== 'running') resetForNewUpload();
      return;
    }
    if (cloudUploadStore.status === 'completed' && cloudUploadStore.openRequestMode === 'detail') {
      resumeFromStoreCompleted();
    }
  },
);

const resumeFromStore = () => {
  step.value = 'uploading';
  items.value = cloudUploadStore.items;
  canceled.value = false;
};

const resumeFromStoreCompleted = () => {
  step.value = 'done';
  items.value = cloudUploadStore.items;
  canceled.value = false;
};

const enterBackgroundMode = () => {
  cloudUploadStore.enterBackground('', () => {
    canceled.value = true;
  });
};

const confirmBackgroundUpload = () => {
  showBackgroundConfirm.value = false;
  if (neverShowBackgroundConfirm.value) {
    settingStore.cloudUploadBackgroundConfirmDismissed = true;
  }
  enterBackgroundMode();
  // 先把 step 切走，避免 watch(open) 再次拦截关闭
  step.value = 'pick';
  open.value = false;
};

const cancelBackgroundUpload = () => {
  showBackgroundConfirm.value = false;
};

const handleBackgroundRun = () => {
  if (cloudUploadStore.status !== 'running') return;
  enterBackgroundMode();
  step.value = 'pick';
  open.value = false;
};

/**
 * 匹配单个文件：复用导入歌单的搜索机制，获取 audio_id / album_audio_id
 * 云盘写入曲库 ID 采用更保守的匹配门槛，误关联比不关联更难清理。
 */
const matchItem = async (item: CloudUploadItem, list: CloudUploadItem[]) => {
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
  const done = list.filter((i) => i.matchStatus !== 'pending').length;
  cloudUploadStore.updateProgress(done, list.length, { ...item });
};

/** 阶段一：并发匹配所有文件 */
const runMatching = async (list: CloudUploadItem[]) => {
  cloudUploadStore.setPhase('matching');
  let nextIdx = 0;
  const worker = async () => {
    while (true) {
      if (shouldAbort()) return;
      const i = nextIdx++;
      if (i >= list.length) return;
      await matchItem(list[i], list);
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
    // 注册任务中心任务（name 参数预留，面板标题使用 total 展示）
    cloudUploadStore.start('', items.value.length, () => {
      canceled.value = true;
    });
    step.value = 'uploading';
    canceled.value = false;
    // 捕获数组引用：转入后台后组件 reset() 不会影响正在运行的上传流程
    const uploadItems = items.value;
    // 阶段一：并发匹配获取 audio_id / album_audio_id
    await runMatching(uploadItems);
    // 阶段二：串行上传
    await runUpload(uploadItems);
  } catch (error) {
    toastStore.danger(`选择文件失败：${(error as Error)?.message || String(error)}`);
  } finally {
    picking.value = false;
  }
};

const uploadSingleItem = async (item: CloudUploadItem, list: CloudUploadItem[]) => {
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
  const done = list.filter((i) => i.status === 'success' || i.status === 'failed').length;
  cloudUploadStore.updateProgress(done, list.length, { ...item });
};

const runUpload = async (list: CloudUploadItem[]) => {
  cloudUploadStore.setPhase('uploading');
  if (list.length > 0) {
    cloudUploadStore.updateProgress(0, list.length, { ...list[0] });
  }
  for (let i = 0; i < list.length; i++) {
    if (shouldAbort()) break;
    await uploadSingleItem(list[i], list);
  }
  if (open.value) step.value = 'done';
  clearPickedUploadFiles();

  const aborted = shouldAbort();
  const successCount = list.filter((i) => i.status === 'success').length;
  const failedCountNow = list.filter((i) => i.status === 'failed').length;
  const secondCount = list.filter((i) => i.isSecondUpload).length;

  if (successCount > 0) cloudUploadStore.markChanged();

  if (aborted) {
    toastStore.info('已取消上传');
  } else if (failedCountNow === 0) {
    toastStore.success(
      secondCount > 0
        ? `上传完成：${successCount} 首（其中 ${secondCount} 首秒传）`
        : `上传完成：${successCount} 首`,
    );
  } else {
    toastStore.warning(`上传完成：成功 ${successCount} 首，失败 ${failedCountNow} 首`);
  }

  // 任务中心：完成/中止收敛
  if (cloudUploadStore.status === 'running') {
    if (aborted) {
      cloudUploadStore.dismiss();
    } else {
      cloudUploadStore.complete({
        total: list.length,
        success: successCount,
        failed: failedCountNow,
        secondUpload: secondCount,
      });
    }
  }
};

// --- 手动匹配上传 ---
interface ManualSearchResult {
  raw: unknown;
  title: string;
  artist: string;
  album: string;
  duration: number;
  audioId?: string;
  albumAudioId?: string;
}
const manualFile = ref<CloudUploadItem | null>(null);
const manualSearchTitle = ref('');
const manualSearchArtist = ref('');
const manualSearchAlbum = ref('');
const manualSearching = ref(false);
const manualResults = ref<ManualSearchResult[]>([]);
const manualSearchDone = ref(false);
const manualSearchResultList = ref<InstanceType<typeof Scrollbar> | null>(null);

const scrollResultListToTop = () => {
  requestAnimationFrame(() => {
    manualSearchResultList.value?.scrollTo({ top: 0 });
  });
};

const handlePickManual = async () => {
  if (!userStore.isLoggedIn || picking.value) return;
  picking.value = true;
  try {
    const result = await window.electron.cloud.pickUploadFiles('file', false);
    if (result.canceled) return;
    if (result.files.length === 0) {
      toastStore.warning(result.errors?.[0] || '没有可上传的音频文件');
      return;
    }
    const f = result.files[0];
    manualFile.value = {
      name: f.name,
      path: f.path,
      title: f.title || f.name.replace(/\.[^.]+$/, ''),
      artist: f.artist || '',
      duration: f.duration || 0,
      size: f.size,
      extension: f.extension,
      modifiedAt: f.modifiedAt,
      status: 'pending',
      matchStatus: 'pending',
    };
    manualSearchTitle.value = manualFile.value.title ?? '';
    manualSearchArtist.value = manualFile.value.artist ?? '';
    manualSearchAlbum.value = '';
    manualResults.value = [];
    manualSearchDone.value = false;
    step.value = 'manual-search';
  } catch (error) {
    toastStore.danger(`选择文件失败：${(error as Error)?.message || String(error)}`);
  } finally {
    picking.value = false;
  }
};

const handleManualSearch = async () => {
  const keyword = [manualSearchTitle.value.trim(), manualSearchArtist.value.trim()]
    .filter(Boolean)
    .join(' ');
  if (!keyword) {
    toastStore.warning('请输入歌名或歌手');
    return;
  }
  manualSearching.value = true;
  manualSearchDone.value = false;
  manualResults.value = [];
  try {
    const res = await search(keyword, 'song', 1, 30);
    const data = (res as { data?: { lists?: unknown[] } })?.data ?? {};
    const lists = Array.isArray(data.lists) ? data.lists : [];
    manualResults.value = lists.map((item) => {
      const record = item as Record<string, unknown>;
      const singers = record.Singers as { name?: string; AuthorName?: string }[] | undefined;
      const artistStr =
        singers
          ?.map((s) => s.name || s.AuthorName || '')
          .filter(Boolean)
          .join(', ') ||
        (record.SingerName as string) ||
        '';
      const duration = Number(record.Duration ?? 0);
      return {
        raw: item,
        title: (record.SongName as string) || (record.FileName as string) || '',
        artist: artistStr,
        album: (record.AlbumName as string) || '',
        duration: duration > 1000 ? Math.round(duration / 1000) : duration,
        audioId: normalizePositiveNumericId(
          record.Auditoid ?? record.Audioid ?? record.audio_id ?? record.fileid,
        ),
        albumAudioId: normalizePositiveNumericId(
          record.MixSongID ?? record.mixsongid ?? record.album_audio_id,
        ),
      };
    });
    manualSearchDone.value = true;
    scrollResultListToTop();
    if (manualResults.value.length === 0) {
      toastStore.warning('未找到匹配的歌曲，请修改搜索条件重试');
    }
  } catch (error) {
    toastStore.danger(`搜索失败：${(error as Error)?.message || String(error)}`);
  } finally {
    manualSearching.value = false;
  }
};

const handleSelectManualResult = async (result: ManualSearchResult) => {
  if (!manualFile.value) return;
  const item = manualFile.value;
  item.audioId = result.audioId;
  item.albumAudioId = result.albumAudioId;
  item.matchStatus = 'linked';
  item.status = 'uploading';
  // 接入任务中心：手动匹配上传同样注册任务、上报进度
  cloudUploadStore.start('', 1, () => {
    canceled.value = true;
  });
  items.value = [item];
  canceled.value = false;
  step.value = 'uploading';
  await runUpload(items.value);
};

const formatDuration = (sec: number) => {
  if (!sec || !Number.isFinite(sec)) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

const handleCancel = () => {
  canceled.value = true;
  cloudUploadStore.requestAbort({ feedback: false });
  const uploading = items.value.find((i) => i.status === 'uploading' || i.status === 'matching');
  if (uploading) uploading.status = 'pending';
};

const statusLabel = (item: CloudUploadItem) => {
  if (item.status === 'matching') return '匹配中';
  if (item.status === 'uploading') return '上传中';
  if (item.status === 'success') {
    const uploadLabel = item.isSecondUpload ? '秒传成功' : '成功';
    const linkLabel = item.audioId || item.albumAudioId ? '已关联曲库' : '云端自动匹配';
    return `${uploadLabel} · ${linkLabel}`;
  }
  if (item.status === 'failed') return '失败';
  if (
    item.matchStatus === 'not_found' ||
    item.matchStatus === 'low_score' ||
    item.matchStatus === 'no_cloud_ids' ||
    item.matchStatus === 'failed'
  ) {
    return '未关联 · 等待上传';
  }
  return '等待中';
};
</script>

<template>
  <Dialog
    v-model:open="open"
    title="上传到云盘"
    content-class="cloud-upload-dialog"
    flush-body
    no-scroll
    showClose
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
            <div class="text-[13px] font-semibold text-text-main">上传歌曲</div>
            <div class="text-[11px] text-text-secondary/75">
              上传时自动匹配歌曲信息，支持多选，单文件不超过 100MB
            </div>
          </div>
        </button>
        <button class="cloud-upload-option" :disabled="picking" @click="handlePick('folder')">
          <div class="cloud-upload-option-icon">
            <Icon :icon="iconFolderOpen" width="20" height="20" />
          </div>
          <div class="min-w-0 flex-1 text-left">
            <div class="text-[13px] font-semibold text-text-main">上传文件夹</div>
            <div class="text-[11px] text-text-secondary/75">
              收集文件夹内所有音频文件后自动匹配上传
            </div>
          </div>
        </button>
        <button class="cloud-upload-option" :disabled="picking" @click="handlePickManual">
          <div class="cloud-upload-option-icon">
            <Icon :icon="iconSearch" width="20" height="20" />
          </div>
          <div class="min-w-0 flex-1 text-left">
            <div class="text-[13px] font-semibold text-text-main">匹配上传</div>
            <div class="text-[11px] text-text-secondary/75">
              上传时手动匹配歌曲信息，单文件不超过 100MB
            </div>
          </div>
        </button>
      </div>
    </template>

    <!-- 手动匹配：搜索表单 -->
    <template v-else-if="step === 'manual-search'">
      <div
        class="cloud-manual-search"
        @keydown.esc="
          step = 'pick';
          manualFile = null;
        "
      >
        <div class="cloud-manual-file-info" v-if="manualFile">
          <span class="text-[12px] text-text-secondary/70 truncate">
            {{ manualFile.name }}（{{ (manualFile.size / 1024 / 1024).toFixed(1) }} MB）
          </span>
        </div>
        <div class="cloud-manual-form">
          <input
            v-model="manualSearchTitle"
            class="cloud-manual-input"
            placeholder="歌名（必填）"
            @input="
              manualResults = [];
              manualSearchDone = false;
            "
            @keydown.enter="handleManualSearch"
          />
          <input
            v-model="manualSearchArtist"
            class="cloud-manual-input"
            placeholder="歌手"
            @input="
              manualResults = [];
              manualSearchDone = false;
            "
            @keydown.enter="handleManualSearch"
          />
          <input
            v-model="manualSearchAlbum"
            class="cloud-manual-input"
            placeholder="专辑（可选）"
            @keydown.enter="handleManualSearch"
          />
        </div>
        <Button
          variant="primary"
          size="sm"
          class="self-end"
          :disabled="manualSearching || !manualSearchTitle.trim()"
          @click="handleManualSearch"
        >
          <Icon
            v-if="manualSearching"
            :icon="iconLoader2"
            width="14"
            height="14"
            class="animate-spin mr-1"
          />
          <Icon v-else :icon="iconSearch" width="14" height="14" class="mr-1" />
          搜索
        </Button>
        <div v-if="manualSearchDone" class="cloud-manual-results">
          <div class="text-[12px] font-semibold text-text-main mb-2">搜索结果（点击选择）</div>
          <Scrollbar
            ref="manualSearchResultList"
            class="cloud-manual-result-list"
            :scrollbar-inset="3"
            :content-props="{ class: 'cloud-manual-result-list-content' }"
          >
            <div
              v-for="(item, idx) in manualResults"
              :key="idx"
              class="cloud-manual-result-row"
              @click="handleSelectManualResult(item)"
            >
              <div class="min-w-0 flex-1">
                <div class="text-[13px] font-medium text-text-main truncate">{{ item.title }}</div>
                <div class="text-[11px] text-text-secondary/70 truncate">
                  {{ [item.artist, item.album].filter(Boolean).join(' · ') }}
                </div>
              </div>
              <span class="text-[11px] text-text-secondary/60 shrink-0">
                {{ formatDuration(item.duration) }}
              </span>
            </div>
          </Scrollbar>
        </div>
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
      <template v-else-if="step === 'manual-search'">
        <Button
          variant="ghost"
          size="sm"
          @click="
            step = 'pick';
            manualFile = null;
          "
          >返回</Button
        >
        <Button variant="ghost" size="sm" @click="closeDialog">取消</Button>
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
          <Button
            v-if="isUploading && cloudUploadStore.status === 'running'"
            variant="primary"
            size="sm"
            @click="handleBackgroundRun"
          >
            后台运行
          </Button>
          <Button v-else variant="primary" size="sm" @click="closeDialog">完成</Button>
        </div>
      </template>
    </template>
  </Dialog>

  <!-- 后台上传确认弹窗 -->
  <Dialog
    v-model:open="showBackgroundConfirm"
    content-class="cloud-upload-background-confirm-dialog"
    overlay-class="cloud-upload-background-confirm-overlay"
    :close-on-escape="false"
    :close-on-interact-outside="false"
  >
    <template #title>
      <div class="flex items-center gap-2">
        <Icon :icon="iconCloudUpload" width="18" height="18" class="text-primary" />
        <span>上传将在后台继续</span>
      </div>
    </template>
    <div class="flex flex-col gap-4 py-1">
      <p class="text-[13px] text-text-secondary leading-relaxed">
        关闭此弹窗不会中断上传，你可以在标题栏「当前任务」面板中查看进度。
      </p>
      <label class="flex items-center gap-2 cursor-pointer select-none">
        <CheckboxRoot
          v-model:model-value="neverShowBackgroundConfirm"
          class="w-4 h-4 rounded border border-[var(--border-main)] flex items-center justify-center data-[state=checked]:bg-[var(--color-primary)] data-[state=checked]:border-[var(--color-primary)]"
        >
          <CheckboxIndicator class="text-white">
            <Icon :icon="iconCheckMark" width="12" height="12" />
          </CheckboxIndicator>
        </CheckboxRoot>
        <span class="text-[12px] text-text-secondary">以后不再提醒</span>
      </label>
    </div>
    <template #footer>
      <Button variant="ghost" size="sm" type="button" @click="cancelBackgroundUpload">
        留在本页
      </Button>
      <Button variant="primary" size="sm" @click="confirmBackgroundUpload">我知道了</Button>
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

.cloud-upload-pick-body {
  @apply flex flex-col gap-3;
  padding-right: 22px;
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
  margin-right: 22px;
}

.cloud-upload-progress-track {
  width: 100%;
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
  padding-right: 22px;
}

.cloud-upload-footer-content {
  @apply flex w-full items-center justify-between gap-4;
}

.cloud-upload-footer-progress {
  @apply flex min-w-0 flex-1 items-center gap-3;
  max-width: 280px;
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

:global(.dialog-content.cloud-upload-dialog) .dialog-body {
  @apply flex flex-col min-h-0 overflow-hidden;
}

.cloud-manual-search {
  @apply flex flex-col gap-3 min-h-0 flex-1;
  padding-right: 22px;
}

.cloud-manual-file-info {
  @apply px-2 py-1.5 rounded-[6px];
  background: var(--control-muted-bg);
}

.cloud-manual-form {
  @apply flex flex-col gap-2;
}

.cloud-manual-input {
  @apply w-full px-3 py-2 text-[13px] rounded-[8px] outline-none transition-colors;
  background: var(--control-muted-bg);
  border: 1px solid var(--border-subtle);
  color: var(--color-text-main);
}

.cloud-manual-input::placeholder {
  color: var(--color-text-secondary);
  opacity: 0.6;
}

.cloud-manual-input:focus {
  border-color: var(--color-primary);
}

.cloud-manual-results {
  @apply flex flex-col min-h-0 flex-1;
}

.cloud-manual-result-list {
  height: clamp(100px, calc(100vh - 500px), 180px);
  min-height: 0;
}

:global(.cloud-manual-result-list-content) {
  padding-right: 22px;
  padding-bottom: 20px;
}

.cloud-manual-result-row {
  @apply flex items-center gap-2.5 px-2 py-2 rounded-[8px] cursor-pointer transition-colors;
}

.cloud-manual-result-row:hover {
  background: var(--control-hover-bg);
}

:global(.dialog-content.cloud-upload-background-confirm-dialog) {
  width: 400px;
  max-width: calc(100vw - 48px);
  z-index: 1430;
}

:global(.dialog-overlay.cloud-upload-background-confirm-overlay) {
  z-index: 1420;
}
</style>
