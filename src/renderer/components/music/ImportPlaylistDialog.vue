<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useVModel } from '@vueuse/core';
import { Icon } from '@iconify/vue';
import { CheckboxIndicator, CheckboxRoot } from 'reka-ui';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Select from '@/components/ui/Select.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import {
  iconCheckMark,
  iconExternalLink,
  iconPlaylistAdd,
  iconRefreshCw,
  iconTriangleAlert,
} from '@/icons';
import {
  createLinkImportTask,
  createScreenshotImportTask,
  submitImportScreenshot,
  type NativeImportTask,
} from '@/api/importPlaylist';
import { resolveExternalPlaylist } from '@/api/external';
import { NativeImportUnsupportedError, waitForNativeImport } from '@/utils/nativeImportPlaylist';
import { runImport, type ImportItemResult, type ImportSummary } from '@/utils/importPlaylist';
import { usePlaylistStore } from '@/stores/playlist';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import { useImportTaskStore, type ImportTaskRun } from '@/stores/importTask';
import { useSettingStore } from '@/stores/setting';
import type { PlaylistMeta } from '@/models/playlist';
import type { ExternalTrack } from '../../../shared/external';

interface Props {
  open?: boolean;
}

type ImportMode = 'link' | 'screenshot';
type Step = 'input' | 'progress';

const PLATFORM_HINTS = ['网易云', 'QQ 音乐', '酷我', '酷狗', '汽水', 'Spotify', 'Apple Music'];

const props = withDefaults(defineProps<Props>(), { open: false });
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();
const open = useVModel(props, 'open', emit, { defaultValue: false });

const playlistStore = usePlaylistStore();
const userStore = useUserStore();
const toastStore = useToastStore();
const importTaskStore = useImportTaskStore();
let currentDialogRun: ImportTaskRun | null = null;
const canContinueTask = (run: ImportTaskRun) => run.active && !run.signal.aborted;
const settingStore = useSettingStore();

const step = ref<Step>('input');
const mode = ref<ImportMode>('link');
const inputText = ref('');
const selectedFiles = ref<File[]>([]);
const existingListId = ref<string | number | null>(null);
const screenshotTarget = ref<'existing' | 'new'>('existing');
const newScreenshotPlaylistName = ref('截图导入的歌单');
const isStarting = ref(false);
const isImporting = ref(false);
const abortFlag = ref(false);
const errorMessage = ref('');
const progressDone = ref(0);
const progressTotal = ref(1);
const progressItems = ref<ImportItemResult[]>([]);
const summary = ref<ImportSummary | null>(null);
const backgroundTargetName = ref('外部歌单导入');
const showBackgroundConfirm = ref(false);
const neverShowBackgroundConfirm = ref(false);
const isLocalFallback = ref(false);

const currentUserId = computed<number | undefined>(() => {
  const value = userStore.info?.userid ?? userStore.info?.userId;
  return typeof value === 'number' && value > 0 ? value : undefined;
});

const ownedPlaylists = computed<PlaylistMeta[]>(() => {
  const userid = currentUserId.value;
  if (!userid) return [];
  return playlistStore.userPlaylists.filter(
    (playlist) =>
      playlist.source !== 2 &&
      (playlist.listCreateUserid === userid ||
        playlist.isDefault === true ||
        playlist.name === '默认收藏' ||
        playlist.name === '我喜欢的音乐'),
  );
});

const existingPlaylistOptions = computed(() =>
  ownedPlaylists.value.map((playlist) => ({
    label: `${playlist.name}（${playlist.count || playlist.songcount || 0} 首）`,
    value: (playlist.listid || playlist.id) as string | number,
  })),
);

const selectedPlaylist = computed(() =>
  ownedPlaylists.value.find(
    (playlist) => String(playlist.listid || playlist.id) === String(existingListId.value || ''),
  ),
);

const canStart = computed(() => {
  if (isStarting.value || isImporting.value) return false;
  if (mode.value === 'link') return /^https?:\/\//i.test(inputText.value.trim());
  return (
    selectedFiles.value.length > 0 &&
    (screenshotTarget.value === 'new'
      ? Boolean(newScreenshotPlaylistName.value.trim() && currentUserId.value)
      : Boolean(existingListId.value))
  );
});

