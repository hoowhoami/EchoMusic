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
  let cachedSubOverlays: HTMLElement[] = [];
  let cachedSubLineIndex = -1;

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
    if (!line?.characters?.length) {
      cachedYrcOverlays = [];
      cachedYrcLineIndex = -1;
      cachedSubOverlays = [];
      cachedSubLineIndex = -1;
      cachedSubOverlays2 = [];
      cachedSubLineIndex2 = -1;
      return;
    }

    const seekMs = getNowMs() + LYRIC_LOOKAHEAD;

    // 主歌词逐字更新（仅当字符数 > 1 时）
    if (line.characters.length > 1) {
      // 行切换或缓存为空时重新查找 DOM
      if (
        lineIndex !== cachedYrcLineIndex ||
        cachedYrcOverlays.length === 0 ||
        cachedYrcOverlays.length !== line.characters.length
      ) {
        const scrollContainer = lyricListRef.value;
        if (!scrollContainer) {
          cachedYrcOverlays = [];
        } else {
          const lineEl = scrollContainer.querySelector<HTMLElement>(
            `[data-lyric-index="${lineIndex}"] .lyric-yrc-line-wrap`,
          );
          if (!lineEl) {
            cachedYrcOverlays = [];
          } else {
            cachedYrcOverlays = Array.from(lineEl.querySelectorAll<HTMLElement>('.lyric-yrc-char'));
          }
        }
        cachedYrcLineIndex = lineIndex;
      }

      if (cachedYrcOverlays.length > 0) {
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
      }
    } else {
      cachedYrcOverlays = [];
      cachedYrcLineIndex = -1;
    }

    // 更新副歌词（音译/翻译）逐字进度
    updateSubYrcDom(lineIndex, line, seekMs);
  };

  // 副歌词逐字 DOM 更新
  let cachedSubOverlays2: HTMLElement[] = [];
  let cachedSubLineIndex2 = -1;

  const updateSubYrcDom = (
    lineIndex: number,
    line: (typeof lyricStore.lines)[0],
    seekMs: number,
  ) => {
    const romanChars = line.romanizedCharacters;
    const transChars = line.translatedCharacters;
    const hasRoman = romanChars && romanChars.length > 1;
    const hasTrans = transChars && transChars.length > 1;

    if (!hasRoman && !hasTrans) {
      cachedSubOverlays = [];
      cachedSubLineIndex = -1;
      cachedSubOverlays2 = [];
      cachedSubLineIndex2 = -1;
      return;
    }

    const scrollContainer = lyricListRef.value;
    if (!scrollContainer) return;

    // 查找所有 sub-wrap（both 模式下可能有两个：翻译在前，音译在后）
    const subWraps = scrollContainer.querySelectorAll<HTMLElement>(
      `[data-lyric-index="${lineIndex}"] .lyric-yrc-sub-wrap`,
    );

    if (subWraps.length === 0) {
      cachedSubOverlays = [];
      cachedSubLineIndex = -1;
      cachedSubOverlays2 = [];
      cachedSubLineIndex2 = -1;
      return;
    }

    // 确定每个 wrap 对应的字符数据
    // both 模式：wrap[0]=翻译, wrap[1]=音译
    // 单模式：wrap[0]=当前显示的那个
    const mode = lyricStore.lyricsMode;
    let firstChars: typeof romanChars = undefined;
    let secondChars: typeof romanChars = undefined;

    if (mode === 'both') {
      // DOM 顺序：音译在前，翻译在后（如果存在的话）
      // 但如果某行没有音译，DOM 中只有翻译的 wrap
      if (hasRoman && hasTrans) {
        firstChars = romanChars;
        secondChars = transChars;
      } else if (hasRoman) {
        firstChars = romanChars;
      } else if (hasTrans) {
        firstChars = transChars;
      }
    } else if (mode === 'romanization') {
      firstChars = hasRoman ? romanChars : undefined;
    } else if (mode === 'translation') {
      firstChars = hasTrans ? transChars : undefined;
    }

    // 第一个 sub-wrap
    if (subWraps.length > 0 && firstChars) {
      if (lineIndex !== cachedSubLineIndex || cachedSubOverlays.length === 0) {
        cachedSubOverlays = Array.from(
          subWraps[0].querySelectorAll<HTMLElement>('.lyric-yrc-sub-char'),
        );
        cachedSubLineIndex = lineIndex;
      }
      if (cachedSubOverlays.length > 0) {
        updateSubCharsProgress(cachedSubOverlays, firstChars, seekMs);
      }
    } else {
      cachedSubOverlays = [];
      cachedSubLineIndex = -1;
    }

    // 第二个 sub-wrap（both 模式下的音译）
    if (subWraps.length > 1 && secondChars) {
      if (lineIndex !== cachedSubLineIndex2 || cachedSubOverlays2.length === 0) {
        cachedSubOverlays2 = Array.from(
          subWraps[1].querySelectorAll<HTMLElement>('.lyric-yrc-sub-char'),
        );
        cachedSubLineIndex2 = lineIndex;
      }
      if (cachedSubOverlays2.length > 0) {
        updateSubCharsProgress(cachedSubOverlays2, secondChars, seekMs);
      }
    } else {
      cachedSubOverlays2 = [];
      cachedSubLineIndex2 = -1;
    }
  };

  const updateSubCharsProgress = (
    elements: HTMLElement[],
    chars: { startTime: number; endTime: number }[],
    seekMs: number,
  ) => {
    for (let i = 0; i < elements.length; i++) {
      const char = chars[i];
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
      elements[i].style.backgroundPositionX = pos;
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
