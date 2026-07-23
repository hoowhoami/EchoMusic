import type { Ref } from 'vue';
import { usePlayerStore } from '@/stores/player';
import { useLyricStore } from '@/stores/lyric';
import {
  computeLyricCharBackgroundPosition,
  createLyricTimeline,
} from '@/composables/useLyricTimeline';
import { buildPlaybackClockSnapshot } from '../../../../shared/playback';

/** 副歌词类型：音译 / 翻译 */
export type SubLyricKind = 'romanized' | 'translated';

/**
 * 逐字歌词实时进度动画（毫秒级精度）
 * 使用 RAF 循环驱动，绕过 Vue 响应式以保证性能。
 *
 * 字符 DOM 元素由模板通过 ref 回调注册到本 composable 内的注册表，
 * 不再使用 querySelector + 手动缓存，从根本上避免「缓存指向已脱离的旧节点、
 * 新节点停在 CSS 默认未播放色」的问题。
 */
export function useYrcAnimation(activeIndex?: Ref<number>) {
  const playerStore = usePlayerStore();
  const lyricStore = useLyricStore();

  // 主歌词页提前的是滚动位置；逐字进度本身按歌词时间轴走。
  // 播放引擎时间锚点已由共享时间轴插值补偿，逐字进度不再额外提前。
  const LYRIC_LOOKAHEAD = 0;
  const timeline = createLyricTimeline();

  const getPlayback = () => {
    const playback = {
      trackId: playerStore.currentTrackId,
      currentTime: playerStore.currentTime,
      duration: playerStore.duration,
      isPlaying: playerStore.isPlaying,
      playbackRate: playerStore.playbackRate,
      updatedAt: playerStore.currentTimeUpdatedAt,
      seekTimestamp: playerStore.seekTimestamp,
    };
    return {
      ...playback,
      clock: buildPlaybackClockSnapshot(playback),
    };
  };

  // ── 字符元素注册表 ──
  // 主歌词：行索引 -> 字符元素数组（按字符下标存放）
  const mainCharEls = new Map<number, (HTMLElement | null)[]>();
  // 副歌词：`${行索引}:${kind}` -> 字符元素数组
  const subCharEls = new Map<string, (HTMLElement | null)[]>();
  let lastActiveLineIndex = -1;

  const subKey = (lineIndex: number, kind: SubLyricKind) => `${lineIndex}:${kind}`;
  const readActiveLineIndex = () => activeIndex?.value ?? lyricStore.currentIndex;

  // 模板 ref 回调：注册/注销主歌词字符元素
  const registerMainChar = (lineIndex: number, charIndex: number, el: HTMLElement | null) => {
    if (el) {
      if (lineIndex !== readActiveLineIndex()) el.style.backgroundPositionX = '100%';
      let arr = mainCharEls.get(lineIndex);
      if (!arr) {
        arr = [];
        mainCharEls.set(lineIndex, arr);
      }
      arr[charIndex] = el;
    } else {
      const arr = mainCharEls.get(lineIndex);
      if (arr) {
        arr[charIndex] = null;
        if (arr.every((item) => !item)) mainCharEls.delete(lineIndex);
      }
    }
  };

  // 模板 ref 回调：注册/注销副歌词字符元素
  const registerSubChar = (
    lineIndex: number,
    kind: SubLyricKind,
    charIndex: number,
    el: HTMLElement | null,
  ) => {
    const key = subKey(lineIndex, kind);
    if (el) {
      if (lineIndex !== readActiveLineIndex()) el.style.backgroundPositionX = '100%';
      let arr = subCharEls.get(key);
      if (!arr) {
        arr = [];
        subCharEls.set(key, arr);
      }
      arr[charIndex] = el;
    } else {
      const arr = subCharEls.get(key);
      if (arr) {
        arr[charIndex] = null;
        if (arr.every((item) => !item)) subCharEls.delete(key);
      }
    }
  };

  // 歌词整体变化（切歌/重新加载）时清空注册表
  const resetCharRegistry = () => {
    mainCharEls.clear();
    subCharEls.clear();
    lastActiveLineIndex = -1;
  };

  // 获取当前播放时间（毫秒），非响应式
  const getNowMs = () => timeline.getPlaybackMs(getPlayback());

  const getLyricTimelineMs = (lookaheadMs = 0) =>
    timeline.getTimelineMs(getPlayback(), lyricStore.currentTimeOffset, lookaheadMs);

  // 按字符时间轴更新一组字符元素的进度
  const applyCharsProgress = (
    elements: (HTMLElement | null)[],
    chars: { startTime: number; endTime: number }[],
    seekMs: number,
  ) => {
    const count = Math.min(elements.length, chars.length);
    for (let i = 0; i < count; i++) {
      const el = elements[i];
      const char = chars[i];
      if (!el || !char) continue;
      el.style.backgroundPositionX = computeLyricCharBackgroundPosition(
        char.startTime || 0,
        char.endTime || 0,
        seekMs,
      );
    }
  };

  const resetCharsProgress = (elements: (HTMLElement | null)[] | undefined) => {
    if (!elements) return;
    for (const el of elements) {
      if (el) el.style.backgroundPositionX = '100%';
    }
  };

  const resetYrcLineDom = (lineIndex: number) => {
    if (lineIndex < 0) return;
    resetCharsProgress(mainCharEls.get(lineIndex));
    resetCharsProgress(subCharEls.get(subKey(lineIndex, 'romanized')));
    resetCharsProgress(subCharEls.get(subKey(lineIndex, 'translated')));
  };

  // 每帧更新逐字歌词样式（直接操作已注册的 DOM 元素）
  const updateYrcDom = () => {
    const lineIndex = readActiveLineIndex();
    const line = lyricStore.lines[lineIndex];
    if (!line?.characters?.length) {
      resetYrcLineDom(lastActiveLineIndex);
      lastActiveLineIndex = -1;
      return;
    }

    const seekMs = getLyricTimelineMs(LYRIC_LOOKAHEAD);

    if (lineIndex !== lastActiveLineIndex) {
      resetYrcLineDom(lastActiveLineIndex);
      lastActiveLineIndex = lineIndex;
    }

    // 主歌词逐字（仅当字符数 > 1 时才有逐字结构）
    if (line.characters.length > 1) {
      const overlays = mainCharEls.get(lineIndex);
      if (overlays) applyCharsProgress(overlays, line.characters, seekMs);
    }

    // 副歌词（音译/翻译）逐字
    updateSubYrcDom(lineIndex, line, seekMs);
  };

  // 副歌词逐字更新：按 kind 直接定位元素，不再依赖 DOM 顺序
  const updateSubYrcDom = (
    lineIndex: number,
    line: (typeof lyricStore.lines)[number],
    seekMs: number,
  ) => {
    const mode = lyricStore.lyricsMode;
    const romanChars = line.romanizedCharacters;
    const transChars = line.translatedCharacters;

    if ((mode === 'both' || mode === 'romanization') && romanChars && romanChars.length > 1) {
      const els = subCharEls.get(subKey(lineIndex, 'romanized'));
      if (els) applyCharsProgress(els, romanChars, seekMs);
    }

    if ((mode === 'both' || mode === 'translation') && transChars && transChars.length > 1) {
      const els = subCharEls.get(subKey(lineIndex, 'translated'));
      if (els) applyCharsProgress(els, transChars, seekMs);
    }
  };

  const syncSeekAnchor = (force = false) => {
    timeline.sync(getPlayback(), force);
  };

  return {
    getNowMs,
    getLyricTimelineMs,
    updateYrcDom,
    syncSeekAnchor,
    registerMainChar,
    registerSubChar,
    resetCharRegistry,
  };
}
