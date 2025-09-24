<template>
  <div
    ref="pageRef"
    class="album flex flex-col space-y-4"
  >
    <div class="info">
      <AlbumPanel
        :album="albumInfo"
        :size="size"
      />
    </div>
    <SongListContainer
      ref="songListContainerRef"
      type="album"
      virtual-scroll
      :max-height="maxHeight"
      :songs="songs"
      :instance="albumInfo"
      :loading="loading"
      :has-more="hasMore"
      :page-size="pageSize"
      :is-liked="isLikedAlbum"
      :show-like="userStore.isAuthenticated"
      @like="handleAlbumLike"
      @load-more="handleLoadMore"
      v-model:leave-top="leaveTop"
      v-model:scrolling="isScrolling"
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
import { useWheelScroll } from '@/hooks';

defineOptions({
  name: 'Album',
});

const userStore = useUserStore();
const settingStore = useSettingStore();

const leaveTop = ref(false);
const songListContainerRef = ref();
const pageRef = ref();

const { isScrolling } = useWheelScroll({
  direction: 'both',
  containerRef: () => pageRef.value,
  excludeSelector: '.n-data-table',
  onScroll: deltaY => {
    songListContainerRef.value?.songListRef?.scrollBy(deltaY);
  },
});

const size = computed(() => {
  return leaveTop.value ? 'small' : undefined;
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
const songCount = ref(0);
const albumInfo = ref();
const songs = ref<Song[]>([]);
const loading = ref(false);
const hasMore = ref(true);
const pageSize = 30;

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
    return {
      ...item,
      albumid: item.album_id,
      albumname: item.album_name,
      singer: item.author_name,
      publish_time: item.publish_date,
      img: item.sizable_cover,
      songcount: item.songcount || songCount.value || 0,
    };
  })?.[0];
};

const getSongs = async () => {
  if (!albumId.value) {
    return;
  }

  songs.value = [];
  hasMore.value = true;

  try {
    loading.value = true;
    // 只加载第一页数据
    const res = await getAlbumSongs(albumId.value, 1, pageSize);

    songs.value = res?.songs.map(transformAlbumSong) || [];

    // 如果返回的数据少于每页数量，说明没有更多数据了
    hasMore.value = (res.songs?.length || 0) === pageSize;
  } finally {
    loading.value = false;
  }
};

const handleLoadMore = async (page: number, currentPageSize: number) => {
  if (!albumId.value || loading.value) {
    return;
  }

  try {
    loading.value = true;
    const res = await getAlbumSongs(albumId.value, page, currentPageSize);
    const newSongs = res.songs.map(transformAlbumSong) || [];

    // 追加新数据到现有数据
    songs.value = [...songs.value, ...newSongs];

    // 更新hasMore状态
    hasMore.value = newSongs.length === currentPageSize;
  } finally {
    loading.value = false;
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const transformAlbumSong = (item: any): Song => {
  const singerinfo =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    item.authors?.map((item: any) => {
      return {
        id: item.author_id,
        name: item.author_name,
        avatar: item.sizable_avatar,
        publish: item.is_publish,
      };
    }) || [];
  const relate_goods = [];
  if (item.audio_info?.hash_320) {
    relate_goods.push({
      hash: item.hash_320,
      quality: '320',
    });
  }
  if (item.audio_info?.hash_flac) {
    relate_goods.push({
      hash: item.hash_flac,
      quality: 'flac',
    });
  }
  return {
    ...item,
    hash: item.audio_info?.hash || item.audio_info?.hash_128,
    name: item.base?.audio_name,
    cover: item.trans_param?.union_cover,
    timelen: item.audio_info?.duration,
    audio_id: item.base?.audio_id,
    album_id: item.base?.album_id,
    singerinfo: singerinfo,
    albuminfo: {
      id: item.album_info?.album_id,
      name: item.album_info?.album_name,
      cover: item.album_info?.sizable_cover,
    },
    relate_goods: relate_goods,
    privilege: item.copyright?.privilege,
  };
};

onMounted(async () => {
  albumId.value = route.query.id;
  songCount.value = Number(route.query.count);
  getAlbumInfo();
  getSongs();
});
</script>

<style lang="scss" scoped>
.info {
  transition: height 0.3s ease-in-out;
}
</style>
