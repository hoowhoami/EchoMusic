<script setup lang="ts">
import { vTooltip } from '@/components/ui/tooltip';
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useVModel } from '@vueuse/core';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import SelectionBadge from '@/components/ui/SelectionBadge.vue';
import {
  useLyricStore,
  getLyricCandidateKey,
  type LyricLine,
  type ParsedLyricPreview,
  type LyricSearchCandidate,
} from '@/stores/lyric';
import { usePlayerStore } from '@/stores/player';
import { useToastStore } from '@/stores/toast';
import Skeleton from '@/components/ui/Skeleton.vue';
import { iconSearch, iconSparkles, iconTriangleAlert } from '@/icons';
import { resolveMaskedMetadata } from '../../../shared/embeddedMetadata';

const props = defineProps<{
  open: boolean;
  hash: string;
  duration?: number;
  title?: string;
  artist?: string;
  albumAudioId?: string | number;
  embeddedTitle?: string;
  embeddedArtist?: string;
  embeddedLyric?: string;
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const open = useVModel(props, 'open', emit);
const lyricStore = useLyricStore();
const playerStore = usePlayerStore();
const toastStore = useToastStore();

const fieldId = useId();
const searchTitle = ref('');
const searchArtist = ref('');
const searchError = ref('');
let updatingSearchDefaults = false;
let hasUserInteraction = false;
watch(
  [searchTitle, searchArtist],
  () => {
    if (!updatingSearchDefaults) hasUserInteraction = true;
  },
  { flush: 'sync' },
);
const canSearch = computed(() => Boolean(searchTitle.value.trim() || searchArtist.value.trim()));
type SourceCandidate = LyricSearchCandidate & { embeddedContent?: string };
const candidateKey = (candidate: SourceCandidate) =>
  candidate.embeddedContent !== undefined ? 'embedded' : getLyricCandidateKey(candidate);
const embeddedPreview = computed(() =>
  open.value && props.embeddedLyric ? lyricStore.previewEmbeddedLyric(props.embeddedLyric) : null,
);
const embeddedCandidate = computed<SourceCandidate | null>(() =>
  open.value && props.embeddedLyric?.trim()
    ? {
        embeddedContent: props.embeddedLyric,
        song: props.embeddedTitle || props.title,
        singer: props.embeddedArtist || props.artist,
        product_from: '内嵌歌词',
        duration: durationMs.value,
      }
    : null,
);
const candidates = ref<SourceCandidate[]>([]);
const autoCandidateKey = ref('');
let loadSerial = 0;
const selectedKey = ref('');
let hasManualCandidateSelection = false;
const selectCandidate = (candidate: SourceCandidate) => {
  hasUserInteraction = true;
  hasManualCandidateSelection = true;
  selectedKey.value = candidateKey(candidate);
};
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
const selectedCandidate = computed(
  () => candidates.value.find((candidate) => candidateKey(candidate) === selectedKey.value) ?? null,
);
const currentCandidateKey = computed(() => lyricStore.currentCandidateKey);
const manualCandidateKey = computed(() => {
  if (lyricStore.embeddedLyricSelectionMap?.[normalizedHash.value]) return 'embedded';
  const candidate = normalizedHash.value ? lyricStore.manualLyricMap[normalizedHash.value] : null;
  return candidate ? candidateKey(candidate) : '';
});
const canRestoreAuto = computed(() => Boolean(manualCandidateKey.value));

const durationDiffLabel = (candidate: SourceCandidate) => {
  if (!candidate.duration || !durationMs.value) return '';
  const diff = Math.round((candidate.duration - durationMs.value) / 1000);
  if (diff === 0) return '';
  return `${diff > 0 ? '+' : ''}${diff}s`;
};

const hasLargeDurationDiff = (candidate: SourceCandidate) => {
  if (!candidate.duration || !durationMs.value) return false;
  return Math.abs(candidate.duration - durationMs.value) > 5000;
};

const isScrollableCandidate = (candidate: SourceCandidate) =>
  candidate.embeddedContent !== undefined
    ? Boolean(embeddedPreview.value?.lines.length)
    : candidate.contenttype !== 2;
const candidatePreview = (candidate: SourceCandidate): ParsedLyricPreview | null =>
  candidate.embeddedContent !== undefined
    ? embeddedPreview.value
    : (lyricStore.candidatePreviewMap[candidateKey(candidate)] ?? null);

const recommendationLevel = (candidate: SourceCandidate) => {
  // 星级由接口返回的 score（0-100）映射为 0-5 星，按 0.5 粒度（支持半星）
  const score = Number(candidate.score ?? 0);
  if (!Number.isFinite(score) || score <= 0) return 0;
  const stars = Math.round((score / 20) * 2) / 2;
  return Math.min(5, Math.max(0, stars));
};

// 单颗星的状态：实心 / 半星 / 空
const starClass = (candidate: SourceCandidate, index: number) => {
  const rating = recommendationLevel(candidate);
  if (index <= Math.floor(rating)) return 'filled';
  if (index === Math.ceil(rating) && rating % 1 !== 0) return 'half';
  return '';
};

const typeLabels = (candidate: SourceCandidate) => {
  if (candidate.embeddedContent !== undefined)
    return ['内嵌歌词', isScrollableCandidate(candidate) ? '带时间轴' : '纯文本'];
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

const sourceLabel = (candidate: SourceCandidate) => {
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
  const matchKey = (key: string) => {
    if (!key) return '';
    const exact = candidates.value.find((candidate) => candidateKey(candidate) === key);
    if (exact) return candidateKey(exact);
    // Online access keys can change between playback and candidate-list queries.
    // The lyric id identifies the version; keep credentials in detail/cache keys.
    const online = candidates.value.find(
      (candidate) =>
        candidate.embeddedContent === undefined &&
        candidate.id != null &&
        String(candidate.id) !== '' &&
        key.startsWith(`${candidate.id}:`),
    );
    return online ? candidateKey(online) : '';
  };
  for (const key of [
    hasManualCandidateSelection ? selectedKey.value : '',
    currentCandidateKey.value,
    manualCandidateKey.value,
    autoCandidateKey.value,
  ]) {
    const matched = matchKey(key);
    if (matched) {
      selectedKey.value = matched;
      return;
    }
  }
  const fallback =
    candidates.value.find((candidate) => candidate.embeddedContent === undefined) ??
    (!isLoading.value ? embeddedCandidate.value : null);
  selectedKey.value = fallback ? candidateKey(fallback) : '';
};

const loadCandidates = async (mode: 'auto' | 'keywords' = 'auto', force = false) => {
  const hash = normalizedHash.value;
  if (!hash || (mode === 'keywords' && !canSearch.value)) return;
  if (mode === 'keywords') {
    hasUserInteraction = true;
    searchTitle.value = resolveMaskedMetadata(searchTitle.value, props.embeddedTitle) ?? '';
    searchArtist.value = resolveMaskedMetadata(searchArtist.value, props.embeddedArtist) ?? '';
  }
  const serial = ++loadSerial;
  hasManualCandidateSelection = false;
  isLoading.value = true;
  searchError.value = '';
  candidates.value = embeddedCandidate.value ? [embeddedCandidate.value] : [];
  autoCandidateKey.value = '';
  pickInitialCandidate();
  void loadPreview();
  try {
    const result =
      mode === 'keywords'
        ? await lyricStore.searchLyricCandidates({
            title: searchTitle.value,
            artist: searchArtist.value,
            duration: durationMs.value || undefined,
          })
        : await lyricStore.fetchLyricCandidates(hash, {
            title: props.title,
            artist: props.artist,
            duration: durationMs.value || undefined,
            albumAudioId: props.albumAudioId || undefined,
            ...(props.embeddedTitle ? { embeddedTitle: props.embeddedTitle } : {}),
            ...(props.embeddedArtist ? { embeddedArtist: props.embeddedArtist } : {}),
            force,
          });
    if (serial !== loadSerial) return;
    isLoading.value = false;
    const remembered = lyricStore.manualLyricMap[hash];
    candidates.value =
      mode === 'auto' &&
      remembered &&
      !result.some((candidate) => String(candidate.id) === String(remembered.id))
        ? [remembered, ...result]
        : [...result];
    if (embeddedCandidate.value) candidates.value.unshift(embeddedCandidate.value);
    autoCandidateKey.value = mode === 'auto' ? lyricStore.autoCandidateKey : '';
    pickInitialCandidate();
  } catch {
    if (serial === loadSerial) {
      isLoading.value = false;
      searchError.value = '在线歌词搜索失败，请重试';
      pickInitialCandidate();
    }
  } finally {
    if (serial === loadSerial) isLoading.value = false;
  }
};

const resetSearch = (force = true) => {
  hasUserInteraction = false;
  updatingSearchDefaults = true;
  searchTitle.value = resolveMaskedMetadata(props.title, props.embeddedTitle) ?? '';
  searchArtist.value = resolveMaskedMetadata(props.artist, props.embeddedArtist) ?? '';
  updatingSearchDefaults = false;
  void loadCandidates('auto', force);
};

const loadPreview = async () => {
  const candidate = selectedCandidate.value;
  const serial = ++previewSerial.value;
  previewLoading.value = false;
  previewLines.value = [];
  previewStaticLines.value = [];
  previewState.value = {
    hasTranslation: false,
    hasRomanization: false,
    lineCount: 0,
    isScrollable: false,
  };
  if (!candidate) return;

  previewLoading.value = true;
  try {
    const preview =
      candidate.embeddedContent !== undefined
        ? embeddedPreview.value
        : await lyricStore.previewCandidate(candidate);
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
  const serial = loadSerial;
  isApplying.value = true;
  try {
    const ok =
      candidate.embeddedContent !== undefined
        ? lyricStore.applyEmbeddedLyric(normalizedHash.value, candidate.embeddedContent)
        : await lyricStore.applyCandidate(normalizedHash.value, candidate, { remember: true });
    if (serial !== loadSerial) return;
    if (!ok) {
      toastStore.actionFailed('切换歌词');
      return;
    }
    toastStore.success('歌词版本已应用');
    open.value = false;
  } catch {
    if (serial === loadSerial) toastStore.actionFailed('切换歌词');
  } finally {
    if (serial === loadSerial) isApplying.value = false;
  }
};

const restoreAuto = async () => {
  if (!normalizedHash.value) return;
  const serial = loadSerial;
  isApplying.value = true;
  try {
    const track = playerStore.currentTrackSnapshot;
    await lyricStore.restoreAutoLyric(normalizedHash.value, {
      ...(track && String(track.hash || track.id) === normalizedHash.value ? { track } : {}),
      title: props.title,
      artist: props.artist,
      duration: durationMs.value || undefined,
      albumAudioId: props.albumAudioId || undefined,
      ...(props.embeddedTitle ? { embeddedTitle: props.embeddedTitle } : {}),
      ...(props.embeddedArtist ? { embeddedArtist: props.embeddedArtist } : {}),
    });
    if (serial !== loadSerial) return;
    toastStore.success('已改为智能推荐');
    open.value = false;
  } catch {
    if (serial === loadSerial) toastStore.actionFailed('改为智能推荐');
  } finally {
    if (serial === loadSerial) isApplying.value = false;
  }
};

watch(
  [() => open.value, normalizedHash],
  ([isOpen, hash]) => {
    ++loadSerial;
    hasManualCandidateSelection = false;
    candidates.value = [];
    selectedKey.value = '';
    void loadPreview();
    isLoading.value = false;
    isApplying.value = false;
    if (isOpen && hash) resetSearch(false);
    if (!isOpen) {
      // Drop the computed caches as well as visible preview state when the panel closes.
      void embeddedPreview.value;
      void embeddedCandidate.value;
    }
  },
  { immediate: true },
);

watch(
  [
    () => open.value,
    normalizedHash,
    () => props.title,
    () => props.artist,
    () => props.embeddedTitle,
    () => props.embeddedArtist,
    () => props.embeddedLyric,
  ],
  ([isOpen, hash, ...metadata], [wasOpen, previousHash, ...previousMetadata]) => {
    if (!isOpen || !wasOpen || hash !== previousHash) return;
    // Reader enrichment belongs to this song, not to the user's search session.
    const online = candidates.value.filter((candidate) => candidate.embeddedContent === undefined);
    candidates.value = embeddedCandidate.value ? [embeddedCandidate.value, ...online] : online;
    if (!selectedCandidate.value) pickInitialCandidate();
    const namesChanged = metadata
      .slice(0, 4)
      .some((value, index) => value !== previousMetadata[index]);
    if (namesChanged && !hasUserInteraction && !isApplying.value) resetSearch(false);
  },
);

onBeforeUnmount(() => {
  ++loadSerial;
  ++previewSerial.value;
});

watch([currentCandidateKey, manualCandidateKey], () => {
  if (open.value && !hasManualCandidateSelection) pickInitialCandidate();
});

watch(selectedCandidate, () => {
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
    <div class="source-dialog" :aria-busy="isLoading">
      <form class="source-search" @submit.prevent="loadCandidates('keywords')">
        <div class="search-field">
          <label :for="`${fieldId}-title`">歌名</label>
          <Input
            :id="`${fieldId}-title`"
            v-model="searchTitle"
            placeholder="输入歌名"
            :disabled="isApplying"
          />
        </div>
        <div class="search-field">
          <label :for="`${fieldId}-artist`">歌手</label>
          <Input
            :id="`${fieldId}-artist`"
            v-model="searchArtist"
            placeholder="输入歌手"
            :disabled="isApplying"
          />
        </div>
        <div class="search-actions">
          <Button type="submit" :loading="isLoading" :disabled="!canSearch || isApplying">
            搜索
          </Button>
        </div>
      </form>

      <p v-if="searchError && candidates.length" class="source-query-error" role="status">
        {{ searchError }}
      </p>
      <div
        v-if="isLoading && candidates.length === 0"
        class="source-loading"
        role="status"
        aria-label="正在搜索歌词"
      >
        <div v-for="item in 2" :key="item" class="source-loading-row">
          <Skeleton variant="text" width="48%" height="14px" />
          <Skeleton variant="text" width="28%" height="11px" />
        </div>
      </div>
      <div v-else-if="candidates.length === 0" class="source-empty" role="status">
        <Icon :icon="searchError ? iconTriangleAlert : iconSearch" width="28" height="28" />
        <strong>{{ searchError ? '歌词搜索失败' : '没有找到匹配的歌词' }}</strong>
        <p>{{ searchError || '试试修改歌名或歌手后重新搜索' }}</p>
      </div>
      <div v-else class="source-layout">
        <section class="candidate-section" aria-label="歌词版本">
          <div class="source-section-head">
            <h4>歌词版本</h4>
            <span>{{ candidates.length }} 个{{ isLoading ? ' · 搜索中' : '' }}</span>
          </div>
          <div class="candidate-list">
            <button
              v-for="candidate in candidates"
              :key="candidateKey(candidate)"
              class="candidate-item"
              :aria-pressed="selectedKey === candidateKey(candidate)"
              :class="{
                active: selectedKey === candidateKey(candidate),
                recommended: autoCandidateKey === candidateKey(candidate),
              }"
              @click="selectCandidate(candidate)"
            >
              <div class="candidate-content">
                <div class="candidate-main">
                  <span class="candidate-title">
                    {{ candidate.song || title || '未知歌曲' }}
                    <template v-if="candidate.singer || artist">
                      - {{ candidate.singer || artist }}
                    </template>
                  </span>
                </div>
                <div class="candidate-meta">
                  <span
                    v-if="autoCandidateKey === candidateKey(candidate)"
                    class="status-pill recommended-pill"
                  >
                    <Icon :icon="iconSparkles" width="12" height="12" />
                    智能推荐
                  </span>
                  <span
                    v-if="candidate.embeddedContent === undefined"
                    v-tooltip="`推荐 ${recommendationLevel(candidate)} 星`"
                    class="star-rating"
                  >
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
              <SelectionBadge
                v-if="selectedKey === candidateKey(candidate)"
                class="current-check"
              />
            </button>
          </div>
        </section>

        <section class="preview-section" aria-label="歌词预览">
          <div class="source-section-head"><h4>歌词预览</h4></div>
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
                        · {{ selectedCandidate.nickname }}
                      </template>
                    </div>
                  </div>
                  <div class="preview-badges">
                    <small class="preview-line-count">{{ previewState.lineCount }} 行</small>
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
        </section>
      </div>
    </div>

    <template #footer>
      <div class="source-footer">
        <div class="source-footer-actions">
          <Button
            type="button"
            variant="secondary"
            :disabled="isLoading || isApplying"
            @click="resetSearch()"
          >
            重新匹配
          </Button>
          <Button
            v-if="canRestoreAuto"
            variant="secondary"
            :disabled="isApplying"
            @click="restoreAuto"
          >
            恢复智能推荐
          </Button>
          <Button v-if="selectedCandidate" :loading="isApplying" @click="applySelected">
            应用
          </Button>
        </div>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
:global(.dialog-content.lyric-source-dialog) {
  width: min(800px, 92vw);
  max-height: calc(100vh - 64px);
}

.source-dialog {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-height: 0;
}

.source-search {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr) auto;
  align-items: end;
  gap: 12px;
  min-width: 0;
}

.source-query-error {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.search-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.search-field label {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.search-actions {
  display: flex;
  gap: 4px;
}

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
  grid-template-columns: minmax(240px, 0.9fr) minmax(300px, 1.1fr);
  gap: 20px;
  height: min(320px, calc(100vh - 350px));
  min-height: 0;
}

.candidate-section,
.preview-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
}

.source-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 18px;
}

.source-section-head h4 {
  font-weight: 600;
}

.candidate-list,
.preview-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

.preview-pane {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  background: var(--color-bg-elevated);
}

.source-empty {
  display: flex;
  min-height: 144px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px 16px;
  text-align: center;
  color: var(--color-text-secondary);
}

.source-empty > svg {
  margin-bottom: 4px;
}

.source-empty strong {
  color: var(--color-text-main);
  font-size: 14px;
  font-weight: 600;
}

.source-loading {
  display: flex;
  min-height: 144px;
  flex-direction: column;
  gap: 16px;
  padding: 8px 0;
}

.source-loading-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
}

.source-footer {
  display: flex;
  flex-wrap: wrap;
  width: 100%;
  align-items: center;
  gap: 12px;
}

.source-footer-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-left: auto;
}

