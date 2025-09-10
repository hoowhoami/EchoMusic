<template>
  <div class="flex flex-col space-y-4">
    <div class="info">
      <SingerPanel :singer="singerInfo" />
    </div>
    <SongListContainer
      virtual-scroll
      :max-height="maxHeight"
      :songs="songs"
      :singer="singerInfo"
      :loading="loading"
      @play-all="handlePlayAll"
      @song-removed="handleSongRemoved"
    />
  </div>
</template>

<script setup lang="ts">
import type { Song } from '@/types';
import { getSingerDetail, getSingerSongs } from '@/api';
import SongListContainer from '@/components/Container/SongListContainer.vue';
import SingerPanel from '@/components/Panel/SingerPanel.vue';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import player from '@/utils/player';
import { useSettingStore } from '@/store';

defineOptions({
  name: 'Singer',
});

const settingStore = useSettingStore();

const maxHeight = computed(() => {
  return settingStore.mainHeight - 290;
});

const route = useRoute();
const singerId = ref();
const singerInfo = ref();
const songs = ref<Song[]>([]);
const loading = ref(false);

const handlePlayAll = () => {
  player.updatePlayList(songs.value);
};

const handleSongRemoved = (removedSong?: Song) => {
  if (!removedSong) {
    return;
  }
  songs.value = songs.value.filter(song => removedSong.hash !== song.hash);
};

const getSingerInfo = async () => {
  if (!singerId.value) {
    return;
  }
  const res = await getSingerDetail(singerId.value);
  if (res) {
    res.singerid = res.author_id;
    res.singername = res.author_name;
    res.imgurl = res.sizable_avatar;
    res.songcount = res.song_count || 0;
    res.albumcount = res.album_count || 0;
    res.fanscount = res.fansnums || 0;
    res.mvcount = res.mv_count || 0;
    res.descibe = res.long_intro;
  }
  singerInfo.value = res;
  console.log(singerInfo.value);
};

const getSongs = async () => {
  if (!singerId.value) {
    return;
  }
  let page = 1;
  const size = 300;
  let fetchCount = 0;
  songs.value = [];
  try {
    loading.value = true;
    do {
      let res = await getSingerSongs({
        id: singerId.value,
        page,
        pagesize: size,
      });
      res = res?.map((item: any) => {
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
          album_id: item.album_id,
          albuminfo: {
            id: item.album_id,
            name: item.album_name,
          },
          name: item.author_name + ' - ' + item.audio_name,
          singerinfo: [
            {
              id: singerId.value,
              name: item.author_name,
            },
          ],
          publish_time: item.publish_date,
          cover: item.trans_param?.union_cover,
          relate_goods: relate_goods,
          timelen: item.timelength || 0,
        };
      });
      songs.value.push(...res);
      fetchCount = res.length;
      page++;
    } while (fetchCount > 0);
  } finally {
    loading.value = false;
  }
};

onMounted(async () => {
  singerId.value = route.query.id;
  getSingerInfo();
  getSongs();
});
</script>

<style scoped></style>
