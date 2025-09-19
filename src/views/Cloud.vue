<template>
  <div class="cloud flex flex-col space-y-4">
    <div class="info">
      <CloudPanel
        :size="size"
        :count="count"
        :capacity="capacity"
        :available="available"
      />
    </div>
    <SongListContainer
      virtual-scroll
      :max-height="maxHeight"
      type="cloud"
      :songs="songs"
      :loading="loading"
      v-model:list-scrolling="listScrolling"
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

defineOptions({
  name: 'Cloud',
});

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

const loading = ref(false);
const count = ref(0);
const songs = ref<Song[]>([]);
const capacity = ref(0);
const available = ref(0);

const getUserCloudInfo = async () => {
  try {
    loading.value = true;
    count.value = 0;
    songs.value = [];
    capacity.value = 0;
    available.value = 0;
    const res = await getUserCloud();
    count.value = res.list_count || 0;
    capacity.value = res.max_size || 0;
    available.value = res.availble_size || 0;
    songs.value = isArray(res.list)
      ? res.list?.map((item: any) => {
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
        })
      : [];
    for (let i = 0; i < 10; i++) {
      songs.value.push(...songs.value);
    }
    console.log(res);
  } catch (error) {
    console.log('获取云盘数据失败', error);
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
