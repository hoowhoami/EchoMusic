<script setup lang="ts">
import Button from '@/components/ui/Button.vue';
import SkinSettingSection from './SkinSettingSection.vue';
import SkinSettingSlider from './SkinSettingSlider.vue';
import { computed } from 'vue';
import Switch from '@/components/ui/Switch.vue';
import { useLyricSkin } from '../composables/useLyricSkin';
import { HOST_SKIN_KEYS, LYRIC_SKIN_PORTRAIT_DEFAULTS } from './config';
import LyricTextStyleSettings from './LyricTextStyleSettings.vue';

const { settings, patch, reset } = useLyricSkin(
  HOST_SKIN_KEYS.portrait,
  LYRIC_SKIN_PORTRAIT_DEFAULTS,
);

const hasCustomSettings = computed(() =>
  Object.entries(LYRIC_SKIN_PORTRAIT_DEFAULTS).some(
    ([key, value]) => settings.value[key] !== value,
  ),
);

const backdropOpacityLabel = computed(() => `${settings.value.backdropOpacity}%`);
const carouselIntervalLabel = computed(() => `${settings.value.carouselInterval} 秒`);
const autoCollapseDelayLabel = computed(() => `${settings.value.autoCollapseDelay} 秒`);

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
    <SkinSettingSection title="写真背景">
      <SkinSettingSlider
        label="背景透明度"
        :model-value="settings.backdropOpacity"
        :value-label="backdropOpacityLabel"
        :min="10"
        :max="100"
        :step="5"
        @update:model-value="(value) => patch({ backdropOpacity: value })"
      />
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">自动轮播</span
          ><span class="setting-hint">有多张写真时自动切换</span>
        </div>
        <Switch v-model="carouselEnabled" aria-label="自动轮播" />
      </div>
      <SkinSettingSlider
        v-if="settings.carouselEnabled"
        label="轮播间隔"
        :model-value="settings.carouselInterval"
        :value-label="carouselIntervalLabel"
        :min="5"
        :max="60"
        :step="5"
        @update:model-value="(value) => patch({ carouselInterval: value })"
      />
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">无写真时展示封面</span
          ><span class="setting-hint">使用歌曲封面填充背景</span>
        </div>
        <Switch v-model="portraitFallbackCover" aria-label="无写真时展示封面" />
      </div>
    </SkinSettingSection>
    <SkinSettingSection title="自动收起">
      <div class="setting-row">
        <div class="setting-text">
          <span class="setting-label">歌词自动收起</span
          ><span class="setting-hint">无操作后保留底部两行歌词</span>
        </div>
        <Switch v-model="autoCollapseEnabled" aria-label="歌词自动收起" />
      </div>
      <SkinSettingSlider
        v-if="settings.autoCollapseEnabled"
        label="收起延迟"
        :model-value="settings.autoCollapseDelay"
        :value-label="autoCollapseDelayLabel"
        :min="5"
        :max="60"
        :step="1"
        @update:model-value="(value) => patch({ autoCollapseDelay: value })"
      />
      <div v-if="settings.autoCollapseEnabled" class="setting-row">
        <div class="setting-text">
          <span class="setting-label">收起时隐藏控制栏</span
          ><span class="setting-hint">保留更完整的写真画面</span>
        </div>
        <Switch v-model="collapseHideControls" aria-label="收起时隐藏控制栏" />
      </div>
    </SkinSettingSection>
    <LyricTextStyleSettings :skin-key="HOST_SKIN_KEYS.portrait" />
    <div class="skin-settings-footer">
      <Button variant="secondary" size="xs" :disabled="!hasCustomSettings" @click="reset"
        >恢复全部默认</Button
      >
    </div>
  </div>
</template>

<style scoped src="./skinSettings.css"></style>
