<template>
  <div
    class="playlist-panel"
    :class="{ small: props.size === 'small' }"
  >
    <NThing content-indented>
      <template #avatar>
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
      <template #header>
        <NEllipsis :line-clamp="1">
          <div class="name">
            {{ props.playlist?.name }}
          </div>
        </NEllipsis>
      </template>
      <template #description>
        <div
          class="flex flex-col description-content"
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
          v-if="playlistTags && props.size !== 'small'"
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
        <div
          class="count flex items-center space-x-2"
          v-if="props.size !== 'small'"
        >
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
              <ArrowsSort />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ props.playlist?.sort || 0 }}
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
      <template
        #footer
        v-if="props.size !== 'small'"
      >
        <NEllipsis
          :line-clamp="1"
          style="font-size: 12px"
          :tooltip="{
            scrollable: true,
          }"
        >
          <template #tooltip>
            <div
              class="intro max-w-[500px] max-h-[200px]"
              style="font-size: 11px"
            >
              {{ playlistIntro }}
            </div>
          </template>
          {{ playlistIntro }}
        </NEllipsis>
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
  name: 'PlaylistPanel',
});

const props = defineProps<{
  size?: 'small' | undefined;
  playlist?: Playlist;
}>();

const userStore = useUserStore();

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
    flex-shrink: 0;
    width: 150px;
    border-radius: 8px;
    transition: width 0.3s ease-in-out;
  }

  .name {
    font-size: 16px;
    font-weight: 800;
    transition: font-size 0.3s ease-in-out;
  }

  .tags {
    transition:
      opacity 0.2s ease-in-out,
      transform 0.2s ease-in-out;
  }

  &.small {
    .cover {
      width: 60px;
    }
    .name {
      font-size: 14px !important;
    }

    .tags {
      opacity: 0;
      transform: translateY(-5px);
    }
  }
}
</style>
