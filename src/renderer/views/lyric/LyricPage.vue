<script setup lang="ts">
import Tooltip from '@/components/ui/Tooltip.vue';

defineOptions({ name: 'lyric-page' });

import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useLyricStore } from '@/stores/lyric';
import { useToastStore } from '@/stores/toast';
import { usePlayerControls } from '@/composables/usePlayerControls';
import { useLyricBackground } from './composables/useLyricBackground';
import { coverFallbackRevision } from '@/plugins/coverFallback';
import { resolveCoverDisplayUrl } from '@/utils/cover';
import LyricPageTitlebar from './LyricPageTitlebar.vue';
import PluginLyricsPageView from '@/plugins/PluginLyricsPageView';
import {
  resolveLyricsPage,
  resolveLyricSkinKey,
  HOST_SKIN_PREFIX,
  setSkinsOpenHandler,
} from '@/plugins/lyricsPage';
import type { LyricsPageContribution } from '@/plugins/lyricsPage';
import { useLyricsPageContext, type LyricsPagePanel } from './composables/useLyricsPageContext';
import QualityPopover from '@/components/player/QualityPopover.vue';
import EffectPopover from '@/components/player/EffectPopover.vue';
import type { Song } from '@/models/song';
import Button from '@/components/ui/Button.vue';
import AddToPlaylistDialog from '@/components/music/AddToPlaylistDialog.vue';
import PlayerQueueDrawer from '@/components/music/PlayerQueueDrawer.vue';
import BarrageControls from '@/components/music/BarrageControls.vue';
import BarrageLayer from '@/components/music/BarrageLayer.vue';
import CommentDrawer from '@/components/music/CommentDrawer.vue';
import CoverMode from './CoverMode.vue';
import PortraitMode from './PortraitMode.vue';
import LyricMode from './LyricMode.vue';
// Apple Music（AMLL）皮肤为异步组件：仅当该皮肤被使用时才加载其依赖。
const AmllMode = /* #__PURE__ */ defineAsyncComponent(() => import('./AmllMode.vue'));
import LyricPlayerControls from './LyricPlayerControls.vue';
import LyricSettingsDrawer from './LyricSettingsDrawer.vue';
import { openSettingsDialog } from '@/composables/useSettingsDialog';
import LyricSourceDialog from './LyricSourceDialog.vue';
import LyricFluidBackground from './LyricFluidBackground.vue';
import {
  iconChevronLeft,
  iconChevronRight,
  iconList,
  iconArrowBarDown,
  iconArrowBarToUp,
  iconRotateCcw,
  iconRotateCw,
  iconRefreshCw,
  iconCopy,
} from '@/icons';

const barrageRef = ref<InstanceType<typeof BarrageLayer> | null>(null);

const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const barrageEnabled = computed({
  get: () => settingStore.lyricBarrageEnabled,
  set: (value: boolean) => {
    settingStore.lyricBarrageEnabled = value;
  },
});
const lyricStore = useLyricStore();
const toastStore = useToastStore();

const controls = usePlayerControls();
const {
  currentTrack,
  isQueueDrawerOpen,
  showAddToPlaylistDialog,
  isPlaylistLoading,
  createdPlaylists,
  addToPlaybackQueues,
  handleOpenAddToPlaylist,
  handleAddToQueue,
  handleSelectPlaylist,
} = controls;

const skin = computed(() =>
  resolveLyricsPage(
    resolveLyricSkinKey(settingStore.lyricsPageProvider, settingStore.lyricViewMode),
  ),
);
/** 自定义皮肤（插件提供）；内置皮肤返回 null。 */
const pluginPage = computed<LyricsPageContribution | null>(() => {
  const current = skin.value;
  return current && !current.key.startsWith(HOST_SKIN_PREFIX)
    ? (current as LyricsPageContribution)
    : null;
});
const isBuiltinSkin = computed(() => !pluginPage.value);
const titlebar = computed(() => skin.value?.titlebar ?? 'host');
/** 自定义皮肤是否使用宿主右侧歌词工具按钮。 */
const pluginTools = computed(() => pluginPage.value?.tools ?? 'host');

// 背景主题色
const coverUrl = computed(() => currentTrack.value?.coverUrl);
const { backgroundColor } = useLyricBackground(coverUrl);
const displayCoverUrl = computed(() => {
  void coverFallbackRevision.value;
  return resolveCoverDisplayUrl(coverUrl.value, 400, { scope: 'lyric-background' });
});

