<template>
  <NLayout class="layout overflow-hidden select-none">
    <!-- Header -->
    <NLayoutHeader
      class="header"
      bordered
    >
      <Titlebar />
    </NLayoutHeader>
    <NLayout
      position="absolute"
      style="top: 50px; bottom: 70px"
      has-sider
      :native-scrollbar="false"
    >
      <!-- Sidebar -->
      <NLayoutSider
        :width="280"
        bordered
        class="sidebar"
        content-style="padding: 12px; overflow: hidden;"
        :native-scrollbar="false"
      >
        <Sidebar />
      </NLayoutSider>
      <!-- Main Content -->
      <NLayout
        ref="mainRef"
        class="content"
        :native-scrollbar="false"
        content-style="padding: 12px; overflow: hidden;"
        embedded
      >
        <Main />
      </NLayout>
    </NLayout>
    <!-- Footer -->
    <NLayoutFooter
      class="footer"
      position="absolute"
      bordered
    >
      <Player />
    </NLayoutFooter>
  </NLayout>
</template>

<script setup lang="ts">
import { NLayout, NLayoutHeader, NLayoutSider, NLayoutFooter } from 'naive-ui';
import Sidebar from './Sidebar.vue';
import Titlebar from './Titlebar.vue';
import Main from './Main.vue';
import Player from './Player.vue';
import { ref, watchEffect } from 'vue';
import { useElementSize } from '@vueuse/core';
import { useSettingStore } from '@/store';

const settingStore = useSettingStore();

const mainRef = ref<HTMLElement>();

// 主内容高度
const { height: mainHeight } = useElementSize(mainRef);

watchEffect(() => {
  settingStore.setMainHeight(mainHeight.value);
});
</script>

<style scoped>
.layout {
  height: 100vh;
}

.header {
  height: 50px;
  padding: 0;
}

.sidebar {
  width: 280px;
  height: calc(100vh - 120px);
}

.content {
  height: calc(100vh - 120px);
}

.footer {
  height: 70px;
  padding: 0;
}
</style>