.candidate-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 4px;
}

.candidate-item {
  position: relative;
  flex-shrink: 0;
  box-sizing: border-box;
  display: block;
  width: 100%;
  padding: 11px 12px;
  border-radius: var(--radius-item);
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

.current-check {
  position: absolute;
  top: 10px;
  right: 10px;
}

.star-rating {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  margin-left: auto;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1;
}

.star-rating .star {
  position: relative;
  display: inline-block;
}

.star-rating .filled {
  color: var(--color-primary-text);
}

.star-rating .half::before {
  content: '★';
  position: absolute;
  left: 0;
  top: 0;
  width: 50%;
  overflow: hidden;
  color: var(--color-primary-text);
}

.candidate-tags .official {
  color: var(--color-primary-text);
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

.preview-line-count {
  color: var(--color-text-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
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
  border-radius: var(--radius-card);
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

@media (max-width: 680px) {
  .source-layout {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 0.8fr) minmax(0, 1fr);
    gap: 16px;
  }
}

@media (max-width: 680px) and (max-height: 600px) {
  .source-layout {
    grid-template-rows: 160px 220px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
}

@media (max-width: 480px) {
  .source-search {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px;
  }

  .search-actions {
    grid-column: 1 / -1;
    justify-content: end;
  }
}
</style>
