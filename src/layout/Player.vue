<template>
  <div class="player">
    <div class="player-slider">
      <NSlider
        v-model:value="playerStore.progress"
        :step="0.01"
        :min="0"
        :max="100"
        :tooltip="false"
        :keyboard="false"
        :marks="playerStore.climax"
        class="player-slider"
        @dragstart="player.pause(false)"
        @dragend="sliderDragend"
      />
    </div>
    <!-- 信息 -->
    <div class="play-data">
      <!-- 封面 -->
      <Transition
        name="fade"
        mode="out-in"
      >
        <div
          :key="cover"
          class="cover"
        >
          <NImage
            :src="cover"
            :alt="cover"
            class="cover-img"
            preview-disabled
          />

          <!-- 打开播放器 -->
        </div>
      </Transition>
      <!-- 信息 -->
      <Transition
        name="left-sm"
        mode="out-in"
      >
        <div
          :key="playerStore.current?.hash"
          class="info"
        >
          <div class="data">
            <!-- 名称 -->
            <TextContainer
              style="font-size: 12px"
              :key="name"
              :text="name"
              :speed="0.2"
              class="name"
            />
            <!-- 喜欢 -->

            <!-- 更多操作 -->
          </div>
          <Transition
            name="fade"
            mode="out-in"
          >
            <!-- 歌词 -->

            <!-- 歌手 -->
            <div class="artists">
              <TextContainer
                class="ar-item"
                style="font-size: 10px"
                :key="singer"
                :text="singer"
                :speed="0.2"
              />
            </div>
          </Transition>
        </div>
      </Transition>
    </div>
    <!-- 控制 -->
    <div class="play-control">
      <!-- 不喜欢 -->

      <!-- 上一曲 -->
      <NButton
        :focusable="false"
        ghost
        text
        v-debounce="() => player.nextOrPrev('prev')"
      >
        <template #icon>
          <NIcon :size="26">
            <SkipPreviousRound />
          </NIcon>
        </template>
      </NButton>
      <!-- 播放暂停 -->
      <NButton
        :loading="playerStore.loading"
        :focusable="false"
        :keyboard="false"
        class="play-pause"
        type="primary"
        strong
        secondary
        circle
        v-debounce="() => player.playOrPause()"
      >
        <template #icon>
          <Transition
            name="fade"
            mode="out-in"
          >
            <NIcon :size="28">
              <PauseRound v-if="playerStore.isPlaying" />
              <PlayArrowRound v-else />
            </NIcon>
          </Transition>
        </template>
      </NButton>
      <!-- 下一曲 -->
      <NButton
        :focusable="false"
        ghost
        text
        v-debounce="() => player.nextOrPrev('next')"
      >
        <template #icon>
          <NIcon :size="26">
            <SkipNextRound />
          </NIcon>
        </template>
      </NButton>
    </div>
    <!-- 功能 -->
    <Transition
      name="fade"
      mode="out-in"
    >
      <NFlex
        key="normal"
        :size="[8, 0]"
        class="play-menu"
        justify="end"
      >
        <!-- 播放时间 -->
        <div class="time">
          <NText depth="2">{{ secondsToTime(playerStore.currentTime) }}</NText>
          <NText depth="2">{{ secondsToTime(playerStore.duration) }}</NText>
        </div>
        <!-- 桌面歌词 -->

        <!-- 播放模式 -->
        <NDropdown
          :options="playModeOptions"
          :show-arrow="true"
          @select="mode => player.togglePlayMode(mode)"
        >
          <div
            class="menu-icon"
            @click.stop="player.togglePlayMode(false)"
          >
            <NButton
              :focusable="false"
              ghost
              text
            >
              <template #icon>
                <NIcon :size="20">
                  <component :is="playModeIcon" />
                </NIcon>
              </template>
            </NButton>
          </div>
        </NDropdown>
        <!-- 音量调节 -->
        <NPopover>
          <template #trigger>
            <div
              class="menu-icon"
              @click.stop="player.toggleMute"
              @wheel="player.setVolume"
            >
              <NButton
                :focusable="false"
                ghost
                text
              >
                <template #icon>
                  <NIcon :size="20">
                    <component :is="volumeIcon" />
                  </NIcon>
                </template>
              </NButton>
            </div>
          </template>
          <div
            class="volume-change"
            @wheel="player.setVolume"
          >
            <NSlider
              v-model:value="playerStore.volume"
              :tooltip="false"
              :min="0"
              :max="1"
              :step="0.01"
              vertical
              @update:value="val => player.setVolume(val)"
            />
            <NText
              class="slider-num"
              style="font-size: 12px"
              >{{ (playerStore.volume * 100).toFixed(0) }}%</NText
            >
          </div>
        </NPopover>
        <!-- 播放列表 -->
        <NBadge
          :value="playerStore.playlist.length ?? 0"
          :show="settingStore.showPlaylistCount"
          :max="999"
          :style="{
            marginRight: settingStore.showPlaylistCount ? '12px' : null,
          }"
        >
          <NButton
            :focusable="false"
            ghost
            text
            class="menu-icon"
            @click.stop="playlistShow = !playlistShow"
          >
            <template #icon>
              <NIcon :size="20">
                <Playlist />
              </NIcon>
            </template>
          </NButton>
        </NBadge>
      </NFlex>
    </Transition>
    <!-- 播放列表 -->
    <NDrawer
      v-model:show="playlistShow"
      :trap-focus="false"
      :block-scroll="false"
      to="#main-layout"
    >
      <NDrawerContent
        :native-scrollbar="false"
        :title="`播放列表 (${playerStore.playlist.length})`"
        :closable="false"
        @close="playlistShow = false"
      >
        <template #header>
          <div class="playlist-header flex items-center justify-between">
            <div style="font-size: 12px">
              <NText>播放列表({{ playerStore.playlist.length }})</NText>
            </div>
            <div>
              <NButton
                :focusable="false"
                ghost
                text
                @click.stop="handlePlaylistClearAll"
              >
                <template #icon>
                  <NIcon :size="16">
                    <Trash />
                  </NIcon>
                </template>
              </NButton>
            </div>
          </div>
        </template>
        <div class="playlist">
          <NVirtualList
            v-if="playerStore.playlist.length"
            :items="playerStore.playlist"
            :item-size="50"
            key-field="hash"
          >
            <template #default="{ item }">
              <div
                class="playlist-item flex items-center justify-between"
                style="height: 50px"
              >
                <div>
                  <SongCard
                    :song="item"
                    @dblclick.stop="player.addNextSong(item, true)"
                  />
                </div>
                <div class="delete-btn-wrapper">
                  <NButton
                    class="delete-btn"
                    :focusable="false"
                    ghost
                    text
                    @click.stop="handlePlaylistDelete(item)"
                  >
                    <template #icon>
                      <NIcon :size="20">
                        <Trash />
                      </NIcon>
                    </template>
                  </NButton>
                </div>
              </div>
            </template>
          </NVirtualList>
        </div>
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<script setup lang="ts">
import type { Song } from '@/types';

