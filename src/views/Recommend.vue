<template>
  <div class="recommend">
    <NCard
      title="推荐歌曲"
      size="small"
      hoverable
    >
      <div class="grid grid-cols-[repeat(auto-fit,200px)] justify-center gap-4 p-2 h-[600px]">
        <SongCard
          v-for="item in recommend"
          :key="item.hash"
          :song="item"
          :loading="loading"
          @play="handlePlay"
        />
      </div>
    </NCard>
  </div>
</template>

<script lang="ts" setup>
import type { Song } from '@/types';
import { getEverydayRecommend } from '@/api';
import SongCard from '@/components/Card/SongCard.vue';
import { NCard } from 'naive-ui';
import { onMounted, ref } from 'vue';
import player from '@/utils/player';

defineOptions({
  name: 'Recommend',
});

const loading = ref(false);
const recommend = ref<Song[]>([]);

const handlePlay = (song: Song) => {
  player.addNextSong(song, true);
};

const getDailyRecommend = async () => {
  try {
    loading.value = true;
    const res = await getEverydayRecommend();
    console.log(res);
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

<style lang="scss" scoped></style>
