<template>
  <NLayout class="layout overflow-hidden select-none">
    <!-- Header -->
    <NLayoutHeader class="header" bordered>
      <Titlebar />
    </NLayoutHeader>
    <NLayout has-sider>
      <!-- Sidebar -->
      <NLayoutSider :width="200" bordered :native-scrollbar="false" class="sidebar">
        <Sidebar />
      </NLayoutSider>
      <!-- Main Content -->
      <NLayoutContent class="content" :native-scrollbar="false">
        <Main />
      </NLayoutContent>
    </NLayout>
    <!-- Footer -->
    <NLayoutFooter class="footer" position="absolute" bordered>
      <Player />
    </NLayoutFooter>
  </NLayout>
</template>

<script setup lang="ts">
import { NLayout, NLayoutContent, NLayoutHeader, NLayoutSider, NLayoutFooter } from 'naive-ui';
import Sidebar from './Sidebar.vue';
import Titlebar from './Titlebar.vue';
import Main from './Main.vue';
import Player from './Player.vue';
</script>

<style scoped>
.layout {
  height: 100vh;
}

.header {
  height: 50px;
  padding: 0;
  box-shadow: 0px 1px 4px rgba(0, 21, 41, 0.08);
}

.sidebar {
  width: 200px;
  padding: 0;
}

.content {
  height: calc(100vh - 120px);
  padding: 0;
}

.footer {
  height: 70px;
  padding: 0;
  box-shadow: 0 -1px 4px rgba(0, 21, 41, 0.08);
}
</style>
