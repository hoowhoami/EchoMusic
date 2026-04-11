<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type ComponentPublicInstance,
} from 'vue';
import { useRafFn, useThrottleFn, useTimeoutFn, useWindowSize, useDebounceFn } from '@vueuse/core';
import {
  iconLanguage,
  iconLock,
  iconLockOpen,
  iconPause,
  iconPlayerPlay,
  iconStepBack,
  iconStepForward,
  iconX,
} from '@/icons';
import type {
  DesktopLyricSnapshot,
  LyricLinePayload,
  LyricCharacterPayload,
} from '../../shared/desktop-lyric';

// ── 渲染行类型 ──

interface RenderLine {
  line: LyricLinePayload;
  index: number;
  key: string;
  active: boolean;
}

// ── 状态 ──

const snapshot = ref<DesktopLyricSnapshot | null>(null);
let disposeSnapshotListener: (() => void) | null = null;

// 锚点时间（毫秒）与锚点帧时间，用于插值推进
let baseMs = 0;
let anchorTick = 0;

// 实时播放进度（毫秒）
const playSeekMs = ref(0);

// 每帧推进播放游标
const { pause: pauseSeek, resume: resumeSeek } = useRafFn(() => {
  if (snapshot.value?.playback?.isPlaying) {
    playSeekMs.value = baseMs + (performance.now() - anchorTick);
  } else {
    playSeekMs.value = baseMs;
  }
});

// 300ms 提前量
const LYRIC_LOOKAHEAD = 300;
const SYNC_THRESHOLD = 300;

// ── 计算属性 ──

const settings = computed(() => snapshot.value?.settings);
const playback = computed(() => snapshot.value?.playback);
const lyrics = computed(() => snapshot.value?.lyrics ?? []);
const currentIndex = computed(() => snapshot.value?.currentIndex ?? -1);
const isLocked = computed(() => settings.value?.locked ?? false);
const isPlaying = computed(() => playback.value?.isPlaying ?? false);
const songName = computed(() => playback.value?.title || 'EchoMusic');
const artistName = computed(() => playback.value?.artist || '');
const alignment = computed(() => settings.value?.alignment ?? 'center');
const doubleLine = computed(() => settings.value?.doubleLine ?? true);
const secondaryEnabled = computed(() => settings.value?.secondaryEnabled ?? false);
// 当前歌词是否有翻译或音译数据
const hasSecondary = computed(() =>
  lyrics.value.some((l) => l.translated?.trim() || l.romanized?.trim()),
);
const playedColor = computed(() => settings.value?.playedColor ?? '#31cfa1');
const unplayedColor = computed(() => settings.value?.unplayedColor ?? '#7a7a7a');
const shadowColor = computed(() =>
  settings.value?.strokeEnabled
    ? (settings.value?.strokeColor ?? 'rgba(0,0,0,0.5)')
    : 'rgba(0,0,0,0.5)',
);
const fontFamily = computed(() => settings.value?.fontFamily ?? 'system-ui');
const fontWeight = computed(() => (settings.value?.bold ? 700 : 400));

// hover 状态
const isHovered = ref(false);
const { start: startHoverTimer } = useTimeoutFn(
  () => {
    isHovered.value = false;
  },
  1000,
  { immediate: false },
);
const handleMouseMove = () => {
  isHovered.value = true;
  startHoverTimer();
};
const handleMouseLeave = () => {
  isHovered.value = false;
};

// ── 占位行 ──

const placeholder = (word: string): RenderLine[] => [
  {
    line: { time: 0, text: word, characters: [{ text: word, startTime: 0, endTime: 0 }] },
    index: -1,
    key: 'placeholder',
    active: true,
  },
];

// ── 过渡名称 ──

const transitionName = computed(() => 'lyric-slide');

// ── 行高计算 ──

const getLineTop = (index: number) => {
  if (index === 0) return '0px';
  return `${localFontSize.value * 1.9}px`;
};

