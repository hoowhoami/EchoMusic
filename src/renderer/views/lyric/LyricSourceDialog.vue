<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useVModel } from '@vueuse/core';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import {
  useLyricStore,
  getLyricCandidateKey,
  type LyricLine,
  type ParsedLyricPreview,
  type LyricSearchCandidate,
} from '@/stores/lyric';
import { usePlayerStore } from '@/stores/player';
import { useToastStore } from '@/stores/toast';
import { iconCheckMark, iconRefreshCw, iconSparkles, iconTriangleAlert } from '@/icons';

const props = defineProps<{
  open: boolean;
  hash: string;
  duration?: number;
  title?: string;
  artist?: string;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const open = useVModel(props, 'open', emit);
const lyricStore = useLyricStore();
const playerStore = usePlayerStore();
const toastStore = useToastStore();

const selectedKey = ref('');
const previewSerial = ref(0);
const previewLoading = ref(false);
const isLoading = ref(false);
const isApplying = ref(false);
const previewLines = ref<LyricLine[]>([]);
const previewStaticLines = ref<string[]>([]);
const previewState = ref({
  hasTranslation: false,
  hasRomanization: false,
  lineCount: 0,
  isScrollable: false,
});

const normalizedHash = computed(() => String(props.hash ?? '').trim());
const durationMs = computed(() => Math.round(Number(props.duration || 0) * 1000));
const candidates = computed(() =>
  lyricStore.candidateHash === normalizedHash.value ? lyricStore.candidates : [],
);
const displayedCandidates = computed(() => candidates.value);
const selectedCandidate = computed(
  () =>
    candidates.value.find((candidate) => getLyricCandidateKey(candidate) === selectedKey.value) ??
    null,
);
const currentCandidateKey = computed(() => lyricStore.currentCandidateKey);
const manualCandidateKey = computed(() => {
  const candidate = normalizedHash.value ? lyricStore.manualLyricMap[normalizedHash.value] : null;
  return candidate ? getLyricCandidateKey(candidate) : '';
});
const canRestoreAuto = computed(() => Boolean(manualCandidateKey.value));

const durationDiffLabel = (candidate: LyricSearchCandidate) => {
  if (!candidate.duration || !durationMs.value) return '';
  const diff = Math.round((candidate.duration - durationMs.value) / 1000);
  if (diff === 0) return '';
  return `${diff > 0 ? '+' : ''}${diff}s`;
};

const hasLargeDurationDiff = (candidate: LyricSearchCandidate) => {
  if (!candidate.duration || !durationMs.value) return false;
  return Math.abs(candidate.duration - durationMs.value) > 5000;
};

const isScrollableCandidate = (candidate: LyricSearchCandidate) => candidate.contenttype !== 2;
const candidatePreview = (candidate: LyricSearchCandidate): ParsedLyricPreview | null =>
  lyricStore.candidatePreviewMap[getLyricCandidateKey(candidate)] ?? null;

const recommendationLevel = (candidate: LyricSearchCandidate) => {
  // 星级由接口返回的 score（0-100）映射为 0-5 星，按 0.5 粒度（支持半星）
  const score = Number(candidate.score ?? 0);
  if (!Number.isFinite(score) || score <= 0) return 0;
  const stars = Math.round((score / 20) * 2) / 2;
  return Math.min(5, Math.max(0, stars));
};

// 单颗星的状态：实心 / 半星 / 空
const starClass = (candidate: LyricSearchCandidate, index: number) => {
  const rating = recommendationLevel(candidate);
  if (index <= Math.floor(rating)) return 'filled';
  if (index === Math.ceil(rating) && rating % 1 !== 0) return 'half';
  return '';
};

const typeLabels = (candidate: LyricSearchCandidate) => {
  const labels: string[] = [];
  const preview = candidatePreview(candidate);
  if (candidate.product_from === '官方推荐歌词') labels.push('官方推荐');
  if (preview?.hasTranslation) labels.push('翻译');
  if (preview?.hasRomanization) labels.push('音译');
  if (candidate.krctype === 1) labels.push('逐字');
  if (!isScrollableCandidate(candidate)) labels.push('无法滚动');
  if (candidate.language) labels.push(candidate.language);
  return labels;
};

const sourceLabel = (candidate: LyricSearchCandidate) => {
  if (candidate.product_from === '官方推荐歌词') return '官方推荐';
  if (candidate.product_from === 'ugc') return '用户上传';
  return candidate.product_from || '未知来源';
};

const getStaticLyricLines = (raw: string) =>
  raw
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\[\d+:\d+(?:\.\d+)?\]/, '')
        .replace(/^\[\d+,\d+\]/, '')
        .trim(),
    )
    .filter((line) => {
      if (!line) return false;
      return !/^\[(?:id|ar|ti|al|by|offset|hash|language|kana):/i.test(line);
    });

const pickInitialCandidate = () => {
  selectedKey.value =
    currentCandidateKey.value ||
    manualCandidateKey.value ||
    lyricStore.autoCandidateKey ||
    (candidates.value[0] ? getLyricCandidateKey(candidates.value[0]) : '');
};

const loadCandidates = async (force = false) => {
  if (!normalizedHash.value) return;
  isLoading.value = true;
  try {
    const previousSelectedKey = selectedKey.value;
    await lyricStore.fetchLyricCandidates(normalizedHash.value, {
      duration: durationMs.value || undefined,
      keywords: props.title || undefined,
      force,
    });
    pickInitialCandidate();
    if (selectedKey.value === previousSelectedKey) void loadPreview();
  } catch {
    toastStore.loadFailed('歌词候选');
  } finally {
    isLoading.value = false;
  }
};

const loadPreview = async () => {
  const candidate = selectedCandidate.value;
  previewLines.value = [];
  previewStaticLines.value = [];
  previewState.value = {
    hasTranslation: false,
    hasRomanization: false,
    lineCount: 0,
    isScrollable: false,
  };
  if (!candidate) return;

  const serial = previewSerial.value + 1;
  previewSerial.value = serial;
  previewLoading.value = true;
  try {
    const preview = await lyricStore.previewCandidate(candidate);
    if (serial !== previewSerial.value) return;
    previewLines.value = preview?.lines ?? [];
    previewStaticLines.value =
      preview?.lines.length === 0 && preview.rawLyric ? getStaticLyricLines(preview.rawLyric) : [];
    previewState.value = {
      hasTranslation: Boolean(preview?.hasTranslation),
      hasRomanization: Boolean(preview?.hasRomanization),
      lineCount: preview?.lines.length || previewStaticLines.value.length || 0,
      isScrollable: (preview?.lines.length ?? 0) > 0,
    };
  } catch {
    if (serial === previewSerial.value) toastStore.loadFailed('歌词预览');
  } finally {
    if (serial === previewSerial.value) previewLoading.value = false;
  }
};

const previewActiveIndex = computed(() => {
  const currentTimeMs = Math.round(playerStore.currentTime * 1000);
  let activeIndex = -1;
  for (let index = 0; index < previewLines.value.length; index += 1) {
    const line = previewLines.value[index];
    if (!line) continue;
    const start = line.characters[0]?.startTime ?? Math.round(line.time * 1000);
    if (currentTimeMs >= start) activeIndex = index;
    else break;
  }
  return activeIndex;
});

const livePreviewLines = computed(() => {
  if (previewLines.value.length === 0) return [];
  const activeIndex = previewActiveIndex.value;
  const start = Math.max(0, activeIndex - 3);
  return previewLines.value.slice(start, start + 11).map((line, offset) => ({
    line,
    index: start + offset,
  }));
});

const applySelected = async () => {
  const candidate = selectedCandidate.value;
  if (!candidate || !normalizedHash.value) return;
  isApplying.value = true;
  try {
    const ok = await lyricStore.applyCandidate(normalizedHash.value, candidate, { remember: true });
    if (!ok) {
      toastStore.actionFailed('切换歌词');
      return;
    }
    toastStore.success('歌词版本已应用');
    open.value = false;
  } catch {
    toastStore.actionFailed('切换歌词');
  } finally {
    isApplying.value = false;
  }
};

const restoreAuto = async () => {
  if (!normalizedHash.value) return;
  isApplying.value = true;
  try {
    await lyricStore.restoreAutoLyric(normalizedHash.value, {
      duration: durationMs.value || undefined,
      keywords: props.title || undefined,
    });
    pickInitialCandidate();
    toastStore.success('已改为智能推荐');
    open.value = false;
  } catch {
    toastStore.actionFailed('改为智能推荐');
  } finally {
    isApplying.value = false;
  }
};

watch(
  () => open.value,
  (value) => {
    if (value) void loadCandidates(false);
  },
);

watch(selectedKey, () => {
  if (open.value) void loadPreview();
});
</script>

<template>
  <Dialog
    v-model:open="open"
    title="选择歌词"
    showClose
    noScroll
    contentClass="lyric-source-dialog"
  >
    <div class="source-dialog">
      <div class="source-summary">
        <div class="track-text">
          <span class="track-title">
            {{ title || '当前歌曲' }}
            <template v-if="artist"> - {{ artist }}</template>
          </span>
        </div>
        <Button
          variant="ghost"
          size="none"
          class="refresh-btn"
          title="刷新歌词候选"
          :disabled="isLoading"
          @click="loadCandidates(true)"
        >
          <Icon :icon="iconRefreshCw" width="14" height="14" />
        </Button>
      </div>

      <div class="source-layout">
        <div class="candidate-list">
          <div v-if="isLoading && candidates.length === 0" class="empty-state">正在搜索歌词...</div>
          <div v-else-if="candidates.length === 0" class="empty-state">没有找到可选歌词</div>
          <button
            v-for="candidate in displayedCandidates"
            :key="getLyricCandidateKey(candidate)"
            class="candidate-item"
            :class="{
              active: selectedKey === getLyricCandidateKey(candidate),
              recommended: lyricStore.autoCandidateKey === getLyricCandidateKey(candidate),
            }"
            @click="selectedKey = getLyricCandidateKey(candidate)"
          >
            <div class="candidate-content">
              <div class="candidate-main">
                <span class="candidate-title">
                  {{ candidate.song || title || '未知歌曲' }}
                  <template v-if="candidate.singer || artist">
                    - {{ candidate.singer || artist }}</template
                  >
                </span>
              </div>
              <div class="candidate-meta">
                <span
                  v-if="lyricStore.autoCandidateKey === getLyricCandidateKey(candidate)"
                  class="status-pill recommended-pill"
                >
                  <Icon :icon="iconSparkles" width="12" height="12" />
                  智能推荐
                </span>
                <span class="star-rating" :title="`推荐 ${recommendationLevel(candidate)} 星`">
                  <span
                    v-for="index in 5"
                    :key="index"
                    class="star"
                    :class="starClass(candidate, index)"
                  >
                    ★
                  </span>
                </span>
              </div>
              <div class="candidate-tags">
                <span
                  v-for="label in typeLabels(candidate)"
                  :key="label"
                  :class="{
                    official: label === '官方推荐',
                    roman: label === '音译',
                    translation: label === '翻译',
                    yrc: label === '逐字',
                    unscrollable: label === '无法滚动',
                  }"
                >
                  {{ label }}
                </span>
                <span
                  v-if="durationDiffLabel(candidate)"
                  :class="{ warn: hasLargeDurationDiff(candidate) }"
                >
                  {{ durationDiffLabel(candidate) }}
                </span>
              </div>
            </div>
            <span
              v-if="currentCandidateKey === getLyricCandidateKey(candidate)"
              class="current-check"
            >
              <Icon :icon="iconCheckMark" width="13" height="13" />
            </span>
          </button>
        </div>

        <div class="preview-pane">
          <Transition name="preview-switch" mode="out-in">
            <div :key="selectedKey || 'empty'" class="preview-content">
              <div v-if="selectedCandidate" class="preview-head">
                <div class="preview-title-group">
                  <div class="preview-title">
                    {{ selectedCandidate.song || title || '未知歌曲' }}
                  </div>
                  <div class="preview-subtitle">
                    {{ sourceLabel(selectedCandidate) }}
                    <template v-if="selectedCandidate.nickname">
                      · {{ selectedCandidate.nickname }}</template
                    >
                  </div>
                </div>
                <div class="preview-badges">
                  <span>{{ previewState.lineCount }} 行</span>
                  <span v-if="previewState.isScrollable">实时预览</span>
                  <span v-if="previewState.hasTranslation">翻译</span>
                  <span v-if="previewState.hasRomanization">音译</span>
                </div>
              </div>
              <div
                v-if="selectedCandidate && hasLargeDurationDiff(selectedCandidate)"
                class="preview-warning"
              >
                <Icon :icon="iconTriangleAlert" width="14" height="14" />
                这份歌词时长差异较大，可能不同步
              </div>
              <div class="preview-lines">
                <div v-if="previewLoading" class="empty-state">正在加载预览...</div>
                <div
                  v-else-if="previewLines.length === 0 && previewStaticLines.length === 0"
                  class="empty-state"
                >
                  暂无歌词预览
                </div>
                <div
                  v-for="entry in livePreviewLines"
                  :key="`${entry.line.time}-${entry.index}`"
                  class="preview-line"
                  :class="{ active: entry.index === previewActiveIndex }"
                >
                  <span>{{ entry.line.text }}</span>
                  <small v-if="entry.line.translated">{{ entry.line.translated }}</small>
                  <small v-if="entry.line.romanized">{{ entry.line.romanized }}</small>
                </div>
                <div
                  v-for="(line, index) in previewStaticLines.slice(0, 18)"
                  v-show="previewLines.length === 0"
                  :key="`${line}-${index}`"
                  class="preview-line static"
                >
                  <span>{{ line }}</span>
                </div>
              </div>
            </div>
          </Transition>
        </div>
      </div>
    </div>

    <template #footer>
      <Button
        variant="ghost"
        size="sm"
        :disabled="!canRestoreAuto || isApplying"
        @click="restoreAuto"
      >
        使用智能推荐
      </Button>
      <Button :loading="isApplying" :disabled="!selectedCandidate" size="sm" @click="applySelected">
        应用
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
:global(.dialog-content.lyric-source-dialog) {
  width: min(760px, 94vw);
  max-height: min(640px, calc(100vh - 96px));
}