// 当前模式（由当前皮肤推导，内置皮肤才使用）
const viewMode = computed(() => {
  const key = skin.value?.key ?? `${HOST_SKIN_PREFIX}cover`;
  if (key === `${HOST_SKIN_PREFIX}portrait`) return 'portrait';
  if (key === `${HOST_SKIN_PREFIX}cover`) return 'cover';
  if (key === `${HOST_SKIN_PREFIX}amll`) return 'amll';
  return 'lyric';
});

// 模糊背景封面 URL（用较小尺寸节省内存）
const blurCoverUrl = computed(() => {
  if (!settingStore.lyricPageBackgroundBlur || !displayCoverUrl.value) return '';
  const url = displayCoverUrl.value;
  // 替换尺寸参数为 400（模糊后不需要高分辨率）
  return url.replace(/\{size\}/g, '400').replace(/\/\d+(?=\/\d{8}\/)/, '/400');
});
const settledBlurCoverUrl = ref('');
let blurCoverSettleTimer: number | null = null;
const BLUR_COVER_SETTLE_MS = 180;

watch(
  blurCoverUrl,
  (url) => {
    if (blurCoverSettleTimer !== null) {
      window.clearTimeout(blurCoverSettleTimer);
      blurCoverSettleTimer = null;
    }
    if (!url) {
      settledBlurCoverUrl.value = '';
      return;
    }
    blurCoverSettleTimer = window.setTimeout(() => {
      blurCoverSettleTimer = null;
      settledBlurCoverUrl.value = url;
    }, BLUR_COVER_SETTLE_MS);
  },
  { immediate: true },
);

// 背景律动：流体背景，固定速度且不关联播放状态
const isBlurBackgroundRhythmEnabled = computed(
  () =>
    !settingStore.effectiveWindowBackground.frosted &&
    settingStore.lyricPageBackgroundBlur &&
    settingStore.lyricPageBackgroundRhythm &&
    Boolean(settledBlurCoverUrl.value) &&
    viewMode.value !== 'portrait',
);

// 背景样式
const backgroundStyle = computed(() => {
  if (viewMode.value === 'portrait') {
    // 写真模式：模糊背景启用时用黑色底色，否则不设（让写真图片透出）
    if (settingStore.lyricPageBackgroundBlur && settledBlurCoverUrl.value) {
      return { backgroundColor: '#000000' };
    }
    return {};
  }
  // 启用模糊背景时使用深色底色（图片叠加在上面）
  if (settingStore.lyricPageBackgroundBlur && settledBlurCoverUrl.value) {
    return { backgroundColor: '#000000' };
  }
  // 封面/歌词模式使用主题色
  if (backgroundColor.value) {
    return { backgroundColor: backgroundColor.value };
  }
  return { backgroundColor: '#1a1d22' };
});

// 设置 Drawer：'skins' 为换肤面板（点皮肤卡进入该皮肤设置），'settings' 直接进入当前皮肤设置
const isSettingsOpen = ref(false);
const settingsView = ref<'skins' | 'settings'>('skins');
const openSettings = (view: 'skins' | 'settings') => {
  settingsView.value = view;
  isSettingsOpen.value = true;
};

// 写真模式 ref
const portraitModeRef = ref<InstanceType<typeof PortraitMode> | null>(null);

