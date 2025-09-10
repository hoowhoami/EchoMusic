<template>
  <div class="flex flex-col space-y-4">
    <div class="info">
      <AlbumPanel :album="albumInfo" />
    </div>
    <SongListContainer
      virtual-scroll
      :max-height="maxHeight"
      :songs="songs"
      :album="albumInfo"
      :loading="loading"
      @play-all="handlePlayAll"
      @song-removed="handleSongRemoved"
    />
  </div>
</template>

<script setup lang="ts">
import type { Song } from '@/types';
import { getAlbumDetail, getAlbumSongs } from '@/api';
import SongListContainer from '@/components/Container/SongListContainer.vue';
import AlbumPanel from '@/components/Panel/AlbumPanel.vue';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import player from '@/utils/player';
import { useSettingStore } from '@/store';

defineOptions({
  name: 'Album',
});

const settingStore = useSettingStore();

const maxHeight = computed(() => {
  return settingStore.mainHeight - 290;
});

const route = useRoute();
const albumId = ref();
const albumInfo = ref();
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

const getAlbumInfo = async () => {
  if (!albumId.value) {
    return;
  }
  const res = await getAlbumDetail(albumId.value);
  albumInfo.value = res?.map((item: any) => {
    console.log(item);
    return {
      ...item,
      albumid: item.album_id,
      albumname: item.album_name,
      singer: item.author_name,
      publish_time: item.publish_date,
      img: item.sizable_cover,
    };
  })?.[0];
  console.log(albumInfo.value);
};

const getSongs = async () => {
  if (!albumId.value) {
    return;
  }
  let page = 1;
  const size = 300;
  let fetchCount = 0;
  songs.value = [];
  try {
    loading.value = true;
    do {
      const res = await getAlbumSongs(albumId.value, page, size);
      songs.value.push(...res.songs);
      fetchCount = res.songs.length;
      page++;
    } while (fetchCount > 0);
  } finally {
    loading.value = false;
  }
};

onMounted(async () => {
  albumId.value = route.query.id;
  getAlbumInfo();
  getSongs();
});
</script>

<style scoped></style>
