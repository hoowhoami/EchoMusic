<template>
  <div class="album-card">
    <NCard size="small">
      <template #cover>
        <NImage
          class="cover"
          :src="cover"
          :preview-disabled="true"
          object-fit="fill"
        />
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
        <div class="count flex items-center space-x-2">
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
          <div class="flex items-center space-x-1">
            <NIcon :size="16">
              <SmartDisplayRound />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ props.album?.play_count || 0 }}
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
import { MusicNoteFilled, SmartDisplayRound } from '@vicons/material';

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
  .cover {
    width: 100%;
  }
}
</style>
