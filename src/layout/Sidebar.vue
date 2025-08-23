<template>
  <div class="sidebar">
    <NMenu ref="menuRef" v-model:value="menuActiveKey" :options="menuOptions" />
  </div>
</template>

<script setup lang="ts">
import type { MenuInst, MenuOption } from 'naive-ui';
import { NMenu, NIcon } from 'naive-ui';
import { Component, h, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import {
  HomeOutline,
  CompassOutline,
  TimeOutline,
  CloudOutline,
  AlbumsOutline,
  MusicalNotesOutline,
  ListOutline,
} from '@vicons/ionicons5';

import { findTreeNodeByField } from '@/utils';

const route = useRoute();

const menuRef = ref<MenuInst>();

const menuActiveKey = ref('home');

// 监听路由
watch(
  () => route.fullPath,
  newValue => {
    menuActiveKey.value = findTreeNodeByField(menuOptions, 'path', newValue)?.key || 'home';
    menuRef.value?.showOption(menuActiveKey.value);
  },
);

const renderIcon = (icon: Component, size: number = 18) => {
  return () => h(NIcon, { size }, { default: () => h(icon) });
};

const renderLabel = (label: string, to: object) => {
  return () => h(RouterLink, { to }, { default: () => label });
};

const menuOptions: MenuOption[] = [
  {
    label: '在线音乐',
    key: 'online-music',
    type: 'group',
    children: [
      {
        label: renderLabel('推荐', {
          path: '/',
        }),
        key: 'home',
        icon: renderIcon(HomeOutline),
      },
      {
        label: renderLabel('发现', {
          path: '/discover',
        }),
        key: 'discover',
        icon: renderIcon(CompassOutline),
      },
    ],
  },
  {
    label: '我的音乐',
    key: 'my-music',
    type: 'group',
    children: [
      {
        label: renderLabel('最近', {
          path: '/history',
        }),
        key: 'history',
        path: '/history',
        icon: renderIcon(TimeOutline),
      },
      {
        label: renderLabel('云盘', {
          path: '/cloud',
        }),
        key: 'cloud',
        path: '/cloud',
        icon: renderIcon(CloudOutline),
      },
    ],
  },
  {
    label: '歌单专辑',
    key: 'playlist',
    type: 'group',
    children: [
      {
        label: renderLabel('自建歌单', {
          name: 'Playlist',
          path: '/playlist',
          params: {
            type: 'created',
          },
        }),
        key: 'created-playlist',
        path: '/playlist/created',
        icon: renderIcon(ListOutline),
      },
      {
        label: renderLabel('收藏歌单', {
          name: 'Playlist',
          path: '/playlist',
          params: {
            type: 'favorite',
          },
        }),
        key: 'favorite-playlist',
        path: '/playlist/favorite',
        icon: renderIcon(MusicalNotesOutline),
      },
      {
        label: renderLabel('收藏专辑', {
          path: '/album',
        }),
        key: 'favorite-album',
        path: '/album',
        icon: renderIcon(AlbumsOutline),
      },
    ],
  },
];
</script>

<style scoped></style>
