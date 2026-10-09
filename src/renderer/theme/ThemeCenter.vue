<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  ref,
  useId,
  watch,
} from 'vue';
import { useWindowSize } from '@vueuse/core';
import { Icon } from '@iconify/vue';
import { iconCheckMark, iconSlidersHorizontal, iconX } from '@/icons';
import Button from '@/components/ui/Button.vue';
import SelectionBadge from '@/components/ui/SelectionBadge.vue';
import Drawer from '@/components/ui/Drawer.vue';
import CustomTabBar from '@/components/ui/CustomTabBar.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import ColorPickerDialog from '@/components/ui/ColorPickerDialog.vue';
import { useThemeStore } from '@/stores/theme';
import { useWindowAppearance } from './useWindowAppearance';
import { useToastStore } from '@/stores/toast';
import { ACCENT_PRESETS } from '@/utils/color';
import {
  APP_THEME_TYPES,
  catalogAppThemes,
  appThemeType,
  resolveAppTheme,
  retryAppTheme,
  type AppThemeEntry,
} from './registry';
import {
  copyAppearance,
  defaultOverride,
  normalizeOverride,
  CUSTOM_THEME_KEY,
  type ThemeOverride,
  contrast,
  type ThemeDraft,
} from './model';
import ThemeContent from './ThemeContent.vue';
import ThemeBackgroundControls from './ThemeBackgroundControls.vue';
import ThemeColorControls from './ThemeColorControls.vue';
import ThemeThumbnail from './ThemeThumbnail.vue';
import ThemeImageEditor from './ThemeImageEditor.vue';
defineOptions({ name: 'theme-center' });
let ownsPreview = false;
const theme = useThemeStore(),
  toast = useToastStore();
const { width: windowWidth, height: windowHeight } = useWindowSize();
const showTextColor = ref(false);
const showSkinColor = ref(false),
  isImporting = ref(false);
const showAdjustments = ref(false);
const resettingAppearance = ref(false);
const windowAppearance = useWindowAppearance();
const resetAppearance = async () => {
  resettingAppearance.value = true;
  theme.resetAppearanceAdjustments();
  try {
    await windowAppearance.setFrosted(false);
    if (windowAppearance.error.value) toast.warning(windowAppearance.error.value);
  } catch {
    toast.warning('外观已恢复，窗口效果未能恢复，请重试');
  } finally {
    resettingAppearance.value = false;
  }
};
const adjustmentsTrigger = ref<HTMLButtonElement | null>(null);
const adjustmentsClose = ref<HTMLButtonElement | null>(null);
watch(showAdjustments, async (open) => {
  await nextTick();
  if (open) adjustmentsClose.value?.focus();
  else adjustmentsTrigger.value?.focus();
});
const imageInput = ref<HTMLInputElement | null>(null),
  imagePreview = ref(''),
  backgroundError = ref('');
const beforeBackground = ref<ThemeDraft | null>(null);
const customBackground = computed(
  () =>
    normalizeOverride(theme.activePreferences.overrides[CUSTOM_THEME_KEY] ?? defaultOverride())
      .background,
);
const customBackgroundHasAdjustments = computed(() => {
  const defaults = defaultOverride().background;
  return (
    ['positionX', 'positionY', 'fit', 'zoom', 'crop', 'textColor', 'shade', 'panelOpacity'] as const
  ).some((key) => customBackground.value[key] !== defaults[key]);
});
const colours = [
  '#7da3ce',
  '#6eafb7',
  '#bd97bb',
  '#ce929c',
  '#bcaa81',
  '#87a793',
  '#9293bf',
  '#6b7180',
  ...ACCENT_PRESETS.map((p) => p.color),
];
const solidColours = [
  '#7da3ce',
  '#6eafb7',
  '#87a793',
  '#9293bf',
  '#bd97bb',
  '#ce929c',
  '#bcaa81',
  '#ac9b8e',
  '#6b7180',
  '#5485ad',
  '#487b76',
  '#67765e',
  '#786889',
  '#a56d7f',
  '#ac7862',
  '#998650',
  '#586f82',
  '#536d62',
  '#66617b',
  '#866e76',
  '#806f62',
  '#73715c',
  '#4d5766',
  '#4b5350',
];
const activeTab = ref(
  theme.effectiveThemeKey === CUSTOM_THEME_KEY
    ? 2
    : theme.effectiveThemeKey === 'host:solid'
      ? 1
      : 0,
);
const tabId = useId();
const tabIds = [`${tabId}-themes-tab`, `${tabId}-solid-tab`, `${tabId}-custom-tab`];
const panelIds = [`${tabId}-themes-panel`, `${tabId}-solid-panel`, `${tabId}-custom-panel`];
const gallery = ref<HTMLElement | null>(null);
const themeTypeLabels = { default: '静态', solid: '纯色', dynamic: '动态' };
const shownThemes = computed(() =>
  catalogAppThemes.value.filter((entry) => entry.key !== 'host:solid'),
);
const themeGroups = computed(() =>
  APP_THEME_TYPES.map((type) => ({
    type,
    label: themeTypeLabels[type],
    entries: shownThemes.value.filter((entry) => appThemeType(entry) === type),
  })).filter((group) => group.entries.length > 0),
);
const thumbnailVariant = (entry: AppThemeEntry) =>
  entry.key === theme.effectiveThemeKey
    ? theme.appearance
    : entry.variants[theme.isDark ? 'dark' : 'light'];