const rootTrack: ExternalTrack = { title: '准备导入', artist: '正在准备' };
const nativeStageTracks: Record<'submitted' | 'parsing' | 'playlist' | 'importing', ExternalTrack> =
  {
    submitted: { title: '提交导入任务', artist: '等待提交' },
    parsing: { title: '读取歌单信息', artist: '等待读取' },
    playlist: { title: '创建新歌单', artist: '等待创建' },
    importing: { title: '添加歌曲', artist: '等待添加' },
  };

const activeProgressItem = computed(() => {
  return (
    progressItems.value.find((item) => item.status === 'matching' || item.status === 'adding') ||
    progressItems.value.find((item) => item.status === 'pending')
  );
});

const reset = () => {
  step.value = 'input';
  mode.value = 'link';
  inputText.value = '';
  selectedFiles.value = [];
  existingListId.value = null;
  screenshotTarget.value = 'existing';
  newScreenshotPlaylistName.value = '截图导入的歌单';
  isStarting.value = false;
  isImporting.value = false;
  abortFlag.value = false;
  errorMessage.value = '';
  progressDone.value = 0;
  progressTotal.value = 1;
  progressItems.value = [];
  summary.value = null;
  isLocalFallback.value = false;
  rootTrack.title = '准备导入';
  rootTrack.artist = '正在准备';
};

const resumeFromStore = (completed = false) => {
  step.value = 'progress';
  progressItems.value = importTaskStore.items;
  progressDone.value = importTaskStore.done;
  progressTotal.value = importTaskStore.total || 1;
  isImporting.value = !completed;
  summary.value = completed ? importTaskStore.summary : null;
};

watch(open, (value) => {
  if (!value) {
    if (step.value === 'progress' && isImporting.value) {
      if (settingStore.importBackgroundConfirmDismissed) {
        importTaskStore.enterBackground(backgroundTargetName.value, () => {
          abortFlag.value = true;
        });
        step.value = 'input';
        return;
      }
      showBackgroundConfirm.value = true;
      open.value = true;
      return;
    }
    if (step.value === 'progress' && importTaskStore.status === 'completed') {
      importTaskStore.dismiss();
    }
    window.setTimeout(reset, 200);
    return;
  }
  if (importTaskStore.status === 'running') resumeFromStore();
  if (value && currentUserId.value) void playlistStore.fetchUserPlaylists();
});

watch(currentUserId, (userid) => {
  if (open.value && userid) void playlistStore.fetchUserPlaylists();
});

let lastOpenRequested = 0;
watch(
  () => importTaskStore.openRequested,
  (value) => {
    if (value === lastOpenRequested || value <= 0) return;
    lastOpenRequested = value;
    if (importTaskStore.status === 'completed') resumeFromStore(true);
  },
);

const responseTaskId = (response: unknown): string | number => {
  if (!response || typeof response !== 'object') throw new Error('创建导入任务失败');
  const data = (response as { data?: { id?: string | number } }).data;
  if (!data?.id) throw new Error('创建导入任务未返回任务编号');
  return data.id;
};

const updateNativeProgress = (run: ImportTaskRun, task: NativeImportTask) => {
  if (!canContinueTask(run)) return;
  const status = Number(task.status);
  const songs = Number(task.songs_num || 0);
  const imported = Number(task.imported_num || 0);
  const missed = Number(task.missed_num || 0);
  const hasPlaylist = Number(task.listid || 0) > 0;
  const total = Math.max(1, songs, imported + missed);

  nativeStageTracks.submitted.artist = '已提交';
  nativeStageTracks.parsing.artist =
    status === 3 || songs > 0 ? `${task.name || '歌单'} · ${songs} 首` : '正在读取歌单信息';
  nativeStageTracks.playlist.artist = hasPlaylist ? '歌单已创建' : '等待创建歌单';
  nativeStageTracks.importing.artist = songs > 0 ? `已导入 ${imported} / ${songs}` : '等待歌曲信息';

  const items: ImportItemResult[] = [
    { external: nativeStageTracks.submitted, status: 'success' },
    {
      external: nativeStageTracks.parsing,
      status: status === 3 || songs > 0 ? 'success' : 'matching',
    },
    {
      external: nativeStageTracks.playlist,
      status: hasPlaylist || status === 3 ? 'success' : 'pending',
    },
    {
      external: nativeStageTracks.importing,
      status: status === 3 ? 'success' : hasPlaylist || songs > 0 ? 'adding' : 'pending',
    },
  ];
  const progressTotalValue = songs > 0 ? total : 4;
  const done = status === 3 ? progressTotalValue : songs > 0 ? Math.min(total - 1, imported) : 1;
  progressDone.value = Math.max(0, done);
  progressTotal.value = progressTotalValue;
  progressItems.value = items;
  items.forEach((item) => run.updateProgress(progressDone.value, progressTotalValue, item));
};

