<script setup lang="ts">
defineOptions({ name: 'recognize-page' });

import { ref, computed, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import Cover from '@/components/ui/Cover.vue';
import Dialog from '@/components/ui/Dialog.vue';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import {
  iconMicrophone,
  iconDeviceSpeaker,
  iconPlay,
  iconHeart,
  iconHeartFilled,
  iconX,
  iconSearch,
  iconInfo,
  iconPlaylistAdd,
} from '@/icons';
import { search } from '@/api/search';
import { mapSearchSong } from '@/utils/mappers';
import { usePlaylistStore } from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';
import { useUserStore } from '@/stores/user';
import { queueAndPlaySong } from '@/utils/playback';
import { isSameSong } from '@/utils/song';
import type { Song } from '@/models/song';
import type { RecognizeStatus, ShazamResult } from '../../shared/shazam';

type AudioSource = 'mic' | 'system';

const router = useRouter();
const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const userStore = useUserStore();

const showPlaylistDialog = ref(false);
const isPlaylistLoading = ref(false);

const audioSource = ref<AudioSource>('mic');
const status = ref<RecognizeStatus>('idle');
const shazamResult = ref<ShazamResult | null>(null);
const matchedSong = ref<Song | null>(null);
const errorMsg = ref('');
const recordingSeconds = ref(0);

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let recordingTimer: ReturnType<typeof setInterval> | null = null;

const isActive = computed(() => status.value === 'recording' || status.value === 'recognizing');

const isFavorite = computed(() => {
  if (!matchedSong.value) return false;
  return playlistStore.favorites.some((item) => isSameSong(item, matchedSong.value!));
});

const sourceIcon = computed(() =>
  audioSource.value === 'mic' ? iconMicrophone : iconDeviceSpeaker,
);
const sourceLabel = computed(() => (audioSource.value === 'mic' ? '麦克风' : '系统音频'));

const displayTitle = computed(() => matchedSong.value?.title || shazamResult.value?.title || '');
const displayArtist = computed(() => matchedSong.value?.artist || shazamResult.value?.artist || '');
const displayAlbum = computed(() => matchedSong.value?.album || shazamResult.value?.album || '');
const displayCover = computed(
  () => matchedSong.value?.coverUrl || shazamResult.value?.coverUrl || '',
);

function audioBufferToPCM(audioBuffer: AudioBuffer): ArrayBuffer {
  const targetSampleRate = 16000;
  const sourceData = audioBuffer.getChannelData(0);
  const ratio = audioBuffer.sampleRate / targetSampleRate;
  const targetLength = Math.floor(sourceData.length / ratio);
  const pcmData = new Int16Array(targetLength);
  for (let i = 0; i < targetLength; i++) {
    const sample = Math.max(-1, Math.min(1, sourceData[Math.floor(i * ratio)]));
    pcmData[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcmData.buffer;
}

async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } finally {
    await ctx.close();
  }
}

async function recognizeAudio(stream: MediaStream) {
  audioChunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    if (audioChunks.length === 0) {
      status.value = 'failed';
      errorMsg.value = '未录制到音频';
      return;
    }
    status.value = 'recognizing';
    try {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const pcmData = audioBufferToPCM(await decodeAudioBlob(blob));
      const res = await window.electron.shazam.recognize(pcmData);
      if (res.success && res.result) {
        shazamResult.value = res.result;
        matchedSong.value = null;
        try {
          const kw = `${res.result.artist} ${res.result.title}`.trim();
          const sr = await search(kw, 'song', 1, 1);
          const lists = (sr as any)?.data?.lists ?? (sr as any)?.data?.list ?? [];
          if (Array.isArray(lists) && lists.length > 0) matchedSong.value = mapSearchSong(lists[0]);
        } catch {
          /* 搜索失败不影响展示 */
        }
        status.value = 'success';
      } else {
        status.value = 'failed';
        errorMsg.value = res.error || '未识别到歌曲';
      }
    } catch (err) {
      status.value = 'failed';
      errorMsg.value = '识别过程出错';
      console.error('[Recognize]', err);
    }
  };
  mediaRecorder.start(500);
  recordingTimer = setInterval(() => {
    recordingSeconds.value++;
    if (recordingSeconds.value >= 8) stopRecording();
  }, 1000);
}

