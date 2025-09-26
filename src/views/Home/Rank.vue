<template>
  <div class="rank">
    <NCard
      size="small"
      hoverable
    >
      <template #header> 排行榜 </template>
      <NRadioGroup
        class="w-full"
        v-model:value="checkedRankId"
        @update-value="handleChecked"
      >
        <div class="grid grid-cols-[repeat(auto-fit,150px)] gap-3 p-2">
          <NRadio
            v-for="rank in ranks"
            :key="rank.rankid"
            :value="rank.rankid"
          >
            {{ rank.rankname }}
          </NRadio>
        </div>
      </NRadioGroup>
    </NCard>

    <div
      class="mt-2"
      v-if="checkedRank"
    >
      <NCard
        size="small"
        hoverable
      >
        <template #header>
          <div>
            {{ checkedRank.rankname }}
          </div>
        </template>
        <template #header-extra>
          <div>
            <NButton
              :focusable="false"
              text
              :loading="loading"
              @click="handleRankSongListRefresh"
            >
              <template #icon>
                <NIcon>
                  <RefreshRound />
                </NIcon>
              </template>
            </NButton>
          </div>
        </template>
        <div class="grid grid-cols-[repeat(auto-fit,200px)] justify-center gap-4 p-2 h-[600px]">
          <div
            v-if="loading"
            class="h-[600px] flex items-center justify-center"
          >
            <NSpin :show="loading" />
          </div>
          <div
            v-else
            v-for="song in rankSongs"
            :key="song.hash"
          >
            <SongCard
              :song="song"
              @play="handlePlaySong(song)"
            />
          </div>
        </div>
      </NCard>
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { Rank, Song } from '@/types';
import { getRankList, getRankSongList } from '@/api';
import { NButton, NCard, NIcon, NRadio, NRadioGroup } from 'naive-ui';
import { computed, nextTick, onMounted, ref } from 'vue';
import { RefreshRound } from '@vicons/material';
import SongCard from '@/components/Card/SongCard.vue';
import player from '@/utils/player';

defineOptions({
  name: 'Rank',
});

const loading = ref(false);
const ranks = ref<Rank[]>([]);
const checkedRankId = ref<number | null>(null);

const rankSongs = ref<Song[]>([]);

const checkedRank = computed(() => {
  return ranks.value.find(rank => rank.rankid === checkedRankId.value);
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
    console.log(error);
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

const handleChecked = async (rankid: number) => {
  if (rankid) {
    await getRankSongs();
  } else {
    checkedRankId.value = null;
    rankSongs.value = [];
  }
};

const handleRankSongListRefresh = async () => {
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
