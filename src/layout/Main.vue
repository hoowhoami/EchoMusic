<template>
  <div class="content overflow-y-auto">
    <!-- 路由页面 -->
    <RouterView v-slot="{ Component }">
      <Transition name="router-transition" mode="out-in">
        <KeepAlive v-if="settingStore.keepAlive" :max="20" :exclude="['layout']">
          <component :is="Component" class="router-view" />
        </KeepAlive>
        <component v-else :is="Component" class="router-view" />
      </Transition>
    </RouterView>
  </div>
</template>

<script setup lang="ts">
import { useSettingStore } from '@/store';

const settingStore = useSettingStore();
</script>

<style scoped>
.content {
  padding: 24px;
}
</style>
