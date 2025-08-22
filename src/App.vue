<template>
  <div id="app">
    <a-config-provider>
      <router-view />
    </a-config-provider>
  </div>
</template>

<script setup lang="ts"></script>

<style>
#app {
  width: 100%;
  height: 100vh;
}
</style>
