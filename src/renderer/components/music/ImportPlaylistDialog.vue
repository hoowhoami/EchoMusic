<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { captureUserSession } from '@/utils/userSession';
import { useVModel } from '@vueuse/core';
import { Icon } from '@iconify/vue';
import Checkbox from '@/components/ui/Checkbox.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import CustomTabBar from '@/components/ui/CustomTabBar.vue';
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
let disposed = false;
let uiRevision = 0;
let resetTimer: number | null = null;
const canUpdateUi = (run: ImportTaskRun) => !disposed && open.value && currentDialogRun === run;
const cancelReset = () => {
  if (resetTimer !== null) window.clearTimeout(resetTimer);
  resetTimer = null;
};
const refreshPlaylists = async () => {
  // A post-import refresh is supplementary and cannot turn a completed import
  // into a failed task. The playlist store itself owns account-scoped results.
  try {
    await playlistStore.fetchUserPlaylists();
  } catch {
    /* Allow later refresh. */
  }
};

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
const isLocalFallback = computed(() => importTaskStore.phase === 'local');
const showDuplicateNameConfirm = ref(false);
const duplicatePlaylistName = ref('');
let duplicateConfirmRun: ImportTaskRun | null = null;
let resolveDuplicateNameConfirm: ((name: string | null) => void) | null = null;

const currentUserId = computed<number | undefined>(() => {
  const value: unknown = userStore.info?.userid ?? userStore.info?.userId;
  return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0
    ? Number(value)
    : undefined;
});

