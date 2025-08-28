<!-- 歌单列表 -->
<template>
  <div class="playlist">
    <div class="info">
      <div class="flex space-x-4">
        <NImage
          width="200"
          height="200"
          :src="getCover(playlistInfo?.pic, 200)"
          :fallback-src="getCover(playlistInfo?.pic, 200)"
        />
        <div class="detail flex flex-col space-y-2">
          <NH2>{{ playlistInfo?.name }}</NH2>
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
          <div v-if="playlistInfo?.tags" class="tags flex items-center space-x-2">
            <NTag v-for="tag in playlistInfo?.tags?.split(',')" :key="tag" size="small" round>
              {{ tag }}
            </NTag>
          </div>
          <div class="count flex items-center space-x-2">
            <div class="flex items-center space-x-1">
              <NIcon :size="20">
                <MusicalNotes />
              </NIcon>
              <NText depth="3"> {{ playlistInfo?.count || 0 }} </NText>
            </div>
            <div class="flex items-center space-x-1">
              <NIcon :size="20">
                <Push />
              </NIcon>
              <NText depth="3"> {{ playlistInfo?.publish_date }} </NText>
            </div>
            <div class="flex items-center space-x-1">
              <NIcon :size="20">
                <Time />
              </NIcon>
              <NText depth="3"> {{ formatTimestamp(playlistInfo?.update_time * 1000) }} </NText>
            </div>
          </div>
          <NEllipsis :line-clamp="2">{{ playlistInfo?.intro }}</NEllipsis>
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
import { onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { MusicalNotes, Push, Time } from '@vicons/ionicons5';

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
