<template>
  <div class="sidebar-content">
    <NMenu
      ref="menuRef"
      :indent="20"
      v-model:value="menuActiveKey"
      :options="menuOptions"
      :render-label="renderMenuLabel"
      :default-expand-all="true"
      @update:value="menuUpdate"
    />
    <NModal
      v-model:show="playlistCreateModal"
      preset="dialog"
      title="创建歌单"
      style="width: 400px"
      :loading="loading"
      positive-text="确认"
      negative-text="取消"
      @positive-click="handleCreatePlaylist"
      @negative-click="playlistCreateModal = false"
    >
      <div>
        <NForm
          ref="formRef"
          :model="formValue"
          :rules="formRules"
          size="small"
        >
          <NFormItem
            label="歌单名称"
            path="name"
          >
            <NInput
              v-model:value="formValue.name"
              :maxlength="60"
              placeholder="请输入歌单名称"
              clearable
            />
          </NFormItem>
          <NFormItem
            label="隐私歌单"
            path="isPrivate"
          >
            <NSwitch
              v-model:value="formValue.isPrivate"
              clearable
            />
          </NFormItem>
        </NForm>
      </div>
    </NModal>
  </div>
</template>

<script setup lang="ts">
import type { FormRules, MenuGroupOption, MenuInst, MenuOption } from 'naive-ui';
import type { Playlist } from '@/types';

