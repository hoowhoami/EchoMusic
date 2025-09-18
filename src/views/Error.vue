<template>
  <div class="error flex items-center justify-center">
    <div>
      <h1 class="text-3xl">Error echo</h1>
      <div class="text-sm">Something went wrong.</div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({
  name: 'Error',
});
</script>

<style scoped>
.error {
  width: 100%;
  height: 100%;
}
</style>