const themeDraft = (): ThemeDraft =>
  copyAppearance({
    themeKey: theme.activePreferences.themeKey,
    overrides: theme.activePreferences.overrides,
  });
const selectedColor = computed(() => {
  const palette = theme.activePreferences.overrides['host:solid']?.palette;
  return palette?.source === 'custom' ? palette.color : '#6b9bd1';
});
const solidSelected = (color: string) =>
  theme.desiredThemeKey === 'host:solid' &&
  selectedColor.value.toLowerCase() === color.toLowerCase();
let importRevision = 0;
const cleanImages = () => {
  const ids = [
    ...Object.values(theme.preferences.overrides),
    ...Object.values(theme.activePreferences.overrides),
  ]
    .map((value) => value.background.image)
    .filter((id) => /^[a-f0-9]{64}\.png$/.test(id));
  void window.electron.ipcRenderer.invoke('appearance:clean-images', ids).catch(() => {});
};
const chooseTheme = (key: string) => {
  retryAppTheme(key);
  theme.selectTheme(key);
};
const updateBackground = (patch: Partial<ThemeOverride['background']>) => {
  beginBackground();
  theme.updateOverride({ background: { ...customBackground.value, ...patch } });
};
const resetBackgroundAdjustments = () => {
  updateBackground({
    ...defaultOverride().background,
    source: customBackground.value.source,
    image: customBackground.value.image,
  });
};
const skinColor = (color: string) => {
  chooseTheme('host:solid');
  theme.updateOverride({ palette: { source: 'custom', color } });
};
const beginBackground = () => {
  if (beforeBackground.value) return;
  ownsPreview = !theme.preview;
  if (ownsPreview) theme.beginPreview();
  beforeBackground.value = themeDraft();
  theme.selectTheme(CUSTOM_THEME_KEY);
  backgroundError.value = '';
};
const cancelBackground = (keepCustomPreview = false) => {
  ++importRevision;
  isImporting.value = false;
  const draft = beforeBackground.value;
  if (keepCustomPreview && draft?.overrides[CUSTOM_THEME_KEY]?.background.image) {
    theme.restoreThemeDraft({ ...draft, themeKey: CUSTOM_THEME_KEY });
  } else {
    if (draft) theme.restoreThemeDraft(draft);
    beforeBackground.value = null;
    if (ownsPreview) {
      theme.cancelPreview();
      ownsPreview = false;
    }
  }
  backgroundError.value = '';
  cleanImages();
};
const acceptBackground = () => {
  if (!customBackground.value.image) {
    backgroundError.value = '请先选择图片';
    return;
  }
  beginBackground();
  if (ownsPreview) {
    theme.applyPreview();
    ownsPreview = false;
  }
  beforeBackground.value = null;
  cleanImages();
};
const previewCustomBackground = () => {
  if (
    activeTab.value === 2 &&
    customBackground.value.image &&
    theme.desiredThemeKey !== CUSTOM_THEME_KEY
  )
    beginBackground();
};
watch(
  activeTab,
  (tab, previous) => {
    if (previous === 2 && tab !== 2 && beforeBackground.value) cancelBackground();
    if (gallery.value) gallery.value.scrollTop = 0;
    previewCustomBackground();
  },
  { immediate: true },
);
onActivated(previewCustomBackground);
async function importImage(file?: File) {
  if (!file) return;
  if (imageInput.value) imageInput.value.value = '';
  const current = ++importRevision;
  backgroundError.value = '';
  isImporting.value = true;
  try {
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
      file.size > 20 * 1024 * 1024
    )
      throw new Error('支持 JPG、PNG、WebP，不超过 20 MB');
    beginBackground();
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (current !== importRevision) return;
    const result = await window.electron.ipcRenderer.invoke('appearance:import-image', bytes);
    if (current !== importRevision) {
      cleanImages();
      return;
    }
    theme.setCustomBackground(result.id);
    imagePreview.value = result.url;
    activeTab.value = 2;
  } catch (error) {
    if (current === importRevision)
      backgroundError.value = error instanceof Error ? error.message : '图片导入失败';
  } finally {
    if (current === importRevision) isImporting.value = false;
  }
}
let imagePreviewRevision = 0;
watch(
  () => customBackground.value.image,
  async (id) => {
    const current = ++imagePreviewRevision;
    imagePreview.value = '';
    if (!id) return;
    try {
      const result = /^[a-f0-9]{64}\.png$/.test(id)
        ? await window.electron.ipcRenderer.invoke('appearance:read-image', id)
        : { url: id };
      if (current === imagePreviewRevision) imagePreview.value = result.url;
    } catch {
      if (current === imagePreviewRevision) backgroundError.value = '背景图片不可用，请重新选择';
    }
  },
  { immediate: true },
);
const endPreview = () => {
  showAdjustments.value = false;
  ++importRevision;
  ++imagePreviewRevision;
  if (beforeBackground.value) cancelBackground();
  if (ownsPreview) {
    theme.cancelPreview();
    cleanImages();
    ownsPreview = false;
  }
};
onBeforeUnmount(endPreview);
onDeactivated(endPreview);
watch(
  () => resolveAppTheme(theme.desiredThemeKey),
  (entry) => {
    if (!entry && theme.preview && theme.preview.themeKey !== theme.preferences.themeKey) {
      cancelBackground();
      toast.warning('预览主题已不可用');
    }
  },
);
</script>
<template>
  <section class="theme-center">
    <header class="theme-center-heading">
      <div>
        <h1>个性主题</h1>
        <p class="theme-current-name">
          <i :style="{ background: theme.accentColor }" />
          {{ beforeBackground ? '预览中' : '正在使用' }} · {{ theme.currentTheme.title }}
        </p>
      </div>
      <div class="theme-heading-actions">
        <button
          ref="adjustmentsTrigger"
          class="theme-action soft-secondary-action app-focus-ring-soft"
          :aria-expanded="showAdjustments"
          @click="showAdjustments = true"
        >
          <Icon :icon="iconSlidersHorizontal" :width="16" />外观调整
        </button>
      </div>
    </header>
    <p v-if="theme.desiredThemeKey !== theme.effectiveThemeKey" class="theme-error" role="status">
      所选插件主题暂不可用，已使用 Echo 主题。重新启用插件后恢复。
    </p>
    <CustomTabBar
      v-model="activeTab"
      :tabs="['主题', '纯色', '自定义']"
      :tab-ids="tabIds"
      :panel-ids="panelIds"
      aria-label="主题浏览"
      class="theme-browse-tabs"
    />
    <input
      ref="imageInput"
      type="file"
      accept="image/jpeg,image/png,image/webp"
      hidden
      @change="importImage(($event.target as HTMLInputElement).files?.[0])"
    />
    <div v-show="activeTab !== 2" class="theme-workbench">
      <Scrollbar
        class="theme-gallery-scroll"
        :content-props="{ ref: (element: HTMLElement | null) => (gallery = element) }"
      >
        <div class="theme-gallery">
          <section
            v-show="activeTab === 1"
            :id="panelIds[1]"
            :aria-labelledby="tabIds[1]"
            role="tabpanel"
            tabindex="0"
            class="theme-palette-section"
          >
            <div class="theme-palette-heading">
              <h2>选择颜色</h2>
              <button class="theme-custom-color" @click="showSkinColor = true">
                <i :style="{ background: selectedColor }" />自选颜色
              </button>
            </div>
            <div class="theme-palette-grid">
              <button
                v-for="color in solidColours"
                :key="color"
                class="theme-color-swatch"
                :style="{
                  background: color,
                  color: contrast('#ffffff', color) >= 3 ? '#ffffff' : '#1d1d1f',
                }"
                :aria-label="`皮肤颜色 ${color}`"
                :aria-pressed="solidSelected(color)"
                @click="skinColor(color)"
              >
                <Icon v-if="solidSelected(color)" :icon="iconCheckMark" :width="16" />
              </button>
            </div>
          </section>
          <div
            v-show="activeTab === 0"
            :id="panelIds[0]"
            :aria-labelledby="tabIds[0]"
            role="tabpanel"
            tabindex="0"
          >
            <section v-for="group in themeGroups" :key="group.type" class="theme-type-section">
              <h2 class="theme-catalog-heading">{{ group.label }}</h2>
              <div class="theme-selection-grid">
                <button
                  v-for="entry in group.entries"
                  :key="entry.key"
                  class="theme-select-card card-hover card-hover-border"
                  :aria-pressed="theme.desiredThemeKey === entry.key"
                  @click="chooseTheme(entry.key)"
                >
                  <div class="theme-card-preview">
                    <ThemeThumbnail
                      :appearance="thumbnailVariant(entry)"
                      :image="entry.preview"
                      :dark="theme.isDark"
                    />
                    <SelectionBadge
                      v-if="theme.desiredThemeKey === entry.key"
                      class="theme-selected"
                    />
                  </div>
                  <div class="theme-card-title">
                    <strong>{{ entry.title }}</strong>
                  </div>
                  <p class="theme-card-description">{{ entry.description }}</p>
                </button>
              </div>
            </section>
          </div>
        </div>
      </Scrollbar>
    </div>
    <section
      v-show="activeTab === 2"
      :id="panelIds[2]"
      :aria-labelledby="tabIds[2]"
      role="tabpanel"
      tabindex="0"
      class="theme-custom-panel"
    >
      <ThemeImageEditor
        :image="imagePreview"
        :has-image="!!customBackground.image"
        :background="customBackground"
        :viewport="{ width: windowWidth, height: windowHeight }"
        :shell="theme.appearance.tokens.shell"
        :importing="isImporting"
        :can-reset="customBackgroundHasAdjustments"
        :can-cancel="!!beforeBackground"
        :can-apply="!!beforeBackground || theme.effectiveThemeKey !== CUSTOM_THEME_KEY"
        :error="backgroundError"
        @change="updateBackground"
        @error="backgroundError = $event"
        @choose-image="imageInput?.click()"
        @select-image="importImage($event)"
        @choose-text-color="showTextColor = true"
        @reset="resetBackgroundAdjustments"
        @cancel="cancelBackground(true)"
        @apply="acceptBackground"
      />
    </section>
  </section>
  <Drawer
    v-model:open="showAdjustments"
    title="外观调整"
    panel-class="theme-adjustments-drawer"
    overlay-class="theme-adjustments-overlay"
  >
    <header class="theme-drawer-heading">
      <div>
        <h2>外观调整</h2>
      </div>
      <button
        ref="adjustmentsClose"
        class="action-icon theme-drawer-close"
        aria-label="关闭外观调整"
        @click="showAdjustments = false"
      >
        <Icon :icon="iconX" :width="20" />
      </button>
    </header>
    <div class="theme-editor">
      <ThemeColorControls />
      <ThemeBackgroundControls />
      <details v-if="theme.currentTheme.settings?.component" class="theme-plugin-settings">
        <summary>{{ theme.currentTheme.title }} · 专属设置</summary>
        <div class="theme-plugin-settings-body">
          <ThemeContent
            :key="theme.currentTheme.revision + theme.effectiveThemeKey"
            layer="settings"
          />
          <Button variant="secondary" size="sm" @click="theme.resetThemeSettings()"
            >重置专属参数</Button
          >
        </div>
      </details>
    </div>
    <footer class="theme-drawer-footer">
      <Button variant="secondary" size="sm" :disabled="resettingAppearance" @click="resetAppearance"
        >恢复外观默认</Button
      >
    </footer>
  </Drawer>
  <ColorPickerDialog
    v-model:open="showTextColor"
    title="文字颜色"
    :value="customBackground.textColor"
    :presets="[
      '#ffffff',
      '#000000',
      '#eeeeee',
      '#cccccc',
      '#999999',
      '#555555',
      '#ffe3a3',
      '#ffb8c7',
      '#d2baff',
      '#acd8ff',
      '#a9e3db',
      '#c3e7af',
    ]"
    @confirm="updateBackground({ textColor: $event })"
  />
  <ColorPickerDialog
    :open="showSkinColor"
    title="皮肤颜色"
    :value="selectedColor"
    :presets="colours"
    @update:open="showSkinColor = $event"
    @confirm="skinColor($event)"
  />