.source-dialog {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: min(480px, calc(100vh - 250px));
  min-height: 360px;
}

.source-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 32px;
  align-items: center;
  gap: 16px;
  width: 100%;
  min-width: 0;
}

.track-text {
  display: block;
  min-width: 0;
  flex: 1;
}

.refresh-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  justify-self: end;
  width: 32px;
  height: 32px;
  border-radius: 8px;
}

.track-title,
.candidate-title,
.preview-title {
  display: block;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 700;
}

.track-title {
  width: 100%;
}

.candidate-artist,
.preview-subtitle {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.source-layout {
  display: grid;
  grid-template-columns: minmax(250px, 0.86fr) minmax(320px, 1.14fr);
  gap: 14px;
  min-height: 0;
  flex: 1;
}

.candidate-list,
.preview-pane {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--color-bg-elevated);
}

.candidate-list {
  display: flex;
  flex-direction: column;
  padding: 8px;
  gap: 8px;
}

.candidate-item {
  position: relative;
  box-sizing: border-box;
  display: block;
  width: 100%;
  padding: 11px 12px;
  border-radius: 8px;
  border: 1px solid var(--control-border);
  background: var(--control-bg);
  color: var(--color-text-main);
  text-align: left;
  transition:
    background-color 0.16s ease,
    border-color 0.16s ease,
    box-shadow 0.16s ease;
}

