<!-- 歌单列表 -->
<template>
  <div class="playlist">
    <div class="info">
      <div class="flex space-x-4">
        <NImage
          class="rounded-lg"
          width="200"
          height="200"
          :src="getCover(playlistInfo?.pic, 200)"
          :fallback-src="getCover(playlistInfo?.pic, 200)"
        />
        <div class="detail flex flex-col">
          <NH2>{{ playlistInfo?.name }}</NH2>
          <div class="flex flex-col space-y-4">
            <div class="creator flex items-center space-x-2">
              <NAvatar
                round
                size="small"
                :src="getCover(playlistInfo?.create_user_pic, 50)"
                :fallback-src="getCover(playlistInfo?.create_user_pic, 50)"
              />
              <div class="name">{{ playlistInfo?.list_create_username }}</div>
              <div class="time">{{ formatTimestamp(playlistInfo?.create_time * 1000) }} 创建</div>
            </div>
            <div v-if="playlistTags" class="tags flex items-center space-x-2">
              <NTag v-for="tag in playlistTags" :key="tag" size="small" round>
                {{ tag }}
              </NTag>
            </div>
            <div class="count flex items-center space-x-2">
              <div class="flex items-center space-x-1">
                <NIcon :size="18">
                  <MusicNoteFilled />
                </NIcon>
                <NText depth="3"> {{ playlistInfo?.count || 0 }} </NText>
              </div>
              <div class="flex items-center space-x-1">
                <NIcon :size="18">
                  <ArrowsSort />
                </NIcon>
                <NText depth="3"> {{ playlistInfo?.sort || 0 }} </NText>
              </div>
              <div class="flex items-center space-x-1">
                <NIcon :size="18">
                  <HistoryOutlined />
                </NIcon>
                <NText depth="3"> {{ formatTimestamp(playlistInfo?.update_time * 1000) }} </NText>
              </div>
            </div>
            <NEllipsis :line-clamp="1">{{ playlistIntro }}</NEllipsis>
          </div>
        </div>
      </div>
    </div>
    <div class="list">
      {{ playlistInfo }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { getPlaylistDetail } from '@/api';
import { formatTimestamp, getCover } from '@/utils';
import { NAvatar, NEllipsis, NH2, NIcon, NImage, NText } from 'naive-ui';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { MusicNoteFilled, HistoryOutlined } from '@vicons/material';
import { ArrowsSort } from '@vicons/tabler';

defineOptions({
  name: 'Playlist',
});

const route = useRoute();

const playlistId = ref('');
const playlistInfo = ref();

const getPlaylistInfo = async () => {
  const res = await getPlaylistDetail(playlistId.value);
  playlistInfo.value = res?.[0];
};

const playlistTags = computed(() => {
  const tags = playlistInfo.value?.tags?.split(',').filter((tag: string) => tag.trim());
  if (tags?.length > 0) {
    return tags;
  }
  return ['默认'];
});

const playlistIntro = computed(() => {
  return playlistInfo.value?.intro || '暂无简介';
});

onMounted(() => {
  console.log('Playlist');
  getPlaylistInfo();
});

watch(
  () => route.query.id,
  newValue => {
    console.log(newValue);
    playlistId.value = newValue as string;
    getPlaylistInfo();
  },
);
</script>

<style lang="scss" scoped></style>
