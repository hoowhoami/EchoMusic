<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import { iconMicrophone, iconSearch, iconX, iconDeviceSpeaker } from '@/icons';
import { search } from '@/api/search';
import { mapSearchSong } from '@/utils/mappers';
import type { Song } from '@/models/song';
import type { RecognizeStatus, ShazamResult } from '../../../shared/shazam';

type AudioSource = 'mic' | 'system';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();
const router = useRouter();

const dialogOpen = computed({
  get: () => props.open,
  set: (v) => emit('update:open', v),
});

const audioSource = ref<AudioSource>('mic');
const status = ref<RecognizeStatus>('idle');
const result = ref<ShazamResult | null>(null);
const matchedSong = ref<Song | null>(null);
const errorMsg = ref('');
const recordingSeconds = ref(0);

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let recordingTimer: ReturnType<typeof setInterval> | null = null;

const statusText = computed(() => {
  switch (status.value) {
    case 'recording':
      return `正在聆听... ${recordingSeconds.value}s`;
    case 'recognizing':
      return '正在识别中...';
    case 'success':
      return '识别成功';
    case 'failed':
      return errorMsg.value || '识别失败';
    default:
      return audioSource.value === 'mic'
        ? '请将设备靠近音源，录制约 5-8 秒'
        : '将捕获系统正在播放的音频';
  }
});

const isActive = computed(() => status.value === 'recording' || status.value === 'recognizing');

function audioBufferToPCM(audioBuffer: AudioBuffer): ArrayBuffer {
  const targetSampleRate = 16000;
  const sourceSampleRate = audioBuffer.sampleRate;
  const sourceData = audioBuffer.getChannelData(0);
  const ratio = sourceSampleRate / targetSampleRate;
  const targetLength = Math.floor(sourceData.length / ratio);
  const pcmData = new Int16Array(targetLength);

  for (let i = 0; i < targetLength; i++) {
    const sourceIndex = Math.floor(i * ratio);
    const sample = Math.max(-1, Math.min(1, sourceData[sourceIndex]));
    pcmData[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return pcmData.buffer;
}

async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext();
  try {
    return await audioContext.decodeAudioData(arrayBuffer);
  } finally {
    await audioContext.close();
  }
}

/** 录制完成后的通用识别流程 */
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
      const audioBuffer = await decodeAudioBlob(blob);
      const pcmData = audioBufferToPCM(audioBuffer);
      const response = await window.electron.shazam.recognize(pcmData);

      if (response.success && response.result) {
        status.value = 'success';
        result.value = response.result;
        // 用识别结果搜索酷狗，匹配第一条歌曲
        matchedSong.value = null;
        try {
          const keyword = `${response.result.artist} ${response.result.title}`.trim();
          const searchRes = await search(keyword, 'song', 1, 1);
          const lists = (searchRes as any)?.data?.lists ?? (searchRes as any)?.data?.list ?? [];
          if (Array.isArray(lists) && lists.length > 0) {
            matchedSong.value = mapSearchSong(lists[0]);
          }
        } catch {
          // 搜索失败不影响识别结果展示
        }
      } else {
        status.value = 'failed';
        errorMsg.value = response.error || '未识别到歌曲';
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
    if (recordingSeconds.value >= 8) {
      stopRecording();
    }
  }, 1000);
}

/** 获取麦克风音频流 */
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

/** 获取系统音频流（通过 electron-audio-loopback） */
async function getSystemAudioStream(): Promise<MediaStream> {
  // 启用 loopback 模式
  await window.electron.shazam.enableLoopback();

  try {
    // getDisplayMedia 必须同时请求 video，loopback 插件会自动处理
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    // 移除视频轨道，只保留音频
    stream.getVideoTracks().forEach((t) => {
      t.stop();
      stream.removeTrack(t);
    });

    if (stream.getAudioTracks().length === 0) {
      throw new Error('未获取到系统音频轨道');
    }

    return stream;
  } finally {
    // 恢复正常的 getDisplayMedia 行为
    await window.electron.shazam.disableLoopback();
  }
}

async function startRecording() {
  if (isActive.value) return;

  status.value = 'recording';
  result.value = null;
  errorMsg.value = '';
  recordingSeconds.value = 0;

  try {
    const stream =
      audioSource.value === 'mic' ? await getMicStream() : await getSystemAudioStream();
    await recognizeAudio(stream);
  } catch (err) {
    status.value = 'failed';
    if (audioSource.value === 'mic') {
      errorMsg.value = '无法访问麦克风，请检查权限设置';
    } else {
      errorMsg.value = err instanceof Error ? err.message : '系统音频捕获失败';
    }
    console.error('[Recognize]', err);
  }
}

