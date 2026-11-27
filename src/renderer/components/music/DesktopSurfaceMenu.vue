<script setup lang="ts">
import ContextMenuPanel from '@/components/music/ContextMenuPanel.vue';
import { useOverlayToggles } from '@/composables/useOverlayToggles';

/**
 * 播放条 / 歌词页那个桌面层按钮弹出的两项菜单。
 * 亮着的那项用主题色标出来；点已开的那项就是关掉，点另一项就切过去。
 */
const toggles = useOverlayToggles();
</script>

<template>
  <ContextMenuPanel
    :open="toggles.desktopSurfaceMenu.open"
    :x="toggles.desktopSurfaceMenu.x"
    :y="toggles.desktopSurfaceMenu.y"
    :fallback-width="168"
    @close="toggles.closeDesktopSurfaceMenu()"
  >
    <button
      v-for="item in toggles.desktopSurfaceItems.value"
      :key="item.key"
      type="button"
      class="song-context-item desktop-surface-item"
      :class="{ 'is-current': item.enabled }"
      role="menuitemradio"
      :aria-checked="item.enabled"
      @click="void toggles.setDesktopSurface(item.key)"
    >
      <span class="desktop-surface-dot" aria-hidden="true"></span>
      <span class="desktop-surface-label">{{ item.label }}</span>
    </button>
  </ContextMenuPanel>
</template>

<style scoped>
.desktop-surface-item {
  gap: 8px;
}

/* 当前开着的那项：圆点与文字都用主题色，另一项保持灰点。 */
.desktop-surface-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--surface-outline);
  transition: background-color var(--motion-duration-fast) var(--motion-ease-standard);
}

.desktop-surface-item.is-current {
  color: var(--color-primary-text);
}

.desktop-surface-item.is-current .desktop-surface-dot {
  background: var(--color-primary-text);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary-text) 24%, transparent);
}

.desktop-surface-label {
  flex: 1;
  min-width: 0;
}
</style>
