<template>
  <div class="history flex flex-col space-y-4">
    <div class="info">
      <PlayHistoryPanel :count="count" />
    </div>
    <SongListContainer
      type="history"
      virtual-scroll
      :max-height="maxHeight"
      :songs="songs"
      :loading="loading"
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

const maxHeight = computed(() => {
  return settingStore.mainHeight - 290;
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
    console.log(res);
    const list = res?.songs
      ?.filter((item: any) => item.info)
      .map((item: any) => {
        return item.info;
      });
    songs.value = list || [];
    console.log(songs.value);
  } catch (error) {
    console.log(error);
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
