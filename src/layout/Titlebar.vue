<template>
  <div class="titlebar drag">
    <NFlex class="content" align="center">
      <div class="no-drag nav">前进/后退/刷新</div>
      <div class="no-drag">
        <NInput
          v-model:value="searchText"
          placeholder="搜索音乐、歌手、歌词、用户"
          style="width: 300px"
        >
          <template #prefix>
            <search-outlined />
          </template>
        </NInput>
      </div>
      <div class="no-drag">xxx</div>
    </NFlex>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { NFlex, NInput } from 'naive-ui';

const searchText = ref('');
</script>

<style scoped>
.titlebar {
  height: 50px;
}

.content {
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
