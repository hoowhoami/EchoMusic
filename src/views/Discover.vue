<template>
  <div class="discover">
    <div>
      <NCard
        size="small"
        hoverable
      >
        <template #header>歌单分类</template>
        <NRadioGroup
          v-model:value="checkedTagId"
          class="w-full"
          @update-value="handleTagChecked"
        >
          <div class="grid grid-cols-[repeat(auto-fit,80px)] gap-3 p-2">
            <NRadio
              v-for="tag in tags"
              :key="tag.tag_id"
              :value="tag.tag_id"
            >
              {{ tag.tag_name }}
            </NRadio>
          </div>
        </NRadioGroup>
        <NDivider />
        <NRadioGroup
          v-model:value="checkedSubTagId"
          class="w-full"
          @update-value="handleSubTagChecked"
        >
          <div class="grid grid-cols-[repeat(auto-fit,100px)] gap-2 p-2">
            <NRadio
              v-for="tag in subTags"
              :key="tag.tag_id"
              :value="tag.tag_id"
            >
              {{ tag.tag_name }}
            </NRadio>
          </div>
        </NRadioGroup>
      </NCard>
    </div>
    <div
      class="mt-4"
      v-if="checkedTag && checkdSubTag"
    >
      <NCard
        size="small"
        hoverable
      >
        <template #header>
          <div>{{ title }}</div>
        </template>
        <template #header-extra>
          <div>
            <NButton
              :focusable="false"
              text
              :loading="loading"
              @click="handleRefresh"
            >
              <template #icon>
                <NIcon>
                  <RefreshRound />
                </NIcon>
              </template>
            </NButton>
          </div>
        </template>
        <div
          class="grid grid-cols-[repeat(auto-fit,220px)] justify-center gap-4 p-2 max-h-[3780px]"
        >
          <PlaylistCard
            class="w-[200px] h-[300px]"
            :playlist="item as Playlist"
            v-for="item in playlist"
            :key="item.listid"
            @click="handleOpenPlaylist(item as Playlist)"
          />
        </div>
      </NCard>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Playlist, PlaylistTag } from '@/types';
import { getPlaylistByCategory, getPlaylistCategory } from '@/api';
import { NButton, NCard, NDivider, NIcon, NRadio, NRadioGroup } from 'naive-ui';
import { computed, nextTick, onMounted, ref } from 'vue';
import PlaylistCard from '@/components/Card/PlaylistCard.vue';
import { useRouter } from 'vue-router';
import { RefreshRound } from '@vicons/material';

defineOptions({
  name: 'Discover',
});

const router = useRouter();

const loading = ref(false);
const playlist = ref<Playlist[]>([]);

const tags = ref<PlaylistTag[]>([]);
const checkedTagId = ref<string | null>(null);
const checkedTag = computed(() => {
  return tags.value.find(tag => tag.tag_id === checkedTagId.value);
});

const subTags = ref<PlaylistTag[]>([]);
const checkedSubTagId = ref<string | null>(null);
const checkdSubTag = computed(() => {
  return subTags.value.find(tag => tag.tag_id === checkedSubTagId.value);
});

const title = computed(() => {
  return checkedTag.value?.tag_name + ' - ' + checkdSubTag.value?.tag_name;
});

const getPlaylistTags = async () => {
  try {
    loading.value = true;
    tags.value = [];
    const res = await getPlaylistCategory();
    tags.value = res;
  } catch (error) {
    console.log('获取歌单分类失败: ', error);
  } finally {
    loading.value = false;
  }
};

const getPlaylist = async (subTagId: string) => {
  try {
    loading.value = true;
    const res = await getPlaylistByCategory({
      category_id: subTagId,
    });
    playlist.value =
      res?.special_list?.map((item: any) => {
        return {
          ...item,
          name: item.specialname,
          pic: item.flexible_cover,
          create_user_pic: item.pic,
          list_create_username: item.nickname,
          publish_date: item.publishtime?.split(' ')?.[0],
          heat: item.collectcount,
        };
      }) || [];
  } catch (error) {
    console.log('获取歌单失败: ', error);
  } finally {
    loading.value = false;
  }
};

const handleTagChecked = (tagId: string) => {
  subTags.value = tags.value.find(tag => tag.tag_id === tagId)?.son || [];
  checkedSubTagId.value = null;
};

const handleSubTagChecked = async (tagId: string) => {
  await getPlaylist(tagId);
};

const handleRefresh = async () => {
  if (!checkedSubTagId.value) {
    return;
  }
  await getPlaylist(checkedSubTagId.value);
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

onMounted(async () => {
  await getPlaylistTags();
  nextTick(async () => {
    checkedTagId.value = tags.value[0]?.tag_id;
    subTags.value = tags.value[0]?.son || [];
    checkedSubTagId.value = subTags.value[0]?.tag_id;
    await getPlaylist(checkedSubTagId.value as string);
  });
});
</script>

<style scoped></style>
