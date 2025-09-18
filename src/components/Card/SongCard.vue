<template>
  <div
    class="song-card flex items-center space-x-2 group"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <div
      class="song-cover-wrapper relative rounded-lg overflow-hidden border cursor-pointer"
      :style="{ width: `${coverSize || 40}px`, height: `${coverSize || 40}px` }"
      @click="handlePlay"
    >
      <NImage
        v-if="showCover || true"
        class="song-cover w-full h-full object-cover"
        :src="cover"
        :preview-disabled="true"
        :alt="song.name"
      />

      <!-- 播放状态遮罩层 -->
      <div
        class="cover-overlay absolute inset-0 bg-black transition-all duration-300 flex items-center justify-center"
        :class="{
          'bg-opacity-40': isPlaying || isHovered,
          'bg-opacity-0': !isPlaying && !isHovered,
        }"
      >
        <!-- 播放按钮 -->
        <div
          v-if="!isPlaying"
          class="play-button transform transition-all duration-300 flex items-center justify-center"
          :class="{
            'scale-100 opacity-100': isHovered,
            'scale-75 opacity-0': !isHovered,
          }"
        >
          <NIcon
            :size="(coverSize || 40) * 0.5"
            color="#ffffff"
          >
            <PlayArrowRound />
          </NIcon>
        </div>

        <!-- 音波动画（正在播放时） -->
        <div
          v-if="isPlaying"
          class="absolute inset-0 flex items-center justify-center"
        >
          <div class="flex items-center justify-center space-x-1">
            <div
              v-for="i in 3"
              :key="i"
              class="w-1 rounded-full animate-wave"
              :style="{
                height: `${8 + (i % 2) * 4}px`,
                animationDelay: `${i * 0.15}s`,
                backgroundColor: themeVars.primaryColor,
              }"
            />
          </div>
        </div>
      </div>
    </div>

    <div class="flex items-center justify-between w-full">
      <div class="song-info flex items-center space-x-2">
        <div class="flex flex-col space-y-1">
          <NEllipsis :line-clamp="1">
            <div
              class="song-name"
              :style="{ color: isPlaying ? themeVars.primaryColor : '' }"
            >
              {{ name }}
            </div>
          </NEllipsis>
          <NEllipsis
            class="text-gray-400"
            :line-clamp="1"
          >
            <div class="song-singer">
              {{ singer }}
            </div>
          </NEllipsis>
        </div>
        <div class="tags flex items-center space-x-2">
          <div v-if="isVip">
            <NTag
              size="small"
              type="warning"
            >
              <div>VIP</div>
            </NTag>
          </div>
          <div v-if="quality">
            <NTag
              size="small"
              type="info"
            >
              <div>
                {{ quality }}
              </div>
            </NTag>
          </div>
          <div v-if="cloud">
            <NIcon :size="14">
              <CloudOutlined />
            </NIcon>
          </div>
        </div>
      </div>

      <div
        class="flex items-center space-x-10"
        v-if="showMore"
      >
        <div class="song-album">
          <NEllipsis :line-clamp="1">
            <NText depth="3">
              {{ album }}
            </NText>
          </NEllipsis>
        </div>

        <div class="song-duration">
          <NEllipsis :line-clamp="1">
            <NText depth="3">
              {{ duration }}
            </NText>
          </NEllipsis>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Song } from '@/types';
import { getCover, msToTime } from '@/utils';
import { isArray } from 'lodash-es';
import { NEllipsis, NImage, NIcon, useThemeVars, NText, NTag } from 'naive-ui';
import { computed, ref } from 'vue';
import { CloudOutlined, PlayArrowRound } from '@vicons/material';
import { usePlayerStore } from '@/store';
import player from '@/utils/player';

defineOptions({
  name: 'SongCard',
});

const props = defineProps<{
  song: Song;
  showCover?: boolean;
  coverSize?: number;
  showMore?: boolean;
}>();

const emit = defineEmits<{
  play: [song: Song];
}>();

const playerStore = usePlayerStore();
const themeVars = useThemeVars();
const isHovered = ref(false);

// 检查是否正在播放
const isPlaying = computed(() => {
  return playerStore.current?.hash === props.song.hash && playerStore.isPlaying;
});

// 处理播放
const handlePlay = () => {
  if (isPlaying.value) {
    // 如果正在播放，则暂停
    player.pause();
  } else {
    // 播放当前歌曲
    emit('play', props.song);
  }
};

const cover = computed(() => {
  return getCover(props.song.cover);
});

const name = computed(() => {
  const nameParts = props.song.name.split(' - ');
  return nameParts.length > 1 ? nameParts[1] : props.song.name;
});

const singer = computed(() => {
  return isArray(props.song.singerinfo)
    ? props.song.singerinfo?.map(item => item.name).join(' / ')
    : props.song.singerinfo || '未知艺术家';
});

const isVip = computed(() => {
  return props.song.privilege === 10;
});

const quality = computed(() => {
  if (props.song.relate_goods) {
    if (props.song.relate_goods.length > 2) {
      return 'SQ';
    }
    if (props.song.relate_goods.length > 1) {
      return 'HQ';
    }
  }
  return '';
});

const cloud = computed(() => {
  return props.song.source === 'cloud';
});

const album = computed(() => {
  return props.song.albuminfo?.name || '-';
});

const duration = computed(() => {
  return msToTime(props.song.timelen) || 0;
});
</script>

<style scoped lang="scss">
.song-card {
  .song-cover-wrapper {
    flex-shrink: 0;
    transition: all 0.3s ease;

    &:hover {
      transform: scale(1.05);
    }
  }

  .song-cover {
    transition: transform 0.3s ease;
  }

  .cover-overlay {
    backdrop-filter: blur(0px);
    transition: backdrop-filter 0.3s ease;

    &.bg-opacity-40 {
      backdrop-filter: blur(2px);
    }

    .play-button {
      filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
    }
  }

  .song-info {
    .song-name {
      font-size: 12px;
      transition: color 0.3s ease;

      &.text-green-400 {
        font-weight: 500;
      }
    }
    .song-singer {
      font-size: 10px;
    }
  }

  .song-album,
  .song-duration {
    font-size: 10px;
  }

  // 音波动画
  @keyframes wave {
    0%,
    100% {
      transform: scaleY(0.3);
      opacity: 0.7;
    }
    50% {
      transform: scaleY(1);
      opacity: 1;
    }
  }

  .animate-wave {
    animation: wave 1.2s ease-in-out infinite;
    transform-origin: bottom;
  }

  .tags {
    .n-tag {
      font-size: 8px;
      padding: 1px 4px;
      height: 12px;
    }
  }
}
</style>
