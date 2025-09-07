<template>
  <div class="playlist-card">
    <NCard size="small">
      <template #header>
        <NEllipsis
          :line-clamp="1"
          style="font-size: 14px; font-weight: 800"
        >
          {{ playlist?.name }}
        </NEllipsis>
      </template>
      <template #cover>
        <NImage
          class="cover"
          :width="coverSize"
          :height="coverSize"
          :src="cover"
        />
      </template>
      <div class="flex flex-col space-y-2">
        <div
          class="time"
          style="font-size: 12px"
        >
          {{ creator }} {{ publishTime }} 发布
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
              {{ playlist?.count || 0 }}
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
              {{ playlist?.play_count || 0 }}
            </NText>
          </div>
        </div>
      </div>
    </NCard>
  </div>
</template>

<script lang="ts" setup>
import { Playlist } from '@/types';
import { getCover } from '@/utils';
import { NCard, NEllipsis, NImage } from 'naive-ui';
import { computed } from 'vue';
import { MusicNoteFilled, SmartDisplayRound } from '@vicons/material';

defineOptions({
  name: 'PlaylistCard',
});

const props = defineProps<{
  playlist?: Playlist;
}>();

const coverSize = computed(() => {
  return 150;
});

const cover = computed(() => {
  return getCover(props.playlist?.pic || '', 150);
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
  .cover {
    border-radius: 8px;
  }
}
</style>
