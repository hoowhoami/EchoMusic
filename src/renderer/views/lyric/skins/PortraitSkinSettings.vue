<script setup lang="ts">
import { computed } from 'vue';
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from 'reka-ui';
import Switch from '@/components/ui/Switch.vue';
import { useLyricSkin } from '../composables/useLyricSkin';
import { HOST_SKIN_KEYS, LYRIC_SKIN_PORTRAIT_DEFAULTS } from './config';
import LyricTextStyleSettings from './LyricTextStyleSettings.vue';

const { settings, patch, reset } = useLyricSkin(
  HOST_SKIN_KEYS.portrait,
  LYRIC_SKIN_PORTRAIT_DEFAULTS,
);

const backdropOpacityLabel = computed(() => `${settings.value.backdropOpacity}%`);
const carouselIntervalLabel = computed(() => `${settings.value.carouselInterval}s`);
const autoCollapseDelayLabel = computed(() => `${settings.value.autoCollapseDelay}s`);

const carouselEnabled = computed({
  get: () => Boolean(settings.value.carouselEnabled),
  set: (enabled: boolean) => patch({ carouselEnabled: enabled }),
});

const autoCollapseEnabled = computed({
  get: () => Boolean(settings.value.autoCollapseEnabled),
  set: (enabled: boolean) => patch({ autoCollapseEnabled: enabled }),
});

const portraitFallbackCover = computed({
  get: () => Boolean(settings.value.portraitFallbackCover),
  set: (enabled: boolean) => patch({ portraitFallbackCover: enabled }),
});

const collapseHideControls = computed({
  get: () => Boolean(settings.value.collapseHideControls),
  set: (enabled: boolean) => patch({ collapseHideControls: enabled }),
});
</script>

<template>
  <div class="skin-settings">
    <div class="setting-row setting-row-compact">
      <span class="setting-label">背景透明度</span>
      <span class="setting-value">{{ backdropOpacityLabel }}</span>
    </div>
    <SliderRoot
      :model-value="[settings.backdropOpacity]"
      :min="10"
      :max="100"
      :step="5"
      class="settings-slider-root"
      @update:model-value="(v) => v?.length && patch({ backdropOpacity: Number(v[0]) })"
    >
      <SliderTrack class="settings-slider-track">
        <SliderRange class="settings-slider-range" />
      </SliderTrack>
      <SliderThumb class="settings-slider-thumb" />
    </SliderRoot>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-label">自动轮播</span>
        <span class="setting-hint">多张写真时自动切换</span>
      </div>
      <Switch v-model="carouselEnabled" />
    </div>
    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-label">无写真时展示封面</span>
        <span class="setting-hint">没有写真图片时使用歌曲封面填充背景</span>
      </div>
      <Switch v-model="portraitFallbackCover" />
    </div>

    <template v-if="settings.carouselEnabled">
      <div class="setting-row setting-row-compact">
        <span class="setting-label">轮播间隔</span>
        <span class="setting-value">{{ carouselIntervalLabel }}</span>
      </div>
      <SliderRoot
        :model-value="[settings.carouselInterval]"
        :min="5"
        :max="60"
        :step="5"
        class="settings-slider-root"
        @update:model-value="(v) => v?.length && patch({ carouselInterval: Number(v[0]) })"
      >
        <SliderTrack class="settings-slider-track">
          <SliderRange class="settings-slider-range" />
        </SliderTrack>
        <SliderThumb class="settings-slider-thumb" />
      </SliderRoot>
    </template>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-label">歌词自动收起</span>
        <span class="setting-hint">无操作后收起到底部两行</span>
      </div>
      <Switch v-model="autoCollapseEnabled" />
    </div>
    <template v-if="settings.autoCollapseEnabled">
      <div class="setting-row setting-row-compact">
        <span class="setting-label">收起延迟</span>
        <span class="setting-value">{{ autoCollapseDelayLabel }}</span>
      </div>
      <SliderRoot
        :model-value="[settings.autoCollapseDelay]"
        :min="5"
        :max="60"
        :step="1"
        class="settings-slider-root"
        @update:model-value="(v) => v?.length && patch({ autoCollapseDelay: Number(v[0]) })"
      >
        <SliderTrack class="settings-slider-track">
          <SliderRange class="settings-slider-range" />
        </SliderTrack>
        <SliderThumb class="settings-slider-thumb" />
      </SliderRoot>
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">收起时隐藏控制栏</span>
          <span class="setting-hint">让写真画面更干净</span>
        </div>
        <Switch v-model="collapseHideControls" />
      </div>
    </template>

    <button class="reset-btn" type="button" @click="reset">恢复默认</button>
  </div>

  <div class="skin-settings">
    <div class="setting-row setting-row-compact">
      <div class="setting-text">
        <span class="setting-label">歌词样式</span>
        <span class="setting-hint">写真模式下歌词的字号、字重与颜色</span>
      </div>
    </div>
    <LyricTextStyleSettings :skin-key="HOST_SKIN_KEYS.portrait" />
  </div>
</template>

<style scoped src="./skinSettings.css"></style>
