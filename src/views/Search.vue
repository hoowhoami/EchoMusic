<template>
  <div class="search-result flex flex-col space-y-2">
    <div class="flex space-x-2">
      <div>
        <NText>搜索关键字</NText>
      </div>
      <NTag
        size="small"
        type="info"
        >{{ keyword }}</NTag
      >
    </div>
    <div>
      <NTabs
        type="segment"
        v-model:value="activeKey"
      >
        <NTabPane
          name="song"
          tab="单曲"
        >
          <PageableScrollLoading
            :height="scrollHeight"
            :loader="searchSong"
          >
            <template #default="{ list }">
              <div class="p-2 flex flex-col space-y-2 mr-2">
                <SongCard
                  show-more
                  :song="song as Song"
                  v-for="song in list"
                  :key="(song as Song).hash"
                />
              </div>
            </template>
          </PageableScrollLoading>
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
import { getSearchResult } from '@/api';
import SongCard from '@/components/Card/SongCard.vue';
import PageableScrollLoading from '@/components/Core/PageableScrollLoading.vue';
import { useSettingStore } from '@/store';
import { Song } from '@/types';
import { NTabPane, NTabs, NTag, NText } from 'naive-ui';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

defineOptions({
  name: 'SearchResult',
});

const settingStore = useSettingStore();

const scrollHeight = computed(() => {
  return settingStore.mainHeight - 120;
});

const route = useRoute();
const keyword = ref('');
const activeKey = ref('song');

const searchSong = async (page: number, pageSize: number): Promise<object[]> => {
  const res = await getSearchResult(keyword.value, 'song', page, pageSize);
  return res?.lists?.map((item: any) => {
    return {
      ...item,
      hahs: item.FileHash,
      name: item.FileName,
      timelen: item.Duration * 1000,
      audio_id: item.Audioid,
      album_id: item.AlbumID,
      albuminfo: {
        id: item.AlbumID,
        name: item.AlbumName,
      },
      singerinfo: item.Singers?.map((singer: any) => {
        return {
          id: singer.id,
          name: singer.name,
        };
      }),
      cover: item.Image,
    };
  });
};

watch(
  () => route.query.keyword,
  newValue => {
    keyword.value = newValue as string;
  },
);

onMounted(async () => {
  keyword.value = route.query.keyword as string;
});
</script>

<style lang="scss" scoped>
.search-result {
  .loading {
    height: 30px;
  }
  .no-more {
    height: 30px;
    font-size: 12px;
  }
}
</style>