function stopRecording() {
  if (recordingTimer) {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function resetState() {
  stopRecording();
  status.value = 'idle';
  result.value = null;
  matchedSong.value = null;
  errorMsg.value = '';
  recordingSeconds.value = 0;
}

function handleButtonClick() {
  if (status.value === 'recording') {
    stopRecording();
  } else if (status.value === 'recognizing') {
    return;
  } else {
    startRecording();
  }
}

function switchSource(source: AudioSource) {
  if (isActive.value) return;
  audioSource.value = source;
  resetState();
}

function searchInApp() {
  if (!result.value) return;
  const q = `${result.value.artist} ${result.value.title}`.trim();
  dialogOpen.value = false;
  router.push({ name: 'search', query: { q } });
}

watch(dialogOpen, (open) => {
  if (!open) resetState();
});

onUnmounted(() => {
  stopRecording();
});
</script>

<template>
  <Dialog
    v-model:open="dialogOpen"
    title="听歌识曲"
    showClose
    noScroll
    contentClass="recognize-dialog"
    :close-on-interact-outside="!isActive"
    :close-on-escape="!isActive"
  >
    <div class="flex flex-col items-center py-4 px-4">
      <!-- 音源切换 -->
      <div class="rec-tabs" :class="{ 'is-disabled': isActive }">
        <button
          :class="['rec-tab', audioSource === 'mic' && 'is-active']"
          :disabled="isActive"
          @click="switchSource('mic')"
        >
          <Icon :icon="iconMicrophone" width="14" height="14" />
          麦克风
        </button>
        <button
          :class="['rec-tab', audioSource === 'system' && 'is-active']"
          :disabled="isActive"
          title="捕获系统正在播放的音频"
          @click="switchSource('system')"
        >
          <Icon :icon="iconDeviceSpeaker" width="14" height="14" />
          系统音频
        </button>
      </div>

      <!-- 状态文字 -->
      <p class="text-[13px] text-text-secondary mb-6 tracking-wide text-center">
        {{ statusText }}
      </p>

      <!-- 识别按钮（成功后隐藏） -->
      <div v-if="status !== 'success'" class="relative mb-6">
        <div
          v-if="status === 'recording'"
          class="absolute inset-0 rounded-full bg-primary/20 animate-ping"
        />
        <div
          v-if="status === 'recording'"
          class="absolute -inset-3 rounded-full bg-primary/10 animate-pulse"
        />
        <button
          :disabled="status === 'recognizing'"
          :class="[
            'relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 shadow-lg cursor-pointer',
            status === 'recording'
              ? 'bg-red-500 hover:bg-red-600 text-white scale-110'
              : status === 'recognizing'
                ? 'bg-primary/60 text-white cursor-wait'
                : 'bg-primary hover:bg-primary/90 text-white hover:scale-105 active:scale-95',
          ]"
          @click="handleButtonClick"
        >
          <Icon v-if="status === 'recording'" :icon="iconX" width="28" height="28" />
          <Icon
            v-else
            :icon="audioSource === 'mic' ? iconMicrophone : iconDeviceSpeaker"
            width="32"
            height="32"
            :class="{ 'animate-pulse': status === 'recognizing' }"
          />
        </button>
      </div>

      <!-- 识别结果 -->
      <Transition name="fade">
        <div
          v-if="result"
          class="w-full rounded-xl bg-black/3 dark:bg-white/4 p-4 flex items-center gap-4"
        >
          <img
            v-if="matchedSong?.coverUrl || result.coverUrl"
            :src="matchedSong?.coverUrl || result.coverUrl"
            alt="cover"
            class="w-14 h-14 rounded-lg object-cover shadow shrink-0"
          />
          <div class="min-w-0 flex-1">
            <p class="text-[14px] font-semibold text-text-main truncate">
              {{ matchedSong?.title || result.title }}
            </p>
            <p class="text-[12px] text-text-secondary truncate mt-0.5">
              {{ matchedSong?.artist || result.artist }}
            </p>
            <p
              v-if="matchedSong?.album || result.album"
              class="text-[11px] text-text-secondary/60 truncate mt-0.5"
            >
              {{ matchedSong?.album || result.album }}
            </p>
          </div>
        </div>
      </Transition>
    </div>

    <template #footer>
      <Button v-if="status === 'failed'" variant="ghost" size="sm" @click="startRecording">
        重新识别
      </Button>
      <Button v-if="result" variant="primary" size="sm" @click="searchInApp">
        <Icon :icon="iconSearch" width="14" height="14" class="mr-1" />
        去搜索
      </Button>
      <Button v-if="result" variant="ghost" size="sm" @click="startRecording"> 再试一次 </Button>
    </template>
  </Dialog>
</template>

<style scoped>
:global(.recognize-dialog) {
  width: min(400px, 92vw);
}

/* 音源切换 tab */
.rec-tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.05);
  margin-bottom: 16px;
  width: 100%;
}

.dark .rec-tabs {
  background: rgba(255, 255, 255, 0.06);
}

.rec-tabs.is-disabled {
  opacity: 0.5;
  pointer-events: none;
}

.rec-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 32px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
}

.rec-tab:hover:not(:disabled) {
  color: var(--color-text-main);
}

.rec-tab.is-active {
  background: var(--color-bg-card);
  color: var(--color-primary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.rec-tab:disabled:not(.is-active) {
  opacity: 0.4;
  cursor: not-allowed;
}

.rec-tab-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.08);
  color: var(--color-text-secondary);
  line-height: 1.2;
}

.dark .rec-tab-badge {
  background: rgba(255, 255, 255, 0.1);
}

.fade-enter-active,
.fade-leave-active {
  transition:
    opacity 0.3s ease,
    transform 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
