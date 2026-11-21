<script setup lang="ts">
import '@/theme/sliders.css';
import { neutralThemePalette, DEFAULT_THEME_ACCENT } from '../../shared/themePalette';
import { createAccentPaletteFromPrimary } from '../../shared/accentPalette';
import { buildFontFamily } from '../../shared/font';
import {
  DEFAULT_TASKBAR_LYRIC_SETTINGS,
  normalizeTaskbarLyricSettings,
  type TaskbarContentAlign,
  type TaskbarLyricState,
} from '../../shared/taskbar';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import {
  iconHeart,
  iconHeartFilled,
  iconMusic,
  iconPause,
  iconPlay,
  iconSkipBack,
  iconSkipForward,
} from '@/icons';
import { SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import SliderRoot from '@/components/ui/SliderRoot.vue';
import TaskbarLyricLine from './TaskbarLyricLine.vue';
import type { NowPlayingCommand } from '../../shared/nowPlaying';
import { useTaskbarSeek } from './useTaskbarSeek';
import { useTaskbarLyrics } from './useTaskbarLyrics';
import { resolveContentWidth, MIN_CONTENT_WIDTH } from './lyricWidth';
const { snapshot, playback, lyric, line, nextLine, timeMs, error } = useTaskbarLyrics();
const settings = ref({ ...DEFAULT_TASKBAR_LYRIC_SETTINGS });
const dark = ref(true);
const anchor = ref<'left' | 'center' | 'right'>('left');
const maxWidth = ref(400);
const hovered = ref(false);
const focused = ref(false);
const width = ref(MIN_CONTENT_WIDTH);
const primaryWidth = ref(0);
const secondaryWidth = ref(0);
const coverFailed = ref('');
const root = ref<HTMLElement>();
/** 收起态那行「歌名 · 歌手」的隐藏量具：绝对定位、不参与布局，只为量出自然宽度。 */
const nowMeasure = ref<HTMLElement>();
const FALLBACK_FONT_FAMILY = '"Segoe UI", "Microsoft YaHei", sans-serif';
const resolveFontFamily = () => {
  const name = settings.value.fontFamily || 'follow';
  if (name === 'follow') return snapshot.value?.appearance.fontFamily || FALLBACK_FONT_FAMILY;
  return buildFontFamily(name);
};
const colors = computed(() => {
  const palette = neutralThemePalette(dark.value);
  const accent = snapshot.value?.appearance.accentColor || DEFAULT_THEME_ACCENT;
  return {
    '--fg': palette.text,
    '--muted': palette.secondary,
    '--bg': palette.main,
    '--accent': accent,
    '--accent-text': createAccentPaletteFromPrimary(accent, dark.value, [palette.main]).primaryText,
    '--font-size': `${settings.value.fontSize}px`,
    '--lyric-unplayed': palette.secondary,
    fontFamily: resolveFontFamily(),
  };
});
const title = computed(() => playback.value?.title || 'EchoMusic');
// 没在放歌时不再兜底出一行「EchoMusic」：歌词区会整块收起，只留封面。
const primary = computed(
  () => error.value || line.value?.text || (playback.value ? title.value : ''),
);
const secondary = computed(() => {
  if (error.value) return '';
  if (line.value) {
    if (settings.value.showTranslation && line.value.translated) return line.value.translated;
    if (lyric.value?.wantRomanization && line.value.romanized) return line.value.romanized;
    return nextLine.value?.text || playback.value?.artist || '';
  }
  return playback.value?.artist || '双击打开主窗口';
});
// 换行动画的触发键：主行或副行任一文本变化都算一次换行，两行作为整块一起滚动。
const linesKey = computed(() => `${primary.value}\u0000${secondary.value}`);
const seek = useTaskbarSeek(
  () => playback.value,
  (value) => window.electron?.nowPlaying.command({ type: 'seek', value }),
);
const { progressValue, duration, isDragging } = seek;
const lineEndTimeMs = computed(() => {
  if (!line.value) return undefined;
  if (nextLine.value) return nextLine.value.time * 1000;
  const durationMs = playback.value?.clock?.durationMs ?? (playback.value?.duration ?? 0) * 1000;
  return durationMs > 0 ? durationMs + (lyric.value?.timeOffset ?? 0) : undefined;
});
const expanded = computed(() =>
  Boolean(playback.value && (hovered.value || focused.value || isDragging.value)),
);
/** 歌词区收起动画时长，与控制条展开同一套曲线。 */
const LYRIC_COLLAPSE_MS = 300;
/**
 * 不播放时只留封面：歌词滑出、窗口按封面收窄。
 *
 * 判据是 isPlaying 而不是「有没有歌」——暂停时同样收起，悬停仍能展开出控制条，
 * 点播放后歌词再滑回来。
 */
const lyricsCollapsed = computed(() => !playback.value?.isPlaying);
/** 播放中这一档要不要歌词：设置里选「封面」时播放态只剩封面。 */
const showLyricLines = computed(() => settings.value.playingDisplay !== 'cover');
/** 歌词是否真的在位：播放中且这一档要显示歌词。 */
const lyricsActive = computed(() => !lyricsCollapsed.value && showLyricLines.value);
/**
 * 封面是否出现。
 *
 * 播放态看「播放时显示」，暂停态看「暂停时显示」——同一项在两状态里可以各显不显，
 * 这也是存档从「一个封面布尔」改成两档枚举的原因。
 */
const coverVisible = computed(() =>
  lyricsCollapsed.value
    ? settings.value.pausedDisplay !== 'name'
    : settings.value.playingDisplay !== 'lyrics',
);
/** 暂停态那一行「歌名·歌手」是否出现（悬停展开时另有一块 song-info，与它无关）。 */
const nowVisible = computed(
  () => lyricsCollapsed.value && settings.value.pausedDisplay !== 'cover',
);
/**
 * 歌词行只区分左右滚动方向：中间对齐时内容仍从左侧开始排，溢出方向同左对齐。
 *
 * TaskbarLyricLine 的 anchor 只有 left/right，这里收敛一次，避免把 center 传下去。
 */
const lyricAnchor = computed<'left' | 'center' | 'right'>(() => {
  if (anchor.value === 'right') return 'right';
  // 居中档里只有「封面 + 歌词」并排那一档贴左，其余（含只显示歌词）文字居中。
  return anchor.value === 'center' && !pinned.value ? 'center' : 'left';
});
/**
 * 播放中是否「封面 + 歌词」并排。
 *
 * 只有这一档内容宽度会随换行变化，需要贴左避免整条左右跳；
 * 播放中只显示封面或只显示歌词时宽度是稳的（歌词档由窗口上限兜住），
 * 按居中档正常对中即可。
 */
const lyricsBesideCover = computed(
  () => lyricsActive.value && settings.value.playingDisplay === 'both',
);
/**
 * 居中档把窗口宽度锁在展开上限。
 *
 * 宽度变一次就要重新对中一次，而歌词每换一行宽度都会变、悬停出控制条也会变，
 * 结果就是条子一直在左右跳。锁宽后只有暂停收起（idle）才会改动宽度。
 */
const pinned = computed(() => anchor.value === 'center' && lyricsBesideCover.value);
/** 窗口可见宽度（= 原生给的空闲区宽度）：内容改成绝对定位后要自己算左右位置。 */
const viewportWidth = ref(window.innerWidth);
/**
 * 内容框左沿。居中档播放时贴左、暂停时居中，右对齐档贴右；左对齐档恒为 0。
 *
 * 只有左沿参与补间（见样式里的 transition），宽度仍和原生窗口形状同步瞬间变化，
 * 于是暂停时图案是「滑」到中间的，而不是整体瞬移。
 */
const contentLeft = computed(() => {
  const slack = viewportWidth.value - width.value;
  if (anchor.value === 'right') return Math.max(0, slack);
  if (anchor.value === 'center' && !pinned.value) return Math.max(0, Math.round(slack / 2));
  return 0;
});
const syncViewportWidth = () => {
  viewportWidth.value = window.innerWidth;
};
let hoverLeaveTimer: ReturnType<typeof setTimeout> | undefined;
const setHovered = (value: boolean) => {
  clearTimeout(hoverLeaveTimer);
  if (value) hovered.value = true;
  else
    hoverLeaveTimer = setTimeout(() => {
      hovered.value = false;
    }, 60);
};
const command = (value: NowPlayingCommand) => {
  if (playback.value) window.electron?.nowPlaying.command(value);
};
const showMain = () => window.electron?.taskbarLyric?.showMain();
/** 内容块补间时长（与 .content 的 width/left 过渡一致）加一点余量。 */
const BOX_SYNC_MS = 320;
let boxSyncFrame = 0;
let boxSyncUntil = 0;
let boxAlign: TaskbarContentAlign = 'start';
/**
 * 窗口里还有没有东西可显示。
 *
 * 两档设置保证每种状态至少留一样东西，所以正常情况下恒为 false；留这一层是因为
 * 没有播放内容时歌词与歌名的文本都是空的，只剩封面图案，仍要把结果如实报给主进程。
 */
const blanked = computed(
  () => !expanded.value && !coverVisible.value && !lyricsActive.value && !nowVisible.value,
);
/**
 * 把窗口形状逐帧贴到内容块上。
 *
 * 播放↔暂停时图案是滑过去的：只把最终宽度交给主进程，可见区会先一步缩到终点，
 * 图案在过渡途中被裁在旧区域里，看上去就是「窗口先到位、图案后到」。
 * 这里用 rAF 采样内容块的实测矩形，一路喂到补间结束。
 */
const sendContentBox = () => {
  const element = root.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  window.electron?.taskbarLyric?.setContentWidth(rect.width, boxAlign, Math.round(rect.x));
};
const startBoxSync = () => {
  boxSyncUntil = Date.now() + BOX_SYNC_MS;
  if (boxSyncFrame) return;
  const step = () => {
    boxSyncFrame = 0;
    if (!alive) return;
    sendContentBox();
    if (Date.now() >= boxSyncUntil) return;
    boxSyncFrame = requestAnimationFrame(step);
  };
  boxSyncFrame = requestAnimationFrame(step);
};
let alive = true;
let receivedState = false;
let disposeState: (() => void) | undefined;
/**
 * 换行动画进行中：期间不收窄窗口宽度，见 resolveContentWidth。
 *
 * 由过渡的 before-enter / after-enter 驱动，不用定时器。切行过于频繁时前一次
 * enter 会被打断，Vue 触发的是 enter-cancelled 而非 after-enter——这里**有意不**
 * 处理 enter-cancelled：打断后紧接着的新过渡会再次 before-enter、并最终以
 * after-enter 收尾，rolling 不会卡住；若在 enter-cancelled 就复位，反而会在
 * 连续切行的中途误放行、重现被裁。
 */
let rolling = false;
/**
 * 收起动画进行中：期间同样不收窄窗口。
 *
 * 窗口宽度就是可见区，先收窄等于把歌词裁掉，滑动会变成瞬间消失。这里用定时器
 * 而不是 transitionend：收起完成后歌词块已经 opacity:0，拿不到稳定的事件。
 */
let collapsing = false;
let collapseTimer: ReturnType<typeof setTimeout> | undefined;
const reportWidth = async () => {
  await nextTick();
  if (!alive) return;
  const element = root.value;
  if (!element) return;
  const style = getComputedStyle(element);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const coverWidth = coverVisible.value
    ? (element.querySelector('.cover')?.getBoundingClientRect().width ?? 0) +
      parseFloat(style.columnGap)
    : 0;
  // 收起态歌词已经让出位置，但两行的实测宽度还停在收起前的值，
  // 必须在这里直接按 0 计，否则窗口收不窄。
  // 收起态歌词区让出宽度，只剩「歌名 · 歌手」这一行：量它的自然宽度，
  // 不再写死 0（那会把窗口压到只剩封面，暂停时看不到在放什么）。
  const textWidth = lyricsActive.value
    ? Math.max(primaryWidth.value, secondaryWidth.value)
    : nowVisible.value
      ? Math.ceil(nowMeasure.value?.getBoundingClientRect().width ?? 0)
      : 0;
  const naturalWidth = Math.ceil(textWidth + coverWidth + padding + 8);
  width.value = resolveContentWidth({
    natural: naturalWidth,
    maxWidth: maxWidth.value,
    expanded: expanded.value,
    idle: !lyricsActive.value,
    rolling: rolling || collapsing,
    current: width.value,
  });
  // 「封面 + 歌词」并排时贴空闲区左端（宽度随文字向右长），其余档居中。
  const align: TaskbarContentAlign = lyricsBesideCover.value ? 'start' : 'center';
  boxAlign = align;
  // 目标宽度只用于布局，可见区域始终按实测矩形喂，补间途中也不会裁到图案。
  startBoxSync();
};
/**
 * 换行动画结束：这时旧行已经滑出，才可以把宽度收到新行的尺寸。
 *
 * 依赖进入与离开用的是同一段 0.5s 过渡（`.taskbar-lines-*-active`）：after-enter
 * 与新行的 enter 同时开始，与旧行的 leave 才会同时收尾。若将来单独改掉其中一方
 * 的时长，after-enter 可能早于旧行完全滑出，会重新出现「尾巴被裁一小截」。
 */
const finishRoll = () => {
  rolling = false;
  void reportWidth();
};
// settings 由 normalizeTaskbarLyricSettings 整体替换，其余源为标量 ref，无需 deep 遍历
watch([expanded, maxWidth, primaryWidth, secondaryWidth, settings, pinned], reportWidth);
// 空窗与宽度走两条通道：宽度靠 rAF 逐帧贴（窗口藏起来后 rAF 会停），
// 空窗标记必须一翻转就送到主进程，否则藏下去就再也没机会叫醒它。
watch(
  blanked,
  (value) => {
    window.electron?.taskbarLyric?.setBlank?.(value);
  },
  { immediate: true },
);
watch(lyricsActive, (active) => {
  clearTimeout(collapseTimer);
  collapsing = !active;
  if (active) {
    void reportWidth();
    return;
  }
  collapseTimer = setTimeout(() => {
    collapsing = false;
    void reportWidth();
  }, LYRIC_COLLAPSE_MS);
});
watch(secondary, (value) => {
  if (!value) secondaryWidth.value = 0;
});
const focusOut = (event: FocusEvent) => {
  if (!root.value?.contains(event.relatedTarget as Node | null)) focused.value = false;
};
const stateListener = (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as TaskbarLyricState;
  receivedState = true;
  dark.value = Boolean(value.isDark);
  anchor.value = value.anchor === 'right' ? 'right' : value.anchor === 'center' ? 'center' : 'left';
  maxWidth.value = Number(value.maxWidth) || 400;
  settings.value = normalizeTaskbarLyricSettings(value.settings);
};
onMounted(async () => {
  const api = window.electron?.taskbarLyric;
  if (!api) {
    error.value = '连接不可用，请重新打开任务栏歌词';
    return;
  }
  window.addEventListener('resize', syncViewportWidth);
  disposeState = api.onStateChange(stateListener);
  try {
    const value = await api.getState();
    if (alive && !receivedState) stateListener(value);
  } catch {
    if (alive) error.value = '连接失败，请重新打开任务栏歌词';
  }
  void reportWidth();
});
onUnmounted(() => {
  alive = false;
  if (boxSyncFrame) cancelAnimationFrame(boxSyncFrame);
  boxSyncFrame = 0;
  window.removeEventListener('resize', syncViewportWidth);
  clearTimeout(hoverLeaveTimer);
  clearTimeout(collapseTimer);
  disposeState?.();
});
</script>
<template>
  <section
    class="taskbar"
    :class="{ dark, right: anchor === 'right', center: anchor === 'center', pinned }"
    :style="colors"
    aria-label="任务栏歌词"
    @mouseenter="setHovered(true)"
    @mouseleave="setHovered(false)"
    @dblclick="showMain"
  >
    <div
      ref="root"
      class="content"
      role="group"
      tabindex="0"
      :aria-label="primary"
      :class="{ expanded }"
      :style="{ width: `${width}px`, left: `${contentLeft}px` }"
      @focusin="focused = ($event.target as HTMLElement).matches(':focus-visible')"
      @focusout="focusOut"
    >
      <button
        v-if="coverVisible"
        type="button"
        class="cover"
        aria-label="打开 EchoMusic"
        @click="showMain"
      >
        <img
          v-if="playback?.coverUrl && coverFailed !== playback.coverUrl"
          :src="playback.coverUrl"
          alt=""
          draggable="false"
          decoding="async"
          @error="coverFailed = playback?.coverUrl || ''"
        />
        <Icon v-else :icon="iconMusic" width="14" />
      </button>
      <div class="body">
        <div
          v-if="playback"
          class="controls"
          :inert="!expanded"
          :aria-hidden="!expanded"
          @dblclick.stop
        >
          <button type="button" aria-label="上一曲" @click="command('previousTrack')">
            <Icon :icon="iconSkipBack" width="14" />
          </button>
          <button
            type="button"
            class="play"
            :aria-label="playback.isPlaying ? '暂停' : '播放'"
            @click="command('togglePlayback')"
          >
            <Icon :icon="playback.isPlaying ? iconPause : iconPlay" width="14" />
          </button>
          <button type="button" aria-label="下一曲" @click="command('nextTrack')">
            <Icon :icon="iconSkipForward" width="14" />
          </button>
          <button
            type="button"
            class="favorite"
            :class="{ active: playback.isFavorite }"
            :aria-label="playback.isFavorite ? '取消收藏' : '收藏'"
            :aria-pressed="playback.isFavorite"
            @click="command('toggleFavorite')"
          >
            <Icon :icon="playback.isFavorite ? iconHeartFilled : iconHeart" width="14" />
          </button>
        </div>
        <div class="details" :class="{ 'has-progress': playback && duration }">
          <div
            class="copy"
            :class="{ collapsed: !lyricsActive }"
            :aria-hidden="expanded || !lyricsActive"
          >
            <!-- 两个钩子用来在换行动画期间冻结/解冻窗口宽度，规则见 lyricWidth.ts：
                 新文本一测量完就会把窗口收窄，而旧行还要再向上滑出 0.5s，
                 这段时间被裁掉的就是旧行的尾巴。 -->
            <Transition
              name="taskbar-lines"
              @before-enter="rolling = true"
              @after-enter="finishRoll"
            >
              <div :key="linesKey" class="lines">
                <TaskbarLyricLine
                  class="primary"
                  :text="primary"
                  :line="line"
                  :time-ms="timeMs"
                  :end-time-ms="lineEndTimeMs"
                  :word-by-word="settings.wordByWord"
                  :anchor="lyricAnchor"
                  @width="primaryWidth = $event"
                />
                <TaskbarLyricLine
                  v-if="secondary"
                  class="secondary"
                  :text="secondary"
                  :time-ms="timeMs"
                  :anchor="lyricAnchor"
                  @width="secondaryWidth = $event"
                />
              </div>
            </Transition>
          </div>
          <!-- 暂停态按「暂停时显示」决定要不要这一行（悬停展开时由 song-info 顶替）。 -->
          <div v-if="nowVisible && !expanded" class="now">
            <span class="now-title">{{ title }}</span>
            <span v-if="playback?.artist" class="now-artist">{{ playback.artist }}</span>
          </div>
          <span v-if="nowVisible" ref="nowMeasure" class="now-measure" aria-hidden="true">
            {{ title }}{{ playback?.artist ? ' · ' + playback.artist : '' }}
          </span>
          <div class="song-info" :aria-hidden="!expanded">
            <div class="song-title" :title="title">{{ title }}</div>
            <div class="song-artist" :title="playback?.artist">{{ playback?.artist }}</div>
          </div>
          <SliderRoot
            v-if="playback && duration"
            class="progress echo-slider echo-slider-progress"
            :data-dragging="isDragging"
            :inert="!expanded"
            :min="0"
            :max="duration"
            :model-value="progressValue"
            :step="0.1"
            @pointerdown.capture="seek.handleStart"
            @keydown.capture="seek.handleKeydown"
            @keyup="seek.handleEnd"
            @update:model-value="seek.handleValueUpdate"
            @value-commit="seek.handleCommit"
            @pointerup="seek.handleEnd"
            @pointercancel="seek.handleCancel"
            @blur.capture="seek.handleCancel"
          >
            <SliderTrack class="progress-track echo-slider-track"
              ><SliderRange class="progress-range echo-slider-range"
            /></SliderTrack>
            <SliderThumb class="echo-slider-thumb" aria-label="播放进度" />
          </SliderRoot>
        </div>
      </div>
    </div>
  </section>
</template>
<style>
html,
body,
#app {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent;
}
* {
  box-sizing: border-box;
}
.taskbar {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  color: var(--fg);
  user-select: none;
  pointer-events: auto;
}
.taskbar.right {
  justify-content: flex-end;
}
.taskbar.center {
  justify-content: center;
}
/* 居中档锁宽后窗口不再随内容收缩，内容从窗口左沿开始排：
   宽度不变就不需要对中，换行与悬停都不会再把整条挪走。 */