// 评论抽屉
const isCommentDrawerOpen = ref(false);
const commentTrack = ref<Song | null>(null);
const isQualityOpen = ref(false);
const isEffectOpen = ref(false);
const openComments = () => {
  if (!currentTrack.value) throw new Error('当前没有歌曲');
  commentTrack.value = { ...currentTrack.value };
  isCommentDrawerOpen.value = true;
};
const closePanels = () => {
  isSettingsOpen.value = false;
  settingsView.value = 'skins';
  isQueueDrawerOpen.value = false;
  isCommentDrawerOpen.value = false;
  showAddToPlaylistDialog.value = false;
  lyricStore.sourceDialogOpen = false;
  isQualityOpen.value = false;
  isEffectOpen.value = false;
};
const openPanel = async (panel: LyricsPagePanel) => {
  if (
    ![
      'queue',
      'lyrics-picker',
      'quality-picker',
      'audio-effects',
      'comments',
      'add-to-playlist',
      'settings',
    ].includes(panel)
  ) {
    throw new Error('未知的歌词页面板');
  }
  if (['lyrics-picker', 'comments', 'add-to-playlist'].includes(panel) && !currentTrack.value) {
    throw new Error('当前没有歌曲');
  }
  if (panel === 'add-to-playlist' && !controls.canAddToPlaylist.value) {
    throw new Error('请先登录后添加到歌单');
  }
  closePanels();
  switch (panel) {
    case 'queue':
      isQueueDrawerOpen.value = true;
      break;
    case 'lyrics-picker':
      lyricStore.sourceDialogOpen = true;
      break;
    case 'quality-picker':
      isQualityOpen.value = true;
      break;
    case 'audio-effects':
      isEffectOpen.value = true;
      break;
    case 'comments':
      openComments();
      break;
    case 'add-to-playlist':
      await handleOpenAddToPlaylist();
      break;
    case 'settings':
      openSettings('skins');
      break;
  }
};
const pageContext = useLyricsPageContext(controls, titlebar, openPanel, closePanels, {
  enabled: barrageEnabled,
  send: (content: string) => barrageRef.value?.onSent(content),
});
watch(pluginPage, (next, previous) => {
  if (next !== previous) closePanels();
  // 仅当 provider 指向自定义皮肤但解析失败时才提示；用户主动切换到内置皮肤不提示
  if (previous && !next && !settingStore.lyricsPageProvider.startsWith(HOST_SKIN_PREFIX)) {
    toastStore.warning('自定义歌词页不可用，已恢复默认歌词页');
    settingStore.lyricsPageProvider = `${HOST_SKIN_PREFIX}cover`;
  }
});

// 鼠标活动状态（写真收起时控制按钮显隐）
const isMouseActive = ref(false);
let mouseActiveTimer: number | null = null;

const handlePageMouseMove = () => {
  isMouseActive.value = true;
  if (mouseActiveTimer) window.clearTimeout(mouseActiveTimer);
  mouseActiveTimer = window.setTimeout(() => {
    isMouseActive.value = false;
    mouseActiveTimer = null;
  }, 3000);
};

// 内容区域 hover 状态（控制工具按钮显隐）
const isContentHovered = ref(false);

const handleContentEnter = () => {
  isContentHovered.value = true;
};

const handleContentLeave = () => {
  isContentHovered.value = false;
};

// 收起状态快捷计算
const isCollapsed = computed(
  () => viewMode.value === 'portrait' && !!portraitModeRef.value?.isLyricCollapsed,
);

// 歌词工具按钮
const hasLyrics = computed(() => lyricStore.lines.length > 0);

// 歌词对齐微调步长（秒），来自设置，兜底 0.5s
const lyricOffsetStep = computed(() => {
  const step = Number(settingStore.lyricOffsetStep);
  return Number.isFinite(step) && step > 0 ? step : 0.5;
});
const lyricOffsetStepLabel = computed(() => `${lyricOffsetStep.value.toFixed(1)}s`);

const handleOffsetAdjust = (direction: 1 | -1) => {
  const deltaMs = direction * Math.round(lyricOffsetStep.value * 1000);
  const newOffset = lyricStore.adjustTimeOffset(deltaMs);
  const sign = newOffset >= 0 ? '+' : '';
  toastStore.success(`歌词偏移: ${sign}${(newOffset / 1000).toFixed(1)}s`);
  lyricStore.updateCurrentIndex(playerStore.currentTime);
};

const handleOffsetReset = () => {
  lyricStore.resetTimeOffset();
  toastStore.success('歌词偏移已重置');
  lyricStore.updateCurrentIndex(playerStore.currentTime);
};

const handleCopyLyrics = async () => {
  const text = lyricStore.copyableText.trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  toastStore.success('歌词已复制');
};

// 确保歌词加载
const currentTrackLyricHash = computed(() =>
  String(currentTrack.value?.hash ?? currentTrack.value?.id ?? '').trim(),
);

const ensureLyricsForCurrentTrack = () => {
  const track = currentTrack.value;
  if (!track) return;

  const lyricHash = currentTrackLyricHash.value;
  if (!lyricHash) {
    if (lyricStore.lines.length === 0) lyricStore.clear('', '暂无歌词');
    return;
  }

  if (lyricStore.loadedHash !== lyricHash) {
    if (track.lyric) {
      lyricStore.setLyric(track.lyric, lyricHash);
    } else if (lyricStore.lines.length === 0) {
      lyricStore.clear(lyricHash, '歌词加载中...');
    }
  }

  void lyricStore.fetchLyrics(lyricHash, {
    preserveCurrent: Boolean(track.lyric),
    duration: track.duration ? track.duration * 1000 : undefined,
    track,
  });
};

