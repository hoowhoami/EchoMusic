<script setup lang="ts">
defineOptions({ name: 'recognize-page' });

import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import Cover from '@/components/ui/Cover.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Popover from '@/components/ui/Popover.vue';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';
import {
  iconMicrophone,
  iconDeviceSpeaker,
  iconPlay,
  iconHeart,
  iconHeartFilled,
  iconX,
  iconInfo,
  iconPlaylistAdd,
  iconChevronDown,
} from '@/icons';
import { recognizeAudio } from '@/api/recognize';
import { usePlaylistStore } from '@/stores/playlist';
import { usePlayerStore } from '@/stores/player';
import { useUserStore } from '@/stores/user';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import { queueAndPlaySong } from '@/utils/playback';
import { logger } from '@/utils/logger';
import type { Song } from '@/models/song';
import type { RecognizeMatch } from '@/utils/mappers';
import type { RecognizeStatus } from '../../shared/recognize';

type AudioSource = 'mic' | 'system';

const SAMPLE_RATE = 8000;
const MAX_SECONDS = 10;

const router = useRouter();
const playlistStore = usePlaylistStore();
const playerStore = usePlayerStore();
const userStore = useUserStore();
const settingStore = useSettingStore();
const toastStore = useToastStore();

const showPlaylistDialog = ref(false);
const isPlaylistLoading = ref(false);
const pendingSong = ref<Song | null>(null);

const audioSource = ref<AudioSource>('mic');
const sourceMenuOpen = ref(false);
const status = ref<RecognizeStatus>('idle');
const matches = ref<RecognizeMatch[]>([]);
const errorMsg = ref('');
const recordingSeconds = ref(0);

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let recordingTimer: ReturnType<typeof setInterval> | null = null;

const isActive = computed(() => status.value === 'recording' || status.value === 'recognizing');

// 麦克风设备列表
const micDevices = ref<{ label: string; value: string }[]>([
  { label: '系统默认', value: 'default' },
]);

async function fetchMicDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((d) => d.kind === 'audioinput');
    micDevices.value = [
      { label: '系统默认', value: 'default' },
      ...audioInputs
        .filter((d) => d.deviceId && d.deviceId !== 'default')
        .map((d) => ({
          label: d.label || `麦克风 (${d.deviceId.slice(0, 6)})`,
          value: d.deviceId,
        })),
    ];
    // 如果之前选择的设备已不存在，回退到默认
    if (!micDevices.value.some((d) => d.value === settingStore.inputDevice)) {
      settingStore.inputDevice = 'default';
    }
  } catch {
    micDevices.value = [{ label: '系统默认', value: 'default' }];
  }
}

const sourceIcon = computed(() =>
  audioSource.value === 'mic' ? iconMicrophone : iconDeviceSpeaker,
);

const currentSourceLabel = computed(() => {
  if (audioSource.value === 'system') return '系统音频';
  const matched = micDevices.value.find((d) => d.value === settingStore.inputDevice);
  return matched?.label || '麦克风';
});

function isFavorite(song: Song): boolean {
  return playlistStore.isFavoriteSong(song);
}

function distPercent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** 解码录音并重采样为 8000Hz / 16bit / 单声道 PCM */
async function decodeToPCM(blob: Blob): Promise<ArrayBuffer> {
  const offlineCtx = new OfflineAudioContext(1, SAMPLE_RATE * MAX_SECONDS, SAMPLE_RATE);
  const arrayBuffer = await blob.arrayBuffer();
  const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer);
  const float32 = audioBuffer.getChannelData(0);
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16.buffer;
}

async function recognizeStream(stream: MediaStream) {
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
      const pcm = await decodeToPCM(blob);
      const results = await recognizeAudio(pcm);
      if (results.length > 0) {
        matches.value = results;
        status.value = 'success';
      } else {
        status.value = 'failed';
        errorMsg.value = '未识别到歌曲，请靠近音源重试';
      }
    } catch (err) {
      status.value = 'failed';
      errorMsg.value = '识别过程出错';
      logger.error('Recognize', '识别过程出错', err);
    }
  };
  mediaRecorder.start(500);
  recordingTimer = setInterval(() => {
    recordingSeconds.value++;
    if (recordingSeconds.value >= MAX_SECONDS) stopRecording();
  }, 1000);
}