const runLocalFallback = async (url: string, run: ImportTaskRun) => {
  isLocalFallback.value = true;
  rootTrack.title = '正在换一种方式继续导入';
  rootTrack.artist = '正在读取歌单信息';
  progressItems.value = [{ external: rootTrack, status: 'matching' }];
  progressDone.value = 0;
  progressTotal.value = 1;

  const resolved = await resolveExternalPlaylist({ input: url, provider: 'auto' });
  if (!canContinueTask(run)) return;
  if (!resolved.ok) throw new Error(resolved.error);
  if (!resolved.playlist.tracks.length) throw new Error('外部歌单没有可导入歌曲');
  if (!currentUserId.value) throw new Error('请先登录');

  const playlistName = resolved.playlist.name || '导入的歌单';
  backgroundTargetName.value = `${playlistName} · 自动导入`;
  const listId = await playlistStore.createPlaylistAndReturnId(
    playlistName,
    false,
    currentUserId.value,
  );
  if (!canContinueTask(run)) return;
  if (!listId) throw new Error('创建歌单失败');

  const tracks = resolved.playlist.tracks;
  progressItems.value = tracks.map((track) => ({ external: track, status: 'pending' }));
  progressDone.value = 0;
  progressTotal.value = tracks.length;
  const result = await runImport(tracks, listId, {
    shouldAbort: () => run.signal.aborted || abortFlag.value || importTaskStore.abortRequested,
    onProgress: (done, total, item) => {
      if (!canContinueTask(run)) return;
      progressDone.value = done;
      progressTotal.value = total;
      const index = progressItems.value.findIndex(
        (progressItem) => progressItem.external === item.external,
      );
      if (index >= 0) progressItems.value[index] = { ...item };
      run.updateProgress(done, total, item);
    },
  });
  if (!canContinueTask(run)) return;
  summary.value = result;
  run.complete(result);
  if (!abortFlag.value && !importTaskStore.abortRequested) {
    toastStore.success(`导入完成：成功 ${result.success} / ${result.total}`);
  }
  await playlistStore.fetchUserPlaylists();
};

const monitorTask = async (taskId: string | number, fallbackUrl: string, run: ImportTaskRun) => {
  isStarting.value = false;
  isImporting.value = true;
  step.value = 'progress';
  updateNativeProgress(run, { id: taskId, status: 0 });

  try {
    const result = await waitForNativeImport(taskId, {
      shouldStop: () => run.signal.aborted || abortFlag.value || importTaskStore.abortRequested,
      onProgress: (task) => updateNativeProgress(run, task),
    });
    if (!canContinueTask(run)) return;
    if (!result) {
      if (importTaskStore.status === 'running') {
        run.dismiss();
        toastStore.warning('已停止查看进度，导入任务仍会继续处理');
      }
      return;
    }

    const total = Math.max(
      1,
      Number(result.task.songs_num || 0),
      Number(result.task.imported_num || 0) + Number(result.task.missed_num || 0),
    );
    const success = Number(result.task.imported_num || 0);
    const skipped = Number(result.task.missed_num || 0);
    const missedItems: ImportItemResult[] = result.missed.map((track) => ({
      external: {
        title: track.audio_name || '未识别歌曲',
        artist: track.author_name || '未知歌手',
        album: track.album_name || '',
      },
      status: 'skipped',
      error: track.reason || '未匹配',
    }));
    if (!canContinueTask(run)) return;
    updateNativeProgress(run, result.task);
    progressItems.value = [...progressItems.value, ...missedItems];
    progressDone.value = total;
    progressTotal.value = total;
    summary.value = { total, success, low: 0, skipped, failed: 0 };
    missedItems.forEach((item) => run.updateProgress(total, total, item));

    run.complete(summary.value);
    toastStore.success(`导入完成：成功 ${success} / ${total}`);
    await playlistStore.fetchUserPlaylists();
  } catch (error: unknown) {
    if (!canContinueTask(run)) return;
    if (error instanceof NativeImportUnsupportedError && fallbackUrl) {
      toastStore.warning('正在换一种方式继续导入');
      await runLocalFallback(fallbackUrl, run);
      return;
    }
    rootTrack.title = '导入失败';
    const item: ImportItemResult = {
      external: rootTrack,
      status: 'failed',
      error: error instanceof Error ? error.message : '导入失败',
    };
    progressItems.value = [item];
    summary.value = { total: 1, success: 0, low: 0, skipped: 0, failed: 1 };
    run.updateProgress(1, 1, item);
    run.complete(summary.value);
    toastStore.actionFailed('导入');
  } finally {
    if (currentDialogRun === run) isImporting.value = false;
  }
};

