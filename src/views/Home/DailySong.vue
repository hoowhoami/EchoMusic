<template>
  <div class="daily-song flex flex-col space-y-4">
    <div class="title">根据你的音乐口味每日歌曲推荐</div>
    <div class="flex flex-wrap flex-start justify-stretch gap-4 max-h-[600px]">
      <div
        v-if="loading"
        class="h-[600px] flex items-center justify-center"
      >
        <NSpin :show="loading" />
      </div>
      <SongCard
        v-else
        v-for="item in recommend"
        class="flex-1 min-w-[200px] max-w-[250px]"
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
import { getEverydayRecommend } from '@/api';
import SongCard from '@/components/Card/SongCard.vue';
import { onMounted, ref } from 'vue';
import player from '@/utils/player';

defineOptions({
  name: 'DailySong',
});

const loading = ref(false);
const recommend = ref<Song[]>([]);

const handlePlay = (song: Song) => {
  player.addNextSong(song, true);
};

const getDailyRecommend = async () => {
  try {
    loading.value = true;
    recommend.value = [];
    const res = await getEverydayRecommend();
    recommend.value =
      res?.song_list?.map((item: any) => {
        return {
          ...item,
          name: item.filename || item.songname,
          cover: item.sizable_cover,
          timelen: item.time_length,
        };
      }) || [];
  } catch (error) {
    console.log('获取推荐歌曲失败: ', error);
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  getDailyRecommend();
});
</script>

<style lang="scss" scoped>
.daily-song {
  .title {
    font-size: 1.2rem;
    font-weight: bold;
  }
}
</style>