const renderLyricLines = computed<RenderLine[]>(() => {
  if (!snapshot.value) return [];
  const lines = lyrics.value;
  const idx = currentIndex.value;
  // 无歌词
  if (!lines.length) {
    if (!songName.value) return placeholder('EchoMusic Desktop Lyric');
    return placeholder('EchoMusic - 听你想听');
  }
  // 索引小于 0，显示歌曲名称
  if (idx < 0) {
    return placeholder(`${songName.value} - ${artistName.value}`);
  }
  const current = lines[idx];
  if (!current) return [];
  const next = lines[idx + 1];

  // 计算安全结束时间
  const safeEnd = next
    ? (next.characters?.[0]?.startTime ?? next.time * 1000)
    : (current.characters?.[current.characters.length - 1]?.endTime ?? 0);

  // 翻译模式
  if (secondaryEnabled.value) {
    const tran = current.translated?.trim() ?? '';
    const roman = current.romanized?.trim() ?? '';
    // 合并翻译和音译到一行
    const secondaryText = [tran, roman].filter(Boolean).join(' / ');
    if (secondaryText) {
      return [
        {
          line: { ...current, characters: current.characters.map((c) => ({ ...c })) },
          index: idx,
          key: `${idx}-orig`,
          active: true,
        },
        {
          line: {
            time: current.time,
            text: secondaryText,
            characters: [
              {
                text: secondaryText,
                startTime: current.characters?.[0]?.startTime ?? 0,
                endTime: safeEnd,
              },
            ],
          },
          index: idx,
          key: `${idx}-secondary`,
          active: false,
        },
      ];
    }
  }
  // 双行模式：当前 + 下一句
  if (doubleLine.value) {
    const result: RenderLine[] = [{ line: current, index: idx, key: `${idx}-orig`, active: true }];
    if (next) {
      result.push({ line: next, index: idx + 1, key: `${idx + 1}-orig`, active: false });
    }
    return result;
  }
  // 单行模式
  return [{ line: current, index: idx, key: `${idx}-orig`, active: true }];
});

// 逐字歌词样式

const getYrcStyle = (char: LyricCharacterPayload, lineIndex: number) => {
  const line = lyrics.value[lineIndex];
  if (!line?.characters?.length) return { backgroundPositionX: '100%' };
  const seekMs = playSeekMs.value + LYRIC_LOOKAHEAD;
  const lineStart = line.characters[0].startTime;
  const lineEnd = line.characters[line.characters.length - 1].endTime;
  const isLineActive =
    (seekMs >= lineStart && seekMs < lineEnd) || currentIndex.value === lineIndex;
  if (!isLineActive) {
    return { backgroundPositionX: seekMs >= (char.endTime || 0) ? '0%' : '100%' };
  }
  const duration = Math.max((char.endTime || 0) - (char.startTime || 0), 0.001);
  const progress = Math.max(Math.min((seekMs - (char.startTime || 0)) / duration, 1), 0);
  return { backgroundPositionX: `${100 - progress * 100}%` };
};

// 判断行是否有逐字数据
const isYrcLine = (line: LyricLinePayload) => (line.characters?.length ?? 0) > 1;

// 歌词行滚动

const lineRefs = new Map<string, HTMLElement>();
const contentRefs = new Map<string, HTMLElement>();
const setLineRef = (el: Element | ComponentPublicInstance | null, key: string) => {
  if (el) lineRefs.set(key, el as HTMLElement);
  else lineRefs.delete(key);
};
const setContentRef = (el: Element | ComponentPublicInstance | null, key: string) => {
  if (el) contentRefs.set(key, el as HTMLElement);
  else contentRefs.delete(key);
};

