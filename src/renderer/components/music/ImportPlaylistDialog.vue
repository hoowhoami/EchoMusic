<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useVModel, useVirtualList } from '@vueuse/core';
import { Icon } from '@iconify/vue';
import { CheckboxIndicator, CheckboxRoot } from 'reka-ui';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import Switch from '@/components/ui/Switch.vue';
import Select from '@/components/ui/Select.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import Cover from '@/components/ui/Cover.vue';
import {
  iconCheckMark,
  iconChevronLeft,
  iconExternalLink,
  iconList,
  iconPlaylistAdd,
  iconRefreshCw,
  iconTriangleAlert,
} from '@/icons';
import { resolveExternalPlaylist } from '@/api/external';
import { runImport, type ImportItemResult, type ImportSummary } from '@/utils/importPlaylist';
import { getPlaylistDetail } from '@/api/playlist';
import { mapPlaylistMeta } from '@/utils/mappers';
import { usePlaylistStore } from '@/stores/playlist';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import type { ExternalPlaylist, ExternalProviderId } from '../../../shared/external';
import type { PlaylistMeta } from '@/models/playlist';

interface Props {
  open?: boolean;
}
const props = withDefaults(defineProps<Props>(), { open: false });
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();
const open = useVModel(props, 'open', emit, { defaultValue: false });

const playlistStore = usePlaylistStore();
const userStore = useUserStore();
const toastStore = useToastStore();
const router = useRouter();

type Step = 'input' | 'preview' | 'progress' | 'kugou-native';
const step = ref<Step>('input');

// Step 1
const inputText = ref('');
const provider = ref<ExternalProviderId>('auto');
const isResolving = ref(false);
const resolveError = ref('');
const PROVIDERS: { id: ExternalProviderId; label: string }[] = [
  { id: 'auto', label: '自动识别' },
  { id: 'netease', label: '网易云' },
  { id: 'qqmusic', label: 'QQ 音乐' },
  { id: 'kuwo', label: '酷我' },
  { id: 'kugou', label: '酷狗' },
  { id: 'text', label: '纯文本' },
];

const STEPS: { key: Step; label: string }[] = [
  { key: 'input', label: '粘贴' },
  { key: 'preview', label: '预览' },
  { key: 'progress', label: '导入' },
];
const stepIndex = computed(() => STEPS.findIndex((s) => s.key === step.value));

