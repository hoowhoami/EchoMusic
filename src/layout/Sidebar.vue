<template>
  <div class="sidebar">
    <NMenu
      ref="menuRef"
      v-model:value="menuActiveKey"
      :options="menuOptions"
      :render-label="renderMenuLabel"
      :default-expand-all="true"
      @update:value="menuUpdate"
    />
  </div>
</template>

<script setup lang="ts">
import type { MenuGroupOption, MenuInst, MenuOption } from 'naive-ui';
import type { Playlist } from '@/types';

import { NMenu, NIcon, NText, NButton, NAvatar, NEllipsis } from 'naive-ui';
import { Component, computed, h, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import {
  HomeOutline,
  CompassOutline,
  TimeOutline,
  CloudOutline,
  Add,
  AlbumsOutline,
  MusicalNotesOutline,
  ListOutline,
} from '@vicons/ionicons5';

import { getPlaylist } from '@/api';

import { useUserStore } from '@/store';

const userStore = useUserStore();
const route = useRoute();
const router = useRouter();

const menuRef = ref<MenuInst>();
const menuActiveKey = ref<string | number>((route.name as string) || 'home');

const renderIcon = (icon: Component, size: number = 18) => {
  const style = {
    transform: 'translateY(-1px)',
  };
  return () => h(NIcon, { size, style }, { default: () => h(icon) });
};

const playlists = ref<Playlist[]>([]);

// 菜单内容
const menuOptions = computed<MenuOption[] | MenuGroupOption[]>(() => {
  return [
    {
      key: 'home',
      link: 'home',
      label: '推荐',
      icon: renderIcon(HomeOutline),
    },
    {
      key: 'discover',
      link: 'discover',
      label: '发现',
      icon: renderIcon(CompassOutline),
    },
    {
      key: 'divider',
      type: 'divider',
    },
    {
      key: 'history',
      link: 'history',
      label: '最近',
      icon: renderIcon(TimeOutline),
    },
    {
      key: 'cloud',
      link: 'cloud',
      label: '云盘',
      icon: renderIcon(CloudOutline),
    },
    {
      key: 'divider-two',
      type: 'divider',
    },
    // 创建的歌单
    {
      key: 'user-playlists',
      icon: renderIcon(AlbumsOutline),
      label: () =>
        h('div', { class: 'flex items-center justify-between space-x-4' }, [
          h(NText, { depth: 3 }, () => ['创建的歌单']),
          h(NButton, {
            text: true,
            type: 'tertiary',
            round: true,
            strong: true,
            secondary: true,
            renderIcon: renderIcon(Add),
            onclick: (event: Event) => {
              event.stopPropagation();
              openCreatePlaylist();
            },
          }),
        ]),
      children: [...createPlaylist.value],
    },
    // 收藏的歌单
    {
      key: 'liked-playlists',
      icon: renderIcon(MusicalNotesOutline),
      label: () =>
        h(
          'div',
          { class: 'flex items-center justify-between' },
          h(NText, { depth: 3 }, () => ['收藏的歌单']),
        ),
      children: [...likedPlaylist.value],
    },
  ];
});

// 生成歌单列表
const renderPlaylist = (playlist: Playlist[], showCover: boolean = true) => {
  if (!userStore.isAuthenticated) {
    return [];
  }
  return playlist.map(playlist => ({
    key: playlist.global_collection_id,
    label: () =>
      showCover
        ? h('div', { class: 'flex items-center' }, [
            h(NAvatar, {
              src: playlist.cover,
              fallbackSrc: '/images/album.jpg?assest',
              lazy: true,
            }),
            h(NEllipsis, null, () => playlist.name),
          ])
        : h(NEllipsis, null, () => playlist.name),
    icon: showCover ? undefined : renderIcon(ListOutline),
  }));
};

// 创建的歌单
const createPlaylist = computed<MenuOption[]>(() => {
  const userid = userStore.userid;
  const list = playlists.value.filter(
    playlist => playlist.list_create_userid === userid || playlist.name === '我喜欢',
  );
  return renderPlaylist(list, false);
});

// 收藏的歌单
const likedPlaylist = computed<MenuOption[]>(() => {
  const userid = userStore.userid;
  const list = playlists.value.filter(
    playlist => playlist.list_create_userid !== userid && !playlist.authors,
  );
  return renderPlaylist(list);
});

// 渲染菜单路由
const renderMenuLabel = (option: MenuOption) => {
  // 路由链接
  if (option.link) {
    console.log(option);
  }
  if ('link' in option) {
    return h(RouterLink, { to: { path: option.link as string } }, () => option.label as string);
  }
  return typeof option.label === 'function' ? option.label() : (option.label as string);
};

// 菜单项更改
const menuUpdate = (key: string, item: MenuOption) => {
  if (typeof key === 'number') {
    router.push({
      name: 'playlist',
      query: { id: item.key },
    });
  } else {
    switch (key) {
      case 'like-songs':
        router.push({
          name: 'like-songs',
        });
        break;
      default:
        break;
    }
  }
};

// 选中菜单项
const checkMenuItem = () => {
  // 当前路由名称
  const routerName = route?.name as string;
  if (!routerName) {
    return;
  }
  // 显示菜单
  menuRef.value?.showOption(routerName);
  // 高亮菜单
  switch (routerName) {
    case 'playlist': {
      // 获取歌单 id
      const playlistId = Number(route.query.id || 0);
      // 是否处于用户歌单
      const isUserPlaylist = playlists.value.some(
        playlist => playlist?.global_collection_id === playlistId,
      );
      if (playlistId) {
        menuActiveKey.value = isUserPlaylist ? Number(playlistId) : 'home';
      }
      menuRef.value?.showOption(playlistId);
      break;
    }
    default:
      menuActiveKey.value = routerName;
      break;
  }
};

const openCreatePlaylist = () => {};

// 监听路由
watch(
  () => [route, playlists],
  () => checkMenuItem(),
);

onMounted(() => {
  // 获取歌单
  if (userStore.isAuthenticated) {
    getPlaylist().then(res => {
      const sortedInfo = res.info.sort((a: Playlist, b: Playlist) => {
        if (a.sort !== b.sort) {
          return a.sort - b.sort;
        }
        return 0;
      });
      playlists.value = sortedInfo;
    });
  }
});
</script>

<style scoped></style>