</template>
<style scoped>
.theme-center {
  box-sizing: border-box;
  height: 100%;
  padding: 26px 32px 20px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 0;
  overflow: hidden;
  color: var(--text-main);
}
.theme-center-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  margin-bottom: 20px;
  flex-shrink: 0;
}
.theme-center h1 {
  font-size: 28px;
  font-weight: 650;
  letter-spacing: -0.5px;
  margin: 0;
}
.theme-current-name {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--text-secondary);
}
.theme-current-name i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.theme-workbench {
  /* Extend the scroll clip into page padding without shifting the card grid. */
  --theme-gallery-bleed: 14px;
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
  margin-inline: calc(-1 * var(--theme-gallery-bleed));
  overflow: hidden;
}
.theme-gallery-scroll {
  flex: 1 1 0;
  min-height: 0;
  min-width: 0;
}
.theme-gallery {
  /* Leave room for preview shadows and keyboard focus outside the cards. */
  padding: 2px calc(2px + var(--theme-gallery-bleed)) 12px;
  container-type: inline-size;
}
.theme-browse-tabs {
  width: 288px;
  max-width: 100%;
  flex-shrink: 0;
  margin: 0 0 26px;
}
.theme-custom-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 0;
}
.theme-palette-section {
  margin-bottom: 28px;
}
.theme-palette-heading h2,
.theme-catalog-heading {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.theme-catalog-heading {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 14px;
}
.theme-catalog-heading::after {
  content: '';
  height: 1px;
  background: var(--border-subtle);
  flex: 1;
}
.theme-selection-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
  gap: 24px 18px;
  margin-bottom: 32px;
}
.theme-select-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  text-align: left;
  min-width: 0;
  cursor: pointer;
  border: 1px solid transparent;
  background: var(--content-panel-bg);
  padding: 10px;
  border-radius: var(--radius-card);
}
.theme-select-card:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 4px;
}
.theme-card-preview {
  flex: none;
  width: 100%;
  position: relative;
  overflow: hidden;
  margin: 0;
  border-radius: var(--radius-control);
}
.theme-selected {
  position: absolute;
  right: 8px;
  top: 8px;
}

