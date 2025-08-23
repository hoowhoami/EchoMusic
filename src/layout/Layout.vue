<template>
  <NLayout class="layout overflow-hidden select-none">
    <!-- Header -->
    <NLayoutHeader class="header">
      <Titlebar />
    </NLayoutHeader>
    <NLayout has-sider>
      <!-- Sidebar -->
      <NLayoutSider
        v-model:collapsed="collapsed"
        :native-scrollbar="false"
        collapsible
        class="sidebar"
      >
        <div class="logo">
          <span v-if="!collapsed">MixMusic</span>
          <span v-else>MM</span>
        </div>
        <Sidebar :collapsed="collapsed" @toggle="toggleCollapse" />
      </NLayoutSider>
      <!-- Main Content -->
      <NLayoutContent class="content" :native-scrollbar="false">
        <Main />
      </NLayoutContent>
    </NLayout>
    <!-- Footer -->
    <NLayoutFooter class="footer">
      <Player />
    </NLayoutFooter>
  </NLayout>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { NLayout, NLayoutContent, NLayoutHeader, NLayoutSider, NLayoutFooter } from 'naive-ui';
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
  height: 60px;
  padding: 0;
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
  height: 60px;
  padding: 0;
  box-shadow: 0 -1px 4px rgba(0, 21, 41, 0.08);
}
</style>