const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error(`读取图片失败：${file.name}`));
    reader.readAsDataURL(file);
  });

const handleFiles = (event: Event) => {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  errorMessage.value = '';
  if (files.length > 9) {
    errorMessage.value = '一次最多选择 9 张截图';
    selectedFiles.value = files.slice(0, 9);
    return;
  }
  const oversized = files.find((file) => file.size > 10 * 1024 * 1024);
  if (oversized) {
    errorMessage.value = `${oversized.name} 超过 10 MB`;
    selectedFiles.value = [];
    return;
  }
  selectedFiles.value = files;
};

const setExistingListId = (value: unknown) => {
  existingListId.value = typeof value === 'string' || typeof value === 'number' ? value : null;
};

const startImport = async () => {
  if (!canStart.value) return;
  abortFlag.value = false;
  const run = importTaskStore.start('歌单导入', () => {
    abortFlag.value = true;
  });
  currentDialogRun = run;
  isStarting.value = true;
  errorMessage.value = '';
  summary.value = null;
  progressItems.value = [{ external: rootTrack, status: 'pending' }];

  try {
    if (mode.value === 'link') {
      backgroundTargetName.value = '外部歌单导入';
      const url = inputText.value.trim();
      const response = await createLinkImportTask(url);
      if (!canContinueTask(run)) return;
      await monitorTask(responseTaskId(response), url, run);
      return;
    }

    if (!currentUserId.value) throw new Error('请先登录');
    const playlistName =
      screenshotTarget.value === 'new'
        ? newScreenshotPlaylistName.value.trim()
        : selectedPlaylist.value?.name || '';
    let listId = existingListId.value;
    if (screenshotTarget.value === 'new') {
      listId = await playlistStore.createPlaylistAndReturnId(
        playlistName,
        false,
        currentUserId.value,
      );
      if (!canContinueTask(run)) return;
    }
    if (!listId || !playlistName) throw new Error('请选择或创建目标歌单');
    backgroundTargetName.value = playlistName;
    const taskSn = `${currentUserId.value}${Date.now()}`;
    for (let index = 0; index < selectedFiles.value.length; index++) {
      if (!canContinueTask(run)) return;
      rootTrack.title = `正在上传截图 ${index + 1} / ${selectedFiles.value.length}`;
      progressDone.value = index;
      progressTotal.value = selectedFiles.value.length + 1;
      step.value = 'progress';
      const item: ImportItemResult = { external: rootTrack, status: 'adding' };
      progressItems.value = [item];
      run.updateProgress(index, progressTotal.value, item);
      const imageBase64 = await fileToBase64(selectedFiles.value[index]);
      if (!canContinueTask(run)) return;
      await submitImportScreenshot(taskSn, imageBase64);
      if (!canContinueTask(run)) return;
    }
    const response = await createScreenshotImportTask(taskSn, listId, playlistName);
    if (!canContinueTask(run)) return;
    rootTrack.title = playlistName;
    await monitorTask(responseTaskId(response), '', run);
  } catch (error: unknown) {
    if (!canContinueTask(run)) return;
    run.dismiss();
    isStarting.value = false;
    isImporting.value = false;
    errorMessage.value = error instanceof Error ? error.message : '创建导入任务失败';
    step.value = 'input';
    toastStore.actionFailed('创建导入任务');
  }
};

