import type { Ref } from 'vue';
import { usePlayerStore } from '@/stores/player';
import { useLyricStore } from '@/stores/lyric';

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
  // 但 player 上报时间有 250ms 节流 + IPC 延迟，锚点时间偏旧会导致逐字整体滞后（行尾尤其明显），
  // 这里给一个小的提前量抵消该固定延迟，让逐字跟手又不至于明显抢拍。
  const LYRIC_LOOKAHEAD = 120;
  const CLOCK_SYNC_TOLERANCE_MS = 300;
  const RECENT_SEEK_SYNC_WINDOW_MS = 800;
  const PLAYBACK_STALE_THRESHOLD_MS = 1800;
  // 播放中允许的「回退」阈值：超过此值才认为是真实跳转（手动 seek 之外的不连续），
  // 否则忽略，避免播放器上报时间抖动把歌词时钟往回拨导致逐字/滚动倒退弹跳。
  const BACKWARD_RESYNC_THRESHOLD_MS = 1500;
  let seekBaseMs = 0;
  let seekAnchorTick = 0;
  let lastPlaybackUpdateTick = 0;
  let lastObservedPlayerTimeMs = -1;

  // ── 字符元素注册表 ──
  // 主歌词：行索引 -> 字符元素数组（按字符下标存放）
  const mainCharEls = new Map<number, (HTMLElement | null)[]>();
  // 副歌词：`${行索引}:${kind}` -> 字符元素数组
  const subCharEls = new Map<string, (HTMLElement | null)[]>();

  const subKey = (lineIndex: number, kind: SubLyricKind) => `${lineIndex}:${kind}`;

  // 模板 ref 回调：注册/注销主歌词字符元素
  const registerMainChar = (lineIndex: number, charIndex: number, el: HTMLElement | null) => {
    if (el) {
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
  };

  // 获取当前播放时间（毫秒），非响应式
  const getNowMs = () => {
    const now = performance.now();
    const hasFreshPlaybackProgress = now - lastPlaybackUpdateTick <= PLAYBACK_STALE_THRESHOLD_MS;
    if (playerStore.isPlaying && hasFreshPlaybackProgress) {
      return seekBaseMs + (now - seekAnchorTick) * (playerStore.playbackRate || 1);
    }
    return seekBaseMs;
  };

  const getLyricTimelineMs = (lookaheadMs = 0) =>
    Math.round(getNowMs() + lyricStore.currentTimeOffset + lookaheadMs);

  // 计算单个字符的 background-position-x
  const computeCharPos = (charStart: number, charEnd: number, seekMs: number): string => {
    if (seekMs >= charEnd) return '0%';
    if (seekMs <= charStart) return '100%';
    const duration = charEnd - charStart;
    // 防止 duration 为 0 导致计算失效
    if (duration <= 0) return '0%';
    const progress = (seekMs - charStart) / duration;
    return `${100 - progress * 100}%`;
  };

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
      el.style.backgroundPositionX = computeCharPos(char.startTime || 0, char.endTime || 0, seekMs);
    }
  };

  // 每帧更新逐字歌词样式（直接操作已注册的 DOM 元素）
  const updateYrcDom = () => {
    const lineIndex = activeIndex?.value ?? lyricStore.currentIndex;
    const line = lyricStore.lines[lineIndex];
    if (!line?.characters?.length) return;

    const seekMs = getLyricTimelineMs(LYRIC_LOOKAHEAD);

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
    const nextBaseMs = Math.round((playerStore.currentTime || 0) * 1000);
    const now = performance.now();
    const hasNewPlayerTime = force || nextBaseMs !== lastObservedPlayerTimeMs;
    if (hasNewPlayerTime) {
      lastPlaybackUpdateTick = now;
      lastObservedPlayerTimeMs = nextBaseMs;
    }

    if (playerStore.isPlaying && !force) {
      const predictedMs = seekBaseMs + (now - seekAnchorTick) * (playerStore.playbackRate || 1);
      const driftMs = nextBaseMs - predictedMs;
      const recentSeek = Date.now() - (playerStore.seekTimestamp || 0) < RECENT_SEEK_SYNC_WINDOW_MS;

      if (!recentSeek) {
        // 播放器上报时间可能有轻微回退/抖动，播放中用本地单调时钟更稳。
        if (Math.abs(driftMs) < CLOCK_SYNC_TOLERANCE_MS) return;
        // 非最近 seek 时，忽略中等幅度的「回退」：只有超过阈值的大幅回退才认为是
        // 真实跳转并重置，避免播放器抖动把歌词时钟往回拨造成逐字/滚动倒退弹跳。
        if (driftMs < 0 && -driftMs < BACKWARD_RESYNC_THRESHOLD_MS) return;
      }
    }

    seekBaseMs = nextBaseMs;
    seekAnchorTick = now;
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
