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
        @update:value="handleTabChange"
      >
        <NTabPane
          name="song"
          tab="单曲"
        >
          <NInfiniteScroll
            @load="searchSong"
            :style="{ height: `${scrollHeight}px` }"
          >
            <div class="p-2 flex flex-col space-y-2 mr-2">
              <SongCard
                show-more
                :song="song"
                v-for="song in songs"
                :key="song.hash"
              />
            </div>
            <div
              v-if="loading"
              class="flex items-center justify-center loading"
            >
              <NSpin :size="20" />
            </div>
            <div
              v-if="noMore"
              class="flex items-center justify-center no-more"
            >
              <NText depth="3"> 没有更多了 </NText>
            </div>
          </NInfiniteScroll>
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
import { useSettingStore } from '@/store';
import { Song } from '@/types';
import { NInfiniteScroll, NSpin, NTabPane, NTabs, NTag, NText } from 'naive-ui';
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

const page = ref(1);
const pageSize = ref(30);
const loading = ref(false);
const noMore = ref(false);

const songs = ref<Song[]>([]);
const playlists = ref([]);
const albums = ref([]);
const artists = ref([]);

const handleTabChange = (key: string) => {
  if (key === 'song') {
    searchSong();
  }
  if (key === 'playlist') {
    searchPlaylist();
  }
  if (key === 'album') {
    searchAlbum();
  }
  if (key === 'artist') {
    searchArtist();
  }
};

const searchSong = async () => {
  if (loading.value || noMore.value) {
    return;
  }
  try {
    loading.value = true;
    const res = await getSearchResult(keyword.value, 'song', page.value, pageSize.value);
    console.log(res);
    const data = res?.lists;
    if (!data || data.length < pageSize.value) {
      noMore.value = true;
    } else {
      page.value = page.value + 1;
    }
    // 转换数据
    const formattedData: Song[] = data.map((item: any) => {
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
    console.log(formattedData);
    songs.value.push(...formattedData);
  } finally {
    loading.value = false;
  }
};

const searchPlaylist = async () => {
  const res = await getSearchResult(keyword.value, 'special');
  console.log(res);
  playlists.value = res?.lists;
};

const searchAlbum = async () => {
  const res = await getSearchResult(keyword.value, 'album');
  console.log(res);
  albums.value = res?.lists;
};

const searchArtist = async () => {
  const res = await getSearchResult(keyword.value, 'author');
  console.log(res);
  artists.value = res?.lists;
};

watch(
  () => route.query.keyword,
  newValue => {
    keyword.value = newValue as string;
  },
);

onMounted(async () => {
  keyword.value = route.query.keyword as string;
  await searchSong();
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