.candidate-content {
  display: flex;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  flex-direction: column;
  gap: 8px;
}

.candidate-item:hover,
.candidate-item.active {
  background: color-mix(in srgb, var(--color-primary) 7%, var(--color-bg-elevated));
  border-color: color-mix(in srgb, var(--color-primary) 22%, var(--control-border));
}

.candidate-item.recommended {
  background: color-mix(in srgb, var(--color-primary) 6%, var(--color-bg-elevated));
  border-color: color-mix(in srgb, var(--color-primary) 16%, var(--control-border));
}

.candidate-item.recommended.active {
  background: color-mix(in srgb, var(--color-primary) 10%, var(--color-bg-elevated));
  border-color: color-mix(in srgb, var(--color-primary) 36%, var(--control-border));
}

.candidate-main,
.candidate-meta,
.candidate-tags,
.preview-badges {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.candidate-main {
  display: block;
  min-width: 0;
  padding-right: 24px;
}

.candidate-meta,
.candidate-tags {
  flex-wrap: nowrap;
}

.candidate-meta {
  justify-content: space-between;
}

.candidate-tags {
  overflow: hidden;
}

.candidate-tags span,
.status-pill,
.preview-badges span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 21px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: var(--control-muted-bg);
  color: var(--color-text-secondary);
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  flex: 0 0 auto;
}