async function getMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: 44100,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
}

async function getSystemAudioStream(): Promise<MediaStream> {
  await window.electron.shazam.enableLoopback();
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => {
      t.stop();
      stream.removeTrack(t);
    });
    if (stream.getAudioTracks().length === 0) throw new Error('未获取到系统音频轨道');
    return stream;
  } finally {
    await window.electron.shazam.disableLoopback();
  }
}

async function startRecording() {
  if (isActive.value) return;
  status.value = 'recording';
  shazamResult.value = null;
  matchedSong.value = null;
  errorMsg.value = '';
  recordingSeconds.value = 0;
  try {
    const stream =
      audioSource.value === 'mic' ? await getMicStream() : await getSystemAudioStream();
    await recognizeAudio(stream);
  } catch (err) {
    status.value = 'failed';
    errorMsg.value =
      audioSource.value === 'mic'
        ? '无法访问麦克风，请检查权限设置'
        : err instanceof Error
          ? err.message
          : '系统音频捕获失败';
  }
}

function stopRecording() {
  if (recordingTimer) {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

function resetAndRestart() {
  stopRecording();
  status.value = 'idle';
  shazamResult.value = null;
  matchedSong.value = null;
  errorMsg.value = '';
  recordingSeconds.value = 0;
}

function handleMainButton() {
  if (status.value === 'recording') stopRecording();
  else if (status.value !== 'recognizing') startRecording();
}

function toggleSource() {
  if (isActive.value) return;
  audioSource.value = audioSource.value === 'mic' ? 'system' : 'mic';
}

async function handlePlay() {
  if (matchedSong.value) await queueAndPlaySong(playlistStore, playerStore, matchedSong.value);
}

function handleFavorite() {
  if (!matchedSong.value) return;
  if (isFavorite.value) void playlistStore.removeFavoriteSong(matchedSong.value);
  else void playlistStore.addToFavorites(matchedSong.value);
}

function goToSearch() {
  if (!shazamResult.value) return;
  router.push({
    name: 'search',
    query: { q: `${shazamResult.value.artist} ${shazamResult.value.title}`.trim() },
  });
}

function goToDetail() {
  if (!matchedSong.value) return;
  const song = matchedSong.value;
  const commentId = song.mixSongId || song.id;
  router.push({
    name: 'comment',
    params: { id: String(commentId) },
    query: {
      mainTab: 'detail',
      type: 'music',
      title: song.title,
      artist: song.artist,
      artistId: song.artists?.[0]?.id ?? '',
      album: song.album ?? '',
      cover: song.coverUrl ?? '',
      albumId: song.albumId ?? '',
      hash: song.hash ?? '',
      mixSongId: song.mixSongId ?? song.id,
    },
  });
}

const selectablePlaylists = computed(() =>
  playlistStore.getCreatedPlaylists(userStore.info?.userid),
);

async function handleAddToPlaylist() {
  showPlaylistDialog.value = true;
  if (playlistStore.userPlaylists.length === 0) {
    isPlaylistLoading.value = true;
    await playlistStore.fetchUserPlaylists();
    isPlaylistLoading.value = false;
  }
}

async function handleSelectPlaylist(listId: string | number) {
  if (!matchedSong.value) return;
  await playlistStore.addToPlaylist(String(listId), matchedSong.value);
  showPlaylistDialog.value = false;
}

onUnmounted(() => stopRecording());
</script>

<template>
  <PageScrollContainer class="recognize-page-container">
    <div class="rec-page">
      <!-- 页面标题 -->
      <h1 class="rec-page-title">听歌识曲</h1>

      <Transition name="rec-fade" mode="out-in">
        <!-- 识别成功 -->
        <div v-if="status === 'success'" key="result" class="rec-result">
          <div class="rec-result-card">
            <!-- 封面 -->
            <div class="rec-cover-area">
              <Cover
                v-if="displayCover"
                :url="displayCover"
                :size="400"
                :borderRadius="16"
                class="rec-cover"
              />
              <div v-else class="rec-cover rec-cover-empty">
                <Icon :icon="iconMicrophone" width="48" height="48" class="opacity-20" />
              </div>
            </div>

            <!-- 信息区 -->
            <div class="rec-detail">
              <p class="rec-label">识别结果</p>
              <h2 class="rec-song-title">{{ displayTitle }}</h2>
              <p class="rec-song-artist">{{ displayArtist }}</p>
              <p v-if="displayAlbum" class="rec-song-album">{{ displayAlbum }}</p>

              <!-- 第一排：播放、收藏、添加到歌单 -->
              <div class="rec-action-row">
                <Button
                  v-if="matchedSong"
                  variant="unstyled"
                  size="none"
                  class="rec-circle-btn rec-circle-primary"
                  title="播放"
                  @click="handlePlay"
                >
                  <Icon :icon="iconPlay" width="20" height="20" />
                </Button>
                <Button
                  v-if="matchedSong"
                  variant="unstyled"
                  size="none"
                  :class="[
                    'rec-circle-btn',
                    isFavorite ? 'rec-circle-fav-active' : 'rec-circle-fav',
                  ]"
                  :title="isFavorite ? '已收藏' : '收藏'"
                  @click="handleFavorite"
                >
                  <Icon :icon="isFavorite ? iconHeartFilled : iconHeart" width="20" height="20" />
                </Button>
                <Button
                  v-if="matchedSong"
                  variant="unstyled"
                  size="none"
                  class="rec-circle-btn rec-circle-ghost"
                  title="添加到歌单"
                  @click="handleAddToPlaylist"
                >
                  <Icon :icon="iconPlaylistAdd" width="19" height="19" />
                </Button>
              </div>
              <!-- 第二排：详情、搜索 -->
              <div class="rec-action-row rec-action-row-secondary">
                <Button
                  v-if="matchedSong"
                  variant="unstyled"
                  size="none"
                  class="rec-text-btn"
                  @click="goToDetail"
                >
                  <Icon :icon="iconInfo" width="14" height="14" />
                  歌曲详情
                </Button>
                <Button variant="unstyled" size="none" class="rec-text-btn" @click="goToSearch">
                  <Icon :icon="iconSearch" width="14" height="14" />
                  去搜索
                </Button>
              </div>
            </div>
          </div>
          <div class="rec-retry-center">
            <Button variant="unstyled" size="none" class="rec-retry-btn" @click="resetAndRestart">
              <Icon :icon="iconMicrophone" width="15" height="15" />
              重新识别
            </Button>
          </div>
        </div>

        <!-- 录音 / 空闲 / 失败 -->
        <div v-else key="capture" class="rec-capture">
          <p class="rec-desc">
            {{
              status === 'recording'
                ? `正在聆听... ${recordingSeconds}s`
                : status === 'recognizing'
                  ? '识别中，请稍候...'
                  : status === 'failed'
                    ? errorMsg
                    : '让我听听周围在放什么歌'
            }}
          </p>

          <!-- 主按钮 -->
          <div class="rec-orb-wrap">
            <!-- 呼吸光圈（仅录音时） -->
            <div v-if="status === 'recording'" class="rec-orb-bg" />
            <!-- 雷达扩散波纹（仅录音时） -->
            <template v-if="status === 'recording'">
              <div class="rec-ripple rec-ripple-1" />
              <div class="rec-ripple rec-ripple-2" />
              <div class="rec-ripple rec-ripple-3" />
            </template>
            <button
              :disabled="status === 'recognizing'"
              :class="[
                'rec-orb',
                { 'is-recording': status === 'recording', 'is-waiting': status === 'recognizing' },
              ]"
              @click="handleMainButton"
            >
              <Icon v-if="status === 'recording'" :icon="iconX" width="36" height="36" />
              <Icon
                v-else
                :icon="sourceIcon"
                width="44"
                height="44"
                :class="{ 'animate-pulse': status === 'recognizing' }"
              />
            </button>
          </div>

          <!-- 音源切换 -->
          <button class="rec-source-toggle" :disabled="isActive" @click="toggleSource">
            <Icon :icon="sourceIcon" width="14" height="14" />
            {{ sourceLabel }}
            <span class="rec-source-hint">点击切换</span>
          </button>

          <Button
            v-if="status === 'failed'"
            variant="ghost"
            size="sm"
            class="mt-4"
            @click="startRecording"
          >
            重新识别
          </Button>
        </div>
      </Transition>
    </div>

    <!-- 添加到歌单弹窗 -->
    <Dialog
      v-model:open="showPlaylistDialog"
      title="添加到歌单"
      contentClass="max-w-[420px]"
      showClose
    >
      <div class="flex flex-col gap-3">
        <div v-if="isPlaylistLoading" class="py-6 text-center text-text-secondary text-[12px]">
          加载歌单中...
        </div>
        <div
          v-else-if="selectablePlaylists.length === 0"
          class="py-6 text-center text-text-secondary text-[12px]"
        >
          暂无可用歌单
        </div>
        <Button
          v-for="entry in selectablePlaylists"
          :key="entry.listid ?? entry.id"
          type="button"
          class="rec-playlist-item"
          variant="ghost"
          size="sm"
          @click="handleSelectPlaylist(entry.listid ?? entry.id)"
        >
          <span class="text-[13px] font-semibold text-text-main truncate">{{ entry.name }}</span>
          <span class="text-[11px] text-text-secondary/60">{{ entry.count ?? 0 }} 首</span>
        </Button>
      </div>
    </Dialog>
  </PageScrollContainer>
