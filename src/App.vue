<template>
  <n-config-provider :locale="zhCN" :date-locale="dateZhCN" :theme="naiveTheme">
    <n-global-style />
    <router-view />
  </n-config-provider>
</template>

<script setup lang="ts">
import { NConfigProvider, NGlobalStyle } from 'naive-ui';
import { zhCN, dateZhCN } from 'naive-ui';
import { useTheme } from '@/hooks';

const { naiveTheme } = useTheme();
</script>

<style>
#app {
  width: 100%;
  height: 100vh;
}
</style>
