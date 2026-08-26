<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { iconCheckMark, iconCloudDownload, iconHeadphones, iconLoader2, iconMusic } from '@/icons';
import type { CommunityAudioEffect } from '@/api/audioEffect';
import type { AudioEffectPlazaState } from '@/composables/useAudioEffectPlaza';

const props = defineProps<{ effect: CommunityAudioEffect; plaza: AudioEffectPlazaState }>();
// 原平台的歌手自动匹配说明不适用于手动应用，避免在悬浮提示中承诺错误的生效范围。
const description = computed(() =>
  props.effect.artistName
    ? `${props.effect.intro.split(/生效范围[：:]/)[0].trim() || props.effect.name}\n手动应用于播放，不会按歌曲歌手自动切换。`
    : props.effect.intro || props.effect.name,
);
const imageFailed = ref(false);
watch(
  () => props.effect.iconUrl,
  () => {
    imageFailed.value = false;
  },
);
const userCount = (count: number) =>
  count >= 10_000
    ? `${(count / 10_000).toFixed(count >= 100_000 ? 0 : 1)} 万人使用`
    : `${count} 人使用`;
</script>

<template>
  <article
    class="online-effect"
    :class="{ 'is-active': plaza.isActive(effect) }"
    :title="description"
  >
    <span class="effect-art" :class="{ 'is-artist': effect.artistName }" aria-hidden="true">
      <Icon :icon="effect.brandName ? iconHeadphones : iconMusic" width="20" />
      <img
        v-if="effect.iconUrl && !imageFailed"
        :src="effect.iconUrl"
        alt=""
        loading="lazy"
        @error="imageFailed = true"
      />
    </span>
    <div class="effect-copy">
      <strong>{{ effect.name }}</strong>
      <span
        >{{ effect.artistName || effect.brandName || effect.author || '音效创作者' }} ·
        {{ plaza.typeLabel(effect) }}</span
      >
      <small v-if="plaza.unavailableReason(effect)" class="effect-requirement">{{
        plaza.unavailableReason(effect)
      }}</small>
      <small v-else-if="effect.userCount">{{ userCount(effect.userCount) }}</small>
    </div>
    <button
      type="button"
      class="effect-action"
      :class="{ 'is-active': plaza.isActive(effect) }"
      :disabled="
        !!plaza.unavailableReason(effect) || plaza.isActive(effect) || plaza.downloadingId !== null
      "
      :title="plaza.unavailableReason(effect) || undefined"
      :aria-label="`${plaza.downloadedEffect(effect) ? '使用' : '下载'}${effect.name}`"
      @click="plaza.actOnEffect(effect)"
    >
      <Icon
        v-if="plaza.downloadingId === effect.id"
        :icon="iconLoader2"
        width="13"
        class="effect-spin"
      />
      <Icon v-else-if="plaza.isActive(effect)" :icon="iconCheckMark" width="13" />
      <Icon
        v-else-if="!plaza.downloadedEffect(effect) && !plaza.unavailableReason(effect)"
        :icon="iconCloudDownload"
        width="13"
      />
      {{
        plaza.downloadingId === effect.id
          ? '下载中'
          : plaza.isActive(effect)
            ? '使用中'
            : plaza.unavailableReason(effect)
              ? '不可用'
              : plaza.downloadedEffect(effect)
                ? '使用'
                : '下载'
      }}
    </button>
  </article>
</template>

<style scoped>
.online-effect {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--control-border);
  border-radius: 10px;
  background: var(--control-muted-bg);
}
.online-effect:hover,
.online-effect.is-active {
  border-color: color-mix(in srgb, var(--color-primary) 50%, transparent);
  background: color-mix(in srgb, var(--color-primary) 6%, var(--color-bg-elevated));
}
.effect-art {
  position: relative;
  display: flex;
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 8px;
  background: var(--color-bg-elevated);
  color: var(--color-primary);
}
.effect-art.is-artist {
  border-radius: 50%;
}
.effect-art img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.effect-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  gap: 3px;
}
.effect-copy strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-main);
  font-size: 12px;
  font-weight: 650;
}
.effect-copy span,
.effect-copy small {
  color: var(--color-text-secondary);
  font-size: 10px;
  line-height: 1.4;
}
.effect-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.effect-copy .effect-requirement {
  font-size: 9px;
}
.effect-action {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 58px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--control-border);
  border-radius: 7px;
  background: var(--color-bg-elevated);
  color: var(--color-primary);
  font-size: 10px;
  font-weight: 650;
  cursor: pointer;
}
.effect-action:hover:not(:disabled),
.effect-action.is-active {
  border-color: var(--color-primary);
  background: var(--color-primary);
  color: white;
}
.effect-action:disabled:not(.is-active) {
  color: var(--color-text-secondary);
  opacity: 0.65;
  cursor: default;
}
.effect-action:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.effect-spin {
  animation: effect-spin 0.8s linear infinite;
}
@keyframes effect-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