const stopMonitoring = () => {
  abortFlag.value = true;
  if (importTaskStore.status === 'running') {
    importTaskStore.requestAbort({ feedback: false });
  }
};

const runInBackground = () => {
  importTaskStore.enterBackground(backgroundTargetName.value, () => {
    abortFlag.value = true;
  });
  step.value = 'input';
  open.value = false;
};

const confirmBackgroundImport = () => {
  showBackgroundConfirm.value = false;
  if (neverShowBackgroundConfirm.value) settingStore.importBackgroundConfirmDismissed = true;
  runInBackground();
};

const closeResult = () => {
  if (importTaskStore.status === 'completed') importTaskStore.dismiss();
  open.value = false;
};

const itemStatusLabel = (status: ImportItemResult['status']) => {
  if (status === 'success') return '完成';
  if (status === 'failed') return '失败';
  if (status === 'skipped') return '未匹配';
  if (status === 'matching') return '解析中';
  if (status === 'adding') return '导入中';
  return '等待';
};
</script>

<template>
  <Dialog
    v-model:open="open"
    content-class="import-playlist-dialog"
    show-close
    no-scroll
    :close-on-interact-outside="!isStarting && !isImporting"
    :close-on-escape="!isStarting && !isImporting"
  >
    <template #title>
      <div class="flex items-center justify-between gap-3 w-full pr-8">
        <div class="flex items-center gap-2 min-w-0">
          <Icon :icon="iconExternalLink" width="18" height="18" class="text-primary shrink-0" />
          <span class="truncate">导入外部歌单</span>
        </div>
        <div class="import-stepper">
          <span class="import-step-pill" :class="{ 'is-active': step === 'input' }">1 输入</span>
          <span class="import-step-sep" />
          <span class="import-step-pill" :class="{ 'is-active': step === 'progress' }">2 导入</span>
        </div>
      </div>
    </template>

    <div v-if="step === 'input'" class="flex flex-col gap-4 pt-1">
      <div class="import-mode-grid">
        <button
          type="button"
          class="import-mode-card"
          :class="{ 'is-active': mode === 'link' }"
          @click="mode = 'link'"
        >
          <Icon :icon="iconExternalLink" width="19" height="19" />
          <span><strong>链接导入</strong><small>粘贴歌单链接，自动完成导入</small></span>
        </button>
        <button
          type="button"
          class="import-mode-card"
          :class="{ 'is-active': mode === 'screenshot' }"
          @click="mode = 'screenshot'"
        >
          <Icon :icon="iconPlaylistAdd" width="19" height="19" />
          <span><strong>截图导入</strong><small>上传截图，自动识别其中的歌曲</small></span>
        </button>
      </div>

      <template v-if="mode === 'link'">
        <textarea
          v-model="inputText"
          class="import-textarea"
          rows="4"
          placeholder="粘贴外部平台的歌单链接"
          :disabled="isStarting"
        />
        <div class="import-platforms">
          <span class="import-platforms-label">支持平台</span>
          <span v-for="platform in PLATFORM_HINTS" :key="platform" class="import-platform-chip">
            {{ platform }}
          </span>
        </div>
        <p class="import-hint">
          粘贴歌单链接后即可开始。如果直接导入失败，会自动切换其他方式，无需手动操作。
        </p>
      </template>

      <template v-else>
        <label class="import-dropzone">
          <input type="file" accept="image/jpeg,image/png" multiple hidden @change="handleFiles" />
          <Icon :icon="iconPlaylistAdd" width="24" height="24" />
          <strong>{{
            selectedFiles.length ? `已选择 ${selectedFiles.length} 张截图` : '选择歌单截图'
          }}</strong>
          <span>JPEG / PNG，最多 9 张，单张不超过 10 MB</span>
        </label>
        <div v-if="selectedFiles.length" class="import-file-list">
          <span v-for="file in selectedFiles" :key="`${file.name}-${file.size}`">{{
            file.name
          }}</span>
        </div>
        <div class="import-target-tabs">
          <button
            type="button"
            :class="{ 'is-active': screenshotTarget === 'existing' }"
            @click="screenshotTarget = 'existing'"
          >
            选择歌单
          </button>
          <button
            type="button"
            :class="{ 'is-active': screenshotTarget === 'new' }"
            @click="screenshotTarget = 'new'"
          >
            新建歌单
          </button>
        </div>
        <Select
          v-if="screenshotTarget === 'existing'"
          :model-value="existingListId ?? ''"
          :options="existingPlaylistOptions"
          placeholder="选择要写入的歌单"
          :filterable="ownedPlaylists.length > 8"
          class="w-full"
          @update:model-value="setExistingListId"
        />
        <Input
          v-else
          v-model="newScreenshotPlaylistName"
          placeholder="请输入新歌单名称"
          input-class="h-10 rounded-xl px-3 text-[13px]"
        />
        <p class="import-hint">识别结果会添加到所选歌单，或写入新建歌单。</p>
      </template>

      <div v-if="errorMessage" class="import-alert">
        <Icon :icon="iconTriangleAlert" width="14" height="14" />
        <span>{{ errorMessage }}</span>
      </div>
    </div>

    <div v-else class="flex flex-col gap-3 pt-1">
      <div class="flex items-center justify-between text-[12px]">
        <span class="text-text-main font-medium">
          {{
            summary
              ? `已处理 ${summary.total} 首`
              : `${isLocalFallback ? '正在匹配歌曲' : '正在导入'} · ${progressDone} / ${progressTotal}`
          }}
        </span>
        <Icon
          v-if="!summary && isImporting"
          :icon="iconRefreshCw"
          width="14"
          height="14"
          class="text-primary animate-spin"
        />
      </div>
      <div class="import-progress-bar">
        <div
          class="import-progress-fill"
          :class="{ 'is-done': !!summary }"
          :style="{ width: `${Math.min(100, (progressDone / Math.max(1, progressTotal)) * 100)}%` }"
        />
      </div>
      <div
        v-if="isImporting && activeProgressItem"
        :key="activeProgressItem.external.title"
        class="import-current-card"
      >
        <span class="import-current-wave" aria-hidden="true"><i /><i /><i /><i /></span>
        <div class="min-w-0 flex-1">
          <div class="import-current-label">正在处理</div>
          <div class="import-current-title truncate">{{ activeProgressItem.external.title }}</div>
          <div class="import-current-artist truncate">
            {{ activeProgressItem.external.artist || '请稍候' }}
          </div>
        </div>
      </div>
      <Scrollbar class="import-track-list" :scrollbar-inset="3">
        <div
          v-for="(item, index) in progressItems"
          :key="index"
          class="import-track-row"
          :class="`status-${item.status}`"
        >
          <span class="import-status-dot" />
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-medium text-text-main truncate">
              {{ item.external.title }}
            </div>
            <div class="text-[11px] text-text-secondary/80 truncate">
              {{ item.external.artist || '未知歌手' }}
              <template v-if="item.error"> · {{ item.error }}</template>
            </div>
          </div>
          <span class="text-[11px] text-text-secondary/80 shrink-0">
            {{ itemStatusLabel(item.status) }}
          </span>
        </div>
      </Scrollbar>
      <p v-if="isImporting" class="import-hint">
        停止查看不会取消当前任务，稍后仍可在歌单列表中查看导入结果。
      </p>
    </div>

    <template #footer>
      <template v-if="step === 'input'">
        <Button variant="ghost" size="sm" :disabled="isStarting" @click="open = false">取消</Button>
        <Button
          variant="primary"
          size="sm"
          :loading="isStarting"
          :disabled="!canStart"
          @click="startImport"
        >
          <Icon :icon="iconPlaylistAdd" width="14" height="14" />
          开始导入
        </Button>
      </template>
      <template v-else>
        <div
          v-if="summary"
          class="import-summary mr-auto"
          :class="{ 'is-warn': summary.success === 0 }"
        >
          <Icon
            :icon="summary.success ? iconCheckMark : iconTriangleAlert"
            width="15"
            height="15"
          />
          <span
            >成功 {{ summary.success }} · 未匹配 {{ summary.skipped }} · 失败
            {{ summary.failed }}</span
          >
        </div>
        <Button v-if="isImporting" variant="secondary" size="sm" @click="stopMonitoring"
          >停止查看</Button
        >
        <Button v-if="isImporting" variant="primary" size="sm" @click="runInBackground"
          >后台运行</Button
        >
        <Button v-else variant="primary" size="sm" @click="closeResult">完成</Button>
      </template>
    </template>
  </Dialog>

  <Dialog
    v-model:open="showBackgroundConfirm"
    content-class="background-confirm-dialog"
    :close-on-escape="false"
    :close-on-interact-outside="false"
  >
    <template #title>导入将在后台继续</template>
    <div class="flex flex-col gap-4 py-1">
      <p class="text-[13px] text-text-secondary leading-relaxed">
        关闭弹窗不会中断查询，你可以在标题栏任务中心查看进度。
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
      <Button variant="ghost" size="sm" @click="showBackgroundConfirm = false">留在本页</Button>
      <Button variant="primary" size="sm" @click="confirmBackgroundImport">我知道了</Button>
    </template>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