const getScrollStyle = (line: RenderLine) => {
  const container = lineRefs.get(line.key);
  const content = contentRefs.get(line.key);
  if (!container || !content || !line.line) return {};
  const overflow = Math.max(0, content.scrollWidth - container.clientWidth);
  if (overflow <= 0) return { transform: 'translateX(0px)' };
  const seekMs = playSeekMs.value;
  const chars = line.line.characters;
  if (!chars?.length) return { transform: 'translateX(0px)' };
  const start = chars[0].startTime;
  const endRaw = chars[chars.length - 1].endTime;
  if (!endRaw || endRaw <= start) return { transform: 'translateX(0px)' };
  const end = Math.max(start + 0.001, endRaw - 2000);
  const duration = Math.max(end - start, 0.001);
  const progress = Math.max(Math.min((seekMs - start) / duration, 1), 0);
  if (progress <= 0.3) return { transform: 'translateX(0px)' };
  const ratio = (progress - 0.3) / 0.7;
  return { transform: `translateX(-${Math.round(overflow * ratio)}px)`, willChange: 'transform' };
};

// 拖拽

// EchoMusic 的 preload send 只接受 (channel, data)，多参数包装成数组
const sendToMain = (channel: string, ...args: any[]) => {
  window.electron?.ipcRenderer?.send(channel, ...args);
};

const updateDesktopLyricSettings = async (partial: Record<string, unknown>) => {
  if (!window.electron?.desktopLyric) return;
  snapshot.value = await window.electron.desktopLyric.updateSettings(partial);
};

// 缓存窗口和屏幕边界
const cachedBounds = reactive({
  x: 0,
  y: 0,
  width: 800,
  height: 180,
  screenMinX: -99999,
  screenMinY: -99999,
  screenMaxX: 99999,
  screenMaxY: 99999,
});

const updateCachedBounds = async () => {
  try {
    const [winBounds, screenBounds] = await Promise.all([
      window.electron.ipcRenderer.invoke('desktop-lyric:get-bounds'),
      window.electron.ipcRenderer.invoke('desktop-lyric:get-virtual-screen-bounds'),
    ]);
    cachedBounds.x = winBounds?.x ?? 0;
    cachedBounds.y = winBounds?.y ?? 0;
    cachedBounds.width = winBounds?.width ?? 800;
    cachedBounds.height = winBounds?.height ?? 180;
    cachedBounds.screenMinX = screenBounds?.minX ?? -99999;
    cachedBounds.screenMinY = screenBounds?.minY ?? -99999;
    cachedBounds.screenMaxX = screenBounds?.maxX ?? 99999;
    cachedBounds.screenMaxY = screenBounds?.maxY ?? 99999;
  } catch (e) {
    console.warn('Failed to update cached bounds:', e);
  }
};

const dragState = reactive({
  isDragging: false,
  startX: 0,
  startY: 0,
  startWinX: 0,
  startWinY: 0,
  winWidth: 0,
  winHeight: 0,
});

const onDocPointerDown = (event: PointerEvent) => {
  if (isLocked.value || event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('.menu-btn')) return;
  const safeWidth = cachedBounds.width > 0 ? cachedBounds.width : 800;
  const safeHeight = cachedBounds.height > 0 ? cachedBounds.height : 180;
  dragState.isDragging = true;
  dragState.startX = event.screenX;
  dragState.startY = event.screenY;
  dragState.startWinX = cachedBounds.x;
  dragState.startWinY = cachedBounds.y;
  dragState.winWidth = safeWidth;
  dragState.winHeight = safeHeight;
  // 固定最大尺寸以规避 DPI 缩放 bug
  sendToMain('desktop-lyric:toggle-fixed-size', {
    width: safeWidth,
    height: safeHeight,
    fixed: true,
  });
  document.addEventListener('pointermove', onDocPointerMove);
  document.addEventListener('pointerup', onDocPointerUp);
  event.preventDefault();
};

