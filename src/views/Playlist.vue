<!-- 歌单列表 -->
<template>
  <div class="playlist flex flex-col space-y-4">
    <div class="info">
      <PlaylistPanel :playlist="playlistInfo" />
    </div>
    <SongListContainer
      ref="songListContainerRef"
      type="playlist"
      :songs="songs"
      :instance="playlistInfo"
      virtual-scroll
      :max-height="maxHeight"
      :loading="loading"
      :is-liked="isLikedPlaylist"
      :show-like="userStore.isAuthenticated && !isCreatedPlaylist"
      :show-delete="userStore.isAuthenticated && isCreatedPlaylist && !isDefaultPlaylist"
      @like="handleLikePlaylist"
      @delete="handleDeletePlaylist"
      @song-removed="handleSongRemoved"
      @deleted-songs="handleDeletedSongs"
    />
  </div>
</template>

<script setup lang="ts">
import type { Playlist, Song } from '@/types';
import { getPlaylistDetail, getPlaylistTrackAll } from '@/api';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SongListContainer from '@/components/Container/SongListContainer.vue';
import PlaylistPanel from '@/components/Panel/PlaylistPanel.vue';
import { useSettingStore, useUserStore } from '@/store';

defineOptions({
  name: 'Playlist',
});

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();
const settingStore = useSettingStore();

const songListContainerRef = ref();

const playlistId = ref('');
const playlistInfo = ref();

const maxHeight = computed(() => {
  return settingStore.mainHeight - 290;
});

const loading = ref(false);
const songs = ref<Song[]>([]);

const handleDeletePlaylist = (data: any) => {
  const playlist = data as Playlist;
  userStore
    .deletePlaylist(playlist.listid)
    .then(async () => {
      window.$message.success('删除成功');
      router.back();
    })
    .catch(() => {
      window.$message.error('删除失败');
    });
};

const handleLikePlaylist = async (playlist: any) => {
  if (!playlist) {
    return;
  }
  const data = playlist as Playlist;
  if (isLikedPlaylist.value) {
    const likedPlaylist = userStore.playlist?.filter(
      item => item.list_create_gid === data.list_create_gid,
    )?.[0];
    if (!likedPlaylist) {
      return;
    }
    await userStore.unlikePlaylist(likedPlaylist.listid);
    window.$message.success('已取消收藏');
  } else {
    await userStore.likePlaylist(data);
    window.$message.success('已添加收藏');
  }
};

const handleDeletedSongs = async (deletedSongs: Song[]) => {
  songs.value = songs.value.filter(
    song => !deletedSongs.some(deleted => deleted.hash === song.hash),
  );
  await getPlaylistInfo();
};

const handleSongRemoved = async (removedSong?: Song) => {
  if (!removedSong) {
    return;
  }
  songs.value = songs.value.filter(song => removedSong.hash !== song.hash);
  await getPlaylistInfo();
};

const isCreatedPlaylist = computed(() => {
  return userStore.isCreatedPlaylist(playlistInfo.value?.list_create_gid);
});

const isLikedPlaylist = computed(() => {
  return userStore.isLikedPlaylist(playlistInfo.value?.list_create_gid);
});

const isDefaultPlaylist = computed(() => {
  return userStore.isDefaultPlaylist(playlistInfo.value?.list_create_gid);
});

const getPlaylistInfo = async () => {
  if (!playlistId.value) {
    return;
  }
  const res = await getPlaylistDetail(playlistId.value);
  playlistInfo.value = res?.[0];
};

const getSongs = async () => {
  if (!playlistId.value) {
    return;
  }
  let page = 1;
  const size = 300;
  let fetchCount = 0;
  songs.value = [];
  try {
    loading.value = true;
    do {
      const res = await getPlaylistTrackAll(playlistId.value, page, size);
      songs.value.push(...res.songs);
      fetchCount = res.songs.length;
      page++;
    } while (fetchCount > 0);
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  playlistId.value = route.query.id as string;
  getPlaylistInfo();
  getSongs();
});
</script>

<style lang="scss" scoped></style>
