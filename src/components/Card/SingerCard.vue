<template>
  <div class="singer-card">
    <NCard size="small" class="card-container">
      <template #cover>
        <div class="cover-container">
          <div class="background-blur">
            <NImage
              class="blur-image"
              :src="cover"
              :preview-disabled="true"
              object-fit="cover"
            />
          </div>
          <div class="circle-overlay">
            <NImage
              class="circle-image"
              :src="cover"
              :preview-disabled="true"
              object-fit="cover"
            />
          </div>
        </div>
      </template>
      <div class="flex flex-col space-y-1">
        <div class="name">
          <NEllipsis
            :line-clamp="1"
            style="font-size: 14px; font-weight: 800"
          >
            {{ props.singer?.singername }}
          </NEllipsis>
        </div>
        <div class="flex items-center space-x-2">
          <div class="flex items-center space-x-1">
            <NIcon :size="16">
              <MusicNoteFilled />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ props.singer?.songcount || 0 }}
            </NText>
          </div>
          <div class="flex items-center space-x-1">
            <NIcon :size="16">
              <AlbumRound />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ props.singer?.albumcount || 0 }}
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
              {{ props.singer?.mvcount || 0 }}
            </NText>
          </div>
        </div>
        <div class="flex items-center space-x-2">
          <div class="flex items-center space-x-1">
            <NIcon :size="16">
              <PeopleRound />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ props.singer?.fanscount || 0 }}
            </NText>
          </div>
          <div class="flex items-center space-x-1">
            <NIcon :size="16">
              <WhatshotRound />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ props.singer?.heat }}
            </NText>
          </div>
        </div>
      </div>
    </NCard>
  </div>
</template>

<script lang="ts" setup>
import type { Singer } from '@/types';
import { getCover } from '@/utils';
import { NCard, NEllipsis, NImage } from 'naive-ui';
import { computed } from 'vue';
import {
  MusicNoteFilled,
  SmartDisplayRound,
  WhatshotRound,
  PeopleRound,
  AlbumRound,
} from '@vicons/material';

defineOptions({
  name: 'AlbumCard',
});

const props = defineProps<{
  singer?: Singer;
}>();

const cover = computed(() => {
  return getCover(props.singer?.imgurl || '');
});
</script>

<style lang="scss" scoped>
.singer-card {
  .card-container {
    transition: transform 0.3s ease, box-shadow 0.3s ease;
    cursor: pointer;
    
    &:hover {
      transform: translateY(-6px);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
    }
  }

  .cover-container {
    position: relative;
    width: 100%;
    aspect-ratio: 1;
    overflow: hidden;
    
    .background-blur {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      
      .blur-image {
        width: 100%;
        height: 100%;
        filter: blur(8px);
      }
    }
    
    .circle-overlay {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 70%;
      height: 70%;
      border-radius: 50%;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.4);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      
      .circle-image {
        width: 100%;
        height: 100%;
      }
    }
  }

  .cover {
    width: 100%;
  }
}
</style>
