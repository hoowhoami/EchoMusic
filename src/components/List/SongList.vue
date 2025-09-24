<template>
  <div class="song-list">
    <NDataTable
      ref="dataTableRef"
      size="small"
      :virtual-scroll="props.virtualScroll"
      :max-height="props.maxHeight"
      :bordered="false"
      :bottom-bordered="false"
      :single-column="true"
      :row-key="row => row.hash"
      :loading="props.loading"
      :columns="columns"
      :data="songs"
      v-model:checked-row-keys="checkedRowKeys"
      :row-props="rowProps"
      @scroll="handleScroll"
      :scrollbar-props="{
        trigger: scrolling ? 'none' : 'hover',
      }"
    />
  </div>
</template>

<script setup lang="ts">
import type { DataTableColumns } from 'naive-ui';

import { Song, Playlist } from '@/types';
import { msToTime } from '@/utils';
import { NDataTable, NEllipsis } from 'naive-ui';
import { computed, h, ref, watch } from 'vue';
import SongCard from '@/components/Card/SongCard.vue';
import player from '@/utils/player';
import { isEqual } from 'lodash-es';
import { usePlayerStore, useSettingStore } from '@/store';

defineOptions({
  name: 'SongList',
});

const emit = defineEmits<{
  scroll: [e: Event];
  'song-removed': [song?: Song];
  'load-more': [page: number, pageSize: number];
}>();

const props = defineProps<{
  maxHeight?: number;
  virtualScroll?: boolean;
  loading?: boolean;
  batchMode?: boolean;
  playlist?: Playlist;
  hasMore?: boolean;
  pageSize?: number;
}>();

const leaveTop = defineModel<boolean>('leaveTop', { default: false });
const scrolling = defineModel<boolean>('scrolling', { default: false });

const settingStore = useSettingStore();
const playerStore = usePlayerStore();

const dataTableRef = ref();

const songs = defineModel<Song[]>();

const checkedSongs = defineModel<Song[]>('checked-songs');

const checkedRowKeys = ref<string[]>([]);

// 分页相关状态
const currentPage = ref(1);
const isLoadingMore = ref(false);

// 行属性配置
const rowProps = () => {
  return {};
};

const currentScrollTop = ref(0);

// 处理列表滚动
const handleScroll = (e: Event) => {
  const target = e.target as HTMLElement;
  const scrollTop = target.scrollTop;
  const scrollHeight = target.scrollHeight;
  const clientHeight = target.clientHeight;

  leaveTop.value = scrollTop > 10;

  // 同步外部滚动的 currentScrollTop
  currentScrollTop.value = scrollTop;

  // 检测是否滚动到底部
  const threshold = 100; // 距离底部100px时开始加载
  const isNearBottom = scrollHeight - scrollTop - clientHeight <= threshold;

  if (isNearBottom && !isLoadingMore.value && props.hasMore && !props.loading) {
    handleLoadMore();
  }

  emit('scroll', e);
};

// 处理加载更多数据
const handleLoadMore = async () => {
  if (isLoadingMore.value || !props.hasMore || props.loading) {
    return;
  }

  isLoadingMore.value = true;
  const nextPage = currentPage.value + 1;
  const pageSize = props.pageSize || 30;

  try {
    emit('load-more', nextPage, pageSize);
    currentPage.value = nextPage;
  } finally {
    // 延迟重置加载状态，避免重复触发
    setTimeout(() => {
      isLoadingMore.value = false;
    }, 500);
  }
};

// 重置分页状态
const resetPagination = () => {
  currentPage.value = 1;
  isLoadingMore.value = false;
};