.theme-card-title {
  flex: none;
  min-width: 0;
  line-height: 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 10px 0 4px;
}
.theme-card-title strong {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.theme-card-description {
  /* Reserve two lines even for short or missing descriptions so rows stay aligned. */
  flex: none;
  min-height: 3.2em;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin: 0;
}
.theme-heading-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.theme-action {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 9px 12px;
  border-radius: var(--radius-control);
  font-size: 13px;
  cursor: pointer;
}
.theme-drawer-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px 14px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.theme-drawer-heading h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
.theme-drawer-close {
  padding: 6px;
  border-radius: var(--radius-control);
  cursor: pointer;
}
.theme-drawer-close:hover {
  background: var(--control-muted-bg);
}
.theme-editor {
  padding: 4px 24px 12px;
  min-height: 0;
  overflow: auto;
  flex: 1;
}
.theme-drawer-footer {
  padding: 8px 18px;
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.theme-palette-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}
.theme-custom-color {
  display: flex;
  gap: 7px;
  align-items: center;
  font-size: 11px;
  color: var(--text-main);
  cursor: pointer;
  flex-shrink: 0;
}
.theme-custom-color i {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 1px solid var(--border-subtle);
}
.theme-palette-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 12px;
  max-width: 960px;
}
.theme-color-swatch {
  height: 32px;
  border-radius: var(--radius-control);
  display: grid;
  place-items: center;
  cursor: pointer;
  border: 2px solid transparent;
}
.theme-color-swatch:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -4px;
}
.theme-plugin-settings {
  margin-top: 24px;
  border-top: 1px solid var(--border-subtle);
}
.theme-plugin-settings summary {
  font-size: 13px;
  padding: 18px 0;
  cursor: pointer;
}
.theme-plugin-settings-body {
  display: grid;
  gap: 16px;
}
.theme-error {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 16px;
}
@media (max-width: 700px) {
  .theme-center {
    padding: 20px;
  }
  .theme-center-heading {
    align-items: flex-start;
    flex-wrap: wrap;
    margin-bottom: 22px;
  }
  .theme-heading-actions {
    gap: 6px;
  }
  .theme-palette-grid {
    grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
  }
  .theme-current-name {
    font-size: 11px;
  }
}
</style>
<style>
.drawer-overlay.theme-adjustments-overlay {
  background: transparent;
}
.drawer-right.theme-adjustments-drawer {
  right: 12px;
  width: min(360px, calc(100vw - 24px));
  border-radius: var(--radius-popover);
  box-shadow: var(--shadow-dialog);
  -webkit-user-select: none;
  user-select: none;
}
.theme-adjustments-drawer :is(input:not([type='range']), textarea, [contenteditable='true']) {
  -webkit-user-select: text;
  user-select: text;
}
</style>
