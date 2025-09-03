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
    <div class="toolbar flex items-center justify-between">
      <div class="flex items-center space-x-2">
        <NButton
          :focusable="false"
          circle
          :disabled="!songs.length"
          @click="handlePlayAll"
        >
          <template #icon>
            <NIcon :size="24">
              <PlayArrowRound />
            </NIcon>
          </template>
        </NButton>
        <NButton
          :focusable="false"
          round
          v-if="userStore.isAuthenticated && !isCreatedPlaylist"
        >
          <template #icon>
            <NIcon :size="20">
              <Heart />
            </NIcon>
          </template>
          {{ isLikedPlaylist ? '取消收藏' : '收藏歌单' }}
        </NButton>
        <NPopconfirm
          v-if="userStore.isAuthenticated && isCreatedPlaylist && !isDefaultPlaylist"
          @positive-click="handleDeletePlaylist"
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
        <NButton
          :focusable="false"
          round
          @click="handleBatchModeClick"
        >
          <template #icon>
            <NIcon :size="20">
              <List v-if="batchMode" />
              <ListCheck v-else />
            </NIcon>
          </template>
          {{ batchMode ? '取消操作' : '批量操作' }}
        </NButton>
        <NDropdown
          v-if="batchMode"
          trigger="click"
          :options="moreOptions"
        >
          <NBadge
            :value="checkedSongs.length"
            :max="999"
          >
            <NButton
              :focusable="false"
              circle
              :disabled="!checkedSongs.length"
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
      <div class="flex items-center space-x-4">
        <NButton
          :focusable="false"
          ghost
          text
          @click.stop="handleScrollToCurrent"
        >
          <template #icon>
            <NIcon :size="18">
              <CurrentLocation />
            </NIcon>
          </template>
        </NButton>
        <NInput
          v-model:value="searchKeyword"
          size="small"
          clearable
          placeholder="模糊搜索"
        >
          <template #prefix>
            <NIcon :size="16">
              <Search />
            </NIcon>
          </template>
        </NInput>
      </div>
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
import {
  DropdownOption,
  NBadge,
  NButton,
  NDropdown,
  NIcon,
  NInput,
  NPopconfirm,
  NSkeleton,
} from 'naive-ui';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SongList from '@/components/List/SongList.vue';
import PlaylistCard from '@/components/Card/PlaylistCard.vue';
import { PlayArrowRound, BatchPredictionRound } from '@vicons/material';
import { Search, Heart } from '@vicons/ionicons5';
import { ListCheck, List, Trash, CurrentLocation } from '@vicons/tabler';
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

// 更多操作
const moreOptions = computed<DropdownOption[]>(() => [
  {
    label: '添加到播放列表',
    key: 'addToPlaylist',
    props: {
      onClick: () => {
        console.log('添加到播放列表', checkedSongs.value);
      },
    },
  },
  {
    label: '添加到其他歌单',
    key: 'addToOtherPlaylist',
    props: {
      onClick: () => {
        console.log('添加到歌单', checkedSongs.value);
      },
    },
  },
  {
    label: '从当前歌单删除',
    key: 'deleteFromPlaylist',
    show: isCreatedPlaylist.value,
    props: {
      onClick: () => {
        console.log('从歌单中删除', checkedSongs.value);
      },
    },
  },
]);

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
