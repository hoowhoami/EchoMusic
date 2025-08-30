<template>
  <div class="player flex flex-col">
    <div class="player-slider">
      <NSlider v-model:value="playerStore.progress"
               :step="0.01"
               :min="0"
               :max="100"
               :tooltip="false"
               :keyboard="false"
               :marks="playerStore.climax"
               class="player-slider"
               @dragstart="player.pause(false)"
               @dragend="sliderDragend"/>
    </div>
    <div class="flex mt-[9px] h-[60px] px-[10px] items-center justify-between">
      <!-- 信息 -->
      <div class="play-data flex items-center space-x-2">
        <!-- 封面 -->
        <Transition name="fade" mode="out-in">
          <div
            :key="playerStore.current?.cover"
            class="cover"
          >
            <NImage
              :src="playerStore.current?.cover"
              :alt="playerStore.current?.cover"
              class="cover-img w-[50px] h-[50px] rounded-lg"
              preview-disabled
            />
            
            <!-- 打开播放器 -->
            <SvgIcon name="Zoom" :size="30" />
          </div>
        </Transition>
        <!-- 信息 -->
        <Transition name="left-sm" mode="out-in">
          <div :key="playerStore.current?.hash" class="info">
            <div class="data">
              <!-- 名称 -->
              <NEllipsis :line-clamp="1" class="name" style="font-size: 12px;">
                {{ playerStore.current?.name }}
              </NEllipsis>
              <!-- 喜欢 -->
              
              <!-- 更多操作 -->
              
            </div>
            <Transition name="fade" mode="out-in">
              <!-- 歌词 -->
              
              <!-- 歌手 -->
              <div class="artists">
                <template v-if="Array.isArray(playerStore.current?.singerinfo)">
                  <NText
                    v-for="(item, index) in playerStore.current.singerinfo"
                    :key="index"
                    style="font-size: 10px;"
                    class="ar-item"
                  >
                    {{ item.name }}
                  </NText>
                </template>
                <NText v-else class="ar-item">
                  {{ playerStore.current?.singerinfo || "未知艺术家" }}
                </NText>
              </div>
            </Transition>
          </div>
        </Transition>
      </div>
      <!-- 控制 -->
      <div class="play-control flex items-center space-x-2">
        <!-- 不喜欢 -->
        
        <!-- 上一曲 -->
        <NButton ghost text v-debounce="() => player.nextOrPrev('prev')">
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
            <Transition name="fade" mode="out-in">
              <NIcon :size="28">
                <PauseRound v-if="playerStore.isPlaying" />
                <PlayArrowRound v-else />
              </NIcon>
            </Transition>
          </template>
        </NButton>
        <!-- 下一曲 -->
        <NButton ghost text v-debounce="() => player.nextOrPrev('next')">
          <template #icon>
            <NIcon :size="26">
              <SkipNextRound />
            </NIcon>
          </template>
        </NButton> 
      </div>
      <!-- 功能 -->
      <Transition name="fade" mode="out-in">
        <NFlex
          key="normal"
          :size="[8, 0]"
          class="play-menu items-center"
          justify="end"
        >
          <!-- 播放时间 -->
          <div class="time">
            <NText depth="2">{{ msToTime(playerStore.currentTime) }}</NText>
            <NText depth="2">{{ msToTime(playerStore.duration) }}</NText>
          </div>
          <!-- 桌面歌词 -->
          
          <!-- 播放模式 -->
          <NDropdown 
            :options="playModeOptions"
            :show-arrow="true"
            @select="(mode) => player.togglePlayMode(mode)"
          >
            <div class="menu-icon" @click.stop="player.togglePlayMode(false)">
              <NButton ghost text>
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
              <div class="menu-icon" @click.stop="player.toggleMute" @wheel="player.setVolume">
                <NButton ghost text>
                  <template #icon>
                    <NIcon :size="20">
                      <component :is="volumeIcon" />
                    </NIcon>
                  </template>
                </NButton>
              </div>
            </template>
            <div class="volume-change w-[40px] h-[100px] flex flex-col items-center justify-center" @wheel="player.setVolume">
              <NSlider
                v-model:value="playerStore.volume"
                :tooltip="false"
                :min="0"
                :max="1"
                :step="0.01"
                vertical
                @update:value="(val) => player.setVolume(val)"
              />
              <NText class="slider-num" style="font-size: 12px;">{{ (playerStore.volume * 100).toFixed(0) }}%</NText>
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
            <NButton ghost text class="menu-icon" @click.stop="playerStore.playlistShow = !playerStore.playlistShow">
              <template #icon>
                <NIcon :size="20">
                  <ListRound />
                </NIcon>
              </template>
            </NButton>
          </NBadge>
        </NFlex>
      </Transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NBadge, NButton, NDropdown, NEllipsis, NFlex, NIcon, NImage, NPopover, NSlider, NText } from 'naive-ui';

import { usePlayerStore, useSettingStore } from '@/store';
import { calculateCurrentTime, msToTime, renderIcon } from '@/utils';
import player from '@/utils/player';
import { computed, ref } from 'vue';
import {Repeat, RepeatOnce, ArrowsShuffle, Volume, Volume2, Volume3} from '@vicons/tabler';
import { SkipPreviousRound, SkipNextRound, PauseRound, PlayArrowRound, ListRound } from '@vicons/material';

const playerStore = usePlayerStore();

const settingStore = useSettingStore();

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

</script>

<style scoped lang="scss">
.player {
  .player-slider {
    position: absolute;
    width: 100%;
    height: 16px;
    top: -4px;
    left: 0;
    margin: 0;
    z-index: 1000;
    --n-rail-height: 3px;
    --n-handle-size: 14px;
  }
}
</style>
