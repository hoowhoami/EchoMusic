<template>
  <div class="song-list-menu flex items-center justify-between">
    <!-- 左侧操作按钮 -->
    <div class="left-actions flex items-center space-x-2">
      <!-- 播放全部 -->
      <NButton
        :focusable="false"
        circle
        :disabled="!props.songs.length"
        @click="$emit('play-all', props.songs)"
      >
        <template #icon>
          <NIcon :size="24">
            <PlayArrowRound />
          </NIcon>
        </template>
      </NButton>

      <!-- 收藏 -->
      <NButton
        v-if="props.showLike"
        :focusable="false"
        round
        @click="handleLike"
      >
        <template #icon>
          <NIcon :size="20">
            <Heart v-if="!props.isLiked" />
            <HeartDislike v-else />
          </NIcon>
        </template>
        {{ likeTitle }}
      </NButton>

      <!-- 删除 -->
      <NPopconfirm
        v-if="props.showDelete"
        @positive-click="handleDelete"
      >
        <template #trigger>
          <NButton
            :focusable="false"
            circle
          >
            <template #icon>
              <NIcon :size="20">
                <Trash />
              </NIcon>
            </template>
          </NButton>
        </template>
        确定要删除歌单吗？
      </NPopconfirm>

      <!-- 批量操作 -->
      <NButton
        v-if="props.showBatch"
        :focusable="false"
        :disabled="!props.songs.length"
        round
        @click="$emit('toggle-batch-mode')"
      >
        <template #icon>
          <NIcon :size="20">
            <List v-if="props.batchMode" />
            <ListCheck v-else />
          </NIcon>
        </template>
        {{ props.batchMode ? '取消操作' : '批量操作' }}
      </NButton>

      <!-- 批量操作菜单 -->
      <NDropdown
        v-if="props.showBatch && props.batchMode"
        trigger="click"
        :options="batchOptions"
        @select="handleBatchSelect"
      >
        <NBadge
          :value="selectedSongs.length"
          :max="999"
        >
          <NButton
            :focusable="false"
            circle
            :disabled="!selectedSongs.length"
          >
            <template #icon>
              <NIcon :size="20">
                <BatchPredictionRound />
              </NIcon>
            </template>
          </NButton>
        </NBadge>
      </NDropdown>
    </div>

    <!-- 右侧操作按钮 -->
    <div class="right-actions flex items-center space-x-4">
      <!-- 定位当前播放 -->
      <NButton
        :focusable="false"
        ghost
        text
        @click.stop="$emit('locate-current')"
        :disabled="!props.songs.length"
      >
        <template #icon>
          <NIcon :size="18">
            <CurrentLocation />
          </NIcon>
        </template>
      </NButton>

      <!-- 搜索 -->
      <NInput
        v-model:value="searchValue"
        size="small"
        clearable
        placeholder="模糊搜索"
        :disabled="!props.songs.length"
        @update:value="$emit('update:searchKeyword', $event)"
      >
        <template #prefix>
          <NIcon :size="16">
            <Search />
          </NIcon>
        </template>
      </NInput>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Song, Playlist, Album, Singer } from '@/types';
import {
  NBadge,
  NButton,
  NDropdown,
  NIcon,
  NInput,
  NPopconfirm,
  type DropdownOption,
} from 'naive-ui';
import { computed, ref } from 'vue';
import { PlayArrowRound, BatchPredictionRound } from '@vicons/material';
import { Search, Heart, HeartDislike } from '@vicons/ionicons5';
import { ListCheck, List, Trash, CurrentLocation } from '@vicons/tabler';
import player from '@/utils/player';
import { useUserStore } from '@/store';
import { addPlaylistTrack, deletePlaylistTrack } from '@/api';

defineOptions({
  name: 'SongListToolbar',
});

interface Props {
  // 数据相关
  songs: Song[];
  batchMode: boolean;

  type: 'playlist' | 'album' | 'singer' | 'history';
  instance?: Playlist | Album | Singer;

  // 状态相关
  isLiked?: boolean;

  // 显示控制
  showLike?: boolean;
  showDelete?: boolean;
  showBatch?: boolean;
}

type Emits = {
  'play-all': [songs: Song[]];
  like: [instance?: Playlist | Album | Singer];
  delete: [instance?: Playlist | Album | Singer];
  'toggle-batch-mode': [];
  'locate-current': [];
  'delete-from-playlist': [songs: Song[]];
};

const emit = defineEmits<Emits>();

const props = withDefaults(defineProps<Props>(), {
  type: 'playlist',
  isLiked: false,
  showLike: true,
  showDelete: true,
  showBatch: true,
});

const likeTitle = computed(() => {
  if (props.type === 'playlist' || props.type === 'album') {
    return props.isLiked ? '取消收藏' : '立即收藏';
  }
  if (props.type === 'singer') {
    return props.isLiked ? '取消关注' : '立即关注';
  }
  return '';
});

const selectedSongs = defineModel<Song[]>('selectedSongs', { default: () => [] });
const searchKeyword = defineModel<string>('searchKeyword', { default: '' });

const userStore = useUserStore();

const searchValue = ref(searchKeyword.value);

const handleLike = () => {
  emit('like', props.instance);
};