async function getMicStream(): Promise<MediaStream> {
  const deviceId = settingStore.inputDevice !== 'default' ? settingStore.inputDevice : undefined;
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      sampleRate: 44100,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
}

async function getSystemAudioStream(): Promise<MediaStream> {
  await window.electron.recognize.enableLoopback();
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => {
      t.stop();
      stream.removeTrack(t);
    });
    if (stream.getAudioTracks().length === 0) throw new Error('未获取到系统音频轨道');
    return stream;
  } finally {
    await window.electron.recognize.disableLoopback();
  }
}

async function startRecording() {
  if (isActive.value) return;
  status.value = 'recording';
  matches.value = [];
  errorMsg.value = '';
  recordingSeconds.value = 0;
  try {
    const stream =
      audioSource.value === 'mic' ? await getMicStream() : await getSystemAudioStream();
    await recognizeStream(stream);
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
  matches.value = [];
  errorMsg.value = '';
  recordingSeconds.value = 0;
}

function handleMainButton() {
  if (status.value === 'recording') stopRecording();
  else if (status.value !== 'recognizing') startRecording();
}

function selectMicDevice(deviceId: string) {
  if (isActive.value) return;
  audioSource.value = 'mic';
  settingStore.inputDevice = deviceId;
  sourceMenuOpen.value = false;
}

function selectSystemAudio() {
  if (isActive.value) return;
  audioSource.value = 'system';
  sourceMenuOpen.value = false;
}

async function handlePlay(song: Song) {
  await queueAndPlaySong(playlistStore, playerStore, song);
}

function handleFavorite(song: Song) {
  if (isFavorite(song)) void playlistStore.removeFavoriteSong(song);
  else void playlistStore.addToFavorites(song);
}

function goToDetail(song: Song) {
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

async function handleAddToPlaylist(song: Song) {
  pendingSong.value = song;
  showPlaylistDialog.value = true;
  if (playlistStore.userPlaylists.length === 0) {
    isPlaylistLoading.value = true;
    try {
      await playlistStore.fetchUserPlaylists();
    } catch {
      toastStore.loadFailed('歌单');
    } finally {
      isPlaylistLoading.value = false;
    }
  }
}

async function handleSelectPlaylist(listId: string | number) {
  if (!pendingSong.value) return;
  try {
    const result = await playlistStore.addToPlaylist(String(listId), pendingSong.value);
    if (result === 'added') {
      toastStore.actionCompleted('添加成功');
      showPlaylistDialog.value = false;
      return;
    }
    if (result === 'exists') {
      toastStore.warning('歌单中已有此内容');
      showPlaylistDialog.value = false;
      return;
    }
    toastStore.actionFailed('添加到歌单');
  } catch {
    toastStore.actionFailed('添加到歌单');
  }
}

onMounted(() => {
  fetchMicDevices();
  // 监听设备变化（插拔麦克风）
  navigator.mediaDevices.addEventListener('devicechange', fetchMicDevices);
});

onUnmounted(() => {
  stopRecording();
  navigator.mediaDevices.removeEventListener('devicechange', fetchMicDevices);
});
</script>

<template>
  <PageScrollContainer class="recognize-page-container">
    <div class="rec-page">
      <!-- 页面标题 -->
      <h1 class="rec-page-title">听歌识曲</h1>

      <Transition name="rec-fade" mode="out-in">
        <!-- 识别成功：候选列表 -->
        <div v-if="status === 'success'" key="result" class="rec-result">
          <p class="rec-result-label">识别结果 · 共 {{ matches.length }} 个匹配</p>
          <div class="rec-match-list">
            <div
              v-for="(match, index) in matches"
              :key="`${match.song.id}-${index}`"
              class="rec-match-item"
              @dblclick="handlePlay(match.song)"
            >
              <div
                class="rec-match-score"
                :title="`匹配度 ${distPercent(match.confidence)}`"
                :style="{ '--score': match.confidence }"
              >
                <span class="rec-match-score-num">{{ distPercent(match.confidence) }}</span>
                <span class="rec-match-score-label">匹配度</span>
              </div>

              <Cover
                v-if="match.song.coverUrl"
                :url="match.song.coverUrl"
                :size="96"
                :borderRadius="10"
                class="rec-match-cover"
              />
              <div v-else class="rec-match-cover rec-match-cover-empty">
                <Icon :icon="iconMicrophone" width="22" height="22" class="opacity-20" />
              </div>

              <div class="rec-match-info">
                <div class="rec-match-title">{{ match.song.title }}</div>
                <div class="rec-match-sub">
                  {{ match.song.artist }}
                  <template v-if="match.song.album"> · {{ match.song.album }}</template>
                </div>
              </div>

              <div class="rec-match-actions">
                <Button
                  variant="unstyled"
                  size="none"
                  class="rec-circle-btn rec-circle-primary"
                  title="播放"
                  @click="handlePlay(match.song)"
                >
                  <Icon :icon="iconPlay" width="17" height="17" />
                </Button>
                <Button
                  variant="unstyled"
                  size="none"
                  :class="[
                    'rec-circle-btn',
                    isFavorite(match.song) ? 'rec-circle-fav-active' : 'rec-circle-fav',
                  ]"
                  :title="isFavorite(match.song) ? '已收藏' : '收藏'"
                  @click="handleFavorite(match.song)"
                >
                  <Icon
                    :icon="isFavorite(match.song) ? iconHeartFilled : iconHeart"
                    width="17"
                    height="17"
                  />
                </Button>
                <Button
                  variant="unstyled"
                  size="none"
                  class="rec-circle-btn rec-circle-ghost"
                  title="添加到歌单"
                  @click="handleAddToPlaylist(match.song)"
                >
                  <Icon :icon="iconPlaylistAdd" width="16" height="16" />
                </Button>
                <Button
                  variant="unstyled"
                  size="none"
                  class="rec-circle-btn rec-circle-ghost"
                  title="歌曲详情"
                  @click="goToDetail(match.song)"
                >
                  <Icon :icon="iconInfo" width="16" height="16" />
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

          <!-- 音源选择下拉菜单 -->
          <div class="rec-source-row">
            <Popover
              v-model:open="sourceMenuOpen"
              trigger="click"
              side="bottom"
              :sideOffset="6"
              :showArrow="false"
              :disabled="isActive"
              contentClass="rec-source-dropdown"
            >
              <template #trigger>
                <button class="rec-source-toggle" :disabled="isActive">
                  <Icon :icon="sourceIcon" width="14" height="14" />
                  <span class="rec-source-toggle-label">{{ currentSourceLabel }}</span>
                  <Icon :icon="iconChevronDown" width="12" height="12" class="rec-source-arrow" />
                </button>
              </template>
              <div class="rec-source-menu">
                <div class="rec-source-menu-group-label">系统</div>
                <button
                  type="button"
                  class="rec-source-menu-item"
                  :class="{ 'is-active': audioSource === 'system' }"
                  @click="selectSystemAudio"
                >
                  <Icon :icon="iconDeviceSpeaker" width="13" height="13" />
                  系统音频
                </button>
                <div class="rec-source-menu-divider" />
                <div class="rec-source-menu-group-label">麦克风</div>
                <div class="rec-source-menu-mic-list">
                  <button
                    v-for="device in micDevices"
                    :key="device.value"
                    type="button"
                    class="rec-source-menu-item"
                    :class="{
                      'is-active':
                        audioSource === 'mic' && settingStore.inputDevice === device.value,
                    }"
                    @click="selectMicDevice(device.value)"
                  >
                    {{ device.label }}
                  </button>
                </div>
              </div>
            </Popover>
          </div>

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
  max-width: 220px;
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

