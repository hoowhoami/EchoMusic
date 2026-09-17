<script setup lang="ts">
import { provide } from 'vue';
import type { PropType } from 'vue';
import { lyricsPageSkinKey } from '@/plugins/lyricsPage';
import type { LyricSkin } from '@/plugins/lyricsPage';
import { useLyricSkin } from './composables/useLyricSkin';

/**
 * 当前皮肤的设置面板容器：为皮肤设置组件提供与页面组件共用的皮肤配置句柄，
 * 以皮肤 key 作为外部 :key 保证切换皮肤时设置组件整体重建。
 */
const props = defineProps({
  skin: { type: Object as PropType<LyricSkin>, required: true },
});

const skinHandle = useLyricSkin(
  props.skin.key,
  (props.skin.settings?.defaults ?? {}) as Record<string, unknown>,
  props.skin.settings?.validate,
);
provide(lyricsPageSkinKey, skinHandle);
</script>

<template>
  <div class="skin-settings-panel">
    <component :is="skin.settings?.component" />
  </div>
</template>