const formatDuration = (sec?: number): string => {
  if (!sec || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const totalDurationLabel = computed(() => {
  if (!resolved.value) return '';
  const total = resolved.value.tracks.reduce((acc, t) => acc + (t.duration || 0), 0);
  if (total <= 0) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
});

// 酷狗分享链接只包含部分歌曲
const isKugouPartial = computed(
  () => resolved.value?.provider === 'kugou' && !resolved.value?.externalId,
);

// Step 2
const resolved = ref<ExternalPlaylist | null>(null);
const selectedSet = ref<Set<number>>(new Set());
const target = ref<'new' | 'existing'>('new');
const newPlaylistName = ref('');
const newPlaylistIsPrivate = ref(false);
const existingListId = ref<string | number | null>(null);

const currentUserId = computed<number | undefined>(() => {
  const v = userStore.info?.userid ?? userStore.info?.userId;
  return typeof v === 'number' && v > 0 ? v : undefined;
});

const ownedPlaylists = computed<PlaylistMeta[]>(() => {
  const uid = currentUserId.value;
  if (!uid) return [];
  return playlistStore.userPlaylists.filter(
    (p) => p.source !== 2 && p.listCreateUserid === uid && !p.isDefault,
  );
});

const existingPlaylistOptions = computed(() =>
  ownedPlaylists.value.map((p) => ({
    label: `${p.name}（${p.count || p.songcount || 0} 首）`,
    value: (p.listid || p.id) as string | number,
  })),
);

const selectedTracks = computed(() => {
  if (!resolved.value) return [];
  return resolved.value.tracks.filter((_, idx) => selectedSet.value.has(idx));
});

const canStartImport = computed(() => {
  if (!resolved.value || selectedTracks.value.length === 0) return false;
  if (target.value === 'new') return Boolean(newPlaylistName.value.trim() && currentUserId.value);
  return Boolean(existingListId.value);
});

// Step 3
const progressItems = ref<ImportItemResult[]>([]);
const progressDone = ref(0);
const progressTotal = ref(0);
const isImporting = ref(false);
const abortFlag = ref(false);
const summary = ref<ImportSummary | null>(null);

const reset = () => {
  step.value = 'input';
  inputText.value = '';
  provider.value = 'auto';
  isResolving.value = false;
  resolveError.value = '';
  resolved.value = null;
  selectedSet.value = new Set();
  target.value = 'new';
  newPlaylistName.value = '';
  newPlaylistIsPrivate.value = false;
  existingListId.value = null;
  progressItems.value = [];
  progressDone.value = 0;
  progressTotal.value = 0;
  isImporting.value = false;
  abortFlag.value = false;
  summary.value = null;
  kugouPlaylistMeta.value = null;
  isLoadingKugouMeta.value = false;
};

watch(open, (v) => {
  if (!v) {
    window.setTimeout(reset, 200);
  }
});

const handleResolve = async () => {
  const input = inputText.value.trim();
  if (!input || isResolving.value) return;
  isResolving.value = true;
  resolveError.value = '';
  try {
    const res = await resolveExternalPlaylist({ input, provider: provider.value });
    if (!res.ok) {
      resolveError.value = res.error;
      return;
    }
    resolved.value = res.playlist;

    // 酷狗原生歌单：进入提示页面，让用户选择
    if (res.playlist.provider === 'kugou' && res.playlist.externalId) {
      step.value = 'kugou-native';
      fetchKugouPlaylistMeta(res.playlist.externalId);
      return;
    }

    selectedSet.value = new Set(res.playlist.tracks.map((_, idx) => idx));
    newPlaylistName.value = res.playlist.name || '导入的歌单';
    step.value = 'preview';
  } catch (e: unknown) {
    resolveError.value = e instanceof Error ? e.message : '解析失败';
  } finally {
    isResolving.value = false;
  }
};

const toggleTrack = (idx: number) => {
  const next = new Set(selectedSet.value);
  if (next.has(idx)) next.delete(idx);
  else next.add(idx);
  selectedSet.value = next;
};

const selectAll = () => {
  if (!resolved.value) return;
  selectedSet.value = new Set(resolved.value.tracks.map((_, idx) => idx));
};
const selectNone = () => {
  selectedSet.value = new Set();
};

type CheckboxState = boolean | 'indeterminate';

const allSelected = computed(
  () =>
    !!resolved.value &&
    resolved.value.tracks.length > 0 &&
    selectedSet.value.size === resolved.value.tracks.length,
);
const someSelected = computed(() => selectedSet.value.size > 0 && !allSelected.value);
const selectAllState = computed<CheckboxState>(() => {
  if (allSelected.value) return true;
  if (someSelected.value) return 'indeterminate';
  return false;
});
const toggleSelectAll = () => {
  if (allSelected.value) selectNone();
  else selectAll();
};
const setTrackChecked = (idx: number, value: CheckboxState) => {
  const next = new Set(selectedSet.value);
  if (value === true) next.add(idx);
  else next.delete(idx);
  selectedSet.value = next;
};

const previewTracks = computed(() => resolved.value?.tracks ?? []);
const PREVIEW_ITEM_HEIGHT = 56;
const {
  list: virtualPreviewList,
  containerProps: previewContainerProps,
  wrapperProps: previewWrapperProps,
} = useVirtualList(previewTracks, {
  itemHeight: PREVIEW_ITEM_HEIGHT,
  overscan: 8,
});

const goBackToInput = () => {
  if (isResolving.value) return;
  step.value = 'input';
};

const openKugouPlaylist = () => {
  if (!resolved.value?.externalId) return;
  open.value = false;
  router.push(`/main/playlist/${resolved.value.externalId}`);
};

// 酷狗歌单详情
const kugouPlaylistMeta = ref<PlaylistMeta | null>(null);
const isLoadingKugouMeta = ref(false);

const fetchKugouPlaylistMeta = async (id: string) => {
  isLoadingKugouMeta.value = true;
  kugouPlaylistMeta.value = null;
  try {
    const res = await getPlaylistDetail(id);
    if (res?.status === 1 && res?.data?.[0]) {
      kugouPlaylistMeta.value = mapPlaylistMeta(res.data[0]);
    }
  } catch {
    // 拉取失败不影响跳转
  } finally {
    isLoadingKugouMeta.value = false;
  }
};

const handleStartImport = async () => {
  if (!canStartImport.value || isImporting.value) return;
  const tracks = selectedTracks.value;
  let listId: string | number | null = null;
  if (target.value === 'new') {
    const id = await playlistStore.createPlaylistAndReturnId(
      newPlaylistName.value.trim(),
      newPlaylistIsPrivate.value,
      currentUserId.value,
    );
    if (!id) {
      toastStore.actionFailed('创建歌单');
      return;
    }
    listId = id;
  } else {
    listId = existingListId.value;
  }
  if (!listId) return;

  step.value = 'progress';
  progressItems.value = tracks.map((t) => ({ external: t, status: 'pending' }));
  progressDone.value = 0;
  progressTotal.value = tracks.length;
  isImporting.value = true;
  abortFlag.value = false;
  summary.value = null;

  try {
    const result = await runImport(tracks, listId, {
      shouldAbort: () => abortFlag.value,
      onProgress: (done, total, item) => {
        progressDone.value = done;
        progressTotal.value = total;
        const idx = progressItems.value.findIndex((it) => it.external === item.external);
        if (idx >= 0) progressItems.value[idx] = { ...item };
      },
    });
    summary.value = result;
    if (result.success > 0) {
      toastStore.success(`导入完成：成功 ${result.success} / ${result.total}`);
      await playlistStore.fetchUserPlaylists();
    } else if (!abortFlag.value) {
      toastStore.warning('未能匹配到任何歌曲');
    }
  } catch (e: unknown) {
    toastStore.actionFailed('导入');
    resolveError.value = e instanceof Error ? e.message : '导入失败';
  } finally {
    isImporting.value = false;
  }
};

const handleAbort = () => {
  if (!isImporting.value) return;
  abortFlag.value = true;
};

const handleClose = () => {
  if (isImporting.value) {
    abortFlag.value = true;
    return;
  }
  open.value = false;
};

const statusLabel = (status: ImportItemResult['status']): string => {
  switch (status) {
    case 'pending':
      return '等待';
    case 'matching':
      return '匹配中';
    case 'adding':
      return '添加中';
    case 'success':
      return '成功';
    case 'low':
      return '低相似';
    case 'skipped':
      return '已跳过';
    case 'failed':
      return '失败';
    default:
      return '';
  }
};
</script>

<template>
  <Dialog
    v-model:open="open"
    contentClass="import-playlist-dialog"
    showClose
    no-scroll
    :close-on-interact-outside="!isImporting && !isResolving"
    :close-on-escape="!isImporting && !isResolving"
  >
    <template #title>
      <div class="flex items-center justify-between gap-3 w-full pr-8">
        <div class="flex items-center gap-2 min-w-0">
          <Icon :icon="iconExternalLink" width="18" height="18" class="text-primary shrink-0" />
          <span class="truncate">从链接导入歌单</span>
        </div>
        <div class="import-stepper shrink-0">
          <template v-for="(s, i) in STEPS" :key="s.key">
            <span
              class="import-step-pill"
              :class="{
                'is-active': stepIndex === i,
                'is-done': stepIndex > i,
              }"
            >
              <span class="import-step-num">{{ i + 1 }}</span>
              <span class="import-step-label">{{ s.label }}</span>
            </span>
            <span v-if="i < STEPS.length - 1" class="import-step-sep" />
          </template>
        </div>
      </div>
    </template>

    <!-- Step 1: 输入 -->
    <div v-if="step === 'input'" class="flex flex-col gap-4 pt-1">
      <div class="flex flex-wrap gap-1.5">
        <Button
          v-for="opt in PROVIDERS"
          :key="opt.id"
          variant="unstyled"
          size="none"
          type="button"
          :class="['import-chip', provider === opt.id ? 'is-active' : '']"
          @click="provider = opt.id"
        >
          {{ opt.label }}
        </Button>
      </div>
      <textarea
        v-model="inputText"
        class="import-textarea"
        rows="5"
        placeholder="粘贴歌单链接（网易云 / QQ 音乐 / 酷我 / 酷狗），或粘贴“歌名 - 歌手”格式的多行文本"
        :disabled="isResolving"
      />
      <div v-if="resolveError" class="import-alert">
        <Icon :icon="iconTriangleAlert" width="14" height="14" />
        <span>{{ resolveError }}</span>
      </div>
      <p class="text-[12px] text-text-secondary/80 leading-relaxed">
        解析仅读取歌名、歌手等元数据，不会直接下载音频。导入时会用酷狗搜索匹配本地可播放版本，匹配置信度低的会单独标记。
      </p>
    </div>

    <!-- 酷狗原生歌单提示 -->
    <div v-else-if="step === 'kugou-native'" class="flex flex-col items-center gap-5 py-6">
      <div v-if="isLoadingKugouMeta" class="flex items-center justify-center py-8">
        <div
          class="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin"
        ></div>
      </div>
      <template v-else>
        <div class="flex items-center gap-4 w-full px-2">
          <Cover
            :url="kugouPlaylistMeta?.pic || ''"
            :size="200"
            :width="80"
            :height="80"
            :borderRadius="16"
            class="shrink-0"
          />
          <div class="min-w-0 flex-1">
            <div class="text-[15px] font-bold text-text-main truncate">
              {{ kugouPlaylistMeta?.name || '酷狗歌单' }}
            </div>
            <div class="text-[12px] text-text-secondary/80 truncate mt-1">
              <span>{{ kugouPlaylistMeta?.nickname || '未知创建者' }}</span>
              <template v-if="kugouPlaylistMeta?.count">
                <span class="mx-1.5">·</span>
                <span>{{ kugouPlaylistMeta.count }} 首</span>
              </template>
            </div>
            <div
              v-if="kugouPlaylistMeta?.intro"
              class="text-[11px] text-text-secondary/60 truncate mt-1"
            >
              {{ kugouPlaylistMeta.intro }}
            </div>
          </div>
        </div>

        <div
          class="w-full rounded-xl px-4 py-3 text-[13px] text-text-secondary leading-relaxed"
          style="background: color-mix(in srgb, var(--color-primary) 6%, transparent)"
        >
          该链接指向酷狗歌单，可以直接在应用内打开，享受完整的歌单体验。
        </div>
      </template>

      <div class="flex gap-3 w-full pt-1">
        <Button variant="secondary" class="flex-1" @click="goBackToInput"> 返回 </Button>
        <Button
          variant="primary"
          class="flex-1"
          :disabled="isLoadingKugouMeta"
          @click="openKugouPlaylist"
        >
          打开歌单
        </Button>
      </div>
    </div>

    <!-- Step 2: 预览 + 目标 -->
    <div v-else-if="step === 'preview' && resolved" class="import-preview-wrap">
      <div class="flex items-center gap-3.5 shrink-0">
        <Cover
          :url="resolved.coverUrl || ''"
          :size="200"
          :width="64"
          :height="64"
          :borderRadius="12"
          class="shrink-0"
        />
        <div class="min-w-0 flex-1">
          <div class="text-[14px] font-semibold text-text-main truncate">
            {{ resolved.name }}
          </div>
          <div class="text-[12px] text-text-secondary/80 truncate">
            <span>{{ resolved.creator || '未知创建者' }}</span>
            <span class="mx-1.5">·</span>
            <span>共 {{ resolved.tracks.length }} 首</span>
            <template v-if="totalDurationLabel">
              <span class="mx-1.5">·</span>
              <span>{{ totalDurationLabel }}</span>
            </template>
            <span class="mx-1.5">·</span>
            <span class="uppercase tracking-wider">{{ resolved.provider }}</span>
          </div>
        </div>
      </div>

      <div
        v-if="isKugouPartial"
        class="import-alert"
        style="background: color-mix(in srgb, #f59e0b 12%, transparent); color: #b45309"
      >
        <Icon :icon="iconTriangleAlert" width="14" height="14" />
        <span
          >该分享链接仅包含部分歌曲（{{
            resolved.tracks.length
          }}
          首），完整歌单可能有更多。建议在应用内搜索歌单名称或使用歌单完整链接。</span
        >
      </div>

      <div class="import-preview-grid">
        <!-- Left: target panel -->
        <div class="import-target-pane">
          <div class="import-section-title">导入到</div>
          <div class="import-target-options">
            <button
              type="button"
              class="import-target-card"
              :class="{ 'is-active': target === 'new' }"
              @click="target = 'new'"
            >
              <span class="import-target-icon">
                <Icon :icon="iconPlaylistAdd" width="18" height="18" />
              </span>
              <span class="import-target-text">
                <span class="import-target-title">新建歌单</span>
                <span class="import-target-desc">为这次导入创建一个新歌单</span>
              </span>
              <span class="import-target-radio" aria-hidden="true">
                <span class="import-target-radio-dot" />
              </span>
            </button>

            <button
              type="button"
              class="import-target-card"
              :class="{
                'is-active': target === 'existing',
                'is-disabled': ownedPlaylists.length === 0,
              }"
              :disabled="ownedPlaylists.length === 0"
              @click="target = 'existing'"
            >
              <span class="import-target-icon">
                <Icon :icon="iconList" width="18" height="18" />
              </span>
              <span class="import-target-text">
                <span class="import-target-title">追加到已有歌单</span>
                <span class="import-target-desc">
                  {{ ownedPlaylists.length === 0 ? '暂无自建歌单' : '将曲目追加到一个已有的歌单' }}
                </span>
              </span>
              <span class="import-target-radio" aria-hidden="true">
                <span class="import-target-radio-dot" />
              </span>
            </button>
          </div>

          <div v-if="target === 'new'" class="import-target-detail">
            <Input
              v-model="newPlaylistName"
              placeholder="请输入歌单名称"
              input-class="h-10 rounded-xl px-3 pr-9 text-[13px]"
            />
            <label class="flex items-center justify-between text-[12px] text-text-secondary/90">
              <span>设为隐私歌单</span>
              <Switch v-model="newPlaylistIsPrivate" />
            </label>
          </div>
          <div v-else-if="target === 'existing'" class="import-target-detail">
            <Select
              :model-value="existingListId ?? ''"
              :options="existingPlaylistOptions"
              placeholder="请选择歌单"
              :filterable="ownedPlaylists.length > 8"
              class="w-full"
              @update:model-value="
                (v) => (existingListId = v === '' ? null : (v as string | number))
              "
            />
          </div>
        </div>

        <!-- Right: tracks (virtual scroll) -->
        <div class="import-tracks-pane">
          <div class="import-tracks-header">
            <button type="button" class="import-select-all" @click="toggleSelectAll">
              <CheckboxRoot
                class="import-checkbox"
                :model-value="selectAllState"
                @update:model-value="toggleSelectAll"
                @click.stop
              >
                <CheckboxIndicator as-child>
                  <span class="import-checkbox-indicator" />
                </CheckboxIndicator>
              </CheckboxRoot>
              <span>全选</span>
            </button>
            <span class="text-text-secondary/70 text-[12px]">
              已选 {{ selectedTracks.length }} / {{ resolved.tracks.length }}
            </span>
          </div>
          <Scrollbar
            class="import-track-list"
            :scrollbar-inset="3"
            :content-props="previewContainerProps"
          >
            <div v-bind="previewWrapperProps">
              <div
                v-for="entry in virtualPreviewList"
                :key="entry.index"
                class="import-track-row"
                :class="{ 'is-selected': selectedSet.has(entry.index) }"
                :style="{ height: PREVIEW_ITEM_HEIGHT + 'px' }"
                @click="toggleTrack(entry.index)"
              >
                <div class="import-track-leading" @click.stop>
                  <CheckboxRoot
                    class="import-checkbox"
                    :model-value="selectedSet.has(entry.index)"
                    @update:model-value="setTrackChecked(entry.index, $event)"
                  >
                    <CheckboxIndicator as-child>
                      <span class="import-checkbox-indicator" />
                    </CheckboxIndicator>
                  </CheckboxRoot>
                </div>
                <span class="import-track-index">{{ entry.index + 1 }}</span>
                <div class="min-w-0 flex-1">
                  <div class="text-[13px] font-medium text-text-main truncate">
                    {{ entry.data.title }}
                  </div>
                  <div class="text-[11px] text-text-secondary/80 truncate">
                    {{ entry.data.artist || '未知' }}
                  </div>
                </div>
                <span v-if="entry.data.duration" class="import-track-duration">
                  {{ formatDuration(entry.data.duration) }}
                </span>
              </div>
            </div>
          </Scrollbar>
        </div>
      </div>
    </div>

    <!-- Step 3: 进度与结果 -->
    <div v-else-if="step === 'progress'" class="flex flex-col gap-3 pt-1">
      <div class="flex items-center justify-between text-[12px]">
        <span class="text-text-main font-medium">
          {{
            summary
              ? `已处理 ${summary.total} / ${summary.total}`
              : `正在导入 · ${progressDone} / ${progressTotal}`
          }}
        </span>
        <Icon
          v-if="!summary"
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
          :style="{
            width: progressTotal > 0 ? `${(progressDone / progressTotal) * 100}%` : '0%',
          }"
        />
      </div>
      <Scrollbar class="import-track-list" :scrollbar-inset="3">
        <div class="flex flex-col">
          <div
            v-for="(item, idx) in progressItems"
            :key="idx"
            class="import-track-row is-static"
            :class="['status-' + item.status]"
          >
            <span class="import-status-dot" />
            <div class="min-w-0 flex-1">
              <div class="text-[13px] font-medium text-text-main truncate">
                {{ item.external.title }}
              </div>
              <div class="text-[11px] text-text-secondary/80 truncate">
                {{ item.external.artist || '未知' }}
                <template v-if="item.matched">
                  → {{ item.matched.title }} - {{ item.matched.artist }}
                </template>
                <template v-if="item.error"> · {{ item.error }}</template>
              </div>
            </div>
            <span class="text-[11px] text-text-secondary/80 shrink-0">
              {{ statusLabel(item.status) }}
            </span>
          </div>
        </div>
      </Scrollbar>
    </div>

    <template #footer>
      <template v-if="step === 'input'">
        <Button variant="ghost" size="sm" :disabled="isResolving" @click="open = false">
          取消
        </Button>
        <Button
          variant="primary"
          size="sm"
          :loading="isResolving"
          :disabled="!inputText.trim()"
          @click="handleResolve"
        >
          解析
        </Button>
      </template>
      <template v-else-if="step === 'kugou-native'" />
      <template v-else-if="step === 'preview'">
        <Button variant="ghost" size="sm" type="button" @click="goBackToInput">
          <Icon :icon="iconChevronLeft" width="14" height="14" />
          返回
        </Button>
        <Button variant="primary" size="sm" :disabled="!canStartImport" @click="handleStartImport">
          <Icon :icon="iconPlaylistAdd" width="14" height="14" />
          开始导入
        </Button>
      </template>
      <template v-else>
        <div
          v-if="summary"
          class="import-summary-inline mr-auto"
          :class="{ 'is-warn': summary.success === 0 }"
        >
          <span class="import-summary-icon-sm">
            <Icon
              :icon="summary.success === 0 ? iconTriangleAlert : iconCheckMark"
              width="14"
              height="14"
            />
          </span>
          <div class="min-w-0 flex-1">
            <div class="import-summary-title">
              {{ summary.success === 0 ? '导入未完成' : '导入完成' }}
            </div>
            <div class="import-summary-meta">
              成功 {{ summary.success }} · 低相似 {{ summary.low }} · 跳过 {{ summary.skipped }} ·
              失败 {{ summary.failed }} / 共 {{ summary.total }}
            </div>
          </div>
        </div>
        <Button v-if="isImporting" variant="secondary" size="sm" type="button" @click="handleAbort">
          中止
        </Button>
        <Button v-else variant="primary" size="sm" type="button" @click="handleClose">
          完成
        </Button>
      </template>
    </template>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

