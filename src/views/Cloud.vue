<template>
  <div class="cloud flex flex-col space-y-4">
    <div class="info">
      <CloudPanel
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
import { computed, onMounted, ref } from 'vue';

defineOptions({
  name: 'Cloud',
});

const settingStore = useSettingStore();

const maxHeight = computed(() => {
  return settingStore.mainHeight - 290;
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

<style scoped></style>