const columns = computed<DataTableColumns>(() => {
  return [
    ...firstColumns.value,
    {
      title: '歌曲',
      key: 'name',
      minWidth: 300,
      render: row => {
        const song = row as Song;
        return h(SongCard, {
          song,
          coverSize: 40,
          playlist: props.playlist,
          onPlay: (song: Song) => {
            if (settingStore.addSongsToPlaylist) {
              player.updatePlayList(songs.value || [], song, {
                replace: false,
              });
            } else {
              player.playSong(song);
            }
          },
          onSongRemoved: (song?: Song) => emit('song-removed', song),
        });
      },
      sorter: 'default',
    },
    {
      title: '专辑',
      key: 'album',
      minWidth: 80,
      render: row => {
        const song = row as Song;
        return h(
          NEllipsis,
          { style: 'font-size: 12px;', lineClamp: 1 },
          {
            default: () => song.albuminfo?.name,
          },
        );
      },
      sorter: 'default',
    },
    {
      title: '时长',
      key: 'duration',
      width: 80,
      render: row => {
        const song = row as Song;
        return h(
          NEllipsis,
          { style: 'font-size: 12px;', lineClamp: 1 },
          {
            default: () => msToTime(song.timelen),
          },
        );
      },
      sorter: 'default',
    },
  ];
});

const firstColumns = computed<DataTableColumns>(() => {
  return [
    props.batchMode
      ? {
          type: 'selection',
          width: 60,
          align: 'center',
        }
      : {
          title: '#',
          key: 'index',
          width: 60,
          align: 'center',
        },
  ];
});

watch(
  songs,
  (newSongs, oldSongs) => {
    if (!newSongs) {
      checkedRowKeys.value = [];
      resetPagination();
      return;
    }

    // 如果是全新的数据（长度从有变无或从大变小），重置分页
    if (!oldSongs || newSongs.length < (oldSongs.length || 0)) {
      resetPagination();
    }

    if (checkedRowKeys.value.length) {
      checkedRowKeys.value = checkedRowKeys.value.filter(item =>
        newSongs.some(song => song.hash === item),
      );
    }
  },
  { deep: true },
);

// 根据选中的rowKeys同步选中的歌曲到checkedSongs
watch(
  checkedRowKeys,
  newKeys => {
    if (!songs.value?.length) {
      return;
    }
    // 根据hash匹配选中的歌曲
    checkedSongs.value = songs.value.filter(song => newKeys.includes(song.hash));
  },
  { deep: true },
);

// 当外部修改checkedSongs时，同步更新表格选中状态
watch(
  checkedSongs,
  newChecked => {
    if (!newChecked) {
      return;
    }
    const newKeys = newChecked.map(song => song.hash);
    // 避免不必要的更新
    if (!isEqual(newKeys, checkedRowKeys.value)) {
      checkedRowKeys.value = newKeys;
    }
  },
  { deep: true },
);

// 滚动到当前播放歌曲
const scrollToCurrent = () => {
  // 获取当前播放歌曲
  const currentSong = playerStore.current;
  if (!currentSong || !songs.value) {
    return false;
  }

  // 在当前歌单中查找当前播放歌曲的索引
  const currentIndex = songs.value.findIndex(song => song.hash === currentSong.hash);

  if (currentIndex === -1) {
    return false;
  }

  // 使用 DataTable 的 scrollTo 方法实现平滑滚动
  if (dataTableRef.value?.scrollTo) {
    dataTableRef.value.scrollTo({
      index: currentIndex,
      behavior: 'smooth',
    });
    return true;
  }

  return false;
};

// 手动滚动方法
const scrollBy = (deltaY: number) => {
  if (!dataTableRef.value?.scrollTo || !songs.value?.length) return;

  const sensitivity = 1; // 滚动灵敏度
  const scrollAmount = deltaY * sensitivity;

  // 累加滚动位置
  currentScrollTop.value = Math.max(0, currentScrollTop.value + scrollAmount);

  // 使用 NDataTable 的 scrollTo 方法滚动到指定位置
  dataTableRef.value.scrollTo({
    top: currentScrollTop.value,
    behavior: 'auto', // 使用 auto 获得更好的性能
  });
};

// 获取当前滚动位置
const getCurrentScrollTop = () => currentScrollTop.value;

// 暴露方法给父组件
defineExpose({
  scrollToCurrent,
  scrollBy,
  getCurrentScrollTop,
  resetPagination,
});
</script>

<style lang="scss" scoped></style>
