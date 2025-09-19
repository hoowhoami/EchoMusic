<template>
  <div class="history flex flex-col space-y-4">
    <div class="info">
      <PlayHistoryPanel
        :count="count"
        :size="size"
      />
    </div>
    <SongListContainer
      type="history"
      virtual-scroll
      :max-height="maxHeight"
      :songs="songs"
      :loading="loading"
      v-model:list-scrolling="listScrolling"
    />
  </div>
</template>

<script setup lang="ts">
import { getUserPlayHistory } from '@/api';
import SongListContainer from '@/components/Container/SongListContainer.vue';
import PlayHistoryPanel from '@/components/Panel/PlayHistoryPanel.vue';
import { useSettingStore } from '@/store';
import { Song } from '@/types';
import { computed } from 'vue';
import { ref } from 'vue';
import { onMounted } from 'vue';

defineOptions({
  name: 'History',
});

const settingStore = useSettingStore();

const listScrolling = ref(false);

const size = computed(() => {
  return listScrolling.value ? 'small' : undefined;
});

const maxHeight = computed(() => {
  return settingStore.mainHeight - (size.value === 'small' ? 200 : 290);
});

const loading = ref(false);
const songs = ref<Song[]>([]);

const count = computed(() => {
  return songs.value?.length || 0;
});

const getPlayHistory = async () => {
  try {
    loading.value = true;
    const res = await getUserPlayHistory();
    const list = res?.songs
      ?.filter((item: any) => item.info)
      .map((item: any) => {
        return item.info;
      });
    songs.value = list || [];
  } catch (error) {
    console.log('获取播放历史失败', error);
  } finally {
    loading.value = false;
  }
};

onMounted(async () => {
  console.log('History');
  await getPlayHistory();
});
</script>

<style scoped></style>