.current-check {
  position: absolute;
  top: 10px;
  right: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--color-primary);
  color: white;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--color-primary) 28%, transparent);
}

.status-pill.recommended-pill {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 11%, transparent);
  border-color: color-mix(in srgb, var(--color-primary) 18%, transparent);
  font-weight: 800;
}

.star-rating {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  margin-left: auto;
  color: color-mix(in srgb, var(--color-text-secondary) 48%, transparent);
  font-size: 12px;
  line-height: 1;
}

.star-rating .star {
  position: relative;
  display: inline-block;
}

.star-rating .filled {
  color: var(--color-primary);
}

.star-rating .half::before {
  content: '★';
  position: absolute;
  left: 0;
  top: 0;
  width: 50%;
  overflow: hidden;
  color: var(--color-primary);
}

.candidate-tags .official {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 9%, transparent);
  border-color: color-mix(in srgb, var(--color-primary) 16%, transparent);
}

.candidate-tags .translation,
.candidate-tags .roman,
.candidate-tags .yrc,
.candidate-tags .unscrollable {
  color: var(--color-text-main);
  background: color-mix(in srgb, var(--color-text-main) 7%, transparent);
}

.candidate-tags .warn {
  color: var(--state-warning);
  background: color-mix(in srgb, var(--state-warning) 10%, transparent);
  border-color: color-mix(in srgb, var(--state-warning) 18%, transparent);
}

