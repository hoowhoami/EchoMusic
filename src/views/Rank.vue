<template>
  <div class="rank">
    <NCard
      size="small"
      hoverable
    >
      <template #header> 排行榜 </template>
      <template #header-extra>
        <div>
          <NButton
            :focusable="false"
            text
            :loading="loading"
            @click="handleRankListRefresh"
          >
            <template #icon>
              <NIcon>
                <RefreshRound />
              </NIcon>
            </template>
          </NButton>
        </div>
      </template>
      <div class="grid grid-cols-[repeat(auto-fit,130px)] justify-center gap-4 p-2">
        <NTag
          v-for="rank in ranks"
          :key="rank.rankid"
          checkable
          v-model:checked="rank.checked"
          @update-checked="handleTagChecked($event, rank)"
        >
          {{ rank.rankname }}
        </NTag>
      </div>
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
import { NButton, NCard, NIcon, NTag } from 'naive-ui';
import { nextTick, onMounted, ref } from 'vue';
import { RefreshRound } from '@vicons/material';
import SongCard from '@/components/Card/SongCard.vue';
import player from '@/utils/player';

defineOptions({
  name: 'Rank',
});

interface CheckableRank extends Rank {
  checked: boolean;
}

const loading = ref(false);
const ranks = ref<CheckableRank[]>([]);
const checkedRank = ref<CheckableRank>();
const rankSongs = ref<Song[]>([]);

const getRank = async () => {
  try {
    loading.value = true;
    ranks.value = [];
    rankSongs.value = [];
    checkedRank.value = undefined;
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
    if (!checkedRank.value) {
      return;
    }
    loading.value = true;
    rankSongs.value = [];
    const res = await getRankSongList({ rankid: checkedRank.value.rankid });
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

const uncheckOther = (checkedRank: CheckableRank) => {
  ranks.value.forEach(item => {
    if (item.rankid !== checkedRank.rankid) {
      item.checked = false;
    }
  });
};

const handlePlaySong = (song: Song) => {
  player.addNextSong(song, true);
};

const handleTagChecked = async (checked: boolean, rank: CheckableRank) => {
  if (checked) {
    checkedRank.value = rank;
    uncheckOther(rank);
    await getRankSongs();
  } else {
    checkedRank.value = undefined;
    rankSongs.value = [];
  }
};

const handleRankListRefresh = async () => {
  await getRank();
};

const handleRankSongListRefresh = async () => {
  await getRankSongs();
};

onMounted(async () => {
  await getRank();
  nextTick(async () => {
    if (ranks.value.length > 0) {
      ranks.value[0].checked = true;
      checkedRank.value = ranks.value[0];
      await getRankSongs();
    }
  });
});
</script>

<style lang="scss" scoped></style>
