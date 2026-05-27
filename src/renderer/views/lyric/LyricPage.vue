<script setup lang="ts">
defineOptions({ name: 'lyric-page' });

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useClipboard } from '@vueuse/core';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useLyricStore } from '@/stores/lyric';
import { useToastStore } from '@/stores/toast';
import { usePlayerControls } from '@/composables/usePlayerControls';
import { useLyricBackground } from './composables/useLyricBackground';
import OverlayHeader from '@/layouts/OverlayHeader.vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import PlayerQueueDrawer from '@/components/music/PlayerQueueDrawer.vue';
import CommentDrawer from '@/components/music/CommentDrawer.vue';
import CoverMode from './CoverMode.vue';
import PortraitMode from './PortraitMode.vue';
import LyricMode from './LyricMode.vue';
import LyricPlayerControls from './LyricPlayerControls.vue';
import LyricSettingsDrawer from './LyricSettingsDrawer.vue';
import {
  iconChevronDown,
  iconChevronLeft,
  iconChevronRight,
  iconList,
  iconSettings,
  iconArrowBarDown,
  iconArrowBarToUp,
} from '@/icons';

const playerStore = usePlayerStore();
const settingStore = useSettingStore();
const lyricStore = useLyricStore();
const toastStore = useToastStore();
const { copy } = useClipboard();

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
} = usePlayerControls();

// 背景主题色
const coverUrl = computed(() => currentTrack.value?.coverUrl);
const { backgroundColor } = useLyricBackground(coverUrl);

// 当前模式
const viewMode = computed(() => settingStore.lyricViewMode);

// 背景样式
const backgroundStyle = computed(() => {
  if (viewMode.value === 'portrait') {
    // 写真模式不设背景色，让写真图片完整透出
    return {};
  }
  // 封面/歌词模式使用主题色
  if (backgroundColor.value) {
    return { backgroundColor: backgroundColor.value };
  }
  return { backgroundColor: '#1a1d22' };
});

// 设置 Drawer
const isSettingsOpen = ref(false);

// 写真模式 ref
const portraitModeRef = ref<InstanceType<typeof PortraitMode> | null>(null);

// 评论抽屉
const isCommentDrawerOpen = ref(false);

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

// 收起状态快捷计算
const isCollapsed = computed(
  () => viewMode.value === 'portrait' && !!portraitModeRef.value?.isLyricCollapsed,
);

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
  });
};

// 关闭歌词页
const closeLyricPage = () => {
  playerStore.toggleLyricView(false);
};

// 键盘事件
const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (isSettingsOpen.value) {
      isSettingsOpen.value = false;
      return;
    }
    closeLyricPage();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
    if (lyricStore.lines.length === 0) return;
    event.preventDefault();
    const text = lyricStore.copyableText.trim();
    if (text) {
      copy(text);
      toastStore.success('歌词已复制');
    }
  }
};

watch(
  () => [currentTrack.value?.id, playerStore.isPlaying],
  () => {
    ensureLyricsForCurrentTrack();
  },
  { immediate: true },
);

onMounted(() => {
  ensureLyricsForCurrentTrack();
  window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
  if (mouseActiveTimer) window.clearTimeout(mouseActiveTimer);
});
</script>

