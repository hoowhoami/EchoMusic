<template>
  <div>
    <div>{{ keyword }}</div>
    <div>
      <NTabs
        type="segment"
        v-model:value="activeKey"
      >
        <NTabPane
          name="song"
          tab="单曲"
        >
          单曲
        </NTabPane>
        <NTabPane
          name="playlist"
          tab="歌单"
        >
          歌单
        </NTabPane>
        <NTabPane
          name="album"
          tab="专辑"
        >
          专辑
        </NTabPane>
        <NTabPane
          name="artist"
          tab="歌手"
        >
          歌手
        </NTabPane>
      </NTabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NTabPane, NTabs } from 'naive-ui';
import { onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

defineOptions({
  name: 'SearchResult',
});

const route = useRoute();

const keyword = ref('');

const activeKey = ref('song');

watch(
  () => route.query.keyword,
  newValue => {
    keyword.value = newValue as string;
  },
);

onMounted(() => {
  keyword.value = route.query.keyword as string;
});
</script>

<style scoped></style>
