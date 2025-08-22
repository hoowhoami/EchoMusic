<template>
  <Layout class="layout overflow-hidden">
    <!-- Sidebar -->
    <LayoutSider v-model:collapsed="collapsed" :trigger="null" collapsible class="sidebar">
      <div class="logo">
        <span v-if="!collapsed">MixMusic</span>
        <span v-else>MM</span>
      </div>
      <Sidebar :collapsed="collapsed" @toggle="toggleCollapse" />
    </LayoutSider>

    <Layout>
      <!-- Header -->
      <LayoutHeader class="header">
        <Titlebar />
      </LayoutHeader>
      <!-- Main Content -->
      <LayoutContent class="content">
        <Main />
      </LayoutContent>
      <!-- Player -->
      <LayoutFooter class="footer">
        <Player />
      </LayoutFooter>
    </Layout>
  </Layout>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Layout, LayoutContent, LayoutHeader, LayoutSider, LayoutFooter } from 'ant-design-vue';
import Sidebar from './Sidebar.vue';
import Titlebar from './Titlebar.vue';
import Main from './Main.vue';
import Player from './Player.vue';

const collapsed = ref(false);

const toggleCollapse = () => {
  collapsed.value = !collapsed.value;
};
</script>

<style scoped>
.layout {
  height: 100vh;
}

.header {
  height: 40px;
  padding: 0;
}

.sidebar {
  width: 200px;
}

.footer {
  height: 60px;
  padding: 0;
  box-shadow: 0 -1px 4px rgba(0, 21, 41, 0.08);
}
</style>