const ownedPlaylists = computed<PlaylistMeta[]>(() => {
  const userid = currentUserId.value;
  if (!userid) return [];
  return playlistStore.userPlaylists.filter(
    (playlist) =>
      playlist.source !== 2 &&
      (String(playlist.listCreateUserid) === String(userid) ||
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

const normalizedPlaylistName = (name: string) => name.trim().toLowerCase();
const hasOwnedPlaylistWithName = (name: string) => {
  const normalized = normalizedPlaylistName(name);
  return (
    normalized.length > 0 &&
    ownedPlaylists.value.some(
      (playlist) => normalizedPlaylistName(String(playlist.name ?? '')) === normalized,
    )
  );
};
const confirmDuplicatePlaylistName = async (name: string, run: ImportTaskRun) => {
  await playlistStore.fetchUserPlaylists();
  if (!canContinueTask(run)) return null;
  const trimmedName = name.trim();
  if (!hasOwnedPlaylistWithName(trimmedName)) return trimmedName;
  if (disposed) throw new Error('已有同名歌单，请重新打开导入弹窗后确认名称');
  duplicateConfirmRun = run;
  duplicatePlaylistName.value = trimmedName;
  return new Promise<string | null>((resolve) => {
    resolveDuplicateNameConfirm?.(null);
    const finish = (value: string | null) => {
      run.signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      if (duplicateConfirmRun === run) finishDuplicateNameConfirm(false);
    };
    resolveDuplicateNameConfirm = finish;
    run.signal.addEventListener('abort', onAbort, { once: true });
    showDuplicateNameConfirm.value = true;
  });
};
const finishDuplicateNameConfirm = (confirmed: boolean) => {
  const name = duplicatePlaylistName.value.trim();
  if (confirmed && !name) return;
  showDuplicateNameConfirm.value = false;
  const resolve = resolveDuplicateNameConfirm;
  resolveDuplicateNameConfirm = null;
  duplicateConfirmRun = null;
  resolve?.(confirmed ? name : null);
};
const cancelRunBeforePlaylistCreation = (run: ImportTaskRun) => {
  const ownsUi = canUpdateUi(run);
  run.dismiss();
  if (!ownsUi) return;
  if (currentDialogRun === run) currentDialogRun = null;
  isStarting.value = false;
  isImporting.value = false;
  step.value = 'input';
  progressItems.value = [];
  summary.value = null;
};

const canStart = computed(() => {
  if (
    disposed ||
    !open.value ||
    !userStore.isLoggedIn ||
    !currentUserId.value ||
    isStarting.value ||
    isImporting.value ||
    importTaskStore.status === 'running'
  )
    return false;
  if (mode.value === 'link') return /^https?:\/\//i.test(inputText.value.trim());
  return (
    selectedFiles.value.length > 0 &&
    selectedFiles.value.length <= 9 &&
    selectedFiles.value.every((file) => file.size <= 10 * 1024 * 1024) &&
    (screenshotTarget.value === 'new'
      ? Boolean(newScreenshotPlaylistName.value.trim() && currentUserId.value)
      : Boolean(existingListId.value && selectedPlaylist.value))
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
  finishDuplicateNameConfirm(false);
  duplicatePlaylistName.value = '';
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
  showBackgroundConfirm.value = false;
  neverShowBackgroundConfirm.value = false;
  currentDialogRun = null;
};

const resumeFromStore = () => {
  currentDialogRun = importTaskStore.getCurrentRun();
  step.value = 'progress';
  progressItems.value = importTaskStore.items;
  progressDone.value = importTaskStore.done;
  progressTotal.value = importTaskStore.total || 1;
  isStarting.value = importTaskStore.status === 'running' && importTaskStore.phase === 'preparing';
  isImporting.value = importTaskStore.status === 'running';
  summary.value = importTaskStore.summary;
  backgroundTargetName.value = importTaskStore.playlistName;
};
if (open.value && importTaskStore.status === 'running') resumeFromStore();

watch(
  open,
  (value) => {
    if (disposed) return;
    cancelReset();
    if (!value) {
      if (
        step.value === 'progress' &&
        isImporting.value &&
        currentDialogRun &&
        canContinueTask(currentDialogRun)
      ) {
        if (settingStore.importBackgroundConfirmDismissed) {
          runInBackground();
          return;
        }
        showBackgroundConfirm.value = true;
        open.value = true;
        return;
      }
      if (isStarting.value) currentDialogRun?.dismiss();
      if (step.value === 'progress' && importTaskStore.status === 'completed')
        importTaskStore.dismiss();
      uiRevision++;
      const revision = uiRevision;
      const isSessionCurrent = captureUserSession(userStore);
      const timer = window.setTimeout(() => {
        if (resetTimer !== timer) return;
        resetTimer = null;
        if (!disposed && !open.value && revision === uiRevision && isSessionCurrent()) reset();
      }, 200);
      resetTimer = timer;
      return;
    }
    uiRevision++;
    if (importTaskStore.status === 'running') resumeFromStore();
    if (currentUserId.value) void refreshPlaylists();
  },
  { flush: 'sync' },
);

watch(
  [
    () => userStore.isLoggedIn,
    () => userStore.accountRevision,
    () => userStore.info?.userid ?? userStore.info?.userId,
    () => userStore.info?.token,
  ],
  () => {
    currentDialogRun?.dismiss();
    cancelReset();
    uiRevision++;
    reset();
    open.value = false;
    cancelReset();
  },
  { flush: 'sync' },
);

watch(
  () => [
    importTaskStore.progressRevision,
    importTaskStore.status,
    importTaskStore.phase,
    importTaskStore.summary,
  ],
  () => {
    if (!disposed && open.value && step.value === 'progress') {
      if (importTaskStore.status !== 'running') showBackgroundConfirm.value = false;
      if (importTaskStore.status !== 'idle') resumeFromStore();
      else {
        isStarting.value = false;
        isImporting.value = false;
      }
    }
  },
);
let lastOpenRequested = 0;
watch(
  () => importTaskStore.openRequested,
  (value) => {
    if (disposed || value === lastOpenRequested || value <= 0) return;
    lastOpenRequested = value;
    if (importTaskStore.status === 'completed' || importTaskStore.status === 'running')
      resumeFromStore();
  },
);

onBeforeUnmount(() => {
  disposed = true;
  uiRevision++;
  cancelReset();
  finishDuplicateNameConfirm(false);
  // Pending input/confirmation work cannot continue without a dialog. Once in
  // progress, the captured runner continues and owns its account independently.
  if (step.value === 'input' && isStarting.value) currentDialogRun?.dismiss();
});

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
  run.resetProgress(Math.max(0, done), progressTotalValue, items);
  if (canUpdateUi(run)) resumeFromStore();
};

const runLocalFallback = async (url: string, run: ImportTaskRun) => {
  if (!canContinueTask(run)) return;
  const userid = currentUserId.value;
  if (!userid) throw new Error('请先登录');
  run.setPhase('local');
  const root: ExternalTrack = { title: '正在换一种方式继续导入', artist: '正在读取歌单信息' };
  run.resetProgress(0, 1, [{ external: root, status: 'matching' }]);
  if (canUpdateUi(run)) resumeFromStore();
  const resolved = await resolveExternalPlaylist({ input: url, provider: 'auto' });
  if (!canContinueTask(run)) return;
  if (!resolved.ok) throw new Error(resolved.error);
  if (!resolved.playlist.tracks.length) throw new Error('外部歌单没有可导入歌曲');
  const playlistName = await confirmDuplicatePlaylistName(
    resolved.playlist.name || '导入的歌单',
    run,
  );
  if (!canContinueTask(run)) return;
  if (!playlistName) {
    cancelRunBeforePlaylistCreation(run);
    return;
  }
  const listId = await playlistStore.createPlaylistAndReturnId(playlistName, false, userid);
  if (!canContinueTask(run)) return;
  if (!listId) throw new Error('新歌单创建失败；如存在同名歌单，请换一个名称后重试');
  run.enterBackground(`${playlistName} · 自动导入`, () => {});
  const tracks = resolved.playlist.tracks;
  run.resetProgress(
    0,
    tracks.length,
    tracks.map((track) => ({ external: track, status: 'pending' })),
  );
  const result = await runImport(tracks, listId, {
    shouldAbort: () => !canContinueTask(run),
    onProgress: (done, total, item) => {
      if (canContinueTask(run)) run.updateProgress(done, total, item);
    },
  });
  if (!canContinueTask(run)) return;
  if (run.complete(result))
    toastStore.success(`导入完成：成功 ${result.success} / ${result.total}`);
  if (canContinueTask(run)) await refreshPlaylists();
};

const monitorTask = async (taskId: string | number, fallbackUrl: string, run: ImportTaskRun) => {
  if (!canContinueTask(run)) return;
  run.setPhase('cloud');
  if (canUpdateUi(run)) {
    isStarting.value = false;
    isImporting.value = true;
    step.value = 'progress';
  }
  updateNativeProgress(run, { id: taskId, status: 0 });
  try {
    const result = await waitForNativeImport(taskId, {
      shouldStop: () => !canContinueTask(run),
      onProgress: (task) => updateNativeProgress(run, task),
    });
    if (!canContinueTask(run)) return;
    if (!result) {
      run.dismiss();
      return;
    }
    const total = Math.max(
      1,
      Number(result.task.songs_num || 0),
      Number(result.task.imported_num || 0) + Number(result.task.missed_num || 0),
    );
    const success = Number(result.task.imported_num || 0),
      skipped = Number(result.task.missed_num || 0);
    const missedItems: ImportItemResult[] = result.missed.map((track) => ({
      external: {
        title: track.audio_name || '未识别歌曲',
        artist: track.author_name || '未知歌手',
        album: track.album_name || '',
      },
      status: 'skipped',
      error: track.reason || '未匹配',
    }));
    updateNativeProgress(run, result.task);
    missedItems.forEach((item) => run.updateProgress(total, total, item));
    const resultSummary = { total, success, low: 0, skipped, failed: 0 };
    if (run.complete(resultSummary)) toastStore.success(`导入完成：成功 ${success} / ${total}`);
    if (canContinueTask(run)) await refreshPlaylists();
  } catch (error: unknown) {
    if (!canContinueTask(run)) return;
    if (error instanceof NativeImportUnsupportedError && fallbackUrl) {
      toastStore.warning('正在换一种方式继续导入');
      await runLocalFallback(fallbackUrl, run);
      return;
    }
    const item: ImportItemResult = {
      external: { title: '导入失败', artist: '' },
      status: 'failed',
      error: error instanceof Error ? error.message : '导入失败',
    };
    run.resetProgress(1, 1, [item]);
    run.complete({ total: 1, success: 0, low: 0, skipped: 0, failed: 1 });
    toastStore.actionFailed('导入');
  } finally {
    if (canUpdateUi(run)) {
      isStarting.value = false;
      isImporting.value = false;
    }
  }
};

const fileToBase64 = (file: File, run: ImportTaskRun): Promise<string> =>
  new Promise((resolve, reject) => {
    if (!canContinueTask(run)) {
      reject(new Error('已停止导入'));
      return;
    }
    const reader = new FileReader();
    const cleanup = () => {
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
      run.signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      try {
        if (reader.readyState === 1) reader.abort();
      } catch {
        // Cancellation still settles the read if the browser reader is gone.
      } finally {
        reject(new Error('已停止导入'));
      }
    };
    reader.onload = () => {
      const result = String(reader.result || '');
      if (!/^data:image\/[^;]+;base64,.+/i.test(result)) {
        fail(new Error(`读取图片失败：${file.name}`));
        return;
      }
      cleanup();
      resolve(result);
    };
    reader.onerror = () => fail(reader.error || new Error(`读取图片失败：${file.name}`));
    reader.onabort = () => fail(new Error('已停止读取截图'));
    run.signal.addEventListener('abort', onAbort, { once: true });
    try {
      reader.readAsDataURL(file);
    } catch (error) {
      fail(error);
    }
  });

const handleFiles = (event: Event) => {
  if (isStarting.value || isImporting.value) return;
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  const selected = files.slice(0, 9);
  const oversized = selected.find((file) => file.size > 10 * 1024 * 1024);
  if (oversized) {
    errorMessage.value = `${oversized.name} 超过 10 MB`;
    selectedFiles.value = [];
    return;
  }
  errorMessage.value = files.length > 9 ? '一次最多选择 9 张截图' : '';
  selectedFiles.value = selected;
};

const setExistingListId = (value: unknown) => {
  existingListId.value = typeof value === 'string' || typeof value === 'number' ? value : null;
};

const startImport = async () => {
  if (!canStart.value) return;
  const userid = currentUserId.value!;
  const importMode = mode.value;
  const url = inputText.value.trim();
  const files = [...selectedFiles.value];
  const targetName =
    screenshotTarget.value === 'new'
      ? newScreenshotPlaylistName.value.trim()
      : selectedPlaylist.value?.name || '';
  const targetListId = existingListId.value;
  const isSessionCurrent = captureUserSession(userStore);
  abortFlag.value = false;
  const run = importTaskStore.start(
    '歌单导入',
    () => {
      if (!disposed && currentDialogRun === run) {
        abortFlag.value = true;
        isStarting.value = false;
        isImporting.value = false;
      }
    },
    isSessionCurrent,
  );
  currentDialogRun = run;
  isStarting.value = true;
  errorMessage.value = '';
  summary.value = null;
  progressItems.value = [{ external: rootTrack, status: 'pending' }];
  try {
    if (importMode === 'link') {
      const response = await createLinkImportTask(url);
      if (!canContinueTask(run)) return;
      await monitorTask(responseTaskId(response), url, run);
      return;
    }
    let playlistName = targetName;
    let listId = targetListId;
    if (screenshotTarget.value === 'new') {
      const confirmedName = await confirmDuplicatePlaylistName(playlistName, run);
      if (!canContinueTask(run)) return;
      if (!confirmedName) {
        cancelRunBeforePlaylistCreation(run);
        return;
      }
      playlistName = confirmedName;
      listId = await playlistStore.createPlaylistAndReturnId(playlistName, false, userid);
      if (!canContinueTask(run)) return;
      if (!listId) throw new Error('新歌单创建失败；如存在同名歌单，请换一个名称后重试');
    }
    if (!listId || !playlistName) throw new Error('请选择或创建目标歌单');
    run.enterBackground(playlistName, () => {});
    const taskSn = `${userid}${Date.now()}`;
    if (canUpdateUi(run)) {
      step.value = 'progress';
      isImporting.value = true;
    }
    const root: ExternalTrack = { title: '上传截图', artist: '' };
    for (let index = 0; index < files.length; index++) {
      if (!canContinueTask(run)) return;
      root.title = `正在上传截图 ${index + 1} / ${files.length}`;
      run.resetProgress(index, files.length + 1, [{ external: root, status: 'adding' }]);
      const imageBase64 = await fileToBase64(files[index], run);
      if (!canContinueTask(run)) return;
      await submitImportScreenshot(taskSn, imageBase64);
      if (!canContinueTask(run)) return;
    }
    const response = await createScreenshotImportTask(taskSn, listId, playlistName);
    if (!canContinueTask(run)) return;
    await monitorTask(responseTaskId(response), '', run);
  } catch (error: unknown) {
    if (!canContinueTask(run)) return;
    if (importTaskStore.phase === 'local') {
      const item: ImportItemResult = {
        external: { title: '导入失败', artist: '' },
        status: 'failed',
        error: error instanceof Error ? error.message : '导入失败',
      };
      run.resetProgress(1, 1, [item]);
      run.complete({ total: 1, success: 0, low: 0, skipped: 0, failed: 1 });
      toastStore.actionFailed('导入');
      return;
    }
    const ownsUi = canUpdateUi(run);
    if (ownsUi) {
      run.dismiss();
      isStarting.value = false;
      isImporting.value = false;
      errorMessage.value = error instanceof Error ? error.message : '创建导入任务失败';
      step.value = 'input';
    } else {
      const item: ImportItemResult = {
        external: { title: '导入失败', artist: '' },
        status: 'failed',
        error: error instanceof Error ? error.message : '创建导入任务失败',
      };
      run.resetProgress(1, 1, [item]);
      run.complete({ total: 1, success: 0, low: 0, skipped: 0, failed: 1 });
    }
    toastStore.actionFailed('创建导入任务');
  }
};

const stopMonitoring = () => {
  const run = currentDialogRun ?? importTaskStore.getCurrentRun();
  const wasCloud = importTaskStore.phase === 'cloud';
  run?.abort({ feedback: false });
  finishDuplicateNameConfirm(false);
  abortFlag.value = true;
  isStarting.value = false;
  isImporting.value = false;
  if (wasCloud) toastStore.warning('已停止查看进度，导入任务仍会继续处理');
};

const runInBackground = () => {
  const run = currentDialogRun;
  if (!run || !canContinueTask(run)) return;
  showBackgroundConfirm.value = false;
  run.enterBackground(importTaskStore.playlistName, () => {});
  step.value = 'input';
  isStarting.value = false;
  isImporting.value = false;
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
          <Icon
            :icon="iconExternalLink"
            width="18"
            height="18"
            class="text-primary-text shrink-0"
          />
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
          粘贴链接后点击“开始导入”。如果链接导入失败，系统会自动尝试其他方式。
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
        <CustomTabBar
          :tabs="['选择歌单', '新建歌单']"
          :model-value="screenshotTarget === 'existing' ? 0 : 1"
          role="radiogroup"
          aria-label="截图导入目标"
          @update:model-value="screenshotTarget = $event === 0 ? 'existing' : 'new'"
        />
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
          class="text-primary-text animate-spin"
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
            <div class="text-[11px] text-text-secondary truncate">
              {{ item.external.artist || '未知歌手' }}
              <template v-if="item.error"> · {{ item.error }}</template>
            </div>
          </div>
          <span class="text-[11px] text-text-secondary shrink-0">
            {{ itemStatusLabel(item.status) }}
          </span>
        </div>
      </Scrollbar>
      <p v-if="isImporting" class="import-hint">
        {{
          importTaskStore.phase === 'cloud'
            ? '停止查看不会取消当前任务，稍后仍可在歌单列表中查看导入结果。'
            : '停止导入后将不再继续上传、匹配或添加歌曲，已提交的内容会保留。'
        }}
      </p>
    </div>

    <template #footer>
      <template v-if="step === 'input'">
        <Button variant="secondary" size="sm" :disabled="isStarting" @click="open = false"
          >取消</Button
        >
        <Button
          variant="primary"
          size="sm"
          :loading="isStarting"
          :disabled="!canStart"
          @click="startImport"
        >
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
        <Button v-if="isImporting" variant="secondary" size="sm" @click="stopMonitoring">{{
          importTaskStore.phase === 'cloud' ? '停止查看' : '停止导入'
        }}</Button>
        <Button v-if="isImporting" variant="primary" size="sm" @click="runInBackground"
          >后台运行</Button
        >
        <Button v-else variant="primary" size="sm" @click="closeResult">完成</Button>
      </template>
    </template>
  </Dialog>

  <Dialog
    v-model:open="showDuplicateNameConfirm"
    title="歌单名称重复"
    :close-on-escape="false"
    :close-on-interact-outside="false"
  >
    <div class="flex flex-col gap-3 py-1">
      <p class="text-[13px] text-text-secondary leading-relaxed">
        已有同名歌单。你可以修改名称，或保留原名称继续创建。
      </p>
      <Input
        v-model="duplicatePlaylistName"
        aria-label="新歌单名称"
        placeholder="请输入新歌单名称"
        input-class="h-10 rounded-xl px-3 text-[13px]"
        @keydown.enter.prevent="finishDuplicateNameConfirm(true)"
      />
      <p class="text-[12px] text-text-secondary leading-relaxed">
        {{
          hasOwnedPlaylistWithName(duplicatePlaylistName)
            ? '该名称仍与已有歌单重复，确定后将创建同名歌单。'
            : '将使用这个新名称创建歌单。'
        }}
      </p>
    </div>
    <template #footer>
      <Button variant="secondary" size="sm" @click="finishDuplicateNameConfirm(false)">取消</Button>
      <Button
        variant="primary"
        size="sm"
        :disabled="!duplicatePlaylistName.trim()"
        @click="finishDuplicateNameConfirm(true)"
      >
        确定
      </Button>
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
        <Checkbox
          :model-value="neverShowBackgroundConfirm"
          aria-label="以后不再提醒"
          @update:model-value="neverShowBackgroundConfirm = $event === true"
        />
        <span class="text-[12px] text-text-secondary">以后不再提醒</span>
      </label>
    </div>
    <template #footer>
      <Button variant="secondary" size="sm" @click="showBackgroundConfirm = false">留在本页</Button>
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
  @apply flex items-center gap-3 rounded-card px-4 py-3 text-left transition-all;
  color: var(--color-text-secondary);
  background: var(--control-muted-bg);
  border: 1px solid var(--control-border);
}

.import-mode-card:hover,
.import-mode-card.is-active {
  color: var(--color-primary-text);
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
  @apply text-[11px] text-text-secondary truncate;
}

.import-textarea {
  @apply w-full rounded-card px-4 py-3 text-[13px] leading-relaxed font-medium resize-y;
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
  @apply flex flex-col items-center justify-center gap-1.5 rounded-card px-4 py-7 cursor-pointer transition-colors;
  color: var(--color-text-secondary);
  background: var(--control-muted-bg);
  border: 1px dashed color-mix(in srgb, var(--color-primary) 38%, var(--control-border));
}

.import-dropzone:hover {
  color: var(--color-primary-text);
  background: color-mix(in srgb, var(--color-primary) 7%, transparent);
}

.import-dropzone strong {
  @apply text-[13px] text-text-main;
}

.import-dropzone span {
  @apply text-[11px] text-text-secondary;
}

.import-file-list {
  @apply flex flex-wrap gap-1.5;
}

.import-file-list span {
  @apply rounded-full px-2.5 py-1 text-[11px] text-text-secondary max-w-[200px] truncate;
  background: var(--control-muted-bg);
}

.import-hint {
  @apply text-[12px] text-text-secondary leading-relaxed;
}

.import-platforms {
  @apply flex flex-wrap items-center gap-1.5;
}

.import-platforms-label {
  @apply text-[11px] text-text-secondary mr-0.5;
}

.import-alert {
  @apply flex items-center gap-2 rounded-card px-3 py-2 text-[12px];
  color: var(--color-danger, #ef4444);
  background: color-mix(in srgb, var(--color-danger, #ef4444) 12%, transparent);
}

.import-stepper {
  @apply flex items-center gap-1.5 shrink-0;
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
  @apply flex items-center gap-3 rounded-card px-4 py-3;
  background: color-mix(in srgb, var(--color-primary) 8%, var(--control-muted-bg));
  border: 1px solid color-mix(in srgb, var(--color-primary) 22%, var(--control-border));
  animation: import-current-in 220ms ease-out;
}

.import-current-label {
  @apply text-[10px] text-text-secondary;
}

.import-current-title {
  @apply text-[13px] font-semibold text-text-main;
}

.import-current-artist {
  @apply text-[11px] text-text-secondary;
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
  border-radius: var(--radius-card);
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
  @apply flex items-center gap-2 rounded-card px-3 py-2 text-[12px] text-text-main;
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
