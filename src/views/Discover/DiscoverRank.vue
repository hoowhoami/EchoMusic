<template>
  <div class="discover-rank">
    <div class="menu">
      <NButton
        :focusable="false"
        icon-placement="right"
        strong
        secondary
        round
        @click="rankChangeShow = true"
      >
        <template #icon>
          <NIcon
            class="more"
            depth="3"
          >
            <KeyboardArrowRightRound />
          </NIcon>
        </template>
        {{ title }}
      </NButton>
      <NModal
        v-model:show="rankChangeShow"
        display-directive="show"
        style="width: 600px"
        preset="card"
        title="排行榜列表"
      >
        <div class="tag-list flex flex-wrap items-center justify-stretch gap-4 p-2">
          <NTag
            v-for="rank in ranks"
            :key="rank.rankid"
            :bordered="false"
            class="cursor-pointer"
            :type="rank.rankid === checkedRankId ? 'primary' : 'default'"
            round
            @click="changeRank(rank.rankid)"
          >
            <div class="text-center">
              {{ rank.rankname }}
            </div>
          </NTag>
        </div>
      </NModal>
    </div>
    <div class="mt-4">
      <div class="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4">
        <div
          v-if="loading"
          class="h-[600px] flex items-center justify-center"
        >
          <NSpin :show="loading" />
        </div>
        <SongCard
          v-else
          v-for="song in rankSongs"
          :key="song.hash"
          class="max-w-[200px]"
          :song="song"
          @play="handlePlaySong(song)"
        />
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { Rank, Song } from '@/types';
import { getRankList, getRankSongList } from '@/api';
import { NButton, NIcon, NModal, NTag } from 'naive-ui';
import { computed, nextTick, onMounted, ref } from 'vue';
import SongCard from '@/components/Card/SongCard.vue';
import player from '@/utils/player';
import { KeyboardArrowRightRound } from '@vicons/material';

defineOptions({
  name: 'DiscoverRank',
});

const loading = ref(false);
const ranks = ref<Rank[]>([]);
const checkedRankId = ref<number | null>(null);

const rankSongs = ref<Song[]>([]);

const rankChangeShow = ref<boolean>(false);

const checkedRank = computed(() => {
  return ranks.value.find(rank => rank.rankid === checkedRankId.value);
});

const title = computed(() => {
  return checkedRank.value?.rankname || '请选择';
});

const getRank = async () => {
  try {
    loading.value = true;
    ranks.value = [];
    rankSongs.value = [];
    checkedRankId.value = null;
    const res = await getRankList();
    ranks.value = res?.info?.map((rank: Rank) => ({ ...rank, checked: false })) || [];
  } catch (error) {
    console.log('获取排行榜列表失败', error);
  } finally {
    loading.value = false;
  }
};

const getRankSongs = async () => {
  try {
    if (!checkedRankId.value) {
      return;
    }
    loading.value = true;
    rankSongs.value = [];
    const res = await getRankSongList({ rankid: checkedRankId.value });
    rankSongs.value =
      res?.songlist?.map((item: any) => {
        const singerinfo =
          item.authors?.map((item: any) => {
            return {
              id: item.author_id,
              name: item.author_name,
              avatar: item.sizable_avatar,
              publish: item.is_publish,
            };
          }) || [];
        return {
          ...item,
          hash: item.audio_info?.hash_128,
          name: item.songname,
          cover: item.trans_param?.union_cover,
          timelen: item.audio_info?.duration_128,
          singerinfo: singerinfo,
          albuminfo: {
            id: item.album_id,
            name: item.album_info?.album_name,
            cover: item.album_info?.sizable_cover,
          },
        };
      }) || [];
  } catch (error) {
    console.log('获取排行榜歌曲失败: ', error);
  } finally {
    loading.value = false;
  }
};

const handlePlaySong = (song: Song) => {
  player.addNextSong(song, true);
};

const changeRank = async (rankid: number) => {
  rankChangeShow.value = false;
  checkedRankId.value = rankid;
  await getRankSongs();
};

onMounted(async () => {
  await getRank();
  nextTick(async () => {
    if (ranks.value.length > 0) {
      checkedRankId.value = ranks.value[0]?.rankid;
      await getRankSongs();
    }
  });
});
</script>

<style lang="scss" scoped></style>
