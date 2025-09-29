<template>
  <div class="ip-card">
    <NCard
      size="small"
      class="card-container"
    >
      <template #cover>
        <div class="cover-container">
          <NImage
            class="cover"
            :src="cover"
            :preview-disabled="true"
            object-fit="fill"
          >
            <template #placeholder>
              <img
                class="w-full h-full object-cover"
                :src="cover"
              />
            </template>
          </NImage>
          <div class="play-button-overlay">
            <div class="play-button">
              <NIcon
                :size="24"
                color="white"
              >
                <PlayArrowRound />
              </NIcon>
            </div>
          </div>
        </div>
      </template>
      <div class="flex flex-col space-y-2">
        <div class="name">
          <NEllipsis
            :line-clamp="1"
            style="font-size: 14px; font-weight: 800"
          >
            {{ props.ip?.title }}
          </NEllipsis>
        </div>
        <div class="intro">
          <NEllipsis
            :line-clamp="1"
            style="font-size: 12px; font-weight: 400"
          >
            <NText :depth="3">
              {{ props.ip?.sub_title || '暂无' }}
            </NText>
          </NEllipsis>
        </div>
      </div>
    </NCard>
  </div>
</template>

<script lang="ts" setup>
import type { IP } from '@/types';
import { getCover } from '@/utils';
import { NCard, NEllipsis, NImage, NText } from 'naive-ui';
import { computed } from 'vue';
import { PlayArrowRound } from '@vicons/material';

defineOptions({
  name: 'IPCard',
});

const props = defineProps<{
  ip?: IP;
}>();

const cover = computed(() => {
  return getCover(props.ip?.sizable_image_url || '');
});
</script>

<style lang="scss" scoped>
.ip-card {
  .card-container {
    transition:
      transform 0.3s ease,
      box-shadow 0.3s ease;
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
