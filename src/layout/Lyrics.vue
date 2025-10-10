<template>
  <NDrawer
    v-model:show="showLyrics"
    :width="'100%'"
    :height="'100%'"
    :placement="'top'"
    :trap-focus="false"
    block-scroll
    :show-mask="true"
    :mask-closable="true"
    class="fullscreen-lyrics-drawer"
  >
    <NDrawerContent
      :native-scrollbar="false"
      :closable="false"
      class="lyrics-content"
      :style="{ '--cover-url': `url(${coverUrl})` }"
    >
      <!-- 全屏歌词内容 -->
      <div
        class="lyrics-container"
        id="lyrics-container"
      >
        <!-- 左侧封面区域 -->
        <div class="cover-section">
          <!-- 封面主图 -->
          <div class="cover-main">
            <NImage
              :src="coverUrl"
              :alt="currentSong?.name || ''"
              class="cover-image"
              preview-disabled
            >
              <template #placeholder>
                <img
                  class="cover-image"
                  :src="coverUrl"
                />
              </template>
            </NImage>
          </div>

          <!-- 歌曲信息 -->
          <div class="song-meta">
            <div class="song-title">{{ songName }}</div>
            <div class="song-album">
              <NIcon
                :size="16"
                class="album-icon"
              >
                <AlbumOutlined />
              </NIcon>
              <span>{{ albumName }}</span>
            </div>
            <div class="song-artist">
              <NIcon
                :size="16"
                class="artist-icon"
              >
                <PersonOutline />
              </NIcon>
              <span>{{ artistName }}</span>
            </div>
          </div>
        </div>

        <!-- 右侧歌词区域 -->
        <div class="lyrics-section">
          <!-- 顶部控制栏 -->
          <div class="lyrics-header">
            <div class="header-left">
              <!-- 歌词模式切换 -->
              <NButton
                v-if="hasTranslation"
                @click="toggleLyricsMode"
                :focusable="false"
                text
                size="small"
                class="mode-btn"
              >
                {{ lyricsMode === 'translation' ? '翻译' : '音译' }}
              </NButton>
            </div>

            <!-- 关闭按钮 -->
            <NButton
              @click="closeLyrics"
              :focusable="false"
              text
              circle
              size="large"
              class="close-btn"
            >
              <template #icon>
                <NIcon :size="24">
                  <KeyboardArrowDownRound />
                </NIcon>
              </template>
            </NButton>
          </div>

          <!-- 歌词滚动区域 -->
          <div
            class="lyrics-scroll-area"
            ref="lyricsScrollRef"
          >
            <div
              class="lyrics-wrapper"
              id="lyrics"
              :style="{ transform: `translateY(${scrollAmount || 0}px)` }"
            >
              <template v-if="lyricsData.length > 0">
                <div
                  v-for="(line, index) in lyricsData"
                  :key="index"
                  class="line-group"
                  :class="{ active: isCurrentLine(line) }"
                >
                  <!-- 主歌词 -->
                  <div class="lyrics-line">
                    <span
                      v-for="(char, charIndex) in line.characters"
                      :key="charIndex"
                      :class="{ highlighted: char.highlighted }"
                      class="lyrics-char"
                    >
                      {{ char.char }}
                    </span>
                  </div>

                  <!-- 翻译/音译 -->
                  <div
                    v-if="getSecondaryText(line)"
                    class="lyrics-translation"
                  >
                    {{ getSecondaryText(line) }}
                  </div>
                </div>
              </template>

              <!-- 无歌词提示 -->
              <div
                v-else
                class="no-lyrics"
              >
                <div class="no-lyrics-text">{{ songTips }}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 底部播放控制 - 移到右侧区域外，全局居中 -->
        <div
          class="lyrics-footer-wrapper"
          v-if="currentSong"
        >
          <div class="lyrics-footer">
            <!-- 播放控制按钮 -->
            <div class="playback-controls">
              <NButton
                :focusable="false"
                text
                circle
                @click="handlePrevSong"
              >
                <template #icon>
                  <NIcon :size="24">
                    <SkipPreviousRound />
                  </NIcon>
                </template>
              </NButton>

              <NButton
                :focusable="false"
                text
                circle
                class="play-btn"
                @click="handlePlayPause"
              >
                <template #icon>
                  <NIcon :size="32">
                    <PauseRound v-if="isPlaying" />
                    <PlayArrowRound v-else />
                  </NIcon>
                </template>
              </NButton>

              <NButton
                :focusable="false"
                text
                circle
                @click="handleNextSong"
              >
                <template #icon>
                  <NIcon :size="24">
                    <SkipNextRound />
                  </NIcon>
                </template>
              </NButton>
            </div>

            <!-- 进度条 -->
            <div class="progress-section">
              <span class="time-text">{{ formatTime(currentTime) }}</span>
              <NSlider
                v-model:value="playerStore.currentTime"
                :max="duration"
                :step="0.1"
                :tooltip="false"
                @dragstart="handleSeekDragStart"
                @dragend="handleSeekDragEnd"
                class="progress-slider"
              />
              <span class="time-text">{{ formatTime(duration) }}</span>
            </div>
          </div>
        </div>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<script lang="ts" setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { NDrawer, NDrawerContent, NButton, NIcon, NImage, NSlider } from 'naive-ui';