// 关闭歌词页
const closeLyricPage = () => {
  playerStore.toggleLyricView(false);
};

// 键盘事件
const handleKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  // Modal dialogs own Escape and focus restoration, including dialogs above our drawers.
  if (document.querySelector('[role="dialog"][data-dialog-stack-interactive="true"]')) return;
  // Handle our panels before their window listeners can close them and expose the page.
  const openPanelRefs = [
    showAddToPlaylistDialog,
    isEffectOpen,
    isQualityOpen,
    isCommentDrawerOpen,
    isQueueDrawerOpen,
    isSettingsOpen,
  ];
  if (lyricStore.sourceDialogOpen) {
    lyricStore.sourceDialogOpen = false;
  } else {
    const panel = openPanelRefs.find((value) => value.value);
    if (panel) panel.value = false;
    else {
      // Let nested plugin/host dialogs process Escape themselves.
      if (
        Array.from(document.querySelectorAll('[role="dialog"]')).some(
          (el) => el.getAttribute('aria-hidden') !== 'true' && el.getClientRects().length > 0,
        )
      )
        return;
      closeLyricPage();
    }
  }
  event.preventDefault();
  event.stopImmediatePropagation();
};

watch(
  () => currentTrack.value?.id,
  () => {
    ensureLyricsForCurrentTrack();
  },
  { immediate: true },
);

onMounted(() => {
  ensureLyricsForCurrentTrack();
  window.addEventListener('keydown', handleKeydown, true);
  // 注册换肤面板打开回调，供插件通过 ctx.ui.lyricsPage.openSkins() 调用
  setSkinsOpenHandler(() => openSettings('skins'));
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown, true);
  closePanels();
  if (mouseActiveTimer) window.clearTimeout(mouseActiveTimer);
  if (blurCoverSettleTimer !== null) window.clearTimeout(blurCoverSettleTimer);
  setSkinsOpenHandler(null);
});
</script>

