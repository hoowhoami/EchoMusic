<template>
  <div class="recommend-song flex flex-col space-y-3">
    <div class="flex flex-col space-y-1">
      <div
        class="title"
        v-show="recommend.length"
      >
        根据你的音乐口味推荐 {{ count }} 首歌曲
      </div>
      <div
        class="tips"
        v-show="createAt"
      >
        <NText :depth="3"> 该推荐生成于 {{ createAt }} 每日更新 </NText>
      </div>
    </div>
    <div class="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4">
      <div
        v-if="loading"
        class="h-[600px] flex items-center justify-center"
      >
        <NSpin :show="loading" />
      </div>
      <SongCard
        v-else
        v-for="item in recommend"
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
import { getEverydayRecommend } from '@/api';
import SongCard from '@/components/Card/SongCard.vue';
import { onMounted, ref } from 'vue';
import player from '@/utils/player';
import { NText } from 'naive-ui';
import { convertDateFormat } from '@/utils';

defineOptions({
  name: 'RecommendSong',
});

const loading = ref(false);
const createAt = ref('');
const count = ref(0);
const recommend = ref<Song[]>([]);

const handlePlay = (song: Song) => {
  player.addNextSong(song, true);
};

const getDailyRecommend = async () => {
  try {
    loading.value = true;
    recommend.value = [];
    const res = await getEverydayRecommend();
    createAt.value = convertDateFormat(res?.creation_date, 'YYYYMMDD', 'YYYY-MM-DD');
    count.value = res?.song_list_size || 0;
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
.recommend-song {
  .title {
    font-size: 1.2rem;
    font-weight: bold;
  }
  .tips {
    font-size: 0.8rem;
  }
}
</style>
