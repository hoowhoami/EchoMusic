<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onDeactivated, ref, useId, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { iconCheckMark, iconImage, iconSlidersHorizontal, iconX } from '@/icons';
import Button from '@/components/ui/Button.vue';
import SelectionBadge from '@/components/ui/SelectionBadge.vue';
import Drawer from '@/components/ui/Drawer.vue';
import Select from '@/components/ui/Select.vue';
import CustomTabBar from '@/components/ui/CustomTabBar.vue';
import Slider from '@/components/ui/Slider.vue';
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
defineOptions({ name: 'theme-center' });
let ownsPreview = false;
const theme = useThemeStore(),
  toast = useToastStore();
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
watch(activeTab, (tab, previous) => {
  if (previous === 2 && tab !== 2 && beforeBackground.value) cancelBackground();
  if (gallery.value) gallery.value.scrollTop = 0;
});
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
const customBackgroundApplied = computed(
  () => theme.effectiveThemeKey === CUSTOM_THEME_KEY && !beforeBackground.value,
);
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
const cancelBackground = () => {
  ++importRevision;
  isImporting.value = false;
  if (beforeBackground.value) theme.restoreThemeDraft(beforeBackground.value);
  beforeBackground.value = null;
  if (ownsPreview) {
    theme.cancelPreview();
    ownsPreview = false;
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
          class="theme-action"
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
    <div class="theme-workbench">
      <div ref="gallery" class="theme-gallery">
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
                class="theme-select-card"
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
        <section
          v-show="activeTab === 2"
          :id="panelIds[2]"
          :aria-labelledby="tabIds[2]"
          role="tabpanel"
          tabindex="0"
          class="theme-custom-panel"
        >
          <input
            ref="imageInput"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            @change="importImage(($event.target as HTMLInputElement).files?.[0])"
          />
          <header v-if="customBackground.image" class="theme-image-heading">
            <h2>背景图片</h2>
            <Button
              :disabled="isImporting"
              variant="secondary"
              size="sm"
              @click="imageInput?.click()"
            >
              <Icon :icon="iconImage" :width="16" />{{ isImporting ? '正在导入…' : '更换图片' }}
            </Button>
          </header>
          <div class="theme-custom-workspace" :class="{ 'has-image': customBackground.image }">
            <div
              class="theme-image-drop"
              :class="{ 'has-image': customBackground.image }"
              @dragover.prevent
              @drop.prevent="importImage($event.dataTransfer?.files[0])"
            >
              <div
                v-if="imagePreview"
                class="theme-custom-image"
                role="img"
                aria-label="自定义背景预览"
                :style="{
                  backgroundImage: `url(${JSON.stringify(imagePreview)})`,
                  backgroundSize: customBackground.fit,
                  backgroundPosition: `${customBackground.positionX}% ${customBackground.positionY}%`,
                }"
              />
              <div
                v-if="imagePreview"
                class="theme-custom-shade"
                :style="{
                  background: theme.isDark ? '#10131a' : '#f7f8fa',
                  opacity: customBackground.shade / 100,
                }"
              />
              <div v-if="!customBackground.image" class="theme-image-actions">
                <Icon :icon="iconImage" :width="32" class="theme-upload-icon" />
                <h2>用喜欢的图片装点音乐</h2>
                <Button
                  :disabled="isImporting"
                  variant="secondary"
                  size="sm"
                  @click="imageInput?.click()"
                >
                  {{ isImporting ? '正在导入…' : '选择本地图片' }}
                </Button>
                <p>或拖入 JPG、PNG、WebP 图片，不超过 20 MB</p>
              </div>
            </div>
            <div v-if="customBackground.image" class="theme-image-controls">
              <h2>图片调整</h2>
              <div class="theme-control-row">
                <label>文字颜色</label>
                <button
                  type="button"
                  class="theme-text-color"
                  aria-label="选择背景文字颜色"
                  @click="showTextColor = true"
                >
                  <i :style="{ background: customBackground.textColor }" />
                  <span>{{ customBackground.textColor.toUpperCase() }}</span>
                </button>
              </div>
              <div class="theme-control-row">
                <label>显示方式</label>
                <Select
                  :model-value="customBackground.fit"
                  :options="[
                    { label: '填充', value: 'cover' },
                    { label: '适应', value: 'contain' },
                  ]"
                  aria-label="背景显示方式"
                  @update:model-value="updateBackground({ fit: $event as 'cover' | 'contain' })"
                />
              </div>
              <div
                v-for="control in [
                  { key: 'positionX', title: '水平位置', max: 100 },
                  { key: 'positionY', title: '垂直位置', max: 100 },
                  { key: 'shade', title: '背景遮罩', max: 85 },
                ] as const"
                :key="control.key"
                class="theme-control-row"
              >
                <label class="theme-range-heading">
                  {{ control.title }}
                  <output>{{ customBackground[control.key] }}%</output>
                </label>
                <Slider
                  :model-value="customBackground[control.key]"
                  :min="0"
                  :max="control.max"
                  :aria-label="control.title"
                  @update:model-value="updateBackground({ [control.key]: $event })"
                />
              </div>
            </div>
          </div>
          <p v-if="backgroundError" role="alert" class="theme-error">{{ backgroundError }}</p>
        </section>
      </div>
    </div>
    <footer
      v-if="
        activeTab === 2 &&
        (beforeBackground || (customBackground.image && !customBackgroundApplied))
      "
      class="theme-custom-footer"
    >
      <Button v-if="beforeBackground" variant="secondary" size="sm" @click="cancelBackground"
        >取消</Button
      >
      <Button
        :disabled="isImporting || !customBackground.image || customBackgroundApplied"
        size="sm"
        @click="acceptBackground"
        >{{ beforeBackground ? '保存背景' : '使用此背景' }}</Button
      >
    </footer>
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
        class="theme-drawer-close"
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
          <Button variant="ghost" size="sm" @click="theme.resetThemeSettings()"
            >重置专属参数</Button
          >
        </div>
      </details>
    </div>
    <footer class="theme-drawer-footer">
      <Button variant="ghost" size="sm" :disabled="resettingAppearance" @click="resetAppearance"
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
  padding: 26px 32px 20px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
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
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.theme-gallery {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  scrollbar-gutter: stable;
  padding: 2px 2px 12px;
  container-type: inline-size;
}
.theme-browse-tabs {
  width: 288px;
  max-width: 100%;
  flex-shrink: 0;
  margin: 0 0 26px;
}
.theme-palette-section {
  margin-bottom: 28px;
}
.theme-palette-heading h2,
.theme-image-heading h2,
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
  border: 0;
  background: transparent;
  padding: 0;
  border-radius: 10px;
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
  border-radius: 10px;
  transition: box-shadow 0.16s;
}
.theme-select-card:hover .theme-card-preview {
  box-shadow: 0 4px 14px color-mix(in srgb, #000 12%, transparent);
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
  margin: 12px 0 4px;
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
  border: 1px solid var(--border-subtle);
  background: var(--control-muted-bg);
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
}
.theme-action:hover {
  background: color-mix(in srgb, var(--text-main) 9%, transparent);
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
  border-radius: 6px;
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
.theme-text-color {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  cursor: pointer;
  width: fit-content;
  font-family: monospace;
  font-size: 12px;
}
.theme-text-color i {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--border-light);
}
.theme-text-color:hover i {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
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
  border-radius: 8px;
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
.theme-custom-workspace {
  display: grid;
  gap: 24px;
  max-width: 1080px;
}
.theme-image-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  max-width: 1080px;
  margin-bottom: 16px;
}
.theme-custom-workspace.has-image {
  grid-template-columns: minmax(0, 1fr) 240px;
  align-items: start;
}
.theme-image-drop {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  border: 1px dashed var(--border-subtle);
  border-radius: 10px;
  min-height: 300px;
  display: grid;
  place-items: center;
  background: var(--control-muted-bg);
}
.theme-image-drop.has-image {
  border-style: solid;
  min-height: 0;
  height: clamp(220px, 34vh, 360px);
}
.theme-custom-image,
.theme-custom-shade {
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-repeat: no-repeat;
}
.theme-image-actions {
  display: grid;
  justify-items: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
}
.theme-image-actions h2 {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 4px;
}
.theme-upload-icon {
  color: var(--text-secondary);
  margin-bottom: 4px;
}
.theme-image-actions p {
  font-size: 12px;
  color: var(--text-secondary);
}
.theme-image-controls {
  min-width: 0;
}
.theme-image-controls h2 {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
}
.theme-custom-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 16px 0 0;
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
@container (max-width: 650px) {
  .theme-custom-workspace.has-image {
    grid-template-columns: 1fr;
  }
}
.theme-control-row {
  display: grid;
  gap: 2px;
  padding: 6px 0 0;
  font-size: 13px;
}
.theme-range-heading {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.theme-range-heading output {
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}
.theme-control-row :deep(.slider-wrapper) {
  width: 100%;
}
.theme-control-row :deep(.echo-select-trigger) {
  width: 100%;
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
  border-radius: 10px;
  box-shadow: var(--shadow-dialog);
  -webkit-user-select: none;
  user-select: none;
}
.theme-adjustments-drawer :is(input:not([type='range']), textarea, [contenteditable='true']) {
  -webkit-user-select: text;
  user-select: text;
}
</style>
