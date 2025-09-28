<template>
  <div class="discover flex flex-col space-y-2">
    <div class="title">发现音乐</div>
    <div>
      <NTabs
        type="segment"
        animated
        v-model:value="discoverType"
      >
        <NTabPane
          name="DiscoverPlaylist"
          tab="歌单"
        >
          <DiscoverPlaylist />
        </NTabPane>
        <NTabPane
          name="DiscoverRank"
          tab="排行榜"
        >
          <DiscoverRank />
        </NTabPane>
        <NTabPane
          name="DiscoverAlbum"
          tab="新碟上架"
        >
          <DiscoverAlbum />
        </NTabPane>
        <NTabPane
          name="DiscoverSong"
          tab="新歌速递"
        >
          <DiscoverSong />
        </NTabPane>
      </NTabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NTabPane, NTabs } from 'naive-ui';
import { ref } from 'vue';
import DiscoverPlaylist from './DiscoverPlaylist.vue';
import DiscoverRank from './DiscoverRank.vue';
import DiscoverAlbum from './DiscoverAlbum.vue';
import DiscoverSong from './DiscoverSong.vue';

defineOptions({
  name: 'DiscoverLayout',
});

// 发现路由
const discoverType = ref<string>('DiscoverPlaylist');
</script>

<style lang="scss" scoped>
.discover {
  .title {
    font-size: 1.5rem;
    font-weight: bold;
  }
}
</style>
