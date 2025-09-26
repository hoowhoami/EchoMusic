<template>
  <div class="discover flex flex-col space-y-2">
    <div class="title">发现音乐</div>
    <div>
      <NTabs
        type="segment"
        animated
        v-model:value="discoverType"
        @update:value="handleTabChanged"
      >
        <NTab name="DiscoverPlaylist"> 歌单 </NTab>
        <NTab name="DiscoverRank"> 排行榜 </NTab>
        <NTab name="DiscoverAlbum"> 新碟上架 </NTab>
        <NTab name="DiscoverSong"> 新歌速递 </NTab>
      </NTabs>
      <!-- 路由 -->
      <RouterView v-slot="{ Component }">
        <Transition
          :name="`router-${$route.fullPath}`"
          mode="out-in"
        >
          <component
            :is="Component"
            class="router-view"
          />
        </Transition>
      </RouterView>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NTab, NTabs } from 'naive-ui';
import { ref } from 'vue';
import { useRouter } from 'vue-router';

defineOptions({
  name: 'Discover',
});

const router = useRouter();

// 发现路由
const discoverType = ref<string>();

const handleTabChanged = async (name: string) => {
  await router.push({ name });
};
</script>

<style lang="scss" scoped>
.discover {
  .title {
    font-size: 1.5rem;
    font-weight: bold;
  }
}
</style>