.rec-source-toggle-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 150px;
}

.rec-source-toggle:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.rec-source-toggle:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* 音源选择行 */
.rec-source-row {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.rec-source-arrow {
  opacity: 0.5;
  margin-left: 2px;
  transition: transform 0.2s ease;
}

/* 音源选择下拉菜单 */
:global(.rec-source-dropdown) {
  width: 220px;
}

.rec-source-menu {
  display: flex;
  flex-direction: column;
  padding: 4px;
}

.rec-source-menu-group-label {
  padding: 4px 10px 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  opacity: 0.6;
  user-select: none;
}

.rec-source-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  transition: all 0.15s ease;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rec-source-menu-item:hover {
  color: var(--color-text-main);
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
}

.rec-source-menu-item.is-active {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.rec-source-menu-divider {
  height: 1px;
  margin: 4px 6px;
  background: color-mix(in srgb, var(--color-text-main) 8%, transparent);
}

.rec-source-menu-mic-list {
  max-height: 160px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.rec-source-menu-mic-list::-webkit-scrollbar {
  width: 4px;
}

.rec-source-menu-mic-list::-webkit-scrollbar-track {
  background: transparent;
}

.rec-source-menu-mic-list::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text-main) 15%, transparent);
  border-radius: 2px;
}

.rec-source-menu-mic-list::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--color-text-main) 25%, transparent);
}

