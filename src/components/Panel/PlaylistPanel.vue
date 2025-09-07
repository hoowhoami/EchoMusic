<template>
  <div class="playlist-panel">
    <NThing content-indented>
      <template #avatar>
        <NImage
          class="cover"
          :width="coverSize"
          :height="coverSize"
          :src="cover"
        />
      </template>
      <template #header>
        <NEllipsis
          :line-clamp="1"
          style="font-size: 16px; font-weight: 800"
        >
          {{ playlist?.name }}
        </NEllipsis>
      </template>
      <template #description>
        <div
          class="flex flex-col"
          style="margin-top: -5px"
        >
          <div class="creator flex items-center space-x-2">
            <NAvatar
              round
              size="small"
              :src="avatar"
              :fallback-src="avatar"
            />
            <div
              class="name"
              style="font-size: 12px"
            >
              {{ creator }}
            </div>
            <div
              class="time"
              style="font-size: 12px"
            >
              {{ createTime }} 创建
            </div>
          </div>
        </div>
      </template>
      <div class="flex flex-col justify-between space-y-2">
        <div
          v-if="playlistTags"
          class="tags flex items-center space-x-2"
        >
          <NTag
            v-for="tag in playlistTags"
            :key="tag"
            size="small"
            round
          >
            {{ tag }}
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
              {{ playlist?.count || 0 }}
            </NText>
          </div>
          <div class="flex items-center space-x-1">
            <NIcon :size="16">
              <ArrowsSort />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ playlist?.sort || 0 }}
            </NText>
          </div>
          <div class="flex items-center space-x-1">
            <NIcon :size="16">
              <HistoryOutlined />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ updateTime }}
            </NText>
          </div>
        </div>
      </div>
      <template #footer>
        <NEllipsis
          :line-clamp="1"
          style="font-size: 12px"
          >{{ playlistIntro }}</NEllipsis
        >
      </template>
    </NThing>
  </div>
</template>

<script lang="ts" setup>
import { Playlist } from '@/types';
import { formatTimestamp, getCover } from '@/utils';
import { NEllipsis, NImage, NThing } from 'naive-ui';
import { computed } from 'vue';
import { MusicNoteFilled, HistoryOutlined } from '@vicons/material';
import { ArrowsSort } from '@vicons/tabler';
import { useUserStore } from '@/store';

defineOptions({
  name: 'PlaylistCard',
});

const props = defineProps<{
  playlist?: Playlist;
}>();

const userStore = useUserStore();

const coverSize = computed(() => {
  return 150;
});

const cover = computed(() => {
  return getCover(props.playlist?.pic || '', 150);
});

const avatar = computed(() => {
  return getCover(props.playlist?.create_user_pic || '', 40);
});

const creator = computed(() => {
  return props.playlist?.list_create_username || '未知';
});

const createTime = computed(() => {
  return formatTimestamp((props.playlist?.create_time || 0) * 1000);
});

const updateTime = computed(() => {
  return formatTimestamp((props.playlist?.update_time || 0) * 1000);
});

const playlistIntro = computed(() => {
  return props.playlist?.intro || '暂无简介';
});

const playlistTags = computed(() => {
  const tags = props.playlist?.tags?.split(',').filter((tag: string) => tag.trim());
  if (tags && tags.length > 0) {
    return tags;
  }
  // 用户歌单
  if (userStore.isCreatedPlaylist(props.playlist?.list_create_gid || '')) {
    if (userStore.isDefaultPlaylist(props.playlist?.list_create_gid || '')) {
      return ['默认'];
    }
    return ['自建'];
  }
  return ['unknown'];
});
</script>

<style lang="scss" scoped>
.playlist-panel {
  .cover {
    border-radius: 8px;
  }
}
</style>
