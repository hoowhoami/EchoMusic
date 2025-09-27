<template>
  <div class="album-card">
    <NCard
      size="small"
      class="card-container"
    >
      <template #cover>
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
      </template>
      <div class="flex flex-col space-y-1">
        <div class="name">
          <NEllipsis
            :line-clamp="1"
            style="font-size: 14px; font-weight: 800"
          >
            {{ props.album?.albumname }}
          </NEllipsis>
        </div>
        <div class="time">
          <NEllipsis
            :line-clamp="1"
            style="font-size: 12px"
          >
            {{ creator }} {{ publishTime }} 发布
          </NEllipsis>
        </div>
        <div class="flex items-center space-x-2">
          <div
            class="language"
            style="font-size: 12px"
          >
            <NTag
              size="small"
              round
              v-if="props.album?.language"
            >
              {{ props.album?.language }}
            </NTag>
          </div>
          <div class="flex items-center space-x-1">
            <NIcon :size="16">
              <MusicNoteFilled />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ props.album?.songcount || 0 }}
            </NText>
          </div>
        </div>
      </div>
    </NCard>
  </div>
</template>

<script lang="ts" setup>
import type { Album } from '@/types';
import { getCover } from '@/utils';
import { NCard, NEllipsis, NImage, NTag } from 'naive-ui';
import { computed } from 'vue';
import { MusicNoteFilled } from '@vicons/material';

defineOptions({
  name: 'AlbumCard',
});

const props = defineProps<{
  album?: Album;
}>();

const cover = computed(() => {
  return getCover(props.album?.img || '');
});

const creator = computed(() => {
  return props.album?.singer || '未知';
});

const publishTime = computed(() => {
  return props.album?.publish_time;
});
</script>

<style lang="scss" scoped>
.album-card {
  .card-container {
    transition:
      transform 0.3s ease,
      box-shadow 0.3s ease;
    cursor: pointer;

    &:hover {
      transform: translateY(-6px);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
    }
  }

  .cover {
    width: 100%;
  }
}
</style>