import {
  SkipPreviousRound,
  SkipNextRound,
  PauseRound,
  PlayArrowRound,
  AlbumOutlined,
  KeyboardArrowDownRound,
} from '@vicons/material';
import { PersonOutline } from '@vicons/ionicons5';
import { usePlayerStore } from '@/store';
import { lyricsHandler } from '@/utils/lyrics';
import { getCover, secondsToTime } from '@/utils';
import player from '@/utils/player';
import type { LyricsLine } from '@/types';

defineOptions({
  name: 'Lyrics',
});

// Store
const playerStore = usePlayerStore();

// 响应式数据
const showLyrics = ref(false);
const lyricsScrollRef = ref<HTMLElement>();

// 从 lyricsHandler 获取数据
const lyricsData = computed(() => lyricsHandler.data.lyricsData.value);
const songTips = computed(() => lyricsHandler.data.songTips.value);
const scrollAmount = computed(() => lyricsHandler.data.scrollAmount.value);
const lyricsMode = computed(() => lyricsHandler.data.lyricsMode.value);

// 播放器数据
const currentSong = computed(() => playerStore.current);
const currentTime = computed(() => playerStore.currentTime);
const duration = computed(() => playerStore.duration);
const isPlaying = computed(() => playerStore.isPlaying);

// 计算属性
const coverUrl = computed(() => {
  const song = currentSong.value;
  return getCover(song?.cover || '', 400);
});

const songName = computed(() => {
  const song = currentSong.value;
  return song?.name?.split(' - ')?.[1] || song?.name || '未知歌曲';
});

const albumName = computed(() => {
  const song = currentSong.value;
  return song?.albuminfo?.name || '未知专辑';
});

const artistName = computed(() => {
  const song = currentSong.value;
  if (!song?.singerinfo) return '未知艺术家';

  if (Array.isArray(song.singerinfo)) {
    return song.singerinfo.map(item => item.name).join(' / ');
  }
  return song.singerinfo;
});

const hasTranslation = computed(() => {
  return lyricsData.value.some(line => line.translated || line.romanized);
});

// 方法
const formatTime = (seconds: number) => {
  return secondsToTime(seconds);
};

const isCurrentLine = (line: LyricsLine) => {
  if (!line.characters.length) return false;
  return line.characters.some(char => char.highlighted);
};

const getSecondaryText = (line: LyricsLine) => {
  if (lyricsMode.value === 'translation') {
    return line.translated || '';
  } else {
    return line.romanized || '';
  }
};

const toggleLyricsMode = () => {
  lyricsHandler.toggleLyricsMode();
};

const closeLyrics = () => {
  showLyrics.value = false;
};

// 播放控制方法
const handlePlayPause = () => {
  player.playOrPause();
};

const handlePrevSong = () => {
  player.nextOrPrev('prev');
};

const handleNextSong = () => {
  player.nextOrPrev('next');
};

// 进度条拖动
const handleSeekDragStart = () => {
  player.pause(false);
};

const handleSeekDragEnd = () => {
  player.setSeek(currentTime.value);
  player.play();
};

