import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import type { NowPlayingSnapshot } from '../../shared/nowPlaying';
import { createLyricTimeline, findLyricIndexAtTimeMs } from '@/composables/useLyricTimeline';

/** 复用播放时钟，歌词切行与逐字进度均从同一个时间轴派生。 */
export function useTaskbarLyrics() {
  const snapshot = shallowRef<NowPlayingSnapshot | null>(null);
  const timeMs = ref(0);
  const error = ref('');
  const timeline = createLyricTimeline();
  const playback = computed(() => snapshot.value?.playback);
  const lyric = computed(() => {
    const value = snapshot.value?.lyric;
    return value?.trackId === (playback.value?.lyricHash || playback.value?.trackId) ? value : null;
  });
  const index = computed(() => findLyricIndexAtTimeMs(lyric.value?.lines ?? [], timeMs.value));
  const line = computed(() => lyric.value?.lines[index.value] ?? null);
  const nextLine = computed(() => lyric.value?.lines[index.value + 1] ?? null);
  let frame = 0;
  let alive = true;
  let received = false;
  let dispose: (() => void) | undefined;
  const sample = () => {
    timeMs.value = timeline.getTimelineMs(playback.value, lyric.value?.timeOffset ?? 0);
  };
  const tick = () => {
    frame = 0;
    sample();
    if (playback.value?.isPlaying && !document.hidden) frame = requestAnimationFrame(tick);
  };
  const schedule = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    sample();
    if (playback.value?.isPlaying && !document.hidden) frame = requestAnimationFrame(tick);
  };
  watch(snapshot, schedule);
  onMounted(async () => {
    document.addEventListener('visibilitychange', schedule);
    const api = window.electron?.nowPlaying;
    if (!api) {
      error.value = '连接不可用';
      return;
    }
    dispose = api.onSnapshot((value) => {
      received = true;
      snapshot.value = value;
      error.value = '';
    });
    try {
      const value = await api.getSnapshot();
      if (alive && !received) snapshot.value = value;
    } catch {
      if (alive) error.value = '连接失败，请重新打开任务栏歌词';
    }
  });
  onUnmounted(() => {
    alive = false;
    dispose?.();
    if (frame) cancelAnimationFrame(frame);
    document.removeEventListener('visibilitychange', schedule);
  });
  return { snapshot, playback, lyric, line, nextLine, timeMs, error };
}
