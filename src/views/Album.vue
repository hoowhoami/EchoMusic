<template>
  <div class="album flex flex-col space-y-4">
    <div class="info">
      <AlbumPanel
        :album="albumInfo"
        :size="size"
      />
    </div>
    <SongListContainer
      type="album"
      virtual-scroll
      :max-height="maxHeight"
      :songs="songs"
      :instance="albumInfo"
      :loading="loading"
      :is-liked="isLikedAlbum"
      :show-like="userStore.isAuthenticated"
      @like="handleAlbumLike"
      v-model:list-scrolling="listScrolling"
    />
  </div>
</template>

<script setup lang="ts">
import type { Album, Song } from '@/types';
import { getAlbumDetail, getAlbumSongs } from '@/api';
import SongListContainer from '@/components/Container/SongListContainer.vue';
import AlbumPanel from '@/components/Panel/AlbumPanel.vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useSettingStore, useUserStore } from '@/store';

defineOptions({
  name: 'Album',
});

const userStore = useUserStore();
const settingStore = useSettingStore();

const listScrolling = ref(false);

const size = computed(() => {
  return listScrolling.value ? 'small' : undefined;
});

// 延迟更新的高度，避免动画期间滚动条闪烁
const delayedSize = ref<'small' | undefined>(undefined);
let heightUpdateTimer: NodeJS.Timeout | null = null;

// 监听size变化，延迟更新高度
watch(size, newSize => {
  if (heightUpdateTimer) {
    clearTimeout(heightUpdateTimer);
  }

  if (newSize === 'small') {
    // 缩小时延迟300ms（等动画完成）
    heightUpdateTimer = setTimeout(() => {
      delayedSize.value = newSize;
    }, 300);
  } else {
    // 放大时立即更新
    delayedSize.value = newSize;
  }
});

const maxHeight = computed(() => {
  return settingStore.mainHeight - (delayedSize.value === 'small' ? 200 : 290);
});

const route = useRoute();
const albumId = ref();
const albumInfo = ref();
const songs = ref<Song[]>([]);
const loading = ref(false);

const isLikedAlbum = ref(false);

const handleAlbumLike = async (data: any) => {
  if (!albumInfo.value) {
    return;
  }
  if (isLikedAlbum.value) {
    // 取消收藏
  } else {
    // 收藏
    const album = data as Album;
    console.log(album);
  }
};

const getAlbumInfo = async () => {
  if (!albumId.value) {
    return;
  }
  const res = await getAlbumDetail(albumId.value);
  albumInfo.value = res?.map((item: any) => {
    console.log(item);
    return {
      ...item,
      albumid: item.album_id,
      albumname: item.album_name,
      singer: item.author_name,
      publish_time: item.publish_date,
      img: item.sizable_cover,
    };
  })?.[0];
  console.log(albumInfo.value);
};

const getSongs = async () => {
  if (!albumId.value) {
    return;
  }
  let page = 1;
  const size = 300;
  let fetchCount = 0;
  songs.value = [];
  try {
    loading.value = true;
    do {
      const res = await getAlbumSongs(albumId.value, page, size);
      songs.value.push(...res.songs);
      fetchCount = res.songs.length;
      page++;
    } while (fetchCount > 0);
  } finally {
    loading.value = false;
  }
};

onMounted(async () => {
  albumId.value = route.query.id;
  getAlbumInfo();
  getSongs();
});
</script>

<style lang="scss" scoped>
.info {
  transition: height 0.3s ease-in-out;
}
</style>