.preview-pane {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.preview-content {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
}

.preview-switch-enter-active,
.preview-switch-leave-active {
  transition: opacity 0.16s ease;
}

.preview-switch-enter-from,
.preview-switch-leave-to {
  opacity: 0;
}

.preview-switch-enter-to,
.preview-switch-leave-from {
  opacity: 1;
}

.preview-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border-bottom: 1px solid var(--border-subtle);
}

.preview-title-group {
  min-width: 0;
  flex: 1 1 auto;
}

.preview-warning {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  color: #c47a08;
  background: rgba(245, 158, 11, 0.12);
  font-size: 12px;
}

.preview-lines {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  overflow: auto;
}

.preview-line {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 6px 8px;
  border-radius: 8px;
  line-height: 1.45;
  text-align: center;
  color: var(--color-text-secondary);
  transition: all 0.16s ease;
}

.preview-line.active {
  color: var(--color-text-main);
  background: rgba(20, 184, 166, 0.1);
}

.preview-line.active span {
  font-weight: 800;
}

.preview-line small {
  color: var(--color-text-secondary);
}

.empty-state {
  display: flex;
  min-height: 120px;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
}

@media (max-width: 720px) {
  .source-layout {
    grid-template-columns: 1fr;
  }

  .source-dialog {
    height: min(620px, calc(100vh - 180px));
  }
}
</style>
