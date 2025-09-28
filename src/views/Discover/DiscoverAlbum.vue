<template>
  <div class="discover-album">
    <div class="menu">
      <NButton
        :focusable="false"
        icon-placement="right"
        strong
        secondary
        round
        @click="typeChangeShow = true"
      >
        <template #icon>
          <NIcon
            class="more"
            depth="3"
          >
            <KeyboardArrowRightRound />
          </NIcon>
        </template>
        {{ title }}
      </NButton>
      <NModal
        v-model:show="typeChangeShow"
        display-directive="show"
        style="width: 600px"
        preset="card"
        title="专辑类型"
      >
        <div class="tag-list flex flex-wrap items-center justify-stretch gap-4 p-2">
          <NTag
            v-for="type in types"
            :key="type.id"
            :bordered="false"
            class="cursor-pointer"
            :type="type.id === checkedTypeId ? 'primary' : 'default'"
            round
            @click="changeType(type.id)"
          >
            <div class="text-center">
              {{ type.name }}
            </div>
          </NTag>
        </div>
      </NModal>
    </div>
    <div class="mt-4">
      <div class="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4">
        <div
          v-if="loading"
          class="h-[3780px] flex items-center justify-center"
        >
          <NSpin :show="loading" />
        </div>
        <AlbumCard
          v-else
          v-for="album in albums"
          :key="album.albumid"
          class="max-w-[250px] h-[300px]"
          :album="album"
          @click="handleOpenAlbum(album)"
        />
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { Album } from '@/types';
import { getAlbumTop } from '@/api';
import { NButton, NIcon, NModal, NTag } from 'naive-ui';
import { computed, onMounted, ref } from 'vue';
import { KeyboardArrowRightRound } from '@vicons/material';
import AlbumCard from '@/components/Card/AlbumCard.vue';
import { useRouter } from 'vue-router';

defineOptions({
  name: 'DiscoverAlbum',
});

const router = useRouter();

const loading = ref(false);
const types = ref<{ id: string; name: string }[]>([
  {
    id: 'all',
    name: '全部',
  },
  {
    id: 'chn',
    name: '华语',
  },
  {
    id: 'eur',
    name: '欧美',
  },
  {
    id: 'jpn',
    name: '日本',
  },
  {
    id: 'kor',
    name: '韩国',
  },
]);
const checkedTypeId = ref<string | null>(null);

const albums = ref<Album[]>([]);

const typeChangeShow = ref<boolean>(false);

const checkedType = computed(() => {
  return types.value.find(type => type.id === checkedTypeId.value);
});

const title = computed(() => {
  return checkedType.value?.name || '全部';
});

const getAlbums = async () => {
  try {
    loading.value = true;
    albums.value = [];
    const res = await getAlbumTop();
    if (checkedTypeId.value === 'all') {
      for (const type of types.value) {
        if (type.id !== 'all') {
          const ret = res?.[type.id]?.map(transformAlbum);
          if (ret) {
            albums.value = [...albums.value, ...ret];
          }
        }
      }
    } else {
      if (checkedTypeId.value) {
        albums.value = res?.[checkedTypeId.value]?.map(transformAlbum);
      }
    }
  } catch (error) {
    console.log('获取新碟上架列表失败', error);
  } finally {
    loading.value = false;
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const transformAlbum = (item: any): Album => {
  return {
    ...item,
    img: item.imgurl,
    name: item.base?.audio_name,
    publish_time: item.publishtime?.split(' ')?.[0],
    singer: item.singername,
    singers: [
      {
        id: item.singerid,
        name: item.singername,
      },
    ],
  };
};

const changeType = async (typeid: string) => {
  typeChangeShow.value = false;
  checkedTypeId.value = typeid;
  await getAlbums();
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

onMounted(async () => {
  checkedTypeId.value = 'all';
  await getAlbums();
});
</script>

<style lang="scss" scoped></style>
