<template>
  <div class="playlist-card">
    <NCard size="small" class="card-container">
      <template #cover>
        <div class="cover-container">
          <NImage
            class="cover"
            :src="cover"
            :preview-disabled="true"
            object-fit="fill"
          />
          <div class="play-button-overlay">
            <div class="play-button">
              <NIcon :size="24" color="white">
                <PlayArrowRound />
              </NIcon>
            </div>
          </div>
        </div>
      </template>
      <div class="flex flex-col space-y-1">
        <div class="name">
          <NEllipsis
            :line-clamp="1"
            style="font-size: 14px; font-weight: 800"
          >
            {{ props.playlist?.name }}
          </NEllipsis>
        </div>
        <div
          class="time"
          style="font-size: 12px"
        >
          <NEllipsis
            :line-clamp="1"
            style="font-size: 12px"
          >
            {{ creator }} {{ publishTime }} 发布
          </NEllipsis>
        </div>
        <div class="count flex items-center space-x-2">
          <div class="flex items-center space-x-1">
            <NIcon :size="16">
              <MusicNoteFilled />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ props.playlist?.count || 0 }}
            </NText>
          </div>
          <div class="flex items-center space-x-1">
            <NIcon :size="16">
              <SmartDisplayRound />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ props.playlist?.play_count || 0 }}
            </NText>
          </div>
        </div>
      </div>
    </NCard>
  </div>
</template>

<script lang="ts" setup>
import type { Playlist } from '@/types';
import { getCover } from '@/utils';
import { NCard, NEllipsis, NImage } from 'naive-ui';
import { computed } from 'vue';
import { MusicNoteFilled, SmartDisplayRound, PlayArrowRound } from '@vicons/material';

defineOptions({
  name: 'PlaylistCard',
});

const props = defineProps<{
  playlist?: Playlist;
}>();

const cover = computed(() => {
  return getCover(props.playlist?.pic || '');
});

const creator = computed(() => {
  return props.playlist?.list_create_username || '未知';
});

const publishTime = computed(() => {
  return props.playlist?.publish_date;
});
</script>

<style lang="scss" scoped>
.playlist-card {
  .card-container {
    transition: transform 0.3s ease, box-shadow 0.3s ease;
    cursor: pointer;
    
    &:hover {
      transform: translateY(-4px);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
    }
  }

  .cover-container {
    position: relative;
    
    .cover {
      width: 100%;
    }
    
    .play-button-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.4);
      opacity: 0;
      transition: opacity 0.3s ease;
      
      .play-button {
        background: rgba(255, 255, 255, 0.2);
        border-radius: 50%;
        width: 48px;
        height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(10px);
        transition: all 0.3s ease;
        
        &:hover {
          background: rgba(255, 255, 255, 0.3);
          transform: scale(1.1);
        }
      }
    }
    
    &:hover .play-button-overlay {
      opacity: 1;
    }
  }
}
</style>
