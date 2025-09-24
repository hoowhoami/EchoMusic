<template>
  <div class="song-list-container flex flex-col space-y-4">
    <div class="toolbar">
      <SongListToolbar
        :type="type"
        :songs="songs"
        v-model:selected-songs="checkedSongs"
        v-model:search-keyword="searchKeyword"
        :batch-mode="batchMode"
        :instance="instance"
        :is-liked="isLiked"
        :show-like="showLike"
        :show-delete="showDelete"
        :show-batch="showBatch"
        @play-all="handlePlayAll"
        @like="handleLike"
        @delete="handleDelete"
        @toggle-batch-mode="handleBatchModeClick"
        @locate-current="handleScrollToCurrent"
        @batch-operation-complete="resetBatchMode"
        @delete-from-playlist="handleDeletedSongs"
      />
    </div>
    <div class="list">
      <SongList
        ref="songListRef"
        :virtual-scroll="virtualScroll"
        :max-height="maxHeight"
        :loading="loading"
        :batch-mode="batchMode"
        :has-more="hasMore"
        :page-size="pageSize"
        :playlist="instance && type === 'playlist' ? (instance as Playlist) : undefined"
        v-model="filteredSongs"
        v-model:checked-songs="checkedSongs"
        @song-removed="handleSongRemoved"
        @scroll="handleScroll"
        @load-more="handleLoadMore"
        v-model:leave-top="leaveTop"
        v-model:scrolling="scrolling"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Playlist, Song, Album, Singer } from '@/types';
import { ref, watch } from 'vue';
import SongList from '@/components/List/SongList.vue';
import SongListToolbar from '@/components/Toolbar/SongListToolbar.vue';
import { usePlayerStore, useSettingStore } from '@/store';
import player from '@/utils/player';

defineOptions({
  name: 'SongListContainer',
});

interface Props {
  // 数据相关
  songs: Song[];

  type: 'playlist' | 'album' | 'singer' | 'history' | 'cloud';
  instance?: Playlist | Album | Singer;

  // 配置相关
  virtualScroll?: boolean;
  maxHeight?: number;
  loading?: boolean;

  // 分页相关
  hasMore?: boolean;
  pageSize?: number;

  // 状态相关
  isLiked?: boolean;

  // 显示控制
  showLike?: boolean;
  showDelete?: boolean;
  showBatch?: boolean;
}

type Emits = {
  scroll: [e: Event];
  like: [data?: Playlist | Album | Singer];
  delete: [data?: Playlist | Album | Singer];
  'song-removed': [song?: Song];
  'deleted-songs': [songs: Song[]];
  'load-more': [page: number, pageSize: number];
};

const emit = defineEmits<Emits>();

const props = withDefaults(defineProps<Props>(), {
  virtualScroll: false,
  loading: false,
  hasMore: true,
  pageSize: 30,
  isLiked: false,
  showLike: false,
  showDelete: false,
  showBatch: true,
});

const leaveTop = defineModel<boolean>('leaveTop', { default: false });
const scrolling = defineModel<boolean>('scrolling', { default: false });

const settingStore = useSettingStore();
const playerStore = usePlayerStore();

const songListRef = ref();
const checkedSongs = ref<Song[]>([]);
const filteredSongs = ref<Song[]>([]);
const searchKeyword = ref('');
const batchMode = ref(false);

// 监听songs变化，更新filteredSongs
watch(
  () => props.songs,
  newSongs => {
    filteredSongs.value = newSongs || [];
  },
  { immediate: true },
);

// 搜索功能
watch(
  () => searchKeyword.value,
  newValue => {
    if (!newValue) {
      filteredSongs.value = props.songs;
    } else {
      filteredSongs.value = props.songs.filter(song => {
        const name = song.name;
        const album = song.albuminfo?.name;
        return name.includes(newValue) || album?.includes(newValue);
      });
    }
  },
);

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

const handlePlayAll = () => {
  player.updatePlayList(props.songs, undefined, {
    replace: settingStore.replacePlaylist,
  });
};

const handleLike = (data?: Playlist | Album | Singer) => {
  emit('like', data);
};

const handleDelete = (data?: Playlist | Album | Singer) => {
  emit('delete', data);
};

const handleDeletedSongs = (deletedSongs: Song[]) => {
  emit('deleted-songs', deletedSongs);
};

const handleSongRemoved = (removedSong?: Song) => {
  emit('song-removed', removedSong);
};

const handleScroll = (e: Event) => {
  emit('scroll', e);
};

const handleLoadMore = (page: number, pageSize: number) => {
  emit('load-more', page, pageSize);
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
    window.$message.warning('当前播放歌曲不在此列表中');
  }
};

// 暴露方法给父组件
defineExpose({
  scrollToCurrent: handleScrollToCurrent,
  resetBatchMode,
  songListRef,
});
</script>

<style lang="scss" scoped></style>