const handleDelete = () => {
  emit('delete', props.instance);
};

// 批量操作选项
const batchOptions = computed<DropdownOption[]>(() => {
  const options: DropdownOption[] = [
    {
      label: '添加到播放列表',
      key: 'addToPlaylist',
    },
    {
      label: '添加到我的歌单',
      key: 'addToMyPlaylist',
      children: userStore.getCreatedPlaylist
        .filter(playlist => {
          if (props.type === 'playlist') {
            return !props.instance || playlist.listid !== (props.instance as Playlist).listid;
          }
          return true;
        })
        .map(playlist => ({
          label: playlist.name,
          key: `playlist-${playlist.listid}`,
          props: {
            onClick: () => handleAddToPlaylist(playlist),
          },
        })),
    },
  ];

  // 只有当是用户创建的歌单时才显示删除选项
  if (
    props.instance &&
    props.type === 'playlist' &&
    userStore.isAuthenticated &&
    userStore.isCreatedPlaylist((props.instance as Playlist).list_create_gid)
  ) {
    options.push({
      label: '从当前歌单删除',
      key: 'deleteFromPlaylist',
    });
  }

  return options;
});

// 处理批量操作选择
const handleBatchSelect = async (key: string) => {
  switch (key) {
    case 'addToPlaylist':
      player.updatePlayList(selectedSongs.value, undefined, {
        replace: false,
      });
      resetBatchSelection();
      window.$message.success('已添加到播放列表');
      break;
    case 'deleteFromPlaylist':
      await handleDeleteFromPlaylist();
      break;
    default:
      // 如果是添加到指定歌单的 key，不做处理（由子菜单的 onClick 处理）
      if (key.startsWith('playlist-')) {
        return;
      }
      break;
  }
};

// 添加到指定歌单
const handleAddToPlaylist = async (playlist: { listid: number; name: string }) => {
  if (!selectedSongs.value.length) return;

  // 每批处理的歌曲数量
  const BATCH_SIZE = 50;
  const totalSongs = selectedSongs.value.length;
  const totalBatches = Math.ceil(totalSongs / BATCH_SIZE);

  let loadingMessage;

  try {
    // 显示加载提示（3秒后自动消失）
    loadingMessage = window.$message.loading(
      `正在添加 ${totalSongs} 首歌曲到歌单「${playlist.name}」...`,
      {
        duration: 0,
      },
    );

    // 分批次处理
    for (let i = 0; i < totalBatches; i++) {
      const start = i * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, totalSongs);
      const batchSongs = selectedSongs.value.slice(start, end);

      // 构建当前批次的歌曲数据字符串
      const songData = batchSongs
        .map((song: Song) => `${song.name}|${song.hash}|${song.album_id}|${song.mixsongid}`)
        .join(',');

      // 调用接口添加当前批次
      await addPlaylistTrack(playlist.listid, songData);

      // 添加小延迟，避免请求过于频繁
      if (i < totalBatches - 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    loadingMessage.destroy();

    // 显示完成通知
    window.$notification.success({
      title: '添加完成',
      content: `已成功将 ${totalSongs} 首歌曲添加到歌单「${playlist.name}」`,
      duration: 5000,
    });

    resetBatchSelection();
  } catch (error) {
    loadingMessage?.destroy();
    console.error('添加到歌单失败:', error);
    // 显示错误通知
    window.$notification.error({
      title: '添加失败',
      content: '添加失败，请重试',
      duration: 5000,
    });
  }
};

// 从当前歌单删除
const handleDeleteFromPlaylist = async () => {
  if (!selectedSongs.value.length || !props.instance || props.type !== 'playlist') {
    return;
  }

  const totalSongs = selectedSongs.value.length;
  const BATCH_SIZE = 50;
  const totalBatches = Math.ceil(totalSongs / BATCH_SIZE);

  let loadingMessage;

  try {
    // 显示加载提示
    loadingMessage = window.$message.loading(`正在从歌单中删除 ${totalSongs} 首歌曲...`, {
      duration: 0,
    });

    // 分批次处理
    for (let i = 0; i < totalBatches; i++) {
      const start = i * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, totalSongs);
      const batchSongs = selectedSongs.value.slice(start, end);

      // 获取歌曲的 fileid
      const fileids = batchSongs.map(song => song.fileid).join(',');

      // 调用删除接口
      await deletePlaylistTrack((props.instance as Playlist).listid, fileids);

      // 添加小延迟，避免请求过于频繁
      if (i < totalBatches - 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // 通知父组件删除完成，以便更新列表
    emit('delete-from-playlist', selectedSongs.value);

    // 重置批量选择
    resetBatchSelection();

    loadingMessage.destroy();

    // 显示完成通知
    window.$notification.success({
      title: '删除完成',
      content: `已成功从歌单中删除 ${totalSongs} 首歌曲`,
      duration: 5000,
    });
  } catch (error) {
    loadingMessage?.destroy();
    console.error('从歌单删除失败:', error);
    // 显示错误通知
    window.$notification.error({
      title: '删除失败',
      content: '删除失败，请重试',
      duration: 5000,
    });
  }
};

// 重置批量选择
const resetBatchSelection = () => {
  selectedSongs.value = [];
};
</script>

<style lang="scss" scoped></style>
