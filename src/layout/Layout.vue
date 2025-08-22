<template>
  <a-layout class="layout">
    <!-- Sidebar -->
    <a-layout-sider
      v-model:collapsed="collapsed"
      :trigger="null"
      collapsible
      class="sidebar"
    >
      <div class="logo">
        <span v-if="!collapsed">MixMusic</span>
        <span v-else>MM</span>
      </div>
      <Sidebar />
    </a-layout-sider>

    <a-layout>
      <!-- Header -->
      <a-layout-header class="header">
        <HeaderBar
          :collapsed="collapsed"
          @toggle="toggleCollapse"
        />
      </a-layout-header>

      <!-- Main Content -->
      <a-layout-content class="content">
        <Main />
      </a-layout-content>

      <!-- Player -->
      <a-layout-footer class="player">
        <Player />
      </a-layout-footer>
    </a-layout>
  </a-layout>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import Sidebar from './Sidebar.vue';
import HeaderBar from './HeaderBar.vue';
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
  overflow: hidden;
}

.sidebar {
  background: #001529;
}

.logo {
  height: 64px;
  padding: 16px;
  color: white;
  font-size: 18px;
  font-weight: bold;
  display: flex;
  align-items: center;
  justify-content: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.header {
  background: #fff;
  padding: 0;
  height: 64px;
  box-shadow: 0 1px 4px rgba(0, 21, 41, 0.08);
}

.content {
  overflow-y: auto;
  background: #f0f2f5;
}

.player {
  height: 72px;
  background: #fff;
  padding: 0;
  box-shadow: 0 -1px 4px rgba(0, 21, 41, 0.08);
}
</style>