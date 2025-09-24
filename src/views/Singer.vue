<template>
  <div
    ref="pageRef"
    class="flex flex-col space-y-4"
  >
    <div class="info">
      <SingerPanel
        :singer="singerInfo"
        :size="size"
      />
    </div>
    <SongListContainer
      ref="songListContainerRef"
      type="singer"
      virtual-scroll
      :max-height="maxHeight"
      :songs="songs"
      :instance="singerInfo"
      :loading="loading"
      :has-more="hasMore"
      :page-size="pageSize"
      :show-like="userStore.isAuthenticated"
      :is-liked="isLikedSinger"
      @like="handleLikeSinger"
      @load-more="handleLoadMore"
      v-model:leave-top="leaveTop"
      v-model:scrolling="isScrolling"
    />
  </div>
</template>

<script setup lang="ts">
import type { Singer, Song } from '@/types';
import { getSingerDetail, getSingerSongs } from '@/api';
import SongListContainer from '@/components/Container/SongListContainer.vue';
import SingerPanel from '@/components/Panel/SingerPanel.vue';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useSettingStore, useUserStore } from '@/store';
import { useWheelScroll } from '@/hooks';

defineOptions({
  name: 'Singer',
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
const singerId = ref();
const singerInfo = ref();
const songs = ref<Song[]>([]);
const loading = ref(false);
const hasMore = ref(true);
const pageSize = 30;
const isLikedSinger = computed(() => {
  if (!singerId.value) {
    return false;
  }
  return userStore.isFollowedSinger(Number(singerId.value));
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handleLikeSinger = async (data: any) => {
  const singer = data as Singer;
  if (isLikedSinger.value) {
    await userStore.unfollowSinger(singer.singerid);
    window.$message.success('已取消关注');
  } else {
    await userStore.followSinger(singer.singerid);
    window.$message.success('已添加关注');
  }
};

const getSingerInfo = async () => {
  if (!singerId.value) {
    return;
  }
  const res = await getSingerDetail(singerId.value);
  if (res) {
    res.singerid = res.author_id;
    res.singername = res.author_name;
    res.imgurl = res.sizable_avatar;
    res.songcount = res.song_count || 0;
    res.albumcount = res.album_count || 0;
    res.fanscount = res.fansnums || 0;
    res.mvcount = res.mv_count || 0;
    res.descibe = res.long_intro;
  }
  singerInfo.value = res;
};

// 抽取数据转换逻辑
const transformSingerSong = (item: any) => {
  const relate_goods = [];
  if (item.hash_320) {
    relate_goods.push({
      hash: item.hash_320,
      quality: '320',
    });
  }
  if (item.hash_flac) {
    relate_goods.push({
      hash: item.hash_flac,
      quality: 'flac',
    });
  }
  return {
    ...item,
    album_id: item.album_id,
    albuminfo: {
      id: item.album_id,
      name: item.album_name,
    },
    name: item.author_name + ' - ' + item.audio_name,
    singerinfo: [
      {
        id: singerId.value,
        name: item.author_name,
      },
    ],
    publish_time: item.publish_date,
    cover: item.trans_param?.union_cover,
    relate_goods: relate_goods,
    timelen: item.timelength || 0,
  };
};

const getSongs = async () => {
  if (!singerId.value) {
    return;
  }

  songs.value = [];
  hasMore.value = true;

  try {
    loading.value = true;
    // 只加载第一页数据
    let res = await getSingerSongs({
      id: singerId.value,
      page: 1,
      pagesize: pageSize,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res = res?.map((item: any) => transformSingerSong(item));

    songs.value = res || [];
    // 如果返回的数据少于每页数量，说明没有更多数据了
    hasMore.value = (res?.length || 0) === pageSize;
  } finally {
    loading.value = false;
  }
};

const handleLoadMore = async (page: number, currentPageSize: number) => {
  if (!singerId.value || loading.value) {
    return;
  }

  try {
    loading.value = true;
    let res = await getSingerSongs({
      id: singerId.value,
      page,
      pagesize: currentPageSize,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res = res?.map((item: any) => transformSingerSong(item));

    const newSongs = res || [];

    // 追加新数据到现有数据
    songs.value = [...songs.value, ...newSongs];

    // 更新hasMore状态
    hasMore.value = newSongs.length === currentPageSize;
  } finally {
    loading.value = false;
  }
};

onMounted(async () => {
  singerId.value = route.query.id;
  await userStore.fetchUserFollow();
  await getSingerInfo();
  await getSongs();
});
</script>

<style lang="scss" scoped>
.info {
  transition: height 0.3s ease-in-out;
}
</style>
