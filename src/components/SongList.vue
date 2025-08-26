<template>
  <div class="song-list">
    <div v-if="showBatchActions" class="batch-actions">
      <NSpace :size="16">
        <NButton size="small" @click="selectAll">全选</NButton>
        <NButton size="small" @click="deselectAll">取消全选</NButton>
        <NButton size="small" type="primary" @click="handleBatchPlay">播放</NButton>
        <NButton size="small" @click="handleBatchAdd">添加到</NButton>
        <NButton size="small" @click="handleBatchDownload">下载</NButton>
        <NButton size="small" @click="handleBatchDelete">删除</NButton>
      </NSpace>
    </div>

    <NDataTable
      :columns="columns"
      :data="songs"
      :row-key="rowKey"
      :checked-row-keys="selectedKeys"
      @update:checked-row-keys="handleSelectionChange"
      :max-height="maxHeight"
      :scroll-x="800"
      :striped="striped"
      :bordered="bordered"
    />
  </div>
</template>

<script setup lang="ts">
import { NDataTable, NButton, NSpace, NText, NPopconfirm, NIcon } from 'naive-ui';
import { h, ref, computed } from 'vue';
import { PlayCircleOutline, DownloadOutline, TrashOutline } from '@vicons/ionicons5';

export interface Song {
  id: string | number;
  name: string;
  artist: string;
  album: string;
  duration: string;
  size?: string;
  quality?: string;
  raw?: any;
}

interface Props {
  songs: Song[];
  rowKey?: (row: Song) => string | number;
  maxHeight?: number | string;
  striped?: boolean;
  bordered?: boolean;
  showBatchActions?: boolean;
  showOperations?: boolean;
  showCheckbox?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  rowKey: (row: Song) => row.id,
  maxHeight: 500,
  striped: true,
  bordered: false,
  showBatchActions: false,
  showOperations: true,
  showCheckbox: false,
});

const emit = defineEmits<{
  play: [song: Song];
  download: [song: Song];
  delete: [song: Song];
  addToPlaylist: [song: Song];
  batchPlay: [songs: Song[]];
  batchAdd: [songs: Song[]];
  batchDownload: [songs: Song[]];
  batchDelete: [songs: Song[]];
}>();

const selectedKeys = ref<(string | number)[]>([]);

const handleSelectionChange = (keys: (string | number)[]) => {
  selectedKeys.value = keys;
};

const selectAll = () => {
  selectedKeys.value = props.songs.map(props.rowKey);
};

const deselectAll = () => {
  selectedKeys.value = [];
};

const getSelectedSongs = () => {
  return props.songs.filter(song => selectedKeys.value.includes(props.rowKey(song)));
};

const handleBatchPlay = () => {
  const selectedSongs = getSelectedSongs();
  if (selectedSongs.length > 0) {
    emit('batchPlay', selectedSongs);
  }
};

const handleBatchAdd = () => {
  const selectedSongs = getSelectedSongs();
  if (selectedSongs.length > 0) {
    emit('batchAdd', selectedSongs);
  }
};

const handleBatchDownload = () => {
  const selectedSongs = getSelectedSongs();
  if (selectedSongs.length > 0) {
    emit('batchDownload', selectedSongs);
  }
};

const handleBatchDelete = () => {
  const selectedSongs = getSelectedSongs();
  if (selectedSongs.length > 0) {
    emit('batchDelete', selectedSongs);
  }
};

const columns = computed(() => {
  const baseColumns = [
    {
      type: 'selection' as const,
      disabled: () => !props.showCheckbox,
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: (row: Song) => {
        if (!props.showOperations) return null;

        return h(
          NSpace,
          { justify: 'center', wrap: false },
          {
            default: () => [
              h(
                NButton,
                {
                  text: true,
                  size: 'small',
                  onClick: () => emit('play', row),
                },
                {
                  icon: () => h(NIcon, { size: 16 }, () => h(PlayCircleOutline)),
                },
              ),
              h(
                NButton,
                {
                  text: true,
                  size: 'small',
                  onClick: () => emit('download', row),
                },
                {
                  icon: () => h(NIcon, { size: 16 }, () => h(DownloadOutline)),
                },
              ),
              h(
                NPopconfirm,
                {
                  onPositiveClick: () => emit('delete', row),
                },
                {
                  default: () => '确定要删除这首歌吗？',
                  trigger: () =>
                    h(
                      NButton,
                      {
                        text: true,
                        size: 'small',
                        type: 'error',
                      },
                      {
                        icon: () => h(NIcon, { size: 16 }, () => h(TrashOutline)),
                      },
                    ),
                },
              ),
            ],
          },
        );
      },
    },
    {
      title: '歌曲',
      key: 'name',
      width: 200,
      ellipsis: {
        tooltip: true,
      },
      render: (row: Song) => h(NText, { depth: 2, style: { fontWeight: 500 } }, () => row.name),
    },
    {
      title: '歌手',
      key: 'artist',
      width: 150,
      ellipsis: {
        tooltip: true,
      },
      render: (row: Song) => h(NText, { depth: 3 }, () => row.artist),
    },
    {
      title: '专辑',
      key: 'album',
      width: 150,
      ellipsis: {
        tooltip: true,
      },
      render: (row: Song) => h(NText, { depth: 3 }, () => row.album),
    },
    {
      title: '时长',
      key: 'duration',
      width: 80,
      align: 'center' as const,
    },
  ];

  // 添加可选列
  if (props.songs.some(song => song.size)) {
    baseColumns.splice(-1, 0, {
      title: '大小',
      key: 'size',
      width: 80,
      align: 'center' as const,
    });
  }

  if (props.songs.some(song => song.quality)) {
    baseColumns.splice(-1, 0, {
      title: '音质',
      key: 'quality',
      width: 80,
      align: 'center' as const,
    });
  }

  return baseColumns;
});

defineExpose({
  selectAll,
  deselectAll,
  selectedKeys,
});
</script>

<style scoped>
.song-list {
  width: 100%;
}

.batch-actions {
  padding: 12px 0;
  border-bottom: 1px solid var(--n-border-color);
  margin-bottom: 12px;
}
</style>