// 打开歌词
const openLyrics = () => {
  showLyrics.value = true;

  // 如果有当前歌曲但没有歌词数据，尝试获取歌词
  if (currentSong.value && lyricsData.value.length === 0) {
    lyricsHandler.getLyrics(currentSong.value.hash);
  } else if (lyricsData.value.length > 0) {
    // 如果已有歌词数据，滚动到当前播放位置
    nextTick(() => {
      const currentLineIndex = lyricsHandler.getCurrentLineIndex(currentTime.value);
      if (currentLineIndex !== -1) {
        lyricsHandler.scrollToCurrentLine(currentLineIndex);
      }
    });
  }
};

// 监听全屏歌词显示状态，通知 lyricsHandler
watch(showLyrics, isShow => {
  // 通知 lyricsHandler 全屏歌词是否打开
  lyricsHandler.data.showLyrics.value = isShow;
});

// 监听当前歌曲变化
watch(currentSong, (newSong, oldSong) => {
  if (newSong && newSong !== oldSong && showLyrics.value) {
    // 清空现有歌词
    lyricsHandler.clearLyrics();
    // 获取新歌曲的歌词
    if (newSong.hash) {
      lyricsHandler.getLyrics(newSong.hash);
    }
  }
});

// 全局事件监听
const handleGlobalLyricsOpen = () => {
  openLyrics();
};

onMounted(() => {
  // 监听全局歌词打开事件
  window.addEventListener('open-fullscreen-lyrics', handleGlobalLyricsOpen);
});

onUnmounted(() => {
  window.removeEventListener('open-fullscreen-lyrics', handleGlobalLyricsOpen);
});

// 暴露方法给父组件
defineExpose({
  openLyrics,
  closeLyrics,
});
</script>

<style lang="scss" scoped>
.fullscreen-lyrics-drawer {
  :deep(.n-drawer) {
    background: transparent;
  }

  :deep(.n-drawer-mask) {
    background-color: rgba(0, 0, 0, 0.9);
    backdrop-filter: blur(20px);
  }

  :deep(.n-drawer .n-drawer-content .n-drawer-body-content-wrapper) {
    padding: 0;
    overflow: hidden;
  }
}

.lyrics-content {
  height: 100vh;
  overflow: hidden;
  padding: 0 !important;
  position: relative;

  // 统一的全局背景
  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-image: var(--cover-url);
    background-size: cover;
    background-position: center;
    filter: blur(80px) brightness(0.3);
    transform: scale(1.2);
    z-index: 0;
  }

  :deep(.n-scrollbar) {
    overflow: hidden !important;
  }

  :deep(.n-scrollbar-container) {
    overflow: hidden !important;
  }
}

.lyrics-container {
  display: grid;
  grid-template-columns: 40% 60%;
  grid-template-rows: 1fr auto;
  height: 100vh;
  width: 100vw;
  color: #ffffff;
  background: transparent;
  overflow: hidden;
  position: relative;
  z-index: 1;
}

// ===== 左侧封面区域 =====
.cover-section {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 40px;
  overflow: hidden;
  z-index: 1;
  background: transparent;
  grid-row: 1 / 2;

  // 封面主图
  .cover-main {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 400px;
    aspect-ratio: 1;
    border-radius: 16px;
    overflow: hidden;
    margin-bottom: 40px;

    .cover-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
  }

  // 歌曲信息
  .song-meta {
    position: relative;
    z-index: 1;
    text-align: center;
    width: 100%;
    max-width: 400px;

    .song-title {
      font-size: 28px;
      font-weight: 700;
      color: #ffffff;
      margin-bottom: 12px;
      line-height: 1.4;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    }

    .song-album {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-size: 16px;
      color: rgba(255, 255, 255, 0.85);
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);

      .album-icon {
        opacity: 0.85;
      }
    }

    .song-artist {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-size: 16px;
      color: rgba(255, 255, 255, 0.85);
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);

      .artist-icon {
        opacity: 0.85;
      }
    }
  }
}

// ===== 右侧歌词区域 =====
.lyrics-section {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: transparent;
  overflow: hidden;
  z-index: 1;
  grid-row: 1 / 2;
}

// ===== 底部控制区域包装器 - 跨越两列 =====
.lyrics-footer-wrapper {
  grid-column: 1 / 3;
  grid-row: 2 / 3;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 30px 0;
  background: transparent;
}

