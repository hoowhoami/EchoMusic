<!-- 歌单列表 -->
<template>
  <div
    ref="pageRef"
    class="playlist flex flex-col space-y-4"
  >
    <div class="info">
      <PlaylistPanel
        :playlist="playlistInfo"
        :size="size"
      />
    </div>
    <SongListContainer
      ref="songListContainerRef"
      type="playlist"
      :songs="songs"
      :instance="playlistInfo"
      virtual-scroll
      :max-height="maxHeight"
      :loading="loading"
      :has-more="hasMore"
      :page-size="pageSize"
      :is-liked="isLikedPlaylist"
      :show-like="userStore.isAuthenticated && !isCreatedPlaylist"
      :show-delete="userStore.isAuthenticated && isCreatedPlaylist && !isDefaultPlaylist"
      @like="handleLikePlaylist"
      @delete="handleDeletePlaylist"
      @song-removed="handleSongRemoved"
      @deleted-songs="handleDeletedSongs"
      @load-more="handleLoadMore"
      v-model:leave-top="leaveTop"
      v-model:scrolling="isScrolling"
    />
  </div>
</template>

<script setup lang="ts">
import type { Playlist, Song } from '@/types';
import { getPlaylistDetail, getPlaylistTrackAll } from '@/api';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SongListContainer from '@/components/Container/SongListContainer.vue';
import PlaylistPanel from '@/components/Panel/PlaylistPanel.vue';
import { useSettingStore, useUserStore } from '@/store';
import { useWheelScroll } from '@/hooks';

defineOptions({
  name: 'Playlist',
});

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();
const settingStore = useSettingStore();

const leaveTop = ref(false);
const songListContainerRef = ref();
const pageRef = ref();

const { isScrolling } = useWheelScroll({
  direction: 'both',
  containerRef: () => pageRef.value,
  excludeSelector: '.n-data-table', // 排除表格内部滚动
  onScroll: deltaY => {
    songListContainerRef.value?.songListRef?.scrollBy(deltaY);
  },
});

const playlistId = ref('');
const playlistInfo = ref();

const size = computed(() => {
  return leaveTop.value ? 'small' : undefined;
});

// 延迟更新的高度，避免动画期间滚动条闪烁
const delayedSize = ref<'small' | undefined>(undefined);
let heightUpdateTimer: NodeJS.Timeout | null = null;

// 监听size变化，延迟更新高度
watch(size, newSize => {
  if (heightUpdateTimer) {
    clearTimeout(heightUpdateTimer);
  }

  if (newSize === 'small') {
    // 缩小时延迟300ms（等动画完成）
    heightUpdateTimer = setTimeout(() => {
      delayedSize.value = newSize;
    }, 300);
  } else {
    // 放大时立即更新
    delayedSize.value = newSize;
  }
});

const maxHeight = computed(() => {
  return settingStore.mainHeight - (delayedSize.value === 'small' ? 200 : 290);
});

const loading = ref(false);
const songs = ref<Song[]>([]);
const hasMore = ref(true);
const pageSize = 30;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handleDeletePlaylist = (data: any) => {
  userStore
    .deletePlaylist(data.listid)
    .then(async () => {
      window.$message.success('删除成功');
      router.back();
    })
    .catch(() => {
      window.$message.error('删除失败');
    });
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handleLikePlaylist = async (data?: any) => {
  if (!data) {
    return;
  }
  const playlist = data as Playlist;
  if (isLikedPlaylist.value) {
    const likedPlaylist = userStore.playlist?.filter(
      item => item.list_create_gid === playlist.list_create_gid,
    )?.[0];
    if (!likedPlaylist) {
      return;
    }
    await userStore.unlikePlaylist(likedPlaylist.listid);
    window.$message.success('已取消收藏');
  } else {
    await userStore.likePlaylist(playlist);
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

  try {
    loading.value = true;
    songs.value = [];
    hasMore.value = true;

    // 只加载第一页数据
    const res = await getPlaylistTrackAll(playlistId.value, 1, pageSize);
    songs.value = res.songs.filter((song: Song) => song.hash);

    // 如果返回的数据少于每页数量，说明没有更多数据了
    hasMore.value = res.songs.length === pageSize;
  } finally {
    loading.value = false;
  }
};

const handleLoadMore = async (page: number, currentPageSize: number) => {
  if (!playlistId.value || loading.value) {
    return;
  }

  try {
    loading.value = true;
    const res = await getPlaylistTrackAll(playlistId.value, page, currentPageSize);
    const newSongs = res.songs.filter((song: Song) => song.hash);

    // 追加新数据到现有数据
    songs.value = [...songs.value, ...newSongs];

    // 更新hasMore状态
    hasMore.value = newSongs.length === currentPageSize;
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

<style lang="scss" scoped>
.info {
  transition: height 0.3s ease-in-out;
}
</style>
