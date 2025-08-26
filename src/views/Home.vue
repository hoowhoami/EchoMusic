<template>
  <div class="home-container">
    <div>Home</div>
    <h1 v-for="value in 999" :key="value">{{ value }}</h1>
  </div>
</template>

<script setup lang="ts">
defineOptions({
  name: 'Home',
});
</script>

<style scoped></style>
