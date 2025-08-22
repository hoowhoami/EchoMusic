<template>
  <div id="app">
    <ConfigProvider :locale="zhCN">
      <App>
        <router-view />
      </App>
    </ConfigProvider>
  </div>
</template>

<script setup lang="ts">
import { App, ConfigProvider } from 'ant-design-vue';
import zhCN from 'ant-design-vue/es/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
dayjs.locale('zh-cn');
</script>

<style>
#app {
  width: 100%;
  height: 100vh;
}
</style>