<template>
  <div
    class="lyric-page fixed inset-0 z-1300 h-screen w-screen overflow-hidden select-none transition-colors duration-500"
    :class="{
      'is-portrait': isBuiltinSkin && viewMode === 'portrait',
      'is-plugin-page': !!pluginPage,
    }"
    :style="isBuiltinSkin && viewMode === 'portrait' ? backgroundStyle : undefined"
    @mousemove="handlePageMouseMove"
  >
    <div
      v-if="isBuiltinSkin && viewMode !== 'portrait'"
      class="lyric-background"
      :style="backgroundStyle"
      aria-hidden="true"
    >
      <!-- 模糊封面背景层 -->
      <div
        v-if="settingStore.lyricPageBackgroundBlur && settledBlurCoverUrl"
        class="lyric-blur-bg"
        :class="{ 'lyric-blur-bg--rhythm': isBlurBackgroundRhythmEnabled }"
      >
        <img
          :src="settledBlurCoverUrl"
          class="lyric-blur-bg-img"
          :class="{ 'lyric-blur-bg-img--rhythm': isBlurBackgroundRhythmEnabled }"
        />
        <LyricFluidBackground
          :cover-url="settledBlurCoverUrl"
          :enabled="isBlurBackgroundRhythmEnabled"
        />
        <div class="lyric-blur-bg-overlay"></div>
      </div>
    </div>

    <!-- Always the lyric overlay header, not MainLayout's TitleBar. -->
    <LyricPageTitlebar v-if="titlebar === 'host'" @close="closeLyricPage" />

    <!-- 弹幕层：对所有皮肤统一渲染 -->
    <BarrageLayer
      ref="barrageRef"
      v-model:enabled="barrageEnabled"
      type="song"
      :hash="currentTrack?.hash || ''"
      :name="currentTrack?.name"
      :playing="playerStore.isPlaying"
    />

    <!-- 自定义皮肤页面：内容完全由插件控制，插件可通过 ctx.ui.components 自行引入宿主组件 -->
    <div
      v-if="pluginPage"
      class="plugin-lyrics-content"
      :class="{ 'with-host-titlebar': titlebar === 'host' }"
      @mouseenter="handleContentEnter"
      @mouseleave="handleContentLeave"
    >
      <PluginLyricsPageView
        :key="pluginPage.revision"
        :contribution="pluginPage"
        :page="pageContext"
      />
    </div>

    <!-- 自定义皮肤右侧歌词工具按钮 -->
    <div
      v-if="pluginPage && pluginTools === 'host'"
      class="lyric-page-tools no-drag"
      :style="{
        opacity: isContentHovered ? 1 : 0,
        pointerEvents: isContentHovered ? 'auto' : 'none',
      }"
      @mouseenter="handleContentEnter"
      @mouseleave="handleContentLeave"
    >
      <!-- 上组：歌词来源 / 时间调整 -->
      <div class="lyric-page-tools-group">
        <Tooltip content="选择歌词">
          <template #trigger>
            <button
              class="lyric-page-tool-btn"
              aria-label="选择歌词"
              @click="lyricStore.sourceDialogOpen = true"
            >
              <Icon :icon="iconList" width="14" height="14" />
            </button>
          </template>
        </Tooltip>
        <Tooltip v-if="hasLyrics" :content="`歌词后退 ${lyricOffsetStepLabel}`">
          <template #trigger>
            <button
              class="lyric-page-tool-btn"
              :aria-label="`歌词后退 ${lyricOffsetStepLabel}`"
              @click="handleOffsetAdjust(-1)"
            >
              <Icon :icon="iconRotateCcw" width="15" height="15" />
            </button>
          </template>
        </Tooltip>
        <Tooltip v-if="hasLyrics" :content="`歌词前进 ${lyricOffsetStepLabel}`">
          <template #trigger>
            <button
              class="lyric-page-tool-btn"
              :aria-label="`歌词前进 ${lyricOffsetStepLabel}`"
              @click="handleOffsetAdjust(1)"
            >
              <Icon :icon="iconRotateCw" width="15" height="15" />
            </button>
          </template>
        </Tooltip>
        <Tooltip v-if="hasLyrics" content="重置偏移">
          <template #trigger>
            <button
              class="lyric-page-tool-btn"
              :style="{ visibility: lyricStore.currentTimeOffset !== 0 ? 'visible' : 'hidden' }"
              aria-label="重置偏移"
              @click="handleOffsetReset"
            >
              <Icon :icon="iconRefreshCw" width="14" height="14" />
            </button>
          </template>
        </Tooltip>
      </div>

      <!-- 下组：翻译/音译/复制 -->
      <div v-if="hasLyrics" class="lyric-page-tools-group">
        <Tooltip v-if="lyricStore.hasTranslation" content="翻译">
          <template #trigger>
            <button
              class="lyric-page-tool-btn"
              :class="{ active: lyricStore.wantTranslation }"
              aria-label="翻译"
              @click="lyricStore.wantTranslation = !lyricStore.wantTranslation"
            >
              译
            </button>
          </template>
        </Tooltip>
        <Tooltip v-if="lyricStore.hasRomanization" content="音译">
          <template #trigger>
            <button
              class="lyric-page-tool-btn"
              :class="{ active: lyricStore.wantRomanization }"
              aria-label="音译"
              @click="lyricStore.wantRomanization = !lyricStore.wantRomanization"
            >
              音
            </button>
          </template>
        </Tooltip>
        <Tooltip content="复制歌词">
          <template #trigger>
            <button class="lyric-page-tool-btn" aria-label="复制歌词" @click="handleCopyLyrics">
              <Icon :icon="iconCopy" width="14" height="14" />
            </button>
          </template>
        </Tooltip>
      </div>
    </div>

    <template v-else>
      <!-- 顶部工具栏：左（展开按钮）、中（轮播切换）、右（播放器模式） -->
      <div class="lyric-page-toolbar no-drag">
        <!-- 左侧：展开/折叠按钮 -->
        <div class="toolbar-left">
          <Button
            v-if="viewMode === 'portrait' && portraitModeRef"
            variant="unstyled"
            size="none"
            type="button"
            class="top-right-btn"
            :style="{
              opacity: isCollapsed && !isMouseActive ? 0 : 1,
              transition: 'opacity 0.3s ease',
            }"
            :tooltip="portraitModeRef.isLyricCollapsed ? '展开歌词' : '收起歌词'"
            @click="portraitModeRef.handleCollapseClick()"
          >
            <Icon
              :icon="portraitModeRef.isLyricCollapsed ? iconArrowBarToUp : iconArrowBarDown"
              width="16"
              height="16"
            />
          </Button>
        </div>

        <!-- 中间：轮播切换按钮 或 歌曲信息（歌词模式） -->
        <div class="toolbar-center">
          <div v-if="viewMode === 'lyric'" class="toolbar-song-info">
            <span class="toolbar-song-title">{{ currentTrack?.name || '未在播放' }}</span>
            <span v-if="currentTrack?.artist" class="toolbar-song-artist">{{
              currentTrack.artist
            }}</span>
          </div>
          <div
            v-else-if="
              viewMode === 'portrait' &&
              portraitModeRef &&
              portraitModeRef.artistPortraitUrls.length > 1
            "
            class="top-right-group"
            :style="{
              opacity: isCollapsed ? 0 : 1,
              transition: 'opacity 0.3s ease',
            }"
          >
            <Button
              variant="unstyled"
              size="none"
              type="button"
              class="top-right-group-btn"
              @click="portraitModeRef.showPreviousPortrait()"
            >
              <Icon :icon="iconChevronLeft" width="14" height="14" />
            </Button>
            <span class="top-right-group-label">{{ portraitModeRef.portraitCounterLabel }}</span>
            <Button
              variant="unstyled"
              size="none"
              type="button"
              class="top-right-group-btn"
              @click="portraitModeRef.showNextPortrait()"
            >
              <Icon :icon="iconChevronRight" width="14" height="14" />
            </Button>
          </div>
        </div>
      </div>

      <!-- 主内容区域 -->
      <div class="lyric-page-body">
        <div
          class="lyric-page-content"
          @mouseenter="handleContentEnter"
          @mouseleave="handleContentLeave"
        >
          <CoverMode v-if="viewMode === 'cover'" />
          <PortraitMode v-else-if="viewMode === 'portrait'" ref="portraitModeRef" />
          <AmllMode v-else-if="viewMode === 'amll'" />
          <LyricMode v-else />
        </div>

        <!-- 歌词同步警告 -->
        <div v-if="lyricStore.lyricSyncWarning" class="lyric-sync-warning">
          播放时长与原曲存在差异，歌词可能不同步
        </div>

        <!-- 底部控制栏 -->
        <LyricPlayerControls
          :style="{
            opacity:
              portraitModeRef?.isLyricCollapsed && settingStore.lyricCollapseHideControls ? 0 : 1,
            maxHeight:
              portraitModeRef?.isLyricCollapsed && settingStore.lyricCollapseHideControls
                ? '0px'
                : '200px',
            overflow:
              portraitModeRef?.isLyricCollapsed && settingStore.lyricCollapseHideControls
                ? 'hidden'
                : 'visible',
            pointerEvents:
              portraitModeRef?.isLyricCollapsed && settingStore.lyricCollapseHideControls
                ? 'none'
                : undefined,
            transition: 'opacity 0.5s ease, max-height 0.5s ease',
          }"
          @open-queue="isQueueDrawerOpen = true"
          @open-comment="openComments"
          @open-add-to-playlist="handleOpenAddToPlaylist"
          @open-skins="openSettings('skins')"
        >
          <template #song-actions>
            <BarrageControls
              v-model="barrageEnabled"
              variant="lyric"
              :resource="{
                type: 'song-barrage',
                hash: currentTrack?.hash || '',
                name: currentTrack?.name,
              }"
              @sent="barrageRef?.onSent($event)"
            />
          </template>
        </LyricPlayerControls>
      </div>

      <!-- 歌词工具按钮：固定在右侧中间 -->
      <div
        v-if="!isCollapsed"
        class="lyric-page-tools no-drag"
        :style="{
          opacity: isContentHovered ? 1 : 0,
          pointerEvents: isContentHovered ? 'auto' : 'none',
        }"
        @mouseenter="handleContentEnter"
        @mouseleave="handleContentLeave"
      >
        <!-- 上组：歌词来源 / 时间调整 -->
        <div class="lyric-page-tools-group">
          <Tooltip content="选择歌词">
            <template #trigger>
              <button
                class="lyric-page-tool-btn"
                aria-label="选择歌词"
                @click="lyricStore.sourceDialogOpen = true"
              >
                <Icon :icon="iconList" width="14" height="14" />
              </button>
            </template>
          </Tooltip>
          <Tooltip v-if="hasLyrics" :content="`歌词后退 ${lyricOffsetStepLabel}`">
            <template #trigger>
              <button
                class="lyric-page-tool-btn"
                :aria-label="`歌词后退 ${lyricOffsetStepLabel}`"
                @click="handleOffsetAdjust(-1)"
              >
                <Icon :icon="iconRotateCcw" width="15" height="15" />
              </button>
            </template>
          </Tooltip>
          <Tooltip v-if="hasLyrics" :content="`歌词前进 ${lyricOffsetStepLabel}`">
            <template #trigger>
              <button
                class="lyric-page-tool-btn"
                :aria-label="`歌词前进 ${lyricOffsetStepLabel}`"
                @click="handleOffsetAdjust(1)"
              >
                <Icon :icon="iconRotateCw" width="15" height="15" />
              </button>
            </template>
          </Tooltip>
          <Tooltip v-if="hasLyrics" content="重置偏移">
            <template #trigger>
              <button
                class="lyric-page-tool-btn"
                :style="{ visibility: lyricStore.currentTimeOffset !== 0 ? 'visible' : 'hidden' }"
                aria-label="重置偏移"
                @click="handleOffsetReset"
              >
                <Icon :icon="iconRefreshCw" width="14" height="14" />
              </button>
            </template>
          </Tooltip>
        </div>

        <!-- 下组：翻译/音译/复制 -->
        <div v-if="hasLyrics" class="lyric-page-tools-group">
          <Tooltip v-if="lyricStore.hasTranslation" content="翻译">
            <template #trigger>
              <button
                class="lyric-page-tool-btn"
                :class="{ active: lyricStore.wantTranslation }"
                aria-label="翻译"
                @click="lyricStore.wantTranslation = !lyricStore.wantTranslation"
              >
                译
              </button>
            </template>
          </Tooltip>
          <Tooltip v-if="lyricStore.hasRomanization" content="音译">
            <template #trigger>
              <button
                class="lyric-page-tool-btn"
                :class="{ active: lyricStore.wantRomanization }"
                aria-label="音译"
                @click="lyricStore.wantRomanization = !lyricStore.wantRomanization"
              >
                音
              </button>
            </template>
          </Tooltip>
          <Tooltip content="复制歌词">
            <template #trigger>
              <button class="lyric-page-tool-btn" aria-label="复制歌词" @click="handleCopyLyrics">
                <Icon :icon="iconCopy" width="14" height="14" />
              </button>
            </template>
          </Tooltip>
        </div>
      </div>
    </template>

    <!-- Shared host panels remain available to replacement pages. -->
    <div v-if="isQualityOpen || isEffectOpen" class="plugin-audio-panel-anchor no-drag">
      <QualityPopover v-if="isQualityOpen" v-model:open="isQualityOpen" />
      <EffectPopover v-if="isEffectOpen" v-model:open="isEffectOpen" />
    </div>

    <!-- 设置 Drawer -->
    <LyricSettingsDrawer
      v-model:open="isSettingsOpen"
      :view="settingsView"
      @update:view="settingsView = $event"
      @open-global-settings="
        isSettingsOpen = false;
        openSettingsDialog('pageLyric');
      "
    />

    <LyricSourceDialog
      v-model:open="lyricStore.sourceDialogOpen"
      :hash="currentTrackLyricHash"
      :duration="playerStore.duration || currentTrack?.duration || 0"
      :title="currentTrack?.name"
      :artist="currentTrack?.artist"
      :album-audio-id="currentTrack?.albumAudioId ?? currentTrack?.mixSongId"
    />

    <!-- 播放队列抽屉 -->
    <PlayerQueueDrawer v-model:open="isQueueDrawerOpen" />

    <!-- 评论抽屉 -->
    <CommentDrawer
      v-if="commentTrack"
      v-model:open="isCommentDrawerOpen"
      :resourceId="
        commentTrack.mixSongId ? String(commentTrack.mixSongId) : String(commentTrack.id)
      "
      resourceType="music"
      :mixSongId="commentTrack.mixSongId ? String(commentTrack.mixSongId) : String(commentTrack.id)"
      title="评论"
    />

    <!-- 添加到对话框 -->
    <AddToPlaylistDialog
      v-model:open="showAddToPlaylistDialog"
      :playbackQueues="addToPlaybackQueues"
      :playlists="createdPlaylists"
      :loading="isPlaylistLoading"
      @selectQueue="handleAddToQueue"
      @selectPlaylist="handleSelectPlaylist"
    />
  </div>
