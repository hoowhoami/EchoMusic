<template>
  <div class="home-container">
    <div class="top flex flex-col space-y-4">
      <div class="greeting">
        <div class="title">
          {{ greeting }}
        </div>
        <div>
          <NText
            class="tip"
            :depth="3"
          >
            由此开启好心情 ~
          </NText>
        </div>
      </div>
      <div class="daily-recommend flex flex-col space-y-2">
        <div class="recommend-card flex items-center space-x-2">
          <NCard
            size="small"
            hoverable
            @click="handleRecommendClick"
          >
            <div class="flex items-center space-x-2 cursor-pointer">
              <div
                class="cover border border-gray-300 rounded-lg flex items-center justify-center w-[50px] h-[50px]"
              >
                <div>
                  {{ day }}
                </div>
              </div>
              <div class="info">
                <div class="title">每日推荐</div>
                <div class="desc">
                  <NText :depth="3">根据你的音乐口味生成 * 每日更新</NText>
                </div>
              </div>
            </div>
          </NCard>
          <NCard
            size="small"
            hoverable
            @click="handleRankClick"
          >
            <div class="flex items-center space-x-2 cursor-pointer">
              <div
                class="cover border border-gray-300 rounded-lg flex items-center justify-center w-[50px] h-[50px]"
              >
                <div class="content">TOP</div>
              </div>
              <div class="info">
                <div class="title">排行榜</div>
                <div class="desc">
                  <NText :depth="3">发现你的专属好歌</NText>
                </div>
              </div>
            </div>
          </NCard>
        </div>
      </div>
      <div>
        <NCard
          size="small"
          hoverable
        >
          <template #header>
            <div class="flex justify-between">
              <div>推荐歌单</div>
            </div>
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
            <div
              v-if="loading"
              class="h-[3780px] flex items-center justify-center"
            >
              <NSpin :show="loading" />
            </div>
            <PlaylistCard
              v-else
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
  </div>
</template>

<script setup lang="ts">
import { getPlaylistByCategory } from '@/api';
import PlaylistCard from '@/components/Card/PlaylistCard.vue';
import { useUserStore } from '@/store';
import { Playlist } from '@/types';
import { formatTimestamp, getGreeting } from '@/utils';
import { RefreshRound } from '@vicons/material';
import { NButton, NCard, NText } from 'naive-ui';
import { onMounted, ref } from 'vue';
import { computed } from 'vue';
import { useRouter } from 'vue-router';

defineOptions({
  name: 'Home',
});

const router = useRouter();
const userStore = useUserStore();

const loading = ref(false);
const playlist = ref<Playlist[]>([]);

const greeting = computed(() => {
  if (userStore.nickname) {
    return `Hi, ${userStore.nickname} ${getGreeting()}`;
  }
  return getGreeting();
});

const day = computed(() => {
  return formatTimestamp(new Date().getTime(), 'D');
});

const handleRecommendClick = () => {
  router.push({
    name: 'Recommend',
  });
};

const handleRankClick = () => {
  router.push({
    name: 'Rank',
  });
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

const handleRefresh = async () => {
  await getRecommendPlaylist();
};

const getRecommendPlaylist = async () => {
  try {
    playlist.value = [];
    loading.value = true;
    const res = await getPlaylistByCategory({
      category_id: '0',
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
    console.log('获取推荐歌单失败:', error);
  } finally {
    loading.value = false;
  }
};

onMounted(async () => {
  await getRecommendPlaylist();
});
</script>

<style lang="scss" scoped>
.home-container {
  .top {
    .greeting {
      .title {
        font-size: 1.5rem;
        font-weight: bold;
      }

      .tip {
        font-size: 0.8rem;
      }
    }
  }

  .recommend-card {
    .cover {
      font-size: 20px;
      font-weight: 800;
      .content {
        font-size: 1rem;
      }
    }
    .info {
      .title {
        font-size: 1rem;
        font-weight: bold;
      }

      .desc {
        font-size: 0.8rem;
      }
    }
  }
}
</style>
