<template>
  <div class="song-list">
    <NDataTable :columns="columns"
                :data="songs"
                :row-key="(row) => row.hash"
                size="small"
                :bordered="false"
                :bottom-bordered="false"
                :single-column="true"></NDataTable>
  </div>
</template>

<script setup lang="ts">
import type { DataTableColumns } from 'naive-ui';

import { getPlaylistTrackAll } from '@/api';
import { Song } from '@/types';
import { msToTime } from '@/utils';
import { NDataTable, NEllipsis } from 'naive-ui';
import { computed, h, onMounted, ref, watch } from 'vue';
import SongCard from '@/components/Card/SongCard.vue';
import player from '@/utils/player';


defineOptions({
  name: 'SongList',
});

const props = defineProps<{
  playlistId: string;
}>();

const batchMode = ref(false);

const songs = ref<Song[]>([]);

const columns = computed<DataTableColumns>(() => {
  return [
    ...firstColumns.value,
    {
      title: '歌曲',
      key: 'name',
      minWidth: 300,
      render: (row) => {
        const song = row as Song;
        return h(SongCard, { song, onDblclick: () => player.updatePlayList(songs.value, song) });
      },
      sorter: 'default',
    },
    {
      title: '专辑',
      key: 'album',
      minWidth: 80,
      render: (row) => {
        const song = row as Song;
        return h(NEllipsis, { style: 'font-size: 12px;', lineClamp: 1 }, {
          default: () => song.albuminfo?.name,
        });
      },
      sorter: 'default',
    },
    {
      title: '时长',
      key: 'duration',
      minWidth: 80,
      render: (row) => {
        const song = row as Song;
        return h(NEllipsis, { style: 'font-size: 12px;', lineClamp: 1 }, {
          default: () => msToTime(song.timelen),
        });
      },
      sorter: 'default',
    },
  ];
});

const firstColumns = computed<DataTableColumns>(() => {
  return [
    batchMode.value
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

const getSongs = () => {
  let page = 1;
  const size = 300;
  let fetchCount = 0;
  songs.value = [];
  do {
    getPlaylistTrackAll(props.playlistId, page, size).then(res => {
      songs.value.push(...res.songs);
      fetchCount = res.count;
      page++;
    });
  } while (fetchCount > 0);
  
};

onMounted(() => {
  console.log(props.playlistId);
  getSongs();
});

watch(() => props.playlistId, () => {
  getSongs();
});

</script>

<style lang="scss" scoped></style>
