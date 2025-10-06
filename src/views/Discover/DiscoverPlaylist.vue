<template>
  <div class="discover-playlists">
    <div class="menu">
      <NButton
        :focusable="false"
        icon-placement="right"
        strong
        secondary
        round
        @click="tagChangeShow = true"
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
        v-model:show="tagChangeShow"
        display-directive="show"
        style="width: 600px"
        preset="card"
        title="歌单分类"
      >
        <NTabs
          type="segment"
          animated
          v-model:value="checkedTagId as string"
        >
          <NTabPane
            v-for="tag in tags"
            :key="tag.tag_id"
            :name="tag.tag_id"
            :tab="tag.tag_name"
          >
            <div class="tag-list flex flex-wrap items-center justify-stretch gap-4 p-2">
              <NTag
                v-for="sub in tags.find(item => item.tag_id === tag.tag_id)?.son || []"
                :key="sub.tag_id"
                :bordered="false"
                class="cursor-pointer"
                :type="sub.tag_id === checkedSubTagId ? 'primary' : 'default'"
                round
                @click="changeTag(tag.tag_id, sub.tag_id)"
              >
                <div class="text-center">
                  {{ sub.tag_name }}
                </div>
              </NTag>
            </div>
          </NTabPane>
        </NTabs>
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
        <PlaylistCard
          v-else
          class="max-w-[250px] h-[300px]"
          :playlist="item as Playlist"
          v-for="item in playlist"
          :key="item.listid"
          @click="handleOpenPlaylist(item as Playlist)"
        />
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { getPlaylistByCategory, getPlaylistCategory } from '@/api';
import PlaylistCard from '@/components/Card/PlaylistCard.vue';
import type { Playlist, PlaylistTag } from '@/types';
import { KeyboardArrowRightRound } from '@vicons/material';
import { NButton, NIcon, NModal, NTabPane, NTabs, NTag } from 'naive-ui';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

defineOptions({
  name: 'DiscoverPlaylist',
});

const route = useRoute();
const router = useRouter();

const loading = ref(false);
const playlist = ref<Playlist[]>([]);

const tagChangeShow = ref<boolean>(false);

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
  if (!checkedTag.value || !checkdSubTag.value) {
    return '请选择';
  }
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
    playlist.value = [];
    const res = await getPlaylistByCategory({
      category_id: subTagId,
    });

    playlist.value =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    console.error('获取歌单失败: ', error);
  } finally {
    loading.value = false;
  }
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

// 分类切换
const changeTag = async (tag: string, sub: string) => {
  tagChangeShow.value = false;
  //
  await init(tag, sub);
};

const init = async (tag: string, sub: string) => {
  checkedTagId.value = tag || tags.value?.[0]?.tag_id;
  subTags.value = tags.value?.find(item => item.tag_id === checkedTagId.value)?.son || [];
  checkedSubTagId.value = sub || subTags.value?.[0]?.tag_id;
  playlist.value = [];
  // 获取歌单
  await getPlaylist(checkedSubTagId.value as string);
};

onMounted(async () => {
  await getPlaylistTags();
  await init(route.query.tag as string, route.query.sub as string);
});
</script>

<style lang="scss" scoped>
.discover-playlists {
  .menu {
    .n-button {
      height: 40px;
    }
    .n-tabs {
      height: 40px;
      width: 140px;
      --n-tab-border-radius: 25px !important;
      :deep(.n-tabs-rail) {
        outline: 1px solid var(--n-tab-color-segment);
      }
    }
  }
}
.tag-list {
  align-content: flex-start;
  min-height: 140px;
  margin-top: 8px;
  .n-tag {
    font-size: 14px;
    .n-icon {
      font-size: 16px;
      margin-left: 4px;
    }
  }
}
</style>