import { NMenu, NText, NButton, NAvatar, NEllipsis, NModal, NForm, NSwitch } from 'naive-ui';
import { computed, h, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import {
  HomeOutline,
  CompassOutline,
  TimeOutline,
  CloudOutline,
  Add,
  ListOutline,
} from '@vicons/ionicons5';
import { FavoriteBorderFilled, RefreshRound } from '@vicons/material';
import { Playlist as PlaylistIcon } from '@vicons/tabler';

import { useUserStore } from '@/store';
import { getCover, renderIcon } from '@/utils';

const userStore = useUserStore();
const route = useRoute();
const router = useRouter();

const menuRef = ref<MenuInst>();
const menuActiveKey = ref<string>((route.name as string) || 'Home');

const loading = ref(false);

const playlistCreateModal = ref(false);

const formRef = ref();

const formValue = ref({
  name: '',
  isPrivate: false,
});

const formRules: FormRules = {
  name: [{ key: 'name', required: true, message: '请输入歌单名称', trigger: 'blur' }],
};

const openCreatePlaylist = () => {
  formValue.value = {
    name: '',
    isPrivate: false,
  };
  formRef.value?.restoreValidation();
  playlistCreateModal.value = true;
};

const handleCreatePlaylist = () => {
  formRef.value?.validate((errors: any) => {
    loading.value = true;
    if (!errors) {
      // 创建歌单
      userStore
        .createPlaylist(formValue.value.name, formValue.value.isPrivate)
        .then(() => {
          playlistCreateModal.value = false;
        })
        .catch((err: any) => {
          console.error('创建歌单失败', err);
        })
        .finally(() => {
          loading.value = false;
        });
    }
  });
};

// 菜单内容
const menuOptions = computed<MenuOption[] | MenuGroupOption[]>(() => {
  return [
    {
      key: 'OnlineMusic',
      type: 'group',
      label: '在线音乐',
      children: [
        {
          key: 'Home',
          link: 'home',
          label: '推荐',
          icon: renderIcon(HomeOutline),
        },
        {
          key: 'Discover',
          link: 'discover',
          label: '发现',
          icon: renderIcon(CompassOutline),
        },
      ],
    },
    {
      key: 'divider',
      type: 'divider',
    },
    {
      key: 'MyMusic',
      type: 'group',
      label: '我的音乐',
      children: [
        {
          key: 'History',
          link: 'history',
          label: '最近',
          icon: renderIcon(TimeOutline),
        },
        {
          key: 'Cloud',
          link: 'cloud',
          label: '云盘',
          icon: renderIcon(CloudOutline),
        },
      ],
    },
    {
      key: 'divider-two',
      type: 'divider',
    },
    {
      key: 'Playlist-Album',
      type: 'group',
      label: () =>
        h('div', { class: 'flex items-center justify-between w-full' }, [
          h(NText, { depth: 3 }, () => ['歌单/专辑']),
          h(NButton, {
            class: 'mr-[18px]',
            text: true,
            focusable: false,
            loading: loading.value,
            disabled: !userStore.isAuthenticated,
            renderIcon: renderIcon(RefreshRound),
            onclick: async (event: Event) => {
              event.stopPropagation();
              getUserPlaylist();
            },
          }),
        ]),
      children: [
        // 创建的歌单
        {
          key: 'user-playlists',
          icon: renderIcon(PlaylistIcon),
          label: () =>
            h('div', { class: 'flex items-center justify-between' }, [
              h(NText, { depth: 3 }, () => ['创建的歌单']),
              h(NButton, {
                class: 'mr-6',
                text: true,
                focusable: false,
                loading: loading.value,
                disabled: !userStore.isAuthenticated,
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
          icon: renderIcon(FavoriteBorderFilled),
          label: () =>
            h(
              'div',
              { class: 'flex items-center justify-between' },
              h(NText, { depth: 3 }, () => ['收藏的歌单']),
            ),
          children: [...likedPlaylist.value],
        },
      ],
    },
  ];
});

// 生成歌单列表
const renderPlaylist = (playlist: Playlist[], showCover: boolean = true, custom: string = '') => {
  if (!userStore.isAuthenticated) {
    return [];
  }
  return playlist.map(playlist => ({
    key:
      playlist.list_create_userid === userStore.userid
        ? playlist.global_collection_id
        : playlist.list_create_gid,
    label: () =>
      showCover
        ? h('div', { class: 'flex items-center' }, [
            h(NAvatar, {
              size: 26,
              src: getCover(playlist.pic, 26),
              fallbackSrc: getCover(playlist.pic, 26),
              lazy: true,
            }),
            h(
              NEllipsis,
              { style: { 'margin-left': '10px', width: 'calc(100% - 36px)' } },
              () => playlist.name,
            ),
          ])
        : h(NEllipsis, { 'margin-left': '10px', width: 'calc(100% - 36px)' }, () => playlist.name),
    icon: showCover ? undefined : renderIcon(ListOutline),
    custom,
  }));
};

// 创建的歌单
const createPlaylist = computed<MenuOption[]>(() => {
  const list = userStore.getCreatedPlaylist;
  return renderPlaylist(list, false, 'create-playlist');
});

// 收藏的歌单
const likedPlaylist = computed<MenuOption[]>(() => {
  const list = userStore.getLikedPlaylist;
  return renderPlaylist(list, true, 'liked-playlist');
});

// 渲染菜单路由
const renderMenuLabel = (option: MenuOption) => {
  // 路由链接
  if ('link' in option) {
    return h(RouterLink, { to: { path: option.link as string } }, () => option.label as string);
  }
  return typeof option.label === 'function' ? option.label() : (option.label as string);
};

// 菜单项更改
const menuUpdate = (key: string, item: MenuOption) => {
  if (key && (item.custom === 'create-playlist' || item.custom === 'liked-playlist')) {
    router.push({
      name: 'Playlist',
      query: { id: item.key, type: item.custom === 'create-playlist' ? 'create' : 'liked' },
    });
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
    case 'Playlist': {
      // 获取歌单 id
      const playlistId = String(route.query.id || '');
      // 是否处于用户歌单
      const isUserPlaylist = userStore.isUserPlaylist(playlistId);

      if (playlistId) {
        menuActiveKey.value = isUserPlaylist ? playlistId : 'Home';
      }
      menuRef.value?.showOption(playlistId);
      break;
    }
    default:
      menuActiveKey.value = routerName;
      break;
  }
};

const getUserPlaylist = async () => {
  try {
    loading.value = true;
    await userStore.fetchPlaylist();
  } finally {
    loading.value = false;
  }
};

// 监听路由
watch(
  () => [route.fullPath],
  () => checkMenuItem(),
);

// 监听用户登录
watch(
  () => userStore.isAuthenticated,
  async () => {
    if (userStore.isAuthenticated) {
      await getUserPlaylist();
    }
  },
);

onMounted(async () => {
  // 获取歌单
  if (userStore.isAuthenticated) {
    await getUserPlaylist();
  }
});
</script>

<style scoped></style>