const onDocPointerMove = useThrottleFn((event: PointerEvent) => {
  if (!dragState.isDragging || isLocked.value) return;
  const newX = Math.round(dragState.startWinX + (event.screenX - dragState.startX));
  const newY = Math.round(dragState.startWinY + (event.screenY - dragState.startY));
  sendToMain('desktop-lyric:move', newX, newY, dragState.winWidth, dragState.winHeight);
}, 16);

const onDocPointerUp = () => {
  if (!dragState.isDragging) return;
  dragState.isDragging = false;
  document.removeEventListener('pointermove', onDocPointerMove);
  document.removeEventListener('pointerup', onDocPointerUp);
  requestAnimationFrame(() => {
    sendToMain('desktop-lyric:resize', dragState.winWidth, dragState.winHeight);
    const height = fontSizeToHeight(localFontSize.value);
    if (height) pushWindowHeight(height);
    sendToMain('desktop-lyric:toggle-fixed-size', {
      width: dragState.winWidth,
      height: dragState.winHeight,
      fixed: false,
    });
    updateCachedBounds();
  });
};

// 字体大小随窗口变化

const { height: winHeight, width: winWidth } = useWindowSize();

watch([winWidth, winHeight], ([w, h]) => {
  if (!dragState.isDragging) {
    cachedBounds.width = w;
    cachedBounds.height = h;
  }
});

// 本地字体大小
const localFontSize = ref(30);

const computedFontSize = computed(() => {
  const h = dragState.isDragging ? dragState.winHeight : Math.round(Number(winHeight.value ?? 0));
  const minH = 140;
  const maxH = 360;
  const minF = 20;
  const maxF = 96;
  if (!Number.isFinite(h) || h <= minH) return minF;
  if (h >= maxH) return maxF;
  return Math.round(minF + ((h - minH) / (maxH - minH)) * (maxF - minF));
});

const debouncedSaveConfig = useDebounceFn((size: number) => {
  const nextHeight = fontSizeToHeight(size);
  if (nextHeight) pushWindowHeight(nextHeight);
}, 500);

const fontSizeToHeight = (size: number) => {
  const minH = 140;
  const maxH = 360;
  const minF = 20;
  const maxF = 96;
  const s = Math.min(Math.max(Math.round(size), minF), maxF);
  return Math.round(minH + ((s - minF) / (maxF - minF)) * (maxH - minH));
};

const pushWindowHeight = (nextHeight: number) => {
  if (!Number.isFinite(nextHeight) || dragState.isDragging) return;
  sendToMain('desktop-lyric:set-height', nextHeight);
};

let initialized = false;

// 窗口高度变 → 计算字体大小 → 更新本地变量 + 防抖保存
watch(computedFontSize, (size) => {
  if (!Number.isFinite(size) || dragState.isDragging || !initialized) return;
  if (Math.abs(localFontSize.value - size) > 1) {
    localFontSize.value = size;
    debouncedSaveConfig(size);
  }
});

// 锁定/解锁

const toggleLyricLock = () => {
  void window.electron?.desktopLyric?.toggleLock();
};

const tempToggleLyricLock = (lock: boolean) => {
  if (!isLocked.value) return;
  // 直接用 preload 暴露的 API，不走 sendToMain 包装
  window.electron?.desktopLyric?.setIgnoreMouseEvents(lock);
};

// ── 操作命令 ──

const toggleSecondary = () => {
  const next = !secondaryEnabled.value;
  void updateDesktopLyricSettings({ secondaryEnabled: next });
};

const closeWindow = async () => {
  if (!window.electron?.desktopLyric) return;
  snapshot.value = await window.electron.desktopLyric.hide();
};

const togglePlayback = () => {
  window.electron?.desktopLyric?.command('togglePlayback');
};
const playPrevious = () => {
  window.electron?.desktopLyric?.command('previousTrack');
};
const playNext = () => {
  window.electron?.desktopLyric?.command('nextTrack');
};

// ── 锚点同步 ──

