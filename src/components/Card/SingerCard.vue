<template>
  <div class="singer-card">
    <NCard size="small">
      <template #header>
        <NEllipsis
          :line-clamp="1"
          style="font-size: 14px; font-weight: 800"
        >
          {{ props.singer?.singername }}
        </NEllipsis>
      </template>
      <template #cover>
        <NImage
          class="cover"
          :width="coverSize"
          :height="coverSize"
          :src="cover"
          :preview-disabled="true"
        />
      </template>
      <div class="flex flex-col space-y-2">
        <div class="count flex items-center space-x-2">
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

const coverSize = computed(() => {
  return 150;
});

const cover = computed(() => {
  return getCover(props.singer?.imgurl || '', 150);
});
</script>

<style lang="scss" scoped>
.singer-card {
  .cover {
    border-radius: 8px;
  }
}
</style>