:global(.dialog-content.import-playlist-dialog) {
  width: 680px;
  max-width: calc(100vw - 32px);
  max-height: min(620px, calc(100vh - 64px));
}

.import-mode-grid {
  @apply grid grid-cols-2 gap-3;
}

.import-mode-card {
  @apply flex items-center gap-3 rounded-[14px] px-4 py-3 text-left transition-all;
  color: var(--color-text-secondary);
  background: var(--control-muted-bg);
  border: 1px solid var(--control-border);
}

.import-mode-card:hover,
.import-mode-card.is-active {
  color: var(--color-primary);
  border-color: color-mix(in srgb, var(--color-primary) 50%, var(--control-border));
  background: color-mix(in srgb, var(--color-primary) 9%, transparent);
}

.import-mode-card span {
  @apply flex flex-col gap-0.5 min-w-0;
}

.import-mode-card strong {
  @apply text-[13px] text-text-main;
}

.import-mode-card small {
  @apply text-[11px] text-text-secondary/80 truncate;
}

.import-textarea {
  @apply w-full rounded-[14px] px-4 py-3 text-[13px] leading-relaxed font-medium resize-y;
  min-height: 112px;
  color: var(--color-text-main);
  background: var(--control-bg);
  border: 1px solid var(--control-border);
  outline: none;
}

