<template>
  <div class="main-content">
    <!-- 路由页面 -->
    <RouterView v-slot="{ Component }">
      <Transition name="router-transition" mode="out-in">
        <KeepAlive v-if="settingStore.keepAlive" :max="20" :exclude="['layout']">
          <component :is="Component" class="router-view" />
        </KeepAlive>
        <component :is="Component" v-else class="router-view" />
      </Transition>
    </RouterView>
    <!-- 回到顶部 -->
    <NBackTop :right="20" :bottom="90" />
  </div>
</template>

<script setup lang="ts">
import { useSettingStore } from '@/store';
import { NBackTop } from 'naive-ui';

const settingStore = useSettingStore();
</script>

<style scoped>
.main-content {
  width: 100%;
}
</style>
