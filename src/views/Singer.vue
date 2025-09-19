<template>
  <div ref="pageRef" class="flex flex-col space-y-4">
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
      :show-like="userStore.isAuthenticated"
      :is-liked="isLikedSinger"
      @like="handleLikeSinger"
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
  onScroll: (deltaY) => {
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
const isLikedSinger = computed(() => {
  if (!singerId.value) {
    return false;
  }
  return userStore.isFollowedSinger(Number(singerId.value));
});

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
  console.log(singerInfo.value);
};

const getSongs = async () => {
  if (!singerId.value) {
    return;
  }
  let page = 1;
  const size = 300;
  let fetchCount = 0;
  songs.value = [];
  try {
    loading.value = true;
    do {
      let res = await getSingerSongs({
        id: singerId.value,
        page,
        pagesize: size,
      });
      res = res?.map((item: any) => {
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
      });
      songs.value.push(...res);
      fetchCount = res.length;
      page++;
    } while (fetchCount > 0);
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