</template>

<style scoped>
@reference "@/style.css";

.rec-page {
  min-height: calc(100vh - 140px);
  display: flex;
  flex-direction: column;
  padding: 24px 32px 40px;
}

.rec-page-title {
  font-size: 22px;
  font-weight: 800;
  color: var(--color-text-main);
  letter-spacing: -0.3px;
  margin-bottom: 0;
  flex-shrink: 0;
}

/* 过渡动画 */
.rec-fade-enter-active,
.rec-fade-leave-active {
  transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}
.rec-fade-enter-from {
  opacity: 0;
  transform: translateY(16px);
}
.rec-fade-leave-to {
  opacity: 0;
  transform: translateY(-12px);
}

/* === 录音状态 === */
.rec-capture {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  flex: 1;
  justify-content: center;
}

.rec-desc {
  @apply text-sm text-text-secondary mt-2 mb-10;
  max-width: 280px;
}

/* 主按钮 + 光圈 */
.rec-orb-wrap {
  position: relative;
  width: 140px;
  height: 140px;
  margin-bottom: 24px;
}

.rec-orb-bg {
  position: absolute;
  inset: -28px;
  border-radius: 9999px;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--color-primary) 22%, transparent) 0%,
    transparent 70%
  );
  animation: rec-breathe 1.6s ease-in-out infinite;
}

