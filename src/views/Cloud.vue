<template>
  <div class="cloud flex flex-col space-y-4">
    <div class="info">
      <CloudPanel :count="count" />
    </div>
    <SongListContainer
      virtual-scroll
      :max-height="maxHeight"
      type="cloud"
      :songs="songs"
    />
  </div>
</template>

<script setup lang="ts">
import { getUserCloud } from '@/api';
import SongListContainer from '@/components/Container/SongListContainer.vue';
import CloudPanel from '@/components/Panel/CloudPanel.vue';
import { useSettingStore } from '@/store';
import { Song } from '@/types';
import { computed, onMounted, ref } from 'vue';

defineOptions({
  name: 'Cloud',
});

const settingStore = useSettingStore();

const maxHeight = computed(() => {
  return settingStore.mainHeight - 290;
});

const count = ref(0);
const songs = ref<Song[]>([]);

const getUserCloudInfo = async () => {
  const res = await getUserCloud();
  count.value = res.list_count || 0;
  console.log(res);
};

onMounted(() => {
  getUserCloudInfo();
});
</script>

<style scoped></style>
