<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { usePlaylistStore } from '@/stores/playlist';
import { useUserStore } from '@/stores/user';
import { iconHeart } from '@/icons';
import { useToastStore } from '@/stores/toast';

const router = useRouter();
const playlistStore = usePlaylistStore();
const userStore = useUserStore();
const toastStore = useToastStore();

const isLoggedIn = computed(() => userStore.isLoggedIn);

const openLikedPlaylist = async () => {
  if (!isLoggedIn.value) return;

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

  const routeId =
    likedPlaylist.source === 2
      ? String(likedPlaylist.listCreateListid ?? likedPlaylist.id)
      : likedPlaylist.listCreateGid || likedPlaylist.globalCollectionId || likedPlaylist.listCreateListid || likedPlaylist.id;

  try {
    await router.replace({
      name: 'playlist-detail',
      params: { id: String(routeId) },
    });
  } catch {
    toastStore.navigateFailed();
  }
};

onMounted(() => {
  void openLikedPlaylist();
});
</script>

<template>
  <div class="liked-view bg-bg-main min-h-full">
    <div v-if="!isLoggedIn" class="liked-empty flex flex-col items-center justify-center min-h-[420px] text-center px-6">
      <div class="w-18 h-18 rounded-[24px] bg-primary/10 text-primary flex items-center justify-center mb-5">
        <Icon :icon="iconHeart" width="32" height="32" />
      </div>
      <div class="text-[22px] font-semibold text-text-main">登录后查看我最喜爱</div>
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.liked-empty {
  min-height: 320px;
}
</style>