@keyframes rec-breathe {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.7;
  }
  50% {
    transform: scale(1.25);
    opacity: 1;
  }
}

/* 雷达扩散波纹 */
.rec-ripple {
  position: absolute;
  inset: 0;
  border-radius: 9999px;
  border: 2px solid var(--color-primary);
  opacity: 0;
  animation: rec-radar 2.4s cubic-bezier(0, 0.4, 0.6, 1) infinite;
}

.rec-ripple-2 {
  animation-delay: 0.8s;
}

.rec-ripple-3 {
  animation-delay: 1.6s;
}

@keyframes rec-radar {
  0% {
    transform: scale(1);
    opacity: 0.5;
  }
  100% {
    transform: scale(2.2);
    opacity: 0;
  }
}

.rec-orb {
  position: relative;
  z-index: 10;
  width: 140px;
  height: 140px;
  border-radius: 9999px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(
    135deg,
    var(--color-primary),
    color-mix(in srgb, var(--color-primary) 80%, #6366f1)
  );
  color: white;
  border: none;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 8px 32px color-mix(in srgb, var(--color-primary) 35%, transparent);
}

.rec-orb:hover {
  transform: scale(1.04);
}
.rec-orb:active {
  transform: scale(0.96);
}

.rec-orb.is-recording {
  background: linear-gradient(135deg, #ef4444, #f97316);
  box-shadow: 0 8px 32px rgba(239, 68, 68, 0.35);
  animation: rec-orb-pulse 1s ease-in-out infinite;
}

@keyframes rec-orb-pulse {
  0%,
  100% {
    transform: scale(1.05);
  }
  50% {
    transform: scale(1.12);
  }
}

.rec-orb.is-waiting {
  opacity: 0.6;
  cursor: wait;
}

/* 音源切换 */
.rec-source-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--color-text-main) 10%, transparent);
  cursor: pointer;
  transition: all 0.2s ease;
}

