<template>
  <div class="titlebar drag">
    <NFlex class="content" align="center" justify="space-between">
      <div class="no-drag nav">
        <NFlex align="center">
          <NButton ghost text :focusable="false" @click="router.go(-1)">
            <template #icon>
              <NIcon :size="25">
                <ArrowBackCircleOutline />
              </NIcon>
            </template>
          </NButton>
          <NButton ghost text :focusable="false" @click="router.go(1)">
            <template #icon>
              <NIcon :size="25">
                <ArrowForwardCircleOutline />
              </NIcon>
            </template>
          </NButton>
          <NButton ghost text :focusable="false">
            <template #icon>
              <NIcon :size="25">
                <RefreshCircleOutline />
              </NIcon>
            </template>
          </NButton>
          <div class="no-drag flex justify-center">
            <NPopselect trigger="click">
              <NInput
                v-model:value="searchText"
                placeholder="搜索音乐、专辑、歌手、歌词"
                style="width: 300px"
                size="small"
              >
                <template #prefix>
                  <NIcon :size="20">
                    <Search />
                  </NIcon>
                </template>
              </NInput>
            </NPopselect>
          </div>
        </NFlex>
      </div>
      <div class="no-drag flex justify-center">
        <NAvatar round :size="25"> whoami </NAvatar>
      </div>
    </NFlex>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { NAvatar, NButton, NFlex, NIcon, NInput, NPopselect } from 'naive-ui';
import {
  ArrowBackCircleOutline,
  ArrowForwardCircleOutline,
  RefreshCircleOutline,
  Search,
} from '@vicons/ionicons5';
import { useRouter } from 'vue-router';

const searchText = ref('');

const router = useRouter();
</script>

<style scoped>
.titlebar {
  height: 50px;
}

.content {
  padding: 0 10px;
  height: 50px;
}

.drag {
  app-region: drag;
  -webkit-app-region: drag;
}

.no-drag {
  app-region: no-drag;
  -webkit-app-region: no-drag;
}

.nav {
  margin-left: 200px;
}
</style>