:global(.dialog-content.import-playlist-dialog) {
  width: 720px;
  max-width: calc(100vw - 32px);
  max-height: min(640px, calc(100vh - 64px));
}

.import-preview-wrap {
  @apply flex flex-col gap-4 pt-1;
}
.import-preview-grid {
  @apply grid gap-4 items-start;
  grid-template-columns: minmax(260px, 1fr) minmax(340px, 1.35fr);
}
.import-target-pane {
  @apply flex flex-col gap-3 rounded-[14px] px-4 py-3.5;
  background: color-mix(in srgb, var(--color-text-main) 3%, transparent);
}
.import-target-options {
  @apply flex flex-col gap-2;
}
.import-target-card {
  @apply flex items-center gap-3 w-full rounded-xl px-3 py-2.5 text-left transition-all cursor-pointer;
  background: color-mix(in srgb, var(--color-text-main) 4%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-border-light) 40%, transparent);
}
.import-target-card:hover {
  background: color-mix(in srgb, var(--color-text-main) 7%, transparent);
  border-color: color-mix(in srgb, var(--color-primary) 30%, transparent);
}
.import-target-card.is-active {
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  border-color: color-mix(in srgb, var(--color-primary) 55%, transparent);
}
.import-target-card.is-disabled {
  @apply cursor-not-allowed opacity-55;
}
.import-target-card.is-disabled:hover {
  background: color-mix(in srgb, var(--color-text-main) 4%, transparent);
  border-color: color-mix(in srgb, var(--color-border-light) 40%, transparent);
}
.import-target-icon {
  @apply flex items-center justify-center w-8 h-8 rounded-[10px] shrink-0 text-text-secondary;
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
}
.import-target-card.is-active .import-target-icon {
  background: color-mix(in srgb, var(--color-primary) 18%, transparent);
  color: var(--color-primary);
}
.import-target-text {
  @apply flex-1 min-w-0 flex flex-col gap-0.5;
}
.import-target-title {
  @apply text-[13px] font-semibold text-text-main truncate;
}
.import-target-desc {
  @apply text-[11px] text-text-secondary/80 truncate;
}
.import-target-radio {
  @apply flex items-center justify-center w-4 h-4 rounded-full shrink-0 transition-colors;
  border: 1.5px solid color-mix(in srgb, var(--color-text-main) 30%, transparent);
}
.import-target-card.is-active .import-target-radio {
  border-color: var(--color-primary);
}
.import-target-radio-dot {
  @apply w-2 h-2 rounded-full transition-all scale-0;
  background: var(--color-primary);
}
.import-target-card.is-active .import-target-radio-dot {
  @apply scale-100;
}
.import-target-detail {
  @apply flex flex-col gap-2 pt-0.5;
}
.import-tracks-pane {
  @apply flex flex-col rounded-[14px] overflow-hidden;
  background: color-mix(in srgb, var(--color-text-main) 3%, transparent);
  height: 280px;
}
.import-tracks-header {
  @apply flex items-center justify-between px-3.5 py-2.5 shrink-0;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border-light) 30%, transparent);
}

