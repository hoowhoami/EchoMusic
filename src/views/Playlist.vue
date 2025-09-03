<!-- 歌单列表 -->
<template>
  <div class="playlist flex flex-col space-y-4">
    <div class="info">
      <div
        v-if="!playlistInfo"
        class="flex space-x-4"
      >
        <div class="rounded-lg w-[200px] h-[200px]">
          <NSkeleton class="rounded-lg w-[200px] h-[200px]" />
        </div>
        <div class="w-full flex flex-col justify-between space-y-2">
          <NSkeleton
            class="h-[30px] rounded-lg"
            v-for="i in 5"
            :key="i"
          />
        </div>
      </div>
      <PlaylistCard
        v-else
        :playlist="playlistInfo"
      />
    </div>
    <div class="toolbar">
      <SongListMenu
        :songs="songs"
        v-model:selected-songs="checkedSongs"
        v-model:search-keyword="searchKeyword"
        :batch-mode="batchMode"
        :playlist="playlistInfo"
        :is-liked="isLikedPlaylist"
        :show-like="userStore.isAuthenticated && !isCreatedPlaylist"
        :show-delete="userStore.isAuthenticated && isCreatedPlaylist && !isDefaultPlaylist"
        @play-all="handlePlayAll"
        @like="handleLikePlaylist"
        @delete="handleDeletePlaylist"
        @toggle-batch-mode="handleBatchModeClick"
        @locate-current="handleScrollToCurrent"
        @batch-operation-complete="resetBatchMode"
        @add-to-playlist="handleAddToPlaylist"
        @delete-from-playlist="handleDeletedSongs"
      />
    </div>
    <div class="list">
      <SongList
        ref="songListRef"
        virtual-scroll
        :max-height="maxHeight"
        :loading="loading"
        :batch-mode="batchMode"
        v-model="filteredSongs"
        v-model:checked-songs="checkedSongs"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Song } from '@/types';
import { getPlaylistDetail, getPlaylistTrackAll } from '@/api';
import { NSkeleton } from 'naive-ui';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SongList from '@/components/List/SongList.vue';
import PlaylistCard from '@/components/Card/PlaylistCard.vue';
import SongListMenu from '@/components/Menu/SongListMenu.vue';
import { useSettingStore, useUserStore, usePlayerStore } from '@/store';
import player from '@/utils/player';

defineOptions({
  name: 'Playlist',
});

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();
const settingStore = useSettingStore();
const playerStore = usePlayerStore();

const songListRef = ref();

const playlistId = ref('');
const playlistInfo = ref();

const maxHeight = computed(() => {
  return settingStore.mainHeight - 290;
});

const loading = ref(false);
const songs = ref<Song[]>([]);
const checkedSongs = ref<Song[]>([]);

const filteredSongs = ref<Song[]>([]);

const searchKeyword = ref('');

const batchMode = ref(false);

const handleBatchModeClick = () => {
  batchMode.value = !batchMode.value;
  if (!batchMode.value) {
    checkedSongs.value = [];
  }
};

const resetBatchMode = () => {
  batchMode.value = false;
  checkedSongs.value = [];
};

const handleDeletePlaylist = () => {
  userStore
    .deletePlaylist(playlistInfo.value.listid)
    .then(async () => {
      window.$message.success('删除成功');
      router.back();
    })
    .catch(() => {
      window.$message.error('删除失败');
    });
};

const handleLikePlaylist = () => {
  // TODO: 实现收藏/取消收藏逻辑
  if (isLikedPlaylist.value) {
    window.$message.success('已取消收藏');
  } else {
    window.$message.success('已添加到收藏');
  }
};

const handleAddToPlaylist = () => {
  window.$message.success('已添加到播放列表');
};

const handleDeletedSongs = (deletedSongs: Song[]) => {
  // 从当前列表中移除已删除的歌曲
  songs.value = songs.value.filter(song => 
    !deletedSongs.some(deleted => deleted.fileid === song.fileid),
  );
  filteredSongs.value = songs.value;
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
    // 初始化
    filteredSongs.value = songs.value;
  } finally {
    loading.value = false;
  }
};

const handlePlayAll = () => {
  player.updatePlayList(songs.value);
};

const handleScrollToCurrent = () => {
  // 获取当前播放歌曲
  const currentSong = playerStore.current;
  if (!currentSong) {
    window.$message.warning('暂无正在播放的歌曲');
    return;
  }

  // 调用 SongList 组件的 scrollToCurrent 方法
  const success = songListRef.value?.scrollToCurrent();

  if (success) {
    window.$message.success(`已定位到：${currentSong.name}`);
  } else {
    window.$message.warning('当前播放歌曲不在此歌单中');
  }
};

onMounted(() => {
  playlistId.value = route.query.id as string;
  getPlaylistInfo();
  getSongs();
});

watch(
  () => searchKeyword.value,
  newValue => {
    if (!newValue) {
      filteredSongs.value = songs.value;
    } else {
      filteredSongs.value = songs.value.filter(song => {
        const name = song.name;
        const album = song.albuminfo?.name;
        return name.includes(newValue) || album.includes(newValue);
      });
    }
  },
);
</script>

<style lang="scss" scoped></style>
