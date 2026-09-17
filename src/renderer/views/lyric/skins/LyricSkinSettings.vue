<script setup lang="ts">
import LyricTextStyleSettings from './LyricTextStyleSettings.vue';
import { HOST_SKIN_KEYS } from './config';
</script>

<template>
  <LyricTextStyleSettings :skin-key="HOST_SKIN_KEYS.lyric" />
</template>

<style scoped src="./skinSettings.css"></style>