</template>

<style scoped>
.lyric-page {
  color: white;
}

.lyric-page.is-portrait {
  background-color: #1a1d22;
}

.lyric-background {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-color: #1a1d22;
  transition: background-color 0.5s ease;
}

/* 模糊封面背景 */
.lyric-blur-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
}

.lyric-blur-bg-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: blur(40px);
  transform: scale(1.2);
  transition:
    opacity 0.8s ease,
    transform 0.8s ease;
}

.lyric-blur-bg-img--rhythm {
  opacity: 0;
  transform: scale(1.45);
}

.lyric-blur-bg-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  background: rgba(0, 0, 0, 0.5);
}

/* The return/close, Mini and fullscreen actions share the same foreground states. */
.lyric-page {
  --window-action-color: rgba(255, 255, 255, 0.7);
  --window-action-hover-color: #fff;
}

.is-plugin-page {
  background: #0a0f0e;
}
.plugin-lyrics-content {
  position: absolute;
  inset: 0;
  overflow: hidden;
  isolation: isolate;
}
.plugin-audio-panel-anchor {
  position: absolute;
  right: 24px;
  bottom: 24px;
  z-index: 80;
}

.lyric-page-toolbar {
  position: fixed;
  top: 56px;
  left: 16px;
  right: 16px;
  z-index: 60;
  display: flex;
  align-items: center;
  height: 36px;
}