const syncAnchor = () => {
  const state = playback.value;
  if (!state) return;
  const newBaseMs = Math.round((state.currentTime || 0) * 1000);
  const ipcDelay = performance.now() - (state.updatedAt || performance.now());
  const compensated = ipcDelay > 0 && ipcDelay < 1000 ? newBaseMs + ipcDelay : newBaseMs;
  if (Math.abs(compensated - playSeekMs.value) > SYNC_THRESHOLD) {
    baseMs = compensated;
    anchorTick = performance.now();
  }
  if (!state.isPlaying) {
    baseMs = newBaseMs;
    anchorTick = performance.now();
  }
};

// ── 生命周期 ──

onMounted(async () => {
  document.documentElement.classList.add('desktop-lyric-window');
  document.body.classList.add('desktop-lyric-window');
  document.getElementById('app')?.classList.add('desktop-lyric-window');

  snapshot.value = (await window.electron?.desktopLyric?.getSnapshot()) ?? null;
  // 从窗口高度计算初始字体大小
  localFontSize.value = computedFontSize.value;

  disposeSnapshotListener =
    window.electron?.desktopLyric?.onSnapshot((next) => {
      snapshot.value = next;
      syncAnchor();
      // 按播放状态节能
      if (next.playback?.isPlaying) {
        resumeSeek();
      } else {
        baseMs = playSeekMs.value;
        anchorTick = performance.now();
        pauseSeek();
      }
    }) ?? null;

  await updateCachedBounds();

  // 启动 RAF
  if (isPlaying.value) {
    resumeSeek();
  } else {
    pauseSeek();
  }

  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseleave', handleMouseLeave);

  // 延迟标记初始化完成
  setTimeout(() => {
    initialized = true;
  }, 2000);
});

onBeforeUnmount(() => {
  pauseSeek();
  document.removeEventListener('pointerdown', onDocPointerDown);
  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseleave', handleMouseLeave);
  if (dragState.isDragging) onDocPointerUp();
  document.documentElement.classList.remove('desktop-lyric-window');
  document.body.classList.remove('desktop-lyric-window');
  document.getElementById('app')?.classList.remove('desktop-lyric-window');
  disposeSnapshotListener?.();
});
</script>

