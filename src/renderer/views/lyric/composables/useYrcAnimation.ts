import { ref, watch, onMounted, onUnmounted, computed, type Ref } from 'vue';
import { usePlayerStore } from '@/stores/player';
import { useLyricStore } from '@/stores/lyric';

/**
 * 逐字歌词实时进度动画（毫秒级精度）
 * 使用 RAF 循环驱动，绕过 Vue 响应式以保证性能
 */
export function useYrcAnimation(lyricListRef: Ref<HTMLElement | null>) {
  const playerStore = usePlayerStore();
  const lyricStore = useLyricStore();

  const LYRIC_LOOKAHEAD = 150;
  let seekBaseMs = 0;
  let seekAnchorTick = 0;
  let seekRafId: number | null = null;
  let seekLastTime = 0;
  let cachedYrcOverlays: HTMLElement[] = [];
  let cachedYrcLineIndex = -1;

  // 获取当前播放时间（毫秒），非响应式
  const getNowMs = () => {
    if (playerStore.isPlaying) {
      return seekBaseMs + (performance.now() - seekAnchorTick);
    }
    return seekBaseMs;
  };

  // 直接操作 DOM 更新逐字歌词样式
  const updateYrcDom = (playedColor: string, unplayedColor: string) => {
    const lineIndex = lyricStore.currentIndex;
    const line = lyricStore.lines[lineIndex];
    if (!line?.characters?.length || line.characters.length <= 1) {
      cachedYrcOverlays = [];
      cachedYrcLineIndex = -1;
      return;
    }

    // 行切换或缓存为空时重新查找 DOM
    if (
      lineIndex !== cachedYrcLineIndex ||
      cachedYrcOverlays.length === 0 ||
      cachedYrcOverlays.length !== line.characters.length
    ) {
      const scrollContainer = lyricListRef.value;
      if (!scrollContainer) {
        cachedYrcOverlays = [];
        return;
      }
      const lineEl = scrollContainer.querySelector<HTMLElement>(
        `[data-lyric-index="${lineIndex}"] .lyric-yrc-line-wrap`,
      );
      if (!lineEl) {
        cachedYrcOverlays = [];
        return;
      }
      cachedYrcOverlays = Array.from(lineEl.querySelectorAll<HTMLElement>('.lyric-yrc-char'));
      cachedYrcLineIndex = lineIndex;
    }

    if (!cachedYrcOverlays.length) return;

    const seekMs = getNowMs() + LYRIC_LOOKAHEAD;
    const characters = line.characters;

    for (let i = 0; i < cachedYrcOverlays.length; i++) {
      const char = characters[i];
      if (!char) continue;

      const charStart = char.startTime || 0;
      const charEnd = char.endTime || 0;

      let pos: string;
      if (seekMs >= charEnd) {
        pos = '0%';
      } else if (seekMs <= charStart) {
        pos = '100%';
      } else {
        const duration = charEnd - charStart;
        const progress = (seekMs - charStart) / duration;
        pos = `${100 - progress * 100}%`;
      }
      cachedYrcOverlays[i].style.backgroundPositionX = pos;
    }
  };

  // 30fps 循环
  const seekLoop = () => {
    seekRafId = requestAnimationFrame((timestamp) => {
      if (timestamp - seekLastTime >= 33) {
        seekLastTime = timestamp;
        lyricStore.updateCurrentIndex(getNowMs() / 1000, true);
        // updateYrcDom 由外部调用时传入颜色
      }
      seekLoop();
    });
  };

  const resumeSeekRaf = () => {
    if (seekRafId !== null) return;
    seekLastTime = performance.now();
    seekLoop();
  };

  const pauseSeekRaf = () => {
    if (seekRafId !== null) {
      cancelAnimationFrame(seekRafId);
      seekRafId = null;
    }
  };

  const syncSeekAnchor = () => {
    seekBaseMs = Math.round((playerStore.currentTime || 0) * 1000);
    seekAnchorTick = performance.now();
  };

  watch(
    () => playerStore.currentTime,
    () => syncSeekAnchor(),
  );

  watch(
    () => playerStore.isPlaying,
    (playing) => {
      syncSeekAnchor();
      if (playing) resumeSeekRaf();
      else pauseSeekRaf();
    },
  );

  onMounted(() => {
    syncSeekAnchor();
    if (playerStore.isPlaying) resumeSeekRaf();
    else pauseSeekRaf();
  });

  onUnmounted(() => {
    pauseSeekRaf();
  });

  return {
    getNowMs,
    updateYrcDom,
    syncSeekAnchor,
  };
}