.rec-source-toggle:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.rec-source-toggle:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.rec-source-hint {
  font-size: 10px;
  opacity: 0.5;
  margin-left: 2px;
}

/* === 结果状态 === */
.rec-result {
  width: 100%;
  max-width: 560px;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  align-self: center;
}

.rec-result-card {
  display: flex;
  gap: 36px;
  align-items: stretch;
}

.rec-cover-area {
  flex-shrink: 0;
}

.rec-cover {
  width: 200px;
  height: 200px;
  border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
}

.rec-cover-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.04);
}

.dark .rec-cover-empty {
  background: rgba(255, 255, 255, 0.05);
}

.rec-detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.rec-label {
  @apply text-xs font-semibold text-primary/70 uppercase tracking-widest mb-2;
}

.rec-song-title {
  @apply text-xl font-bold text-text-main truncate leading-tight;
}

.rec-song-artist {
  @apply text-sm text-text-secondary mt-1.5 truncate;
}

.rec-song-album {
  @apply text-xs text-text-secondary/50 mt-1 truncate;
}

.rec-action-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: auto;
  padding-top: 16px;
}

.rec-circle-btn {
  width: 40px;
  height: 40px;
  border-radius: 9999px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.rec-circle-btn:hover {
  transform: scale(1.1);
}

.rec-circle-primary {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}

.rec-circle-primary:hover {
  background: color-mix(in srgb, var(--color-primary) 20%, transparent);
}

.rec-circle-fav {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
}

.rec-circle-fav:hover {
  background: rgba(239, 68, 68, 0.16);
}

.rec-circle-fav-active {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.12);
}

.rec-circle-ghost {
  color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
}

.rec-circle-ghost:hover {
  color: var(--color-text-main);
  background: color-mix(in srgb, var(--color-text-main) 12%, transparent);
}

.rec-action-row-secondary {
  margin-top: 8px;
  gap: 6px;
}

.rec-text-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-text-main) 5%, transparent);
  transition: all 0.2s ease;
  cursor: pointer;
  border: none;
}

.rec-text-btn:hover {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.rec-playlist-item {
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--color-border-light);
  background: var(--color-bg-card);
  text-align: left;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--color-text-main);
  transition:
    color 0.2s ease,
    border-color 0.2s ease;
}

.rec-playlist-item:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.rec-retry-center {
  display: flex;
  justify-content: center;
  margin-top: 32px;
}

.rec-retry-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  border: 1.5px solid color-mix(in srgb, var(--color-text-main) 15%, transparent);
  background: transparent;
  cursor: pointer;
  transition: all 0.2s ease;
}

.rec-retry-btn:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 6%, transparent);
}
</style>
