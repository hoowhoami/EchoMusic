<template>
  <NLayout class="layout overflow-hidden select-none">
    <!-- Header -->
    <NLayoutHeader class="header" bordered>
      <Titlebar />
    </NLayoutHeader>
    <NLayout position="absolute" style="top: 50px; bottom: 70px" has-sider>
      <!-- Sidebar -->
      <NLayoutSider :width="280" bordered :native-scrollbar="false" class="sidebar">
        <Sidebar />
      </NLayoutSider>
      <!-- Main Content -->
      <NLayout class="content" :native-scrollbar="false">
        <Main />
      </NLayout>
    </NLayout>
    <!-- Footer -->
    <NLayoutFooter class="footer" position="absolute" bordered>
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
  width: 280px;
  height: calc(100vh - 120px);
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