.toolbar-left {
  flex: 1;
  display: flex;
  align-items: center;
  min-width: 0;
}

.toolbar-song-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: min(400px, calc(100vw - 160px));
  overflow: hidden;
}

.toolbar-song-title {
  display: block;
  font-size: 18px;
  font-weight: 700;
  color: white;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.toolbar-song-artist {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.6);
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toolbar-sync-warning {
  font-size: 11px;
  color: rgba(255, 200, 50, 0.85);
  padding: 2px 10px;
  border-radius: 999px;
  background: rgba(255, 200, 50, 0.1);
  white-space: nowrap;
}

.lyric-sync-warning {
  position: fixed;
  bottom: 100px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 50;
  font-size: 11px;
  color: rgba(255, 200, 50, 0.85);
  padding: 4px 14px;
  border-radius: 999px;
  background: rgba(255, 200, 50, 0.1);
  white-space: nowrap;
  pointer-events: none;
}

.toolbar-center {
  display: flex;
  align-items: center;
  justify-content: center;
}

.toolbar-right {
  gap: 8px;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
}

.top-right-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.8);
  transition: all 0.2s ease;
}

.top-right-btn:hover {
  background: rgba(255, 255, 255, 0.18);
  color: white;
}

.top-right-group {
  display: inline-flex;
  align-items: center;
  gap: 0;
  padding: 3px 4px;
  height: 36px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.15);
}

