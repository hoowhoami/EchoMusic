<template>
  <PlaylistDetail :playlist-id="currentPlaylistId" />
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PlaylistDetail from '@/components/PlaylistDetail.vue';

defineOptions({
  name: 'Playlist',
});

const route = useRoute();
const currentPlaylistId = ref('');

// 监听路由参数变化
watch(
  () => route.query.id,
  newId => {
    currentPlaylistId.value = (newId as string) || '';
  },
  { immediate: true },
);
</script>

<style scoped></style>
