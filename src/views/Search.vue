<template>
  <div class="search-result flex flex-col space-y-2">
    <div class="flex space-x-2">
      <div>
        <NText>搜索关键字</NText>
      </div>
      <NTag
        size="small"
        type="info"
      >
        {{ keyword }}
      </NTag>
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
          <ScrollableLoad
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
          </ScrollableLoad>
        </NTabPane>
        <NTabPane
          name="playlist"
          tab="歌单"
        >
          <ScrollableLoad
            :height="scrollHeight"
            :loader="searchPlaylist"
          >
            <template #default="{ list }">
              <div class="grid grid-cols-[repeat(auto-fit,220px)] justify-center gap-4 p-2">
                <PlaylistCard
                  class="w-[200px] h-[300px]"
                  :playlist="item as Playlist"
                  v-for="item in list"
                  :key="item.listid"
                  @click="handleOpenPlaylist(item as Playlist)"
                />
              </div>
            </template>
          </ScrollableLoad>
        </NTabPane>
        <NTabPane
          name="album"
          tab="专辑"
        >
          <ScrollableLoad
            :no-more-on-error="true"
            :height="scrollHeight"
            :loader="searchAlbum"
          >
            <template #default="{ list }">
              <div class="grid grid-cols-[repeat(auto-fit,220px)] justify-center gap-4 p-2">
                <AlbumCard
                  class="w-[200px] h-[310px]"
                  :album="album as Album"
                  v-for="album in list"
                  :key="(album as Album).albumid"
                  @click="handleOpenAlbum(album as Album)"
                />
              </div>
            </template>
          </ScrollableLoad>
        </NTabPane>
        <NTabPane
          name="artist"
          tab="歌手"
        >
          <ScrollableLoad
            :height="scrollHeight"
            :loader="searchSinger"
          >
            <template #default="{ list }">
              <div class="grid grid-cols-[repeat(auto-fit,220px)] justify-center gap-4 p-2">
                <SingerCard
                  class="w-[200px] h-[300px]"
                  :singer="singer as Singer"
                  v-for="singer in list"
                  :key="(singer as Singer).singerid"
                  @click="handleOpenSinger(singer as Singer)"
                />
              </div>
            </template>
          </ScrollableLoad>
        </NTabPane>
      </NTabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Album, Playlist, Singer, Song } from '@/types';
import { getSearchResult } from '@/api';
import PlaylistCard from '@/components/Card/PlaylistCard.vue';
import SongCard from '@/components/Card/SongCard.vue';
import ScrollableLoad from '@/components/Core/ScrollableLoad.vue';
import { useSettingStore } from '@/store';
import { NTabPane, NTabs, NTag, NText } from 'naive-ui';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import player from '@/utils/player';
import AlbumCard from '@/components/Card/AlbumCard.vue';
import SingerCard from '@/components/Card/SingerCard.vue';

defineOptions({
  name: 'SearchResult',
});

const settingStore = useSettingStore();

const scrollHeight = computed(() => {
  return settingStore.mainHeight - 120;
});

const route = useRoute();
const router = useRouter();
const keyword = ref('');
const activeKey = ref('song');

const handlePlaySong = (song: Song) => {
  player.addNextSong(song, true);
};

const handleOpenPlaylist = async (playlist: Playlist) => {
  await router.push({
    name: 'Playlist',
    query: {
      id: playlist.global_collection_id,
      t: new Date().getTime(),
    },
  });
};

const handleOpenAlbum = async (album: Album) => {
  await router.push({
    name: 'Album',
    query: {
      id: album.albumid,
      count: album.songcount,
      t: new Date().getTime(),
    },
  });
};

const handleOpenSinger = async (singer: Singer) => {
  await router.push({
    name: 'Singer',
    query: {
      id: singer.singerid,
      t: new Date().getTime(),
    },
  });
};

const searchSong = async (
  page: number,
  pageSize: number,
): Promise<{ list: any[]; total: number }> => {
  const res = await getSearchResult(keyword.value, 'song', page, pageSize);
  const list = res?.lists?.map((item: any) => {
    const relate_goods = [];
    if (item.HQ) {
      relate_goods.push({
        hash: item.HQ.hash,
        quality: '320',
      });
    }
    if (item.SQ) {
      relate_goods.push({
        hash: item.SQ.hash,
        quality: 'flac',
      });
    }
    return {
      ...item,
      hash: item.FileHash,
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
      privilege: item.HQ?.Privilege,
      relate_goods: relate_goods,
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

const searchAlbum = async (
  page: number,
  pageSize: number,
): Promise<{ list: any[]; total: number }> => {
  const res = await getSearchResult(keyword.value, 'album', page, pageSize);
  const list = res?.lists?.map((item: any) => {
    return {
      ...item,
    };
  });
  return {
    list,
    total: res?.total,
  };
};

const searchSinger = async (
  page: number,
  pageSize: number,
): Promise<{ list: any[]; total: number }> => {
  const res = await getSearchResult(keyword.value, 'author', page, pageSize);
  const list = res?.lists?.map((item: any) => {
    return {
      ...item,
      singerid: item.AuthorId,
      singername: item.AuthorName,
      imgurl: item.Avatar,
      heat: item.Heat,
      albumcount: item.AlbumCount,
      mvcount: item.VideoCount,
      fanscount: item.FansNum,
      songcount: item.AudioCount,
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
