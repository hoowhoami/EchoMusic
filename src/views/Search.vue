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
                  @play="handlePlaySong(song as Song)"
                />
              </div>
            </template>
          </PageableScrollLoading>
        </NTabPane>
        <NTabPane
          name="playlist"
          tab="歌单"
        >
          <PageableScrollLoading
            :height="scrollHeight"
            :loader="searchPlaylist"
          >
            <template #default="{ list }">
              <div class="p-2 flex flex-wrap space-x-2 space-y-2 mr-2">
                <PlaylistCard
                  class="w-[200px]"
                  :playlist="item as Playlist"
                  v-for="item in list"
                  :key="item.listid"
                />
              </div>
            </template>
          </PageableScrollLoading>
        </NTabPane>
        <NTabPane
          name="album"
          tab="专辑"
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
          name="artist"
          tab="歌手"
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
      </NTabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { getSearchResult } from '@/api';
import PlaylistCard from '@/components/Card/PlaylistCard.vue';
import SongCard from '@/components/Card/SongCard.vue';
import PageableScrollLoading from '@/components/Core/PageableScrollLoading.vue';
import { useSettingStore } from '@/store';
import { Playlist, Song } from '@/types';
import { NTabPane, NTabs, NTag, NText } from 'naive-ui';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import player from '@/utils/player';

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

const handlePlaySong = (song: Song) => {
  console.log(song);
  player.playSong(song);
};

const searchSong = async (
  page: number,
  pageSize: number,
): Promise<{ list: any[]; total: number }> => {
  const res = await getSearchResult(keyword.value, 'song', page, pageSize);
  const list = res?.lists?.map((item: any) => {
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
  return {
    list,
    total: res?.total,
  };
};

const searchPlaylist = async (
  page: number,
  pageSize: number,
): Promise<{ list: any[]; total: number }> => {
  const res = await getSearchResult(keyword.value, 'special', page, pageSize);
  console.log(res);
  const list = res?.lists?.map((item: any) => {
    return {
      ...item,
      global_collection_id: item.gid,
      name: item.specialname,
      list_create_userid: item.suid,
      listid: item.specialid,
      count: item.song_count,
      list_create_username: item.nickname,
      pic: item.img,
      intro: item.intro,
      publish_date: item.publish_time?.split(' ')[0],
    };
  });
  return {
    list,
    total: res?.total,
  };
};

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
