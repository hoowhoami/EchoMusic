<template>
  <n-config-provider :locale="zhCN" :date-locale="dateZhCN" :theme="naiveTheme">
    <n-global-style />
    <router-view />
    <GlobalLoading ref="globalLoadingRef" />
  </n-config-provider>
</template>

<script setup lang="ts">
import { NConfigProvider, NGlobalStyle } from 'naive-ui';
import { zhCN, dateZhCN } from 'naive-ui';
import { useTheme } from '@/hooks';
import { ref, onMounted } from 'vue';
import GlobalLoading from '@/components/GlobalLoading.vue';

const { naiveTheme } = useTheme();
const globalLoadingRef = ref();

onMounted(() => {
  // 将全局加载器注册到全局属性中，方便在路由守卫中访问
  if (globalLoadingRef.value) {
    window.$globalLoading = globalLoadingRef.value;
  }
});
</script>

<style>
#app {
  width: 100%;
  height: 100vh;
}
</style>