.import-chip {
  @apply inline-flex items-center justify-center px-3 h-7 rounded-full text-[12px] font-medium transition-colors;
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
  color: var(--color-text-main);
  opacity: 0.75;
}
.import-chip:hover {
  opacity: 1;
}
.import-chip.is-active {
  background: color-mix(in srgb, var(--color-primary) 18%, transparent);
  color: var(--color-primary);
  opacity: 1;
}

.import-textarea {
  @apply w-full rounded-[14px] px-4 py-3 text-[13px] leading-relaxed font-medium resize-y;
  background: color-mix(in srgb, var(--color-text-main) 4%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-border-light) 50%, transparent);
  color: var(--color-text-main);
  outline: none;
  min-height: 120px;
}
.import-textarea:focus {
  border-color: color-mix(in srgb, var(--color-primary) 50%, transparent);
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
}
.import-textarea:disabled {
  opacity: 0.6;
}

.import-alert {
  @apply flex items-center gap-2 rounded-[10px] px-3 py-2 text-[12px];
  background: color-mix(in srgb, var(--color-danger, #ef4444) 12%, transparent);
  color: var(--color-danger, #ef4444);
}

.import-section {
  @apply flex flex-col gap-2.5 rounded-[14px] px-4 py-3.5;
  background: color-mix(in srgb, var(--color-text-main) 3%, transparent);
}
.import-section-title {
  @apply text-[12px] font-semibold text-text-secondary;
}

.import-track-list {
  max-height: 320px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--color-text-main) 3%, transparent);
}
.import-tracks-pane .import-track-list {
  flex: 1;
  min-height: 0;
  max-height: none;
  border-radius: 0;
  background: transparent;
}

.import-track-index {
  @apply shrink-0 text-[11px] text-text-secondary/60 font-mono tabular-nums;
  width: 22px;
  text-align: right;
}
.import-track-duration {
  @apply shrink-0 text-[11px] text-text-secondary/70 font-mono tabular-nums ml-2;
}

.import-stepper {
  @apply flex items-center gap-1.5;
}
.import-step-pill {
  @apply inline-flex items-center gap-1.5 px-2 h-6 rounded-full text-[11px] font-medium transition-colors;
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
  color: color-mix(in srgb, var(--color-text-main) 55%, transparent);
}
.import-step-pill.is-active {
  background: color-mix(in srgb, var(--color-primary) 16%, transparent);
  color: var(--color-primary);
}
.import-step-pill.is-done {
  color: color-mix(in srgb, var(--color-text-main) 80%, transparent);
}
.import-step-num {
  @apply inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-semibold;
  background: color-mix(in srgb, var(--color-text-main) 12%, transparent);
}
.import-step-pill.is-active .import-step-num {
  background: var(--color-primary);
  color: #fff;
}
.import-step-pill.is-done .import-step-num {
  background: color-mix(in srgb, var(--color-primary) 30%, transparent);
  color: var(--color-primary);
}
.import-step-sep {
  @apply w-2 h-px;
  background: color-mix(in srgb, var(--color-text-main) 18%, transparent);
}

.import-summary-inline {
  @apply flex items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 min-w-0;
  max-width: 480px;
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}
.import-summary-inline.is-warn {
  background: color-mix(in srgb, var(--color-danger, #ef4444) 10%, transparent);
}
.import-summary-icon-sm {
  @apply inline-flex items-center justify-center w-7 h-7 rounded-full shrink-0 text-white;
  background: var(--color-primary);
}
.import-summary-inline.is-warn .import-summary-icon-sm {
  background: var(--color-danger, #ef4444);
}
.import-summary-title {
  @apply text-[12.5px] font-semibold text-text-main truncate leading-tight;
}
.import-summary-meta {
  @apply text-[11px] text-text-secondary/85 truncate;
}
.import-progress-fill.is-done {
  background: color-mix(in srgb, var(--color-primary) 70%, transparent);
}

.import-track-row {
  @apply flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors;
  border-bottom: 1px solid color-mix(in srgb, var(--color-border-light) 30%, transparent);
}
.import-track-row:last-child {
  border-bottom: none;
}
.import-track-row:not(.is-static):hover {
  background: color-mix(in srgb, var(--color-primary) 6%, transparent);
}
.import-track-row.is-selected {
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
}
.import-track-leading {
  @apply flex items-center justify-center shrink-0;
}

.import-checkbox {
  @apply inline-flex items-center justify-center shrink-0 transition-colors;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: 1px solid var(--color-border-light);
  background: transparent;
}
.import-track-row:not(.is-static):hover .import-checkbox,
.import-select-all:hover .import-checkbox {
  border-color: color-mix(in srgb, var(--color-primary) 55%, transparent);
}
.import-checkbox[data-state='checked'],
.import-checkbox[data-state='indeterminate'] {
  background: var(--color-primary);
  border-color: var(--color-primary);
}
.import-checkbox-indicator {
  @apply relative flex items-center justify-center;
  width: 10px;
  height: 10px;
}
.import-checkbox[data-state='checked'] .import-checkbox-indicator::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 4px;
  height: 8px;
  border: 2px solid #fff;
  border-top: none;
  border-left: none;
  transform: translate(-50%, -60%) rotate(45deg);
}
.import-checkbox[data-state='indeterminate'] .import-checkbox-indicator::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 8px;
  height: 2px;
  background: #fff;
  border-radius: 999px;
  transform: translate(-50%, -50%);
}

.import-select-all {
  @apply inline-flex items-center gap-2 cursor-pointer text-[13px] text-text-main/85 transition-colors;
}
.import-select-all:hover {
  color: var(--color-text-main);
}

.import-progress-bar {
  @apply w-full h-1.5 rounded-full overflow-hidden;
  background: color-mix(in srgb, var(--color-text-main) 8%, transparent);
}
.import-progress-fill {
  @apply h-full rounded-full transition-all;
  background: var(--color-primary);
}

.import-status-dot {
  @apply w-1.5 h-1.5 rounded-full shrink-0;
  background: color-mix(in srgb, var(--color-text-main) 30%, transparent);
}
.import-track-row.status-matching .import-status-dot,
.import-track-row.status-adding .import-status-dot {
  background: var(--color-primary);
  animation: import-pulse 1.2s ease-in-out infinite;
}
.import-track-row.status-success .import-status-dot {
  background: #10b981;
}
.import-track-row.status-low .import-status-dot {
  background: #f59e0b;
}
.import-track-row.status-skipped .import-status-dot {
  background: color-mix(in srgb, var(--color-text-main) 25%, transparent);
}
.import-track-row.status-failed .import-status-dot {
  background: var(--color-danger, #ef4444);
}

@keyframes import-pulse {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}
</style>