<template>
  <div :class="['desktop-lyric', { locked: isLocked, hovered: isHovered }]">
    <!-- 顶部工具栏 -->
    <div class="header">
      <div class="header-left" @pointerdown.stop>
        <span class="song-name">{{ songName }} - {{ artistName }}</span>
      </div>
      <div class="header-center" @pointerdown.stop>
        <button class="menu-btn" @click.stop="playPrevious">
          <Icon :icon="iconStepBack" width="20" height="20" />
        </button>
        <button class="menu-btn" :title="isPlaying ? '暂停' : '播放'" @click.stop="togglePlayback">
          <Icon :icon="isPlaying ? iconPause : iconPlayerPlay" width="20" height="20" />
        </button>
        <button class="menu-btn" @click.stop="playNext">
          <Icon :icon="iconStepForward" width="20" height="20" />
        </button>
      </div>
      <div class="header-right" @pointerdown.stop>
        <button
          class="menu-btn tran-btn"
          :class="{ 'is-active': secondaryEnabled && hasSecondary }"
          title="翻译"
          @click.stop="toggleSecondary"
        >
          <Icon :icon="iconLanguage" width="20" height="20" />
        </button>
        <button
          class="menu-btn lock-btn"
          @mouseenter.stop="tempToggleLyricLock(false)"
          @mouseleave.stop="tempToggleLyricLock(true)"
          @click.stop="toggleLyricLock"
        >
          <Icon :icon="isLocked ? iconLockOpen : iconLock" width="20" height="20" />
        </button>
        <button class="menu-btn" @click.stop="closeWindow">
          <Icon :icon="iconX" width="20" height="20" />
        </button>
      </div>
    </div>

    <!-- 歌词区域 -->
    <TransitionGroup
      tag="div"
      :name="transitionName"
      :style="{
        fontSize: localFontSize + 'px',
        fontFamily,
        fontWeight,
        textShadow: `0 0 4px ${shadowColor}`,
      }"
      :class="['lyric-container', alignment]"
    >
      <div
        v-for="(line, index) in renderLyricLines"
        :key="line.key"
        :class="[
          'lyric-line',
          {
            active: line.active,
            'is-yrc': line.active && isYrcLine(line.line),
            'is-next': !line.active && doubleLine,
            'align-left': alignment === 'both' && line.index % 2 === 0,
            'align-right': alignment === 'both' && line.index % 2 !== 0,
          },
        ]"
        :style="{
          color: line.active ? playedColor : unplayedColor,
          top: getLineTop(index),
          fontSize: index > 0 ? '0.8em' : '1em',
        }"
        :ref="(el) => setLineRef(el, line.key)"
      >
        <!-- 逐字歌词 -->
        <template v-if="line.active && isYrcLine(line.line)">
          <span
            class="scroll-content"
            :style="getScrollStyle(line)"
            :ref="(el) => setContentRef(el, line.key)"
          >
            <span class="content">
              <span
                v-for="(char, ci) in line.line.characters"
                :key="ci"
                :class="{
                  'content-text': true,
                  'end-with-space': char.text.endsWith(' ') || char.startTime === 0,
                }"
              >
                <span
                  class="word"
                  :style="[
                    {
                      backgroundImage: `linear-gradient(to right, ${playedColor} 50%, ${unplayedColor} 50%)`,
                      textShadow: 'none',
                      filter: `drop-shadow(0 0 1px ${shadowColor}) drop-shadow(0 0 2px ${shadowColor})`,
                    },
                    getYrcStyle(char, line.index),
                  ]"
                  >{{ char.text }}</span
                >
              </span>
            </span>
          </span>
        </template>
        <!-- 普通歌词 -->
        <template v-else>
          <span
            class="scroll-content"
            :style="getScrollStyle(line)"
            :ref="(el) => setContentRef(el, line.key)"
            >{{ line.line.text || '' }}</span
          >
        </template>
      </div>
      <!-- 占位 -->
      <span v-if="renderLyricLines.length === 0" class="lyric-line" key="placeholder">&nbsp;</span>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.desktop-lyric {
  display: flex;
  flex-direction: column;
  height: 100%;
  color: #fff;
  background-color: transparent;
  padding: 12px;
  border-radius: 12px;
  overflow: hidden;
  transition: background-color 0.3s;
  cursor: default;
}

/* 顶部工具栏 */
.header {
  position: relative;
  margin-bottom: 12px;
  cursor: default;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  grid-gap: 12px;
}
.header > * {
  min-width: 0;
}
.header-left {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
}
.header-center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.header-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.song-name {
  font-size: 1em;
  text-align: left;
  flex: 1 1 auto;
  line-height: 36px;
  padding: 0 8px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: opacity 0.3s;
}

.menu-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  padding: 6px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: inherit;
  will-change: transform;
  transition:
    opacity 0.3s,
    background-color 0.3s,
    transform 0.3s;
  cursor: pointer;
}
.menu-btn.lock-btn {
  pointer-events: auto;
}
.menu-btn.lock-btn svg {
  filter: drop-shadow(0 0 6px rgba(0, 0, 0, 0.9)) drop-shadow(0 0 2px rgba(0, 0, 0, 0.6));
}
.menu-btn:hover {
  background-color: rgba(255, 255, 255, 0.3);
}
.menu-btn:active {
  transform: scale(0.98);
}
.menu-btn.tran-btn.is-active svg {
  color: #31cfa1;
}

/* 默认隐藏工具栏 */
.song-name,
.menu-btn {
  opacity: 0;
}

