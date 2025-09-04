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
    ></NDataTable>

    <!-- 右键菜单 -->
    <SongListMenu
      :show="contextMenu.show"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :song="contextMenu.song!"
      :playlist="playlist"
      @close="closeContextMenu"
      @song-played="handleSongPlayed"
      @song-removed="emit('song-removed', contextMenu.song!)"
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
import SongListMenu from '@/components/Menu/SongListMenu.vue';
import player from '@/utils/player';
import { isEqual } from 'lodash-es';
import { usePlayerStore } from '@/store';

defineOptions({
  name: 'SongList',
});

const emit = defineEmits<{
  'song-removed': [song: Song];
}>();

const props = defineProps<{
  maxHeight?: number;
  virtualScroll?: boolean;
  loading?: boolean;
  batchMode?: boolean;
  playlist?: Playlist;
}>();

const playerStore = usePlayerStore();

const dataTableRef = ref();

const songs = defineModel<Song[]>();

const checkedSongs = defineModel<Song[]>('checked-songs');

const checkedRowKeys = ref<string[]>([]);

// 右键菜单状态
const contextMenu = ref({
  show: false,
  x: 0,
  y: 0,
  song: null as Song | null,
});

// 行属性配置，添加右键事件
const rowProps = (row: Song) => {
  return {
    onContextmenu: (e: MouseEvent) => {
      e.preventDefault();
      contextMenu.value = {
        show: true,
        x: e.clientX,
        y: e.clientY,
        song: row,
      };
    },
  };
};

// 关闭右键菜单
const closeContextMenu = () => {
  contextMenu.value.show = false;
};

// 处理播放歌曲
const handleSongPlayed = (song: Song) => {
  player.playSong(song);
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
          onPlay: (song: Song) => {
            player.updatePlayList(songs.value || [], song);
          },
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
  newSongs => {
    if (!newSongs) {
      checkedRowKeys.value = [];
      return;
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

// 暴露方法给父组件
defineExpose({
  scrollToCurrent,
});
</script>

<style lang="scss" scoped></style>
