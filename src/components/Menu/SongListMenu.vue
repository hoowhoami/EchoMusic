<template>
  <NDropdown
    trigger="manual"
    placement="bottom-start"
    :show="show"
    :options="menuOptions"
    :x="x"
    :y="y"
    @select="handleSelect"
    @clickoutside="$emit('close')"
  />
</template>

<script setup lang="ts">
import type { Song, Playlist } from '@/types';
import { NDropdown, type DropdownOption } from 'naive-ui';
import { computed } from 'vue';
import { useUserStore } from '@/store';
import { addPlaylistTrack, deletePlaylistTrack } from '@/api';

defineOptions({
  name: 'SongListMenu',
});

interface Props {
  show: boolean;
  x: number;
  y: number;
  song: Song;
  playlist?: Playlist;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  close: [];
  'song-played': [song: Song];
  'song-removed': [song: Song];
}>();

const userStore = useUserStore();

// 菜单选项
const menuOptions = computed<DropdownOption[]>(() => {
  const options: DropdownOption[] = [
    {
      label: '播放当前歌曲',
      key: 'play',
    },
    {
      label: '添加到其他歌单',
      key: 'addToPlaylist',
      children: userStore.getCreatedPlaylist
        .filter(item => {
          // 排除当前歌单
          return !props.playlist || item.listid !== props.playlist.listid;
        })
        .map(item => ({
          label: item.name,
          key: `playlist-${item.listid}`,
          props: {
            onClick: () => handleAddToPlaylist(item),
          },
        })),
    },
  ];

  // 只有在用户自己的歌单中才显示删除选项
  if (
    props.playlist &&
    userStore.isAuthenticated &&
    userStore.isCreatedPlaylist(props.playlist.list_create_gid)
  ) {
    options.push({
      label: '从当前歌单删除',
      key: 'removeFromPlaylist',
    });
  }

  return options;
});

// 处理菜单选择
const handleSelect = async (key: string) => {
  switch (key) {
    case 'play':
      emit('song-played', props.song);
      break;
    case 'removeFromPlaylist':
      await handleRemoveFromPlaylist();
      break;
    default:
      // 其他情况由子菜单的 onClick 处理
      break;
  }
  emit('close');
};

// 添加到指定歌单
const handleAddToPlaylist = async (playlist: { listid: number; name: string }) => {
  let loadingMessage;
  try {
    loadingMessage = window.$message.loading(`正在添加歌曲到歌单「${playlist.name}」...`, {
      duration: 0,
    });

    const songData = `${props.song.name}|${props.song.hash}|${props.song.album_id}|${props.song.mixsongid}`;
    await addPlaylistTrack(playlist.listid, songData);

    loadingMessage.destroy();

    window.$notification.success({
      title: '添加成功',
      content: `已成功将歌曲添加到歌单「${playlist.name}」`,
      duration: 3000,
    });
  } catch (error) {
    loadingMessage?.destroy();
    console.error('添加到歌单失败:', error);
    window.$notification.error({
      title: '添加失败',
      content: '添加失败，请重试',
      duration: 3000,
    });
  }
};

// 从当前歌单删除
const handleRemoveFromPlaylist = async () => {
  if (!props.playlist) return;

  let loadingMessage;

  try {
    loadingMessage = window.$message.loading('正在从歌单中删除歌曲...', {
      duration: 0,
    });

    await deletePlaylistTrack(props.playlist.listid, props.song.fileid.toString());

    loadingMessage.destroy();

    window.$notification.success({
      title: '删除成功',
      content: '已成功从歌单中删除歌曲',
      duration: 3000,
    });

    emit('song-removed', props.song);
  } catch (error) {
    loadingMessage?.destroy();
    console.error('从歌单删除失败:', error);
    window.$notification.error({
      title: '删除失败',
      content: '删除失败，请重试',
      duration: 3000,
    });
  }
};
</script>

<style lang="scss" scoped></style>
