<template>
  <div
    ref="pageRef"
    class="cloud flex flex-col space-y-4"
  >
    <div class="info">
      <CloudPanel
        :size="size"
        :count="count"
        :capacity="capacity"
        :available="available"
      />
    </div>
    <SongListContainer
      ref="songListContainerRef"
      virtual-scroll
      :max-height="maxHeight"
      type="cloud"
      :songs="songs"
      :loading="loading"
      :has-more="hasMore"
      :page-size="pageSize"
      @load-more="handleLoadMore"
      v-model:leave-top="leaveTop"
      v-model:scrolling="isScrolling"
    />
  </div>
</template>

<script setup lang="ts">
import { getUserCloud } from '@/api';
import SongListContainer from '@/components/Container/SongListContainer.vue';
import CloudPanel from '@/components/Panel/CloudPanel.vue';
import { useSettingStore } from '@/store';
import { Song } from '@/types';
import { isArray } from 'lodash-es';
import { computed, onMounted, ref, watch } from 'vue';
import { useWheelScroll } from '@/hooks';

defineOptions({
  name: 'Cloud',
});

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

const loading = ref(false);
const count = ref(0);
const songs = ref<Song[]>([]);
const capacity = ref(0);
const available = ref(0);
const hasMore = ref(true);
const pageSize = 30;

// 抽取云盘歌曲数据转换逻辑
const transformCloudSong = (item: any) => {
  const singerinfo =
    item?.authors?.map((it: any) => {
      return {
        id: it?.author_id,
        name: it?.author_name,
        avatar: it?.sizable_avatar,
        publish: it?.is_publish,
      };
    }) || [];
  return {
    ...item,
    cover: item?.album_info?.sizable_cover,
    albuminfo: {
      id: item?.album_info?.album_id,
      name: item?.album_info?.album_name,
      publish: item?.album_info?.is_publish,
    },
    singerinfo: singerinfo,
    source: 'cloud',
  };
};

const getUserCloudInfo = async () => {
  try {
    loading.value = true;
    count.value = 0;
    songs.value = [];
    capacity.value = 0;
    available.value = 0;
    hasMore.value = true;

    // 只加载第一页数据
    const res = await getUserCloud(1, pageSize);
    count.value = res.list_count || 0;
    capacity.value = res.max_size || 0;
    available.value = res.availble_size || 0;

    const songList = isArray(res.list)
      ? res.list?.map((item: any) => transformCloudSong(item))
      : [];

    songs.value = songList;
    // 如果返回的数据少于每页数量，说明没有更多数据了
    hasMore.value = songList.length <= pageSize;
  } catch (error) {
    console.log('获取云盘数据失败', error);
  } finally {
    loading.value = false;
  }
};

const handleLoadMore = async (page: number, currentPageSize: number) => {
  if (loading.value) {
    return;
  }

  try {
    loading.value = true;
    const res = await getUserCloud(page, currentPageSize);

    const newSongs = isArray(res.list)
      ? res.list?.map((item: any) => transformCloudSong(item))
      : [];

    // 追加新数据到现有数据
    songs.value = [...songs.value, ...newSongs];

    // 更新hasMore状态
    hasMore.value = newSongs.length === currentPageSize;
  } catch (error) {
    console.log('获取更多云盘数据失败', error);
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  getUserCloudInfo();
});
</script>

<style lang="scss" scoped>
.info {
  transition: height 0.3s ease-in-out;
}
</style>