<template>
  <div
    class="lyric-page fixed inset-0 z-1300 h-screen w-screen overflow-hidden select-none transition-colors duration-500"
    :class="{ 'is-portrait': viewMode === 'portrait' }"
    :style="backgroundStyle"
    @mousemove="handlePageMouseMove"
  >
    <!-- 头部（仅关闭按钮） -->
    <OverlayHeader>
      <template #left>
        <Button
          variant="unstyled"
          size="none"
          type="button"
          class="close-btn no-drag"
          title="返回"
          @click="closeLyricPage"
        >
          <Icon :icon="iconChevronDown" width="20" height="20" />
        </Button>
      </template>
    </OverlayHeader>

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
          :title="portraitModeRef.isLyricCollapsed ? '展开歌词' : '收起歌词'"
          @click="portraitModeRef.handleCollapseClick()"
        >
          <Icon
            :icon="portraitModeRef.isLyricCollapsed ? iconArrowBarToUp : iconArrowBarDown"
            width="16"
            height="16"
          />
        </Button>
      </div>

      <!-- 中间：轮播切换按钮（收起时始终隐藏） -->
      <div class="toolbar-center">
        <div
          v-if="
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

      <!-- 右侧：设置按钮 -->
      <div class="toolbar-right">
        <Button
          variant="unstyled"
          size="none"
          type="button"
          class="top-right-btn"
          :style="{
            opacity: isCollapsed && !isMouseActive ? 0 : 1,
            transition: 'opacity 0.3s ease',
          }"
          title="播放器模式"
          @click="isSettingsOpen = true"
        >
          <Icon :icon="iconSettings" width="16" height="16" />
        </Button>
      </div>
    </div>

    <!-- 主内容区域 -->
    <div class="lyric-page-body">
      <div class="lyric-page-content">
        <CoverMode v-if="viewMode === 'cover'" />
        <PortraitMode v-else-if="viewMode === 'portrait'" ref="portraitModeRef" />
        <LyricMode v-else />
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
          overflow: 'hidden',
          pointerEvents:
            portraitModeRef?.isLyricCollapsed && settingStore.lyricCollapseHideControls
              ? 'none'
              : undefined,
          transition: 'opacity 0.5s ease, max-height 0.5s ease',
        }"
        @open-queue="isQueueDrawerOpen = true"
        @open-comment="isCommentDrawerOpen = true"
        @open-add-to-playlist="handleOpenAddToPlaylist"
      />
    </div>

    <!-- 设置 Drawer -->
    <LyricSettingsDrawer v-model:open="isSettingsOpen" />

    <!-- 播放队列抽屉 -->
    <PlayerQueueDrawer v-model:open="isQueueDrawerOpen" />

    <!-- 评论抽屉 -->
    <CommentDrawer
      v-if="currentTrack"
      v-model:open="isCommentDrawerOpen"
      :resourceId="
        currentTrack.mixSongId ? String(currentTrack.mixSongId) : String(currentTrack.id)
      "
      resourceType="music"
      :mixSongId="currentTrack.mixSongId ? String(currentTrack.mixSongId) : String(currentTrack.id)"
      title="评论"
    />

    <!-- 添加到歌单对话框 -->
    <Dialog
      v-model:open="showAddToPlaylistDialog"
      title="添加到"
      contentClass="max-w-[420px]"
      showClose
    >
      <div class="add-playlist-body">
        <div class="add-playlist-divider"><span>播放队列</span></div>
        <div v-if="addToPlaybackQueues.length === 0" class="add-playlist-empty">暂无播放队列</div>
        <Button
          v-for="queue in addToPlaybackQueues"
          :key="queue.id"
          type="button"
          class="add-playlist-item"
          variant="ghost"
          size="sm"
          @click="handleAddToQueue(queue.id)"
        >
          <span class="add-playlist-name">
            <Icon :icon="iconList" width="16" height="16" />
            {{ queue.title || '播放队列' }}
          </span>
          <span class="add-playlist-count">{{ queue.songs.length }} 首</span>
        </Button>
        <div class="add-playlist-divider"><span>歌单</span></div>
        <div v-if="isPlaylistLoading" class="add-playlist-empty">加载歌单中...</div>
        <div v-else-if="createdPlaylists.length === 0" class="add-playlist-empty">暂无可用歌单</div>
        <Button
          v-for="entry in createdPlaylists"
          :key="entry.listid ?? entry.id"
          type="button"
          class="add-playlist-item"
          variant="ghost"
          size="sm"
          @click="handleSelectPlaylist(entry.listid ?? entry.id)"
        >
          <span class="add-playlist-name">{{ entry.name }}</span>
          <span class="add-playlist-count">{{ entry.count ?? 0 }} 首</span>
        </Button>
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.lyric-page {
  color: white;
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: rgba(255, 255, 255, 0.7);
  transition: all 0.2s ease;
}

.close-btn:hover {
  color: white;
  background: rgba(255, 255, 255, 0.1);
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
}

.toolbar-center {
  display: flex;
  align-items: center;
  justify-content: center;
}

.toolbar-right {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
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

.add-playlist-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.add-playlist-divider {
  padding: 4px 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.add-playlist-empty {
  padding: 18px 0;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.add-playlist-item {
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--color-border-light);
  background: var(--color-bg-card);
  text-align: left;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--color-text-main);
  transition:
    color 0.2s,
    border-color 0.2s;
}

.add-playlist-item:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.add-playlist-name {
  font-size: 13px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.add-playlist-count {
  font-size: 11px;
  opacity: 0.6;
}
</style>
