<template>
  <div class="flex flex-col space-y-2">
    <AlbumPanel :album="albumInfo" />
  </div>
</template>

<script setup lang="ts">
import { getAlbumDetail } from '@/api';
import AlbumPanel from '@/components/Panel/AlbumPanel.vue';
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';

defineOptions({
  name: 'Album',
});

const route = useRoute();
const albumId = ref();
const albumInfo = ref();

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
      singer: item.singer_name,
    };
  })?.[0];
  console.log(albumInfo.value);
};

onMounted(async () => {
  albumId.value = route.query.id;
  getAlbumInfo();
});
</script>

<style scoped></style>