.taskbar.center.pinned {
  /* 内容已绝对定位，这里只为保底：位置由 .content 的 left 决定。 */
  justify-content: flex-start;
}
/* 控制条仍按原样从 0 展开（悬停时把歌词向右让开），
   但窗口宽度已被锁住，所以让位只发生在窗口内部，整条不再移动。 */
.taskbar.right .content,
.taskbar.right .body {
  flex-direction: row-reverse;
}
.taskbar.right .song-info {
  text-align: right;
}
.content {
  position: absolute;
  top: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
  height: calc(100% - 8px);
  padding: 0 4px;
  /* 播放↔暂停时图案从窗口左沿滑到中间，宽度一起补间；
     窗口形状由 reportWidth 逐帧贴上来（见 startBoxSync），三者同时到位。 */
  min-width: 0;
  border-radius: 8px;
  background: transparent;
  pointer-events: none;
  transition:
    width 260ms cubic-bezier(0.22, 1, 0.36, 1),
    left 260ms cubic-bezier(0.22, 1, 0.36, 1),
    background-color 180ms ease;
}
.content.expanded {
  background: color-mix(in srgb, var(--fg) 5%, transparent);
}
.expanded .cover {
  width: min(calc(100vh - 16px), calc((100vw - 112px) / 5));
  height: min(calc(100vh - 16px), calc((100vw - 112px) / 5));
}
.cover {
  pointer-events: auto;
  width: calc(100vh - 16px);
  height: calc(100vh - 16px);
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--fg) 8%, transparent);
}
.cover img {
  pointer-events: none;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: inherit;
}
.cover svg {
  max-width: 100%;
  max-height: 100%;
}
.copy {
  position: relative;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  height: 100%;
  overflow: hidden;
  line-height: 1.2;
  opacity: 1;
  /* 与控制条同一套曲线：max-width 收起/展开，opacity 同步淡出。 */
  transition:
    max-width 300ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 180ms ease;
}
.copy.collapsed {
  max-width: 0;
  opacity: 0;
}
/* 收起态那一行歌名：绝对定位铺满详情区并垂直居中。
   不能用普通流——同级的 .copy 即使收起（max-width: 0）仍占满高度，
   歌名会被顶到容器底部之外。 */
