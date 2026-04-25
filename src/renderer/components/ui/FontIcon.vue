<template>
  <svg xmlns="http://www.w3.org/2000/svg" :width="size" :height="size" viewBox="0 0 24 24">
    <path fill="currentColor" d="M2 4v3h5v12h3V7h5V4zm19 5h-9v3h3v7h3v-7h3z" />
  </svg>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 20 });
</script>
