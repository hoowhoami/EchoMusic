<script setup lang="ts">
import { computed, onMounted, ref, useAttrs, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from '@/components/ui/Avatar.vue';
import Button from '@/components/ui/Button.vue';
import Cover from '@/components/ui/Cover.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Input from '@/components/ui/Input.vue';
import RefreshIcon from '@/components/ui/RefreshIcon.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import Switch from '@/components/ui/Switch.vue';
import {
  iconClock,
  iconCloud,
  iconCompass,
  iconHeart,
  iconPulse,
  iconPlus,
  iconSearch,
  iconSettings,
  iconSparkles,
  iconTrash,
} from '@/icons';
import type { PlaylistMeta } from '@/models/playlist';
import { usePlaylistStore } from '@/stores/playlist';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';

defineOptions({
  inheritAttrs: false,
});

const router = useRouter();
const route = useRoute();
const attrs = useAttrs();
const userStore = useUserStore();
const playlistStore = usePlaylistStore();
const toastStore = useToastStore();

const isMac = computed(() => window.electron.platform === 'darwin');
const isLoggedIn = computed(() => userStore.isLoggedIn);
const userInfo = computed(() => userStore.info);

const activePlaylistTab = ref(0);
const showCreateDialog = ref(false);
const showRemoveDialog = ref(false);
const isCreatingPlaylist = ref(false);
const isRemovingPlaylist = ref(false);
const newPlaylistName = ref('');
const newPlaylistIsPrivate = ref(false);
const pendingRemovePlaylist = ref<PlaylistMeta | null>(null);

const likedPlaylistId = computed(() => String(playlistStore.likedPlaylistQueryId ?? ''));
const currentUserId = computed(() =>
  String(userInfo.value?.userid ?? userInfo.value?.userId ?? ''),
);
const currentUserIdNumber = computed<number | undefined>(() => {
  const value = userInfo.value?.userid ?? userInfo.value?.userId;
  return typeof value === 'number' && value > 0 ? value : undefined;
});

const menuGroups = [
  {
    title: '发现音乐',
    items: [
      { name: '为您推荐', path: '/main/home', icon: 'sparkles' },
      { name: '探索发现', path: '/main/explore', icon: 'compass' },
    ],
  },
  {
    title: '我的乐库',
    items: [
      { name: '我最喜爱', path: '/main/liked', icon: 'heart', action: 'liked-playlist' },
      { name: '私人 FM', path: '/main/personal-fm', icon: 'pulse' },
      { name: '我的云盘', path: '/main/cloud', icon: 'cloud' },
      { name: '播放历史', path: '/main/history', icon: 'clock' },
    ],
  },
] as const;

const iconMap = {
  sparkles: iconSparkles,
  pulse: iconPulse,
  compass: iconCompass,
  search: iconSearch,
  clock: iconClock,
  cloud: iconCloud,
  heart: iconHeart,
} as const;

const getPlaylistIdentityList = (playlist: PlaylistMeta): string[] => {
  return [
    playlist.id,
    playlist.listid,
    playlist.listCreateGid,
    playlist.globalCollectionId,
    playlist.listCreateListid,
  ]
    .filter(
      (value): value is string | number =>
        value !== undefined && value !== null && String(value) !== '',
    )
    .map((value) => String(value));
};

const isLikedPlaylist = (playlist: PlaylistMeta): boolean => {
  const likedId = likedPlaylistId.value;
  if (!likedId) return false;
  return getPlaylistIdentityList(playlist).includes(likedId);
};

const isOwnerPlaylist = (playlist: PlaylistMeta): boolean => {
  const ownerId = String(playlist.listCreateUserid ?? '');
  const userId = currentUserId.value;
  return ownerId !== '' && userId !== '' && ownerId === userId;
};

const isDefaultPlaylist = (playlist: PlaylistMeta): boolean => {
  return playlist.source !== 2 && playlist.type === 0 && playlist.isDefault === true;
};

const canRemovePlaylist = (playlist: PlaylistMeta): boolean => !isDefaultPlaylist(playlist);

const createdPlaylists = computed(() =>
  playlistStore.userPlaylists.filter(
    (playlist) => playlist.source !== 2 && !isLikedPlaylist(playlist) && isOwnerPlaylist(playlist),
  ),
);

const favoritedPlaylists = computed(() =>
  playlistStore.userPlaylists.filter(
    (playlist) => playlist.source !== 2 && !isLikedPlaylist(playlist) && !isOwnerPlaylist(playlist),
  ),
);

const favoritedAlbums = computed(() =>
  playlistStore.userPlaylists.filter((playlist) => playlist.source === 2),
);

const activePlaylistRouteId = computed(() => {
  return route.name === 'playlist-detail' ? String(route.params.id ?? '') : '';
});

const activeAlbumRouteId = computed(() => {
  return route.name === 'album-detail' ? String(route.params.id ?? '') : '';
});

const navigateTo = (path: string) => {
  router.push(path);
};

const getPlaylistRouteId = (playlist: PlaylistMeta): string => {
  if (playlist.source === 2) {
    return String(playlist.listCreateListid ?? playlist.id);
  }
  if (isOwnerPlaylist(playlist)) {
    return String(playlist.globalCollectionId ?? playlist.id);
  }
  return String(playlist.listCreateGid ?? playlist.globalCollectionId ?? playlist.id);
};

const likedPlaylistRouteId = computed(() => {
  const likedPlaylist = playlistStore.likedPlaylist;
  if (!likedPlaylist) return '';
  return getPlaylistRouteId(likedPlaylist);
});

const findPlaylistByRouteId = (routeId: string, source?: number): PlaylistMeta | undefined => {
  if (!routeId) return undefined;
  return playlistStore.userPlaylists.find((playlist) => {
    if (source !== undefined && playlist.source !== source) return false;
    return getPlaylistRouteId(playlist) === routeId;
  });
};

const isActivePlaylist = (playlist: PlaylistMeta): boolean => {
  if (playlist.source === 2) return false;
  return getPlaylistRouteId(playlist) === activePlaylistRouteId.value;
};

const isActiveAlbum = (playlist: PlaylistMeta): boolean => {
  if (playlist.source !== 2) return false;
  return getPlaylistRouteId(playlist) === activeAlbumRouteId.value;
};

const navigateToPlaylist = (playlist: PlaylistMeta) => {
  if (playlist.source === 2) {
    const id = getPlaylistRouteId(playlist);
    if (route.name === 'album-detail' && activeAlbumRouteId.value === id) return;
    router.push({ name: 'album-detail', params: { id } });
    return;
  }

  const id = getPlaylistRouteId(playlist);
  if (route.name === 'playlist-detail' && activePlaylistRouteId.value === id) return;
  router.push({
    name: 'playlist-detail',
    params: { id },
    query: { type: isOwnerPlaylist(playlist) ? 'user' : 'special' },
  });
};

const navigateToLikedPlaylist = async () => {
  if (!isLoggedIn.value) {
    try {
      await router.push('/main/liked');
    } catch {
      toastStore.navigateFailed();
    }
    return;
  }

  let likedPlaylist = playlistStore.likedPlaylist;
  if (!likedPlaylist) {
    try {
      await playlistStore.fetchUserPlaylists();
    } catch {
      toastStore.loadFailed('歌单');
    }
    likedPlaylist = playlistStore.likedPlaylist;
  }

  if (!likedPlaylist) return;

  // Silently sync favorites to update heart icons globally
  void playlistStore.fetchLikedPlaylistSongs();

  navigateToPlaylist(likedPlaylist);
};

const refreshUserPlaylists = async () => {
  if (!isLoggedIn.value) return;
  try {
    await playlistStore.fetchUserPlaylists();
  } catch {
    toastStore.loadFailed('歌单');
  }
};

const openCreatePlaylistDialog = () => {
  if (!isLoggedIn.value || activePlaylistTab.value !== 0) return;
  newPlaylistName.value = '';
  newPlaylistIsPrivate.value = false;
  showCreateDialog.value = true;
};

const closeCreatePlaylistDialog = () => {
  if (isCreatingPlaylist.value) return;
  showCreateDialog.value = false;
};

const handleCreatePlaylist = async () => {
  const name = newPlaylistName.value.trim();
  const userId = currentUserIdNumber.value;
  if (!name || !userId || isCreatingPlaylist.value) return;

  isCreatingPlaylist.value = true;
  try {
    const success = await playlistStore.createPlaylist(name, newPlaylistIsPrivate.value, userId);
    if (!success) {
      toastStore.actionFailed('创建歌单');
      return;
    }
    activePlaylistTab.value = 0;
    showCreateDialog.value = false;
    newPlaylistName.value = '';
    newPlaylistIsPrivate.value = false;
    toastStore.actionSucceeded('创建歌单');
  } catch {
    toastStore.actionFailed('创建歌单');
  } finally {
    isCreatingPlaylist.value = false;
  }
};

const openRemovePlaylistDialog = (playlist: PlaylistMeta) => {
  if (!canRemovePlaylist(playlist)) return;
  pendingRemovePlaylist.value = playlist;
  showRemoveDialog.value = true;
};

const closeRemovePlaylistDialog = () => {
  if (isRemovingPlaylist.value) return;
  showRemoveDialog.value = false;
  pendingRemovePlaylist.value = null;
};

const removeDialogTitle = computed(() => {
  const playlist = pendingRemovePlaylist.value;
  if (!playlist) return '删除歌单';
  return isOwnerPlaylist(playlist) ? '删除歌单' : '取消收藏';
});

const removeDialogConfirmText = computed(() => {
  const playlist = pendingRemovePlaylist.value;
  if (!playlist) return '删除';
  return isOwnerPlaylist(playlist) ? '删除' : '取消收藏';
});

const removeDialogDescription = computed(() => {
  const playlist = pendingRemovePlaylist.value;
  if (!playlist) return '确定要删除当前歌单吗？';
  const action = isOwnerPlaylist(playlist) ? '删除' : '取消收藏';
  return `确定要${action}「${playlist.name || '歌单'}」吗？`;
});

const handleRemovePlaylist = async () => {
  const playlist = pendingRemovePlaylist.value;
  if (!playlist || isRemovingPlaylist.value) return;

  const routeId = getPlaylistRouteId(playlist);
  const currentUserIdValue = currentUserIdNumber.value;
  const isOwned = isOwnerPlaylist(playlist);
  const shouldNavigateAway =
    isOwned && route.name === 'playlist-detail' && activePlaylistRouteId.value === routeId;

  isRemovingPlaylist.value = true;
  try {
    let success = false;
    if (playlist.source === 2) {
      success = await playlistStore.unfavoriteAlbum(
        playlist.listCreateListid ?? playlist.listid ?? playlist.id,
      );
    } else if (isOwned) {
      success = await playlistStore.deleteOwnedPlaylist(playlist.listid ?? playlist.id);
    } else {
      success = await playlistStore.unfavoritePlaylist(playlist, currentUserIdValue);
    }

    if (!success) {
      toastStore.actionFailed(isOwned ? '删除歌单' : '取消收藏');
      return;
    }

    showRemoveDialog.value = false;
    pendingRemovePlaylist.value = null;

    if (shouldNavigateAway) {
      try {
        await router.push('/main/home');
      } catch {
        toastStore.navigateFailed();
      }
    }
    if (isOwned) {
      toastStore.actionCompleted('已删除歌单');
    } else {
      toastStore.actionCompleted('已取消收藏');
    }
  } catch {
    toastStore.actionFailed(isOwned ? '删除歌单' : '取消收藏');
  } finally {
    isRemovingPlaylist.value = false;
  }
};

const isMenuItemDisabled = (item?: { path: string; action?: string }) => {
  void item;
  return false;
};

const handleMenuClick = (item: { path: string; action?: string }) => {
  if (isMenuItemDisabled(item)) return;
  if (item.action === 'liked-playlist') {
    void navigateToLikedPlaylist();
    return;
  }
  navigateTo(item.path);
};

const isMenuItemActive = (item: { path: string; action?: string }) => {
  if (item.action === 'liked-playlist') {
    return (
      route.name === 'liked-songs' ||
      (route.name === 'playlist-detail' &&
        activePlaylistRouteId.value === likedPlaylistRouteId.value)
    );
  }
  return route.path === item.path;
};

const syncCloudData = () => {
  if (isLoggedIn.value) {
    void playlistStore.fetchUserPlaylists();
  }
};

onMounted(() => {
  syncCloudData();
});

watch(isLoggedIn, (value) => {
  if (value) {
    syncCloudData();
  } else {
    playlistStore.userPlaylists = [];
  }
});

watch(
  () => [route.name, route.params.id, playlistStore.userPlaylists.length, currentUserId.value],
  () => {
    if (route.name === 'playlist-detail') {
      const currentId = activePlaylistRouteId.value;
      const matched = findPlaylistByRouteId(currentId) || findPlaylistByRouteId(currentId, 1);
      if (matched) {
        activePlaylistTab.value = isOwnerPlaylist(matched) ? 0 : 1;
      }
      return;
    }

    if (route.name === 'album-detail') {
      const currentId = activeAlbumRouteId.value;
      const matched = findPlaylistByRouteId(currentId, 2);
      if (matched) {
        activePlaylistTab.value = 1;
      }
    }
  },
  { immediate: true },
);
</script>

<template>
  <aside
    v-bind="attrs"
    class="sidebar h-full flex flex-col bg-bg-sidebar border-r border-border-light select-none transition-all duration-300 relative"
  >
    <div :class="['w-full shrink-0 relative', isMac ? 'h-16' : 'h-12']">
      <div class="drag-region"></div>
    </div>

    <div :class="['px-4 pb-3 shrink-0 no-drag', isMac ? 'mt-2' : 'mt-0']">
      <div
        class="user-info-card flex items-center overflow-hidden bg-bg-info-card border border-black/[0.08] dark:border-white/10 rounded-[20px] p-1 transition-all duration-200"
      >
        <div
          class="sidebar-user-link min-w-0 flex-1 flex items-center gap-3 p-1.5 rounded-[14px] cursor-pointer transition-all active:scale-[0.98]"
          @click="navigateTo(isLoggedIn ? '/main/profile' : '/login')"
        >
          <div
            class="w-[34px] h-[34px] shrink-0 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden"
          >
            <Avatar :src="isLoggedIn ? userInfo?.pic : ''" class="w-full h-full" />
          </div>
          <div class="flex flex-col min-w-0 flex-1 overflow-hidden">
            <span
              class="text-[13px] font-semibold text-text-main truncate leading-tight tracking-tight"
            >
              {{ isLoggedIn ? userInfo?.nickname : '未登录' }}
            </span>
            <span
              class="truncate text-[9px] text-text-secondary font-medium opacity-60 tracking-wider"
            >
              {{ isLoggedIn ? `Lv.${userInfo?.p_grade || 0}` : '点击登录账号' }}
            </span>
          </div>
        </div>
        <div class="sidebar-user-divider"></div>
        <Button
          variant="unstyled"
          size="none"
          class="sidebar-settings-btn p-2 mr-1 rounded-[14px] text-text-secondary transition-all active:scale-90"
          @click="navigateTo('/main/settings')"
        >
          <Icon :icon="iconSettings" width="19" height="19" />
        </Button>
      </div>
    </div>

    <div class="px-4 shrink-0 no-drag">
      <div v-for="group in menuGroups" :key="group.title" class="mb-4">
        <h2
          class="px-3.5 text-[11px] font-semibold text-text-main/60 uppercase tracking-[0.5px] mb-2"
        >
          {{ group.title }}
        </h2>
        <nav class="space-y-0.5">
          <Button
            v-for="item in group.items"
            :key="item.path"
            variant="unstyled"
            size="none"
            :disabled="isMenuItemDisabled(item)"
            :class="[
              'sidebar-nav-item w-full flex items-center gap-3.5 px-3.5 py-2 rounded-[14px] transition-all duration-200 group active:scale-[0.98]',
              isMenuItemDisabled(item)
                ? 'is-disabled cursor-not-allowed opacity-35 text-text-main/55'
                : isMenuItemActive(item)
                  ? 'is-active cursor-pointer bg-primary/[0.12] text-primary'
                  : 'cursor-pointer text-text-main/90',
            ]"
            @click="handleMenuClick(item)"
          >
            <Icon
              :icon="iconMap[item.icon as keyof typeof iconMap]"
              width="18"
              height="18"
              :class="[
                isMenuItemDisabled(item)
                  ? 'text-text-main opacity-40'
                  : isMenuItemActive(item)
                    ? 'text-primary'
                    : 'text-text-main opacity-60 group-hover:opacity-100',
              ]"
            />
            <span
              class="text-[14px]"
              :class="[isMenuItemActive(item) ? 'font-semibold' : 'font-normal']"
            >
              {{ item.name }}
            </span>
          </Button>
        </nav>
      </div>
    </div>

    <div class="pl-7.5 pr-3 mb-2 shrink-0 no-drag mt-2 flex items-center gap-1.5">
      <div class="min-w-0 flex flex-1 items-center gap-1">
        <Button
          variant="unstyled"
          size="none"
          :class="[
            'sidebar-playlist-tab',
            activePlaylistTab === 0
              ? 'text-primary opacity-100'
              : 'text-text-main opacity-60 hover:opacity-80',
          ]"
          @click="activePlaylistTab = 0"
        >
          自建歌单
        </Button>
        <span class="sidebar-tab-divider" aria-hidden="true"></span>
        <Button
          variant="unstyled"
          size="none"
          :class="[
            'sidebar-playlist-tab',
            activePlaylistTab === 1
              ? 'text-primary opacity-100'
              : 'text-text-main opacity-60 hover:opacity-80',
          ]"
          @click="activePlaylistTab = 1"
        >
          收藏歌单/专辑
        </Button>
      </div>
      <div class="flex items-center gap-0.5 shrink-0 pl-0.5">
        <Button
          variant="unstyled"
          size="none"
          type="button"
          class="sidebar-section-action sidebar-icon-btn"
          title="刷新歌单"
          :disabled="!isLoggedIn"
          @click="refreshUserPlaylists"
        >
          <RefreshIcon width="15" height="15" />
        </Button>
        <div class="sidebar-section-action-slot">
          <Button
            v-if="isLoggedIn && activePlaylistTab === 0"
            variant="unstyled"
            size="none"
            type="button"
            class="sidebar-section-action sidebar-icon-btn"
            title="新建歌单"
            @click="openCreatePlaylistDialog"
          >
            <Icon :icon="iconPlus" width="14" height="14" />
          </Button>
        </div>
      </div>
    </div>

    <Scrollbar
      class="flex-1 min-h-0 no-drag"
      :scrollbar-inset="3"
      :content-props="{ class: 'sidebar-scroll' }"
    >
      <nav v-if="isLoggedIn" class="sidebar-scroll-inner space-y-0.5">
        <template v-if="activePlaylistTab === 0">
          <div
            v-for="playlist in createdPlaylists"
            :key="playlist.listid || playlist.id"
            :class="[
              'sidebar-library-item relative w-full flex items-center gap-3 px-3.5 py-1.5 rounded-[12px] group cursor-pointer active:scale-[0.98] transition-all',
              isActivePlaylist(playlist)
                ? 'is-active bg-primary/[0.12] text-primary'
                : 'text-text-main/90',
            ]"
            @click="navigateToPlaylist(playlist)"
          >
            <Cover
              :url="playlist.pic"
              :size="100"
              :width="28"
              :height="28"
              :borderRadius="6"
              class="shrink-0"
            />
            <div
              :class="[
                'sidebar-playlist-label-wrap',
                canRemovePlaylist(playlist) ? 'has-action' : '',
              ]"
            >
              <span
                :class="[
                  'text-[13px] truncate w-full font-medium tracking-tight',
                  isActivePlaylist(playlist) ? 'text-primary' : 'text-text-main/90',
                ]"
              >
                {{ playlist.name }}
              </span>
            </div>
            <Button
              v-if="canRemovePlaylist(playlist)"
              variant="unstyled"
              size="none"
              type="button"
              class="sidebar-playlist-action"
              :title="isOwnerPlaylist(playlist) ? '删除歌单' : '取消收藏'"
              @click.stop="openRemovePlaylistDialog(playlist)"
            >
              <Icon :icon="iconTrash" width="14" height="14" />
            </Button>
          </div>
          <div
            v-if="createdPlaylists.length === 0"
            class="py-8 text-center opacity-40 text-[12px] italic"
          >
            暂无自建歌单
          </div>
        </template>

        <template v-else>
          <div
            v-for="playlist in favoritedPlaylists"
            :key="playlist.listid || playlist.id"
            :class="[
              'sidebar-library-item relative w-full flex items-center gap-3 px-3.5 py-1.5 rounded-[12px] group cursor-pointer active:scale-[0.98] transition-all',
              isActivePlaylist(playlist)
                ? 'is-active bg-primary/[0.12] text-primary'
                : 'text-text-main/90',
            ]"
            @click="navigateToPlaylist(playlist)"
          >
            <Cover
              :url="playlist.pic"
              :size="100"
              :width="28"
              :height="28"
              :borderRadius="6"
              class="shrink-0"
            />
            <div class="sidebar-playlist-label-wrap has-action">
              <span
                :class="[
                  'text-[13px] truncate w-full font-medium tracking-tight',
                  isActivePlaylist(playlist) ? 'text-primary' : 'text-text-main/90',
                ]"
              >
                {{ playlist.name }}
              </span>
            </div>
            <Button
              v-if="canRemovePlaylist(playlist)"
              variant="unstyled"
              size="none"
              type="button"
              class="sidebar-playlist-action"
              title="取消收藏"
              @click.stop="openRemovePlaylistDialog(playlist)"
            >
              <Icon :icon="iconTrash" width="14" height="14" />
            </Button>
          </div>

          <div v-if="favoritedAlbums.length > 0" class="sidebar-list-divider"></div>

          <div
            v-for="album in favoritedAlbums"
            :key="album.listid || album.id"
            :class="[
              'sidebar-library-item relative w-full flex items-center gap-3 px-3.5 py-1.5 rounded-[12px] group cursor-pointer active:scale-[0.98] transition-all',
              isActiveAlbum(album)
                ? 'is-active bg-primary/[0.12] text-primary'
                : 'text-text-main/90',
            ]"
            @click="navigateToPlaylist(album)"
          >
            <Cover
              :url="album.pic"
              :size="100"
              :width="28"
              :height="28"
              :borderRadius="6"
              class="shrink-0"
            />
            <div class="sidebar-playlist-label-wrap has-action">
              <span
                :class="[
                  'text-[13px] truncate w-full font-medium tracking-tight',
                  isActiveAlbum(album) ? 'text-primary' : 'text-text-main/90',
                ]"
              >
                {{ album.name }}
              </span>
            </div>
            <Button
              variant="unstyled"
              size="none"
              type="button"
              class="sidebar-playlist-action"
              title="取消收藏"
              @click.stop="openRemovePlaylistDialog(album)"
            >
              <Icon :icon="iconTrash" width="14" height="14" />
            </Button>
          </div>

          <div
            v-if="favoritedPlaylists.length === 0 && favoritedAlbums.length === 0"
            class="py-8 text-center opacity-40 text-[12px] italic"
          >
            暂无收藏内容
          </div>
        </template>
      </nav>

      <div v-else class="sidebar-scroll-empty px-3.5 py-8 text-center">
        <span class="text-[12px] font-normal text-text-main opacity-50 italic"
          >登录同步云端歌单</span
        >
      </div>
    </Scrollbar>
  </aside>

  <Dialog
    v-model:open="showCreateDialog"
    title="新建歌单"
    description="输入歌单名称，可选设为隐私歌单。"
    contentClass="sidebar-dialog"
    showClose
    :close-on-interact-outside="!isCreatingPlaylist"
  >
    <div class="flex flex-col gap-4 pt-1">
      <Input
        v-model="newPlaylistName"
        placeholder="请输入歌单名称"
        :show-clear="!isCreatingPlaylist"
        input-class="h-12 rounded-[14px] px-4 pr-10 text-[14px] font-medium"
      />
      <div
        class="flex items-center justify-between rounded-[14px] bg-black/[0.03] dark:bg-white/[0.03] px-4 py-3"
      >
        <div class="flex flex-col gap-1">
          <span class="text-[14px] font-medium text-text-main">设为隐私歌单</span>
          <span class="text-[12px] text-text-secondary/80">仅自己可见</span>
        </div>
        <Switch v-model="newPlaylistIsPrivate" :disabled="isCreatingPlaylist" />
      </div>
    </div>
    <template #footer>
      <Button
        variant="ghost"
        size="sm"
        :disabled="isCreatingPlaylist"
        @click="closeCreatePlaylistDialog"
      >
        取消
      </Button>
      <Button
        variant="primary"
        size="sm"
        :loading="isCreatingPlaylist"
        :disabled="!newPlaylistName.trim() || !currentUserIdNumber"
        @click="handleCreatePlaylist"
      >
        创建
      </Button>
    </template>
  </Dialog>

  <Dialog
    v-model:open="showRemoveDialog"
    :title="removeDialogTitle"
    :description="removeDialogDescription"
    contentClass="sidebar-dialog"
    showClose
    :close-on-interact-outside="!isRemovingPlaylist"
  >
    <template #footer>
      <Button
        variant="ghost"
        size="sm"
        :disabled="isRemovingPlaylist"
        @click="closeRemovePlaylistDialog"
      >
        取消
      </Button>
      <Button
        variant="danger"
        size="sm"
        :loading="isRemovingPlaylist"
        @click="handleRemovePlaylist"
      >
        {{ removeDialogConfirmText }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

.sidebar {
  width: 230px;
}

:deep(.sidebar-scroll) {
  min-height: 0;
}

.sidebar-scroll-inner,
.sidebar-scroll-empty {
  padding: 0 16px 24px;
}

.sidebar-playlist-tab {
  @apply shrink-0 whitespace-nowrap text-left text-[11px] font-semibold tracking-[0.1px] leading-none transition-colors duration-200;
}

.sidebar-user-divider {
  @apply mx-1.5 h-[22px] w-[1px] shrink-0 rounded-full bg-text-main/14;
}

.dark .sidebar-user-divider {
  background-color: color-mix(in srgb, var(--color-text-main) 18%, transparent);
}

.sidebar-list-divider {
  @apply my-2.5 mx-3.5 h-[1px] rounded-full bg-text-main/10;
}

.dark .sidebar-list-divider {
  background-color: color-mix(in srgb, var(--color-text-main) 18%, transparent);
}

.sidebar-tab-divider {
  @apply shrink-0 mx-1 w-[1px] h-3 rounded-full bg-text-main/22;
}

.dark .sidebar-tab-divider {
  background-color: color-mix(in srgb, var(--color-text-main) 36%, transparent);
}

.sidebar-nav-item,
.sidebar-library-item,
.sidebar-user-link,
.sidebar-settings-btn,
.sidebar-section-action,
.sidebar-playlist-action {
  background-color: transparent;
}

.user-info-card {
  min-width: 0;
}

.sidebar-user-link {
  min-width: 0;
}

.sidebar-settings-btn {
  @apply h-9 w-9 shrink-0 flex items-center justify-center;
}

.sidebar-nav-item:not(.is-active):not(.is-disabled):hover,
.sidebar-library-item:not(.is-active):hover {
  background-color: color-mix(in srgb, var(--color-text-main) 7%, transparent);
}

.sidebar-user-link:hover {
  background-color: color-mix(in srgb, var(--color-text-main) 18%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-text-main) 5%, transparent);
}

.sidebar-settings-btn:hover,
.sidebar-icon-btn:hover {
  background-color: color-mix(in srgb, var(--color-text-main) 20%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-text-main) 5%, transparent);
}

.sidebar-section-action-slot {
  @apply h-6.5 w-6.5 shrink-0;
}

.sidebar-section-action {
  @apply h-6.5 w-6.5 min-w-0 shrink-0 rounded-lg flex items-center justify-center;
  @apply text-text-main opacity-60 transition-all disabled:opacity-30;
}

.sidebar-playlist-label-wrap {
  @apply flex flex-col items-start min-w-0 flex-1 transition-[padding] duration-200;
}

.sidebar-playlist-label-wrap.has-action {
  @apply group-hover:pr-8;
}

.sidebar-playlist-action {
  @apply absolute right-2.5 top-1/2 -translate-y-1/2 h-7 w-7 min-w-0 rounded-lg flex items-center justify-center text-text-main/55;
  @apply opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto hover:text-red-500 transition-all;
}

.sidebar-playlist-action:hover {
  background-color: color-mix(in srgb, var(--color-text-main) 18%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-text-main) 4%, transparent);
}

:deep(.sidebar-dialog) {
  width: min(420px, 92vw);
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}

.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