import {
  NBadge,
  NButton,
  NDrawer,
  NDrawerContent,
  NDropdown,
  NFlex,
  NIcon,
  NImage,
  NPopover,
  NSlider,
  NText,
  NVirtualList,
} from 'naive-ui';

import { usePlayerStore, useSettingStore } from '@/store';
import { calculateCurrentTime, getCover, renderIcon, secondsToTime } from '@/utils';
import player from '@/utils/player';
import { computed, ref } from 'vue';
import {
  Repeat,
  RepeatOnce,
  ArrowsShuffle,
  Volume,
  Volume2,
  Volume3,
  Playlist,
  Trash,
} from '@vicons/tabler';
import { SkipPreviousRound, SkipNextRound, PauseRound, PlayArrowRound } from '@vicons/material';
import TextContainer from '@/components/Core/TextContainer.vue';
import { isArray } from 'lodash-es';
import SongCard from '@/components/Card/SongCard.vue';

const playerStore = usePlayerStore();

const settingStore = useSettingStore();

const playlistShow = ref(false);

const handlePlaylistClearAll = () => {
  playerStore.clearPlaylist();
};

const handlePlaylistDelete = (song: Song) => {
  console.log(song);
};

// 进度条拖拽结束
const sliderDragend = () => {
  const seek = calculateCurrentTime(playerStore.progress, playerStore.duration);
  playerStore.isPlaying = true;
  // 调整进度
  player.setSeek(seek);
  player.play();
};

// 播放模式数据
const playModeOptions = ref([
  {
    label: '列表循环',
    key: 'repeat',
    icon: renderIcon(Repeat),
  },
  {
    label: '单曲循环',
    key: 'repeat-once',
    icon: renderIcon(RepeatOnce),
  },
  {
    label: '随机播放',
    key: 'shuffle',
    icon: renderIcon(ArrowsShuffle),
  },
]);

const playModeIcon = computed(() => {
  const mode = playerStore.mode;
  if (mode === 'repeat') {
    return Repeat;
  }
  if (mode === 'repeat-once') {
    return RepeatOnce;
  }
  if (mode === 'shuffle') {
    return ArrowsShuffle;
  }
  return Repeat;
});

const volumeIcon = computed(() => {
  if (playerStore.volume === 0) {
    return Volume3;
  }
  if (playerStore.volume < 0.5) {
    return Volume2;
  }
  return Volume;
});

const cover = computed(() => {
  const song = playerStore.current;
  return getCover(song?.cover || '', 50);
});

const name = computed(() => {
  const song = playerStore.current;
  const nameParts = song?.name.split(' - ');
  if (nameParts && nameParts.length > 1) {
    return nameParts[1];
  }
  return song?.name || '未知歌曲';
});

const singer = computed(() => {
  const singerinfo = playerStore.current?.singerinfo;
  if (singerinfo) {
    if (isArray(singerinfo)) {
      return singerinfo.map(item => item.name).join(' / ');
    }
    return singerinfo;
  }
  return '未知艺术家';
});
</script>

