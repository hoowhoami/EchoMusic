<script setup lang="ts">
import { computed } from 'vue';
import type { ThemeOverride } from './model';
import { customBackgroundImageStyle } from './imageStyle';

const props = defineProps<{ image: string; background: ThemeOverride['background'] }>();
const style = computed(() => customBackgroundImageStyle(props.image, props.background));
const crop = computed(() => props.background.crop);
</script>

<template>
  <div class="theme-image-frame">
    <svg
      v-if="crop"
      class="theme-image-cropped"
      :viewBox="`${crop.x} ${crop.y} ${crop.width} ${crop.height}`"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <image :href="image" :width="crop.sourceWidth" :height="crop.sourceHeight" />
    </svg>
    <div v-else class="theme-image-artwork" :style="style" />
  </div>
</template>

<style scoped>
.theme-image-frame {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.theme-image-artwork {
  position: absolute;
  background-repeat: no-repeat;
}
.theme-image-cropped {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
</style>