.top-right-group-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  color: rgba(255, 255, 255, 0.8);
  transition: all 0.2s ease;
}

.top-right-group-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: white;
}

.top-right-group-label {
  font-size: 12px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.8);
  min-width: 2em;
  text-align: center;
  padding: 0 2px;
}

.lyric-page-body {
  position: absolute;
  inset: 0;
  top: 96px;
  display: flex;
  flex-direction: column;
}

.lyric-page-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
  z-index: 2;
}

/* 歌词工具按钮 */
.lyric-page-tools {
  position: fixed;
  top: 50%;
  right: 16px;
  transform: translateY(-50%);
  z-index: 60;
  display: grid;
  grid-template-rows: 152px 112px;
  gap: 180px;
  align-items: start;
  justify-items: center;
  transition: opacity 0.2s ease;
}

.lyric-page-tools-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.lyric-page-tool-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.6);
  font-size: 12px;
  font-weight: 700;
  font-family:
    system-ui,
    -apple-system,
    sans-serif;
  cursor: pointer;
  transition: all 0.2s ease;
}

.lyric-page-tool-btn:hover {
  background: rgba(255, 255, 255, 0.18);
  color: white;
}

.lyric-page-tool-btn.active {
  background: rgba(255, 255, 255, 0.2);
  color: white;
  border-color: rgba(255, 255, 255, 0.3);
}
</style>
