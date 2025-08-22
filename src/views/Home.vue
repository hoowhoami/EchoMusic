<template>
  <div class="home">
    <a-layout style="min-height: 100vh">
      <a-layout-header style="background: #fff">
        <div style="display: flex; justify-content: space-between; align-items: center">
          <h1 style="margin: 0">
            MixMusic
          </h1>
          <a-space>
            <span>Theme: {{ appStore.theme }}</span>
            <a-button @click="appStore.toggleTheme">
              {{ appStore.theme === 'light' ? '🌙' : '☀️' }}
            </a-button>
          </a-space>
        </div>
      </a-layout-header>
      <a-layout-content style="padding: 24px">
        <a-card title="Welcome to MixMusic">
          <p>A cross-platform desktop music player built with Vue 3 + Electron</p>
          <p>Volume: {{ appStore.volume }}%</p>
          <a-slider
            v-model:value="appStore.volume"
            :min="0"
            :max="100"
            style="width: 200px"
            @change="appStore.setVolume"
          />
          <div style="margin-top: 16px">
            <a-button
              :type="appStore.isPlaying ? 'default' : 'primary'"
              @click="appStore.togglePlay"
            >
              {{ appStore.isPlaying ? '⏸️ Pause' : '▶️ Play' }}
            </a-button>
          </div>
          <div style="margin-top: 16px">
            <a-button
              type="primary"
              @click="handleClick"
            >
              Get Started
            </a-button>
          </div>
        </a-card>
      </a-layout-content>
    </a-layout>
  </div>
</template>

<script setup lang="ts">
import { useAppStore } from '../store';

const appStore = useAppStore();

const handleClick = () => {
  console.log('Button clicked!');
  console.log('Current state:', {
    theme: appStore.theme,
    volume: appStore.volume,
    isPlaying: appStore.isPlaying,
  });
};
</script>

<style scoped>
.home {
  width: 100%;
  height: 100%;
}
</style>