.import-textarea:focus {
  border-color: color-mix(in srgb, var(--color-primary) 50%, var(--control-border));
}

.import-dropzone {
  @apply flex flex-col items-center justify-center gap-1.5 rounded-[14px] px-4 py-7 cursor-pointer transition-colors;
  color: var(--color-text-secondary);
  background: var(--control-muted-bg);
  border: 1px dashed color-mix(in srgb, var(--color-primary) 38%, var(--control-border));
}

.import-dropzone:hover {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 7%, transparent);
}

.import-dropzone strong {
  @apply text-[13px] text-text-main;
}

.import-dropzone span {
  @apply text-[11px] text-text-secondary/75;
}

.import-file-list {
  @apply flex flex-wrap gap-1.5;
}

.import-file-list span {
  @apply rounded-full px-2.5 py-1 text-[11px] text-text-secondary max-w-[200px] truncate;
  background: var(--control-muted-bg);
}

.import-target-tabs {
  @apply flex gap-1 rounded-xl p-1;
  background: var(--control-muted-bg);
}

.import-target-tabs button {
  @apply flex-1 rounded-lg py-2 text-[12px] text-text-secondary transition-colors;
}

.import-target-tabs button.is-active {
  color: var(--color-primary);
  background: var(--control-bg);
  box-shadow: 0 1px 3px color-mix(in srgb, var(--color-text-main) 10%, transparent);
}

.import-hint {
  @apply text-[12px] text-text-secondary/80 leading-relaxed;
}

.import-platforms {
  @apply flex flex-wrap items-center gap-1.5;
}

