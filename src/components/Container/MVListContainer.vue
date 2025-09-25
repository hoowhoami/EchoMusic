<template>
  <div class="mv-list-container">
    <MVList
      v-if="list?.length"
      :list="list"
    />
    <NEmpty v-else />
  </div>
</template>

<script lang="ts" setup>
import type { MV, Song } from '@/types';
import { getSongMV } from '@/api';
import { onMounted, ref } from 'vue';
import MVList from '../List/MVList.vue';
import { NEmpty } from 'naive-ui';

defineOptions({
  name: 'MVListContainer',
});

const props = defineProps<{
  song: Song;
}>();

const loading = ref(false);
const list = ref<MV[]>([]);

const getSongMVList = async (song: Song) => {
  list.value = [];
  if (!song || (!song.album_audio_id && !song.mixsongid)) {
    return;
  }
  try {
    loading.value = true;
    const res = await getSongMV(song.album_audio_id || song.mixsongid);
    list.value = res?.[0] || [];
    console.log(list.value);
  } catch (error) {
    console.log('获取歌曲MV失败', error);
  } finally {
    loading.value = false;
  }
};

onMounted(async () => {
  await getSongMVList(props.song);
});
</script>
<style lang="scss" scoped></style>
