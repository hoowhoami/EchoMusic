<template>
  <div class="home-container">
    <div class="top flex flex-col space-y-2">
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
          >
            <div class="flex items-center space-x-2">
              <div
                class="cover border border-gray-300 rounded-lg flex items-center justify-center w-[50px] h-[50px]"
              >
                <div>
                  {{ 27 }}
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
          >
            <div class="flex items-center space-x-2">
              <div
                class="cover border border-gray-300 rounded-lg flex items-center justify-center w-[50px] h-[50px]"
              >
                <div>TOP</div>
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { getEverydayRecommend } from '@/api';
import { getGreeting } from '@/utils';
import { NCard, NText } from 'naive-ui';
import { computed, onMounted } from 'vue';

defineOptions({
  name: 'Home',
});

const greeting = computed(() => {
  return getGreeting();
});

const getDailyRecommend = async () => {
  const res = await getEverydayRecommend();
  console.log(res);
};

onMounted(async () => {
  await getDailyRecommend();
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