.lyrics-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24px 40px;
  background: transparent;

  .header-left {
    flex: 1;

    .mode-btn {
      color: rgba(255, 255, 255, 0.9);
      font-size: 14px;
      padding: 8px 20px;
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 20px;
      transition: all 0.3s ease;

      &:hover {
        background: rgba(255, 255, 255, 0.15);
        border-color: rgba(255, 255, 255, 0.5);
        color: #ffffff;
      }
    }
  }

  .close-btn {
    color: rgba(255, 255, 255, 0.9);
    transition: all 0.3s ease;

    &:hover {
      background: rgba(255, 255, 255, 0.15);
      color: #ffffff;
    }
  }
}

.lyrics-scroll-area {
  flex: 1;
  overflow: hidden;
  position: relative;
  padding: 60px 40px;
  display: flex;
  align-items: center;
}

.lyrics-wrapper {
  width: 100%;
  transition: transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.line-group {
  text-align: center;
  margin: 12px 0;
  padding: 6px 0;
  transition: all 0.4s ease;
  opacity: 0.5;

  &.active {
    opacity: 1;
  }

  .lyrics-line {
    font-size: 28px;
    font-weight: 600;
    line-height: 1.5;
    margin-bottom: 8px;
    letter-spacing: 0.5px;

    .lyrics-char {
      color: rgba(255, 255, 255, 0.6);
      transition: all 0.3s ease;
      display: inline-block;

      &.highlighted {
        color: #64b5f6;
        text-shadow: 0 0 15px rgba(100, 181, 246, 0.5);
      }
    }
  }

  .lyrics-translation {
    font-size: 16px;
    color: rgba(255, 255, 255, 0.4);
    line-height: 1.6;
    font-weight: 400;
  }
}

.no-lyrics {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  width: 100%;

  .no-lyrics-text {
    font-size: 24px;
    color: rgba(255, 255, 255, 0.4);
    text-align: center;
  }
}

// 底部播放控制
.lyrics-footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  column-gap: 16px;
  row-gap: 10px;

  .playback-controls {
    display: flex;
    align-items: center;
    justify-content: center;
    column-gap: 16px;
    row-gap: 10px;

    .n-button {
      color: rgba(255, 255, 255, 0.9);
      transition: all 0.3s ease;

      &.play-btn {
        width: 56px;
        height: 56px;

        &:hover {
          transform: scale(1.15);
        }
      }
    }
  }

  .progress-section {
    display: flex;
    align-items: center;
    column-gap: 16px;
    row-gap: 10px;
    width: 600px;

    .time-text {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.75);
      font-variant-numeric: tabular-nums;
      min-width: 50px;
      text-align: center;
    }

    .progress-slider {
      flex: 1;
      min-width: 0;

      :deep(.n-slider-rail) {
        background: rgba(255, 255, 255, 0.2);
        height: 6px;
      }

      :deep(.n-slider-rail__fill) {
        background: linear-gradient(90deg, #ffffff 0%, rgba(255, 255, 255, 0.95) 100%);
        box-shadow: 0 0 10px rgba(255, 255, 255, 0.4);
      }

      :deep(.n-slider-handle) {
        width: 12px;
        height: 12px;
        border: 2px solid #ffffff;
        box-shadow: 0 0 8px rgba(255, 255, 255, 0.5);
      }

      &:hover {
        :deep(.n-slider-rail) {
          background: rgba(255, 255, 255, 0.25);
        }
      }
    }
  }
}

// 响应式设计
@media (max-width: 1200px) {
  .lyrics-container {
    grid-template-columns: 35% 65%;
  }

  .cover-section .cover-main {
    max-width: 320px;
  }

  .line-group .lyrics-line {
    font-size: 32px;
  }
}

@media (max-width: 768px) {
  .lyrics-container {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
  }

  .cover-section {
    padding: 30px 20px;
    min-height: auto;

    .cover-main {
      max-width: 200px;
      margin-bottom: 20px;
    }

    .song-meta .song-title {
      font-size: 20px;
    }

    .song-meta .song-album {
      font-size: 14px;
    }

    .song-meta .song-artist {
      font-size: 14px;
    }
  }

  .lyrics-section {
    height: auto;
  }

  .lyrics-header {
    padding: 16px 20px;
  }

  .lyrics-scroll-area {
    padding: 30px 20px;
  }

  .line-group .lyrics-line {
    font-size: 24px;
  }

  .line-group .lyrics-translation {
    font-size: 16px;
  }

  .lyrics-footer {
    padding: 20px;
  }
}
</style>