/* 歌词容器 */
.lyric-container {
  height: 100%;
  padding: 0 8px;
  cursor: move;
  position: relative;
}

.lyric-line {
  position: absolute;
  width: 100%;
  left: 0;
  line-height: normal;
  padding: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    top 0.6s cubic-bezier(0.55, 0, 0.1, 1),
    font-size 0.6s cubic-bezier(0.55, 0, 0.1, 1),
    color 0.6s cubic-bezier(0.55, 0, 0.1, 1),
    opacity 0.6s cubic-bezier(0.55, 0, 0.1, 1),
    transform 0.6s cubic-bezier(0.55, 0, 0.1, 1);
  will-change: top, font-size, transform;
  transform-origin: left center;
}

.scroll-content {
  display: inline-block;
  white-space: nowrap;
  will-change: transform;
}

/* 逐字歌词 */
.lyric-line.is-yrc .content {
  display: inline-flex;
  flex-wrap: nowrap;
  width: auto;
  overflow-wrap: normal;
  word-break: normal;
  white-space: nowrap;
  text-align: inherit;
}
.lyric-line.is-yrc .content-text {
  position: relative;
  display: inline-block;
}
.lyric-line.is-yrc .content-text .word {
  display: inline-block;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  background-size: 200% 100%;
  background-repeat: no-repeat;
  background-position-x: 100%;
  will-change: background-position-x;
}
.lyric-line.is-yrc .content-text.end-with-space {
  margin-right: 5vh;
}
.lyric-line.is-yrc .content-text.end-with-space:last-child {
  margin-right: 0;
}

/* 对齐方式 */
.lyric-container.center .lyric-line {
  text-align: center;
  transform-origin: center center;
}
.lyric-container.center .lyric-line.is-yrc .content {
  justify-content: center;
}
.lyric-container.right .lyric-line {
  text-align: right;
  transform-origin: right center;
}
.lyric-container.right .lyric-line.is-yrc .content {
  justify-content: flex-end;
}
.lyric-container.both .lyric-line.align-right {
  text-align: right;
  transform-origin: right center;
}
.lyric-container.both .lyric-line.align-left {
  text-align: left;
  transform-origin: left center;
}
.lyric-container.both .lyric-line.is-yrc.align-right .content {
  justify-content: flex-end;
}

/* 过渡动画 */
.lyric-slide-move,
.lyric-slide-enter-active,
.lyric-slide-leave-active {
  transition:
    transform 0.6s cubic-bezier(0.55, 0, 0.1, 1),
    opacity 0.6s cubic-bezier(0.55, 0, 0.1, 1);
  will-change: transform, opacity;
}
.lyric-slide-enter-from {
  opacity: 0;
  transform: translateY(100%);
}
.lyric-slide-leave-to {
  opacity: 0;
  transform: translateY(-100%);
}
.lyric-slide-leave-active {
  position: absolute;
}

/* Hover 状态 */
.desktop-lyric.hovered:not(.locked) {
  background-color: rgba(0, 0, 0, 0.6);
}
.desktop-lyric.hovered:not(.locked) .song-name,
.desktop-lyric.hovered:not(.locked) .menu-btn {
  opacity: 1;
}

/* 锁定状态 */
.desktop-lyric.locked {
  cursor: default;
}
.desktop-lyric.locked .song-name,
.desktop-lyric.locked .menu-btn,
.desktop-lyric.locked .lyric-container {
  pointer-events: none;
}
.desktop-lyric.locked .menu-btn.lock-btn {
  pointer-events: auto;
}
.desktop-lyric.locked.hovered .lock-btn {
  opacity: 1;
  background-color: rgba(0, 0, 0, 0.45);
}
</style>

<style>
body {
  background-color: transparent !important;
}
html,
body {
  overflow: hidden;
}
.desktop-lyric-window {
  background-color: transparent !important;
}
</style>