.import-platforms-label {
  @apply text-[11px] text-text-secondary/70 mr-0.5;
}

.import-platform-chip {
  @apply inline-flex items-center rounded-full px-2.5 py-1 text-[11px] text-text-secondary;
  background: var(--control-muted-bg);
  border: 1px solid var(--control-border);
}

.import-alert {
  @apply flex items-center gap-2 rounded-[10px] px-3 py-2 text-[12px];
  color: var(--color-danger, #ef4444);
  background: color-mix(in srgb, var(--color-danger, #ef4444) 12%, transparent);
}

.import-stepper {
  @apply flex items-center gap-1.5 shrink-0;
}

.import-step-pill {
  @apply inline-flex items-center px-2.5 h-6 rounded-full text-[11px] font-medium;
  color: color-mix(in srgb, var(--color-text-main) 55%, transparent);
  background: var(--control-muted-bg);
}

.import-step-pill.is-active {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 16%, transparent);
}

.import-step-sep {
  @apply w-3 h-px;
  background: color-mix(in srgb, var(--color-text-main) 18%, transparent);
}

.import-progress-bar {
  @apply w-full h-1.5 rounded-full overflow-hidden;
  background: var(--control-track-bg);
}

.import-progress-fill {
  @apply h-full rounded-full transition-all;
  background: var(--color-primary);
}

.import-progress-fill.is-done {
  background: #10b981;
}

.import-current-card {
  @apply flex items-center gap-3 rounded-[14px] px-4 py-3;
  background: color-mix(in srgb, var(--color-primary) 8%, var(--control-muted-bg));
  border: 1px solid color-mix(in srgb, var(--color-primary) 22%, var(--control-border));
  animation: import-current-in 220ms ease-out;
}

.import-current-label {
  @apply text-[10px] text-text-secondary/75;
}

.import-current-title {
  @apply text-[13px] font-semibold text-text-main;
}

.import-current-artist {
  @apply text-[11px] text-text-secondary/75;
}

.import-current-wave {
  @apply flex items-center justify-center gap-0.5 w-8 h-8 rounded-full shrink-0;
  background: color-mix(in srgb, var(--color-primary) 16%, transparent);
}

.import-current-wave i {
  @apply w-0.5 rounded-full;
  height: 9px;
  background: var(--color-primary);
  animation: import-wave 900ms ease-in-out infinite;
}

.import-current-wave i:nth-child(2) {
  animation-delay: 120ms;
}

.import-current-wave i:nth-child(3) {
  animation-delay: 240ms;
}

.import-current-wave i:nth-child(4) {
  animation-delay: 360ms;
}

.import-track-list {
  max-height: 320px;
  min-height: 92px;
  border-radius: 12px;
  background: var(--control-muted-bg);
}

.import-track-row {
  @apply flex items-center gap-3 px-4 py-3;
  border-bottom: 1px solid var(--border-subtle);
}

.import-track-row:last-child {
  border-bottom: none;
}

.import-status-dot {
  @apply w-1.5 h-1.5 rounded-full shrink-0;
  background: var(--color-primary);
  animation: import-pulse 1.2s ease-in-out infinite;
}

.status-success .import-status-dot {
  background: #10b981;
  animation: none;
}

.status-skipped .import-status-dot {
  background: #f59e0b;
  animation: none;
}

.status-failed .import-status-dot {
  background: var(--color-danger, #ef4444);
  animation: none;
}

.import-summary {
  @apply flex items-center gap-2 rounded-[10px] px-3 py-2 text-[12px] text-text-main;
  background: color-mix(in srgb, #10b981 10%, transparent);
}

.import-summary.is-warn {
  background: color-mix(in srgb, var(--color-danger, #ef4444) 10%, transparent);
}

@keyframes import-pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

@keyframes import-wave {
  0%,
  100% {
    height: 7px;
    opacity: 0.55;
  }
  50% {
    height: 18px;
    opacity: 1;
  }
}

@keyframes import-current-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

:global(.dialog-content.background-confirm-dialog) {
  width: 400px;
  max-width: calc(100vw - 48px);
}

@media (max-width: 640px) {
  .import-mode-grid {
    @apply grid-cols-1;
  }
}
</style>