<style scoped lang="scss">
.player {
  position: fixed;
  left: 0;
  // bottom: -90px;
  height: 70px;
  padding: 0 15px;
  width: 100%;
  background-color: var(--surface-container-hex);
  // background-color: rgba(var(--surface-container), 0.28);
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  align-items: center;
  transition: bottom 0.3s;
  z-index: 10;
  &.show {
    bottom: 0;
  }
  .player-slider {
    position: absolute;
    width: 100%;
    height: 14px;
    top: -4px;
    left: 0;
    margin: 0;
    --n-rail-height: 3px;
    --n-handle-size: 14px;
    :deep(.n-slider-handle) {
      width: 14px;
      height: 14px;
    }
  }
  .play-data {
    display: flex;
    flex-direction: row;
    align-items: center;
    max-width: 100%;
    overflow: hidden;
    .cover {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 50px;
      height: 50px;
      min-width: 50px;
      border-width: 1px;
      border-radius: 8px;
      overflow: hidden;
      margin-right: 12px;
      transition: opacity 0.2s;
      cursor: pointer;
      :deep(img) {
        width: 50px;
        height: 50px;
        // opacity: 0;
        transition:
          transform 0.3s,
          opacity 0.3s,
          filter 0.3s;
      }
      .n-icon {
        position: absolute;
        color: #eee;
        opacity: 0;
        transform: scale(0.6);
        transition:
          opacity 0.3s,
          transform 0.3s;
      }
      &:hover {
        :deep(img) {
          transform: scale(1.2);
          filter: brightness(0.6) blur(2px);
        }
        .n-icon {
          opacity: 1;
          transform: scale(1);
        }
      }
      &:active {
        .n-icon {
          transform: scale(1.2);
        }
      }
    }
    .info {
      display: flex;
      flex-direction: column;
      width: 100%;
      .data {
        display: flex;
        align-items: center;
        margin-top: 2px;
        .name {
          font-weight: bold;
          font-size: 16px;
          width: max-content;
          max-width: calc(100% - 100px);
          transition: color 0.3s;
        }
        .like {
          color: var(--primary-hex);
          margin-left: 8px;
          transition: transform 0.3s;
          cursor: pointer;
          &:hover {
            transform: scale(1.15);
          }
          &:active {
            transform: scale(1);
          }
        }
        .more {
          margin-left: 8px;
          cursor: pointer;
        }
      }
      .artists {
        margin-top: 2px;
        display: -webkit-box;
        line-clamp: 1;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 1;
        overflow: hidden;
        word-break: break-all;
        .ar-item {
          display: inline-flex;
          transition: color 0.3s;
          cursor: pointer;
          &::after {
            content: '/';
            margin: 0 6px;
            opacity: 0.6;
            transition: none;
          }
          &:last-child {
            &::after {
              display: none;
            }
          }
          &:hover {
            color: var(--primary-hex);
            &::after {
              color: var(--n-close-icon-color);
            }
          }
        }
      }
      .lyric {
        margin-top: 2px;
      }
    }
  }
  .play-control {
    display: flex;
    flex-direction: row;
    justify-content: center;
    align-items: center;
    .play-pause {
      --n-width: 44px;
      --n-height: 44px;
      margin: 0 12px;
      transition:
        background-color 0.3s,
        transform 0.3s;
      .n-icon {
        transition: opacity 0.1s ease-in-out;
      }
      &:hover {
        transform: scale(1.1);
      }
      &:active {
        transform: scale(1);
      }
    }
    .play-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      border-radius: 50%;
      transition:
        background-color 0.3s,
        transform 0.3s;
      cursor: pointer;
      .n-icon {
        color: var(--primary-hex);
      }
      &:hover {
        transform: scale(1.1);
        background-color: rgba(var(--primary), 0.16);
      }
      &:active {
        transform: scale(1);
      }
    }
  }
  .play-menu {
    .time {
      display: flex;
      align-items: center;
      font-size: 12px;
      margin-right: 8px;
      .n-text {
        color: var(--primary-hex);
        opacity: 0.8;
        &:nth-of-type(1) {
          &::after {
            content: '/';
            margin: 0 4px;
          }
        }
      }
    }
    .menu-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 8px;
      border-radius: 8px;
      transition:
        background-color 0.3s,
        transform 0.3s;
      cursor: pointer;
      .n-icon {
        font-size: 22px;
        color: var(--primary-hex);
      }
      &:hover {
        transform: scale(1.1);
        background-color: rgba(var(--primary), 0.28);
      }
      &:active {
        transform: scale(1);
      }
    }
  }
}
// 音量调节
.volume-change {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 64px;
  height: 200px;
  padding: 12px 16px;
  .slider-num {
    margin-top: 4px;
    font-size: 12px;
  }
}

/* 默认隐藏删除按钮 */
.playlist-item .delete-btn-wrapper {
  opacity: 0;
  transition: opacity 0.2s ease;
}

/* 鼠标悬停在列表项时显示删除按钮 */
.playlist-item:hover .delete-btn-wrapper {
  opacity: 1;
}

/* 可选：添加按钮本身的过渡效果 */
.delete-btn {
  transition: all 0.2s ease;
}
</style>