.now {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  gap: 0;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  line-height: 1.2;
}
.now-title,
.now-artist {
  overflow: hidden;
  text-overflow: ellipsis;
}
.now-artist {
  flex-shrink: 0;
  color: var(--muted);
}
.now-artist::before {
  content: ' · ';
}
/* 量具：绝对定位 + max-content，天然宽度不受父级可见宽度裁剪。 */
.now-measure {
  position: absolute;
  top: 0;
  left: 0;
  width: max-content;
  white-space: nowrap;
  visibility: hidden;
  pointer-events: none;
}
/* 换行动画作用在整块歌词上，而不是每一行各自动画。
   两行放进同一个满高容器里滚动，裁切也只在这一层做——若每行各自在
   自己的 overflow 盒子里滑动，中途每行都是「上半空、下半新字」，
   看上去就是每行各动各的、切换时割裂。 */
.lines {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: space-evenly;
}
.taskbar-lines-enter-active,
.taskbar-lines-leave-active {
  transition:
    transform 0.5s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}
.taskbar-lines-leave-active {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.taskbar-lines-enter-from {
  opacity: 0;
  transform: translateY(100%);
}
.taskbar-lines-leave-to {
  opacity: 0;
  transform: translateY(-100%);
}
.expanded .copy {
  opacity: 0;
}
.body {
  flex: 1;
  min-width: 0;
  align-self: stretch;
  display: flex;
  align-items: center;
}
.details {
  --song-font-size: min(var(--font-size), max(11px, calc((100vh - 21px) / 1.9)));
  position: relative;
  flex: 1;
  min-width: 0;
  height: 100%;
  margin: 0 4px;
  overflow: hidden;
}
.song-info {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-evenly;
  line-height: 1.04;
  opacity: 0;
  pointer-events: none;
  transition: opacity 180ms ease;
}
.expanded .has-progress .song-info {
  bottom: 12px;
}
.expanded .song-info {
  opacity: 1;
  transition-delay: 80ms;
}
.expanded .song-title,
.expanded .song-artist {
  pointer-events: auto;
}
.song-title,
.song-artist {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.song-title {
  font-size: var(--song-font-size);
}
.song-artist {
  font-size: calc(var(--song-font-size) * 0.82);
  color: var(--muted);
}
.primary {
  font-size: min(var(--font-size), max(11px, calc((100vh - 10px) / 2.3)));
  font-weight: 400;
}
.secondary {
  font-size: calc(min(var(--font-size), max(11px, calc((100vh - 10px) / 2.3))) * 0.82);
  color: var(--muted);
}
.controls {
  --control-size: min(calc(100vh - 16px), calc((100vw - 112px) / 5));
  display: flex;
  flex-shrink: 0;
  height: 100%;
  max-width: 0;
  overflow: hidden;
  gap: 4px;
  align-items: center;
  opacity: 0;
  pointer-events: none;
  transition:
    max-width 300ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 180ms ease;
}
.expanded .controls {
  max-width: calc(4 * var(--control-size) + 20px);
  padding: 4px;
  opacity: 1;
  pointer-events: auto;
}
button {
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.controls button {
  width: var(--control-size);
  height: var(--control-size);
  flex-shrink: 0;
  border-radius: 6px;
  transition:
    background-color 180ms ease,
    transform 180ms ease;
}
.controls svg {
  width: 14px;
  height: 14px;
  max-width: 100%;
  max-height: 100%;
}
.controls button:hover,
.cover:hover {
  background: color-mix(in srgb, var(--fg) 10%, transparent);
}
.controls .play {
  color: var(--accent-text);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.controls .play:hover {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}
.controls button:active {
  transform: scale(0.94);
}
.favorite.active {
  color: #ef4444;
}
button:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--fg) 35%, transparent);
  outline-offset: -1px;
}
.progress {
  --slider-track-size: 2px;
  --slider-thumb-size: 8px;
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 12px;
  display: flex;
  align-items: center;
  opacity: 0;
  pointer-events: none;
  touch-action: none;
  cursor: pointer;
}
.progress .echo-slider-range,
.progress .echo-slider-thumb {
  background: var(--accent-text);
}
.expanded .progress {
  opacity: 1;
  pointer-events: auto;
}
@media (max-width: 260px) {
  .expanded .cover {
    display: none;
  }
  .controls {
    --control-size: min(calc(100vh - 16px), calc((100vw - 80px) / 4));
  }
  .expanded .details {
    min-width: 32px;
  }
  .song-info {
    display: none;
  }
}
@media (max-height: 44px) {
  .song-artist {
    display: none;
  }
  .details {
    --song-font-size: min(var(--font-size), max(11px, calc(100vh - 22px)));
  }
}
@media (max-height: 36px) {
  .secondary {
    display: none;
  }
  .primary {
    font-size: min(var(--font-size), max(11px, calc(100vh - 16px)));
  }
}
@media (max-height: 30px) {
  .song-info {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .content,
  .copy,
  .song-info,
  .controls,
  .controls button,
  .taskbar-lines-enter-active,
  .taskbar-lines-leave-active {
    transition: none;
  }
}
@media (forced-colors: active) {
  .taskbar {
    --fg: CanvasText !important;
    --muted: CanvasText !important;
    --bg: Canvas !important;
    --accent-text: Highlight !important;
  }
  .content {
    background: Canvas;
  }
  button:focus-visible {
    outline-color: Highlight;
  }
}
</style>
