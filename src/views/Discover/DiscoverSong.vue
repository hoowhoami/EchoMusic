<template>
  <div class="discover-song flex flex-col space-y-4">
    <div class="title"></div>
    <div class="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4">
      <div
        v-if="loading"
        class="h-[600px] flex items-center justify-center"
      >
        <NSpin :show="loading" />
      </div>
      <SongCard
        v-else
        v-for="item in songs"
        class="max-w-[200px]"
        :key="item.hash"
        :song="item"
        :loading="loading"
        @play="handlePlay"
      />
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { Song } from '@/types';
import { getSongTop } from '@/api';
import SongCard from '@/components/Card/SongCard.vue';
import { onMounted, ref } from 'vue';
import player from '@/utils/player';

defineOptions({
  name: 'DiscoverSong',
});

const loading = ref(false);
const songs = ref<Song[]>([]);

const handlePlay = (song: Song) => {
  player.addNextSong(song, true);
};

const getTopSongs = async () => {
  try {
    loading.value = true;
    songs.value = [];
    const res = await getSongTop();
    songs.value =
      res?.map((item: any) => {
        const relate_goods = [];
        if (item.hash_320) {
          relate_goods.push({
            hash: item.hash_320,
            quality: '320',
          });
        }
        if (item.hash_flac) {
          relate_goods.push({
            hash: item.hash_flac,
            quality: 'flac',
          });
        }
        return {
          ...item,
          name: item.filename || item.songname,
          cover: item.trans_param?.union_cover,
          timelen: item.timelength,
          relate_goods,
          albuminfo: {
            id: item.album_id,
            name: item.album_name,
          },
          singerinfo: item.authors?.map((it: any) => {
            return {
              ...it,
              id: it.author_id,
              name: it.author_name,
              publish: it.is_publish,
              avatar: it.sizable_avatar,
            };
          }),
        };
      }) || [];
  } catch (error) {
    console.error('获取新歌速递歌曲失败: ', error);
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  getTopSongs();
});
</script>

<style lang="scss" scoped>
.discover-song {
  .title {
    font-size: 1.2rem;
    font-weight: bold;
  }
}
</style>