/* === 结果状态：候选列表 === */
.rec-result {
  width: 100%;
  max-width: 640px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-self: center;
  padding-top: 20px;
}

.rec-result-label {
  @apply text-xs font-semibold text-primary/70 uppercase tracking-widest mb-4;
  align-self: center;
  flex-shrink: 0;
}

.rec-match-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 2px 8px 2px 2px;
}

.rec-match-list::-webkit-scrollbar {
  width: 5px;
}

.rec-match-list::-webkit-scrollbar-track {
  background: transparent;
}

.rec-match-list::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text-main) 15%, transparent);
  border-radius: 3px;
}

.rec-match-list::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--color-text-main) 28%, transparent);
}

.rec-match-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--color-text-main) 3%, transparent);
  border: 1px solid transparent;
  transition: all 0.2s ease;
  cursor: default;
}

.rec-match-item:hover {
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
  border-color: color-mix(in srgb, var(--color-primary) 25%, transparent);
}

/* 匹配度徽章（置于最前） */
.rec-match-score {
  flex-shrink: 0;
  width: 50px;
  height: 50px;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  background: color-mix(
    in srgb,
    var(--color-primary) calc(8% + var(--score, 0) * 16%),
    transparent
  );
  color: var(--color-primary);
}

.rec-match-score-num {
  font-size: 14px;
  font-weight: 800;
  line-height: 1;
}

.rec-match-score-label {
  font-size: 9px;
  font-weight: 600;
  opacity: 0.7;
  transform: scale(0.92);
}

.rec-match-cover {
  width: 48px;
  height: 48px;
  border-radius: 10px;
  flex-shrink: 0;
}

.rec-match-cover-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--control-muted-bg);
}

.rec-match-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.rec-match-title {
  @apply text-sm font-semibold text-text-main truncate;
}

.rec-match-sub {
  @apply text-xs text-text-secondary truncate;
}

.rec-match-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.rec-match-item:hover .rec-match-actions {
  opacity: 1;
}

.rec-circle-btn {
  width: 34px;
  height: 34px;
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
  color: var(--state-danger);
  background: color-mix(in srgb, var(--state-danger) 8%, transparent);
}

.rec-circle-fav:hover {
  background: color-mix(in srgb, var(--state-danger) 16%, transparent);
}

.rec-circle-fav-active {
  color: var(--state-danger);
  background: color-mix(in srgb, var(--state-danger) 12%, transparent);
}

.rec-circle-ghost {
  color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-text-main) 6%, transparent);
}

.rec-circle-ghost:hover {
  color: var(--color-text-main);
  background: color-mix(in srgb, var(--color-text-main) 12%, transparent);
}

.rec-playlist-item {
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--control-border);
  background: var(--color-bg-elevated);
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
  margin-top: 20px;
  flex-shrink: 0;
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
