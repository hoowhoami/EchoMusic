<script setup lang="ts">
/**
 * 歌词页换肤 Drawer（右侧抽屉）
 * 强制深色毛玻璃风格，与歌词页沉浸式环境协调。
 * 皮肤设置统一由「全局设置 → 页面歌词」承接，这里只负责挑选皮肤。
 */
import { computed } from 'vue';
import { useSettingStore } from '@/stores/setting';
import Drawer from '@/components/ui/Drawer.vue';
import Button from '@/components/ui/Button.vue';
import LyricSkinSettingsPanel from './LyricSkinSettingsPanel.vue';
import {
  HOST_SKIN_PREFIX,
  lyricsPages,
  resolveLyricsPage,
  resolveLyricSkinKey,
  retryAndSelectLyricsPage,
} from '@/plugins/lyricsPage';
import type { LyricSkin } from '@/plugins/lyricsPage';
import { iconCheck, iconChevronLeft, iconMusic, iconSettings, iconX } from '@/icons';

type LyricViewMode = 'cover' | 'portrait' | 'lyric' | 'amll';

interface SkinGroup {
  label: string;
  key: string;
  skins: LyricSkin[];
}

interface Props {
  open: boolean;
  view?: 'skins' | 'settings';
}

withDefaults(defineProps<Props>(), {
  view: 'skins',
});
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'update:view', value: 'skins' | 'settings'): void;
  (e: 'open-global-settings'): void;
}>();

const settingStore = useSettingStore();

const allSkins = computed(() =>
  lyricsPages.value.filter(
    (skin) => skin.key.startsWith(HOST_SKIN_PREFIX) || resolveLyricsPage(skin.key),
  ),
);
const isSkinAvailable = (skin: LyricSkin) =>
  skin.key.startsWith(HOST_SKIN_PREFIX) || resolveLyricsPage(skin.key) !== undefined;

const skinGroups = computed<SkinGroup[]>(() => {
  const builtins = allSkins.value.filter((skin) => skin.key.startsWith(HOST_SKIN_PREFIX));
  const plugins = allSkins.value.filter((skin) => !skin.key.startsWith(HOST_SKIN_PREFIX));
  const groups: SkinGroup[] = [{ label: '内置', key: 'builtin', skins: builtins }];
  if (plugins.length > 0) {
    groups.push({ label: '自定义', key: 'custom', skins: plugins });
  }
  return groups;
});

const activeSkinKey = computed(() =>
  resolveLyricSkinKey(settingStore.lyricsPageProvider, settingStore.lyricViewMode),
);

const activeSkin = computed(() => allSkins.value.find((skin) => skin.key === activeSkinKey.value));

const applySkin = (key: string) => {
  if (key.startsWith(HOST_SKIN_PREFIX)) {
    settingStore.lyricViewMode = key.slice(HOST_SKIN_PREFIX.length) as LyricViewMode;
  }
  settingStore.lyricsPageProvider = key;
};

const retryActiveSkin = () => {
  retryAndSelectLyricsPage(activeSkinKey.value, applySkin);
};

/** 皮肤卡交互：单击选中皮肤；已选中皮肤再次点击进入该皮肤的设置面板。 */
const selectSkin = (skin: LyricSkin) => {
  if (!isSkinAvailable(skin)) return;
  if (skin.key === activeSkinKey.value) {
    emit('update:view', 'settings');
    return;
  }
  retryAndSelectLyricsPage(skin.key, applySkin);
};

const backToSkins = () => {
  emit('update:view', 'skins');
};

const close = () => {
  emit('update:open', false);
};

const skinDisplayTitle = (skin: LyricSkin) => skin.title;

const cardStyle = (skin: LyricSkin, index: number) => {
  if (skin.preview) return undefined;
  const palettes = [
    'linear-gradient(135deg, #274060, #141b2c)',
    'linear-gradient(135deg, #3b2e4d, #1a1626)',
    'linear-gradient(135deg, #244a3a, #141f1c)',
    'linear-gradient(135deg, #4d3a1f, #211a10)',
    'linear-gradient(135deg, #3a2345, #171020)',
    'linear-gradient(135deg, #1f3d4d, #101a20)',
  ];
  const hash = [...skin.key].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return { background: palettes[(hash + index) % palettes.length] };
};
</script>

<template>
  <Drawer
    :open="open"
    side="right"
    overlay-class="lyric-settings-overlay"
    panel-class="lyric-settings-panel"
    @update:open="emit('update:open', $event)"
  >
    <div class="settings-drawer">
      <!-- 头部 -->
      <div class="settings-header">
        <div class="settings-title-group">
          <h2 class="settings-title">{{ view === 'settings' ? '皮肤设置' : '换肤' }}</h2>
          <p v-if="view === 'settings'" class="settings-subtitle">
            {{ activeSkin ? skinDisplayTitle(activeSkin) : '当前皮肤' }}
          </p>
        </div>
        <div class="settings-header-actions">
          <Button
            v-if="view === 'settings'"
            variant="unstyled"
            size="none"
            class="settings-header-action"
            tooltip="返回换肤"
            aria-label="返回换肤"
            @click="backToSkins"
          >
            <Icon :icon="iconChevronLeft" width="17" height="17" />
          </Button>
          <Button
            variant="unstyled"
            size="none"
            class="settings-header-action"
            tooltip="全局设置"
            aria-label="全局设置"
            @click="emit('open-global-settings')"
          >
            <Icon :icon="iconSettings" width="17" height="17" />
          </Button>
          <Button variant="unstyled" size="none" class="settings-close-btn" @click="close">
            <Icon :icon="iconX" width="18" height="18" />
          </Button>
        </div>
      </div>

      <!-- 内容 -->
      <div class="settings-body">
        <!-- 换肤：皮肤列表 -->
        <template v-if="view === 'skins'">
          <div class="skin-groups">
            <div v-for="group in skinGroups" :key="group.key" class="skin-group">
              <div class="skin-group-label">{{ group.label }}</div>
              <div class="skin-grid">
                <button
                  v-for="(skin, index) in group.skins"
                  :key="skin.key"
                  type="button"
                  class="skin-card"
                  :class="{
                    active: skin.key === activeSkinKey,
                    unavailable: !isSkinAvailable(skin),
                  }"
                  @click="selectSkin(skin)"
                >
                  <div class="skin-card-preview">
                    <img v-if="skin.preview" :src="skin.preview" alt="" />
                    <!-- 内置皮肤：用 CSS 绘制能体现各自特征的缩略图 -->
                    <div
                      v-else-if="skin.pluginId === 'host'"
                      class="skin-thumb"
                      :class="`skin-thumb--${skin.id}`"
                    >
                      <template v-if="skin.id === 'cover'">
                        <div class="thumb-cover-art"></div>
                        <div class="thumb-cover-lines"><span></span><span></span><span></span></div>
                      </template>
                      <template v-else-if="skin.id === 'portrait'">
                        <div class="thumb-portrait-img"></div>
                        <div class="thumb-portrait-lines"><span></span><span></span></div>
                      </template>
                      <template v-else-if="skin.id === 'lyric'">
                        <div class="thumb-lyric-lines">
                          <span></span>
                          <span class="is-current"></span>
                          <span></span>
                          <span></span>
                        </div>
                      </template>
                      <template v-else-if="skin.id === 'amll'">
                        <div class="thumb-amll-lines">
                          <span></span>
                          <span class="is-current"></span>
                          <span></span>
                        </div>
                      </template>
                    </div>
                    <!-- 插件皮肤：渐变背景 + 音符图标 -->
                    <div v-else class="skin-card-placeholder" :style="cardStyle(skin, index)">
                      <Icon :icon="iconMusic" width="26" height="26" class="skin-card-icon" />
                    </div>
                    <span v-if="skin.key === activeSkinKey" class="skin-card-check">
                      <Icon :icon="iconCheck" width="12" height="12" />
                    </span>
                    <span
                      v-if="skin.key === activeSkinKey"
                      class="skin-card-settings"
                      aria-hidden="true"
                    >
                      <Icon :icon="iconSettings" width="13" height="13" />
                    </span>
                  </div>
                  <div class="skin-card-title">{{ skinDisplayTitle(skin) }}</div>
                  <div v-if="!isSkinAvailable(skin)" class="skin-card-unavailable-label">
                    不可用
                  </div>
                </button>
              </div>
            </div>
          </div>
        </template>

        <!-- 皮肤设置 -->
        <template v-else>
          <div v-if="activeSkin?.settings?.component" class="skin-settings-wrap">
            <LyricSkinSettingsPanel :skin="activeSkin" :key="activeSkin.key" />
          </div>
          <div v-else class="skin-settings-empty">
            当前皮肤没有可用的自定义设置。
            <br />
            可前往「全局设置 → 页面歌词」调整外观选项。
          </div>
        </template>
      </div>
    </div>
  </Drawer>
</template>

<style>
/* Drawer 面板样式：与其他抽屉保持一致的安全区与边距（不遮挡标题栏 / 播放器，不贴边），跟随主题 */
.drawer-panel.lyric-settings-panel {
  top: var(--drawer-safe-top) !important;
  right: 12px !important;
  bottom: var(--drawer-safe-bottom) !important;
  width: min(360px, calc(100vw - 24px)) !important;
  border-radius: 12px !important;
  background: var(--lyric-settings-panel-bg, var(--color-bg-dialog)) !important;
  border-color: var(--lyric-settings-panel-border, var(--border-subtle)) !important;
  box-shadow: var(--shadow-dialog) !important;
  overflow: hidden !important;
}

@media (max-width: 420px) {
  .drawer-panel.lyric-settings-panel {
    --drawer-top-gap: 16px;
    --drawer-bottom-gap: -4px;
    right: 8px !important;
    width: min(360px, calc(100vw - 16px)) !important;
  }
}

.dark .lyric-settings-panel {
  --lyric-settings-panel-bg: color-mix(
    in srgb,
    var(--surface-elevated-base) 96%,
    var(--surface-dialog-base) 4%
  );
  --lyric-settings-panel-border: rgba(255, 255, 255, 0.14);
}

.lyric-settings-overlay {
  background: var(--surface-scrim-bg) !important;
}
</style>

<style scoped>
.settings-drawer {
  --lyric-settings-divider-border: var(--border-subtle);
  --lyric-settings-card-bg: color-mix(in srgb, var(--surface-card-base) 96%, var(--text-main) 4%);
  --lyric-settings-card-border: var(--border-subtle);
  --lyric-settings-card-shadow: none;

  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  color: var(--color-text-main);
  user-select: none;
  -webkit-user-select: none;
}

:global(.dark) .settings-drawer {
  --lyric-settings-divider-border: rgba(255, 255, 255, 0.12);
  --lyric-settings-card-bg: color-mix(
    in srgb,
    var(--surface-elevated-base) 88%,
    var(--color-text-main) 12%
  );
  --lyric-settings-card-border: rgba(255, 255, 255, 0.16);
  --lyric-settings-card-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 8px 20px rgba(0, 0, 0, 0.12);
}

.settings-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 20px 20px 16px;
  border-bottom: 1px solid var(--lyric-settings-divider-border);
  flex-shrink: 0;
  gap: 16px;
}

.settings-title-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.settings-title {
  font-size: 16px;
  font-weight: 800;
  color: var(--color-text-main);
}

.settings-subtitle {
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-secondary);
}

.settings-close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  color: var(--color-text-main);
  opacity: 0.5;
  transition: all 0.2s;
}

.settings-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.settings-header-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  color: var(--color-text-main);
  opacity: 0.55;
  transition: all 0.2s;
}

.settings-header-action:hover {
  opacity: 1;
  background: var(--control-hover-bg);
}

.settings-close-btn:hover {
  opacity: 1;
  background: var(--control-hover-bg);
}

.settings-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  scrollbar-width: none;
}

.settings-body::-webkit-scrollbar {
  display: none;
}

/* 换肤面板 */
.skin-groups {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.skin-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.skin-group-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.skin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 12px;
}

.skin-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px;
  border-radius: 16px;
  background: var(--lyric-settings-card-bg);
  border: 1px solid var(--lyric-settings-card-border);
  box-shadow: var(--lyric-settings-card-shadow);
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: left;
}

.skin-card:hover {
  border-color: color-mix(in srgb, var(--color-primary) 55%, transparent);
  transform: translateY(-1px);
}

.skin-card.active {
  border-color: var(--color-primary);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--color-primary) 70%, transparent),
    0 6px 18px color-mix(in srgb, var(--color-primary) 18%, transparent);
}

.skin-card.unavailable {
  opacity: 0.45;
  cursor: default;
}

.skin-card.unavailable:hover {
  border-color: var(--lyric-settings-card-border);
  transform: none;
}

.skin-card-preview {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 11px;
  overflow: hidden;
  background: #1a1d22;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, white 8%, transparent);
}

.skin-card-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.skin-card-preview::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(180deg, color-mix(in srgb, white 10%, transparent), transparent 32%);
  pointer-events: none;
}

.skin-card-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}

.skin-card-icon {
  color: rgba(255, 255, 255, 0.7);
  filter: drop-shadow(0 1px 8px rgba(0, 0, 0, 0.35));
}

/* ===== 内置皮肤 CSS 缩略图 ===== */
.skin-thumb {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #121418;
}

/* 封面模式：左专辑封面 + 右歌词行 */
.skin-thumb--cover {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  background: linear-gradient(135deg, #1b1f27, #101216);
}
.thumb-cover-art {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border-radius: 7px;
  background: linear-gradient(135deg, #5b8def, #8b5cf6 55%, #ec4899);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}
.thumb-cover-lines {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1;
}
.thumb-cover-lines span {
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.22);
}
.thumb-cover-lines span:nth-child(1) {
  width: 80%;
}
.thumb-cover-lines span:nth-child(2) {
  width: 55%;
  background: rgba(255, 255, 255, 0.4);
}
.thumb-cover-lines span:nth-child(3) {
  width: 65%;
}

/* 写真模式：竖版大图 + 底部歌词 */
.skin-thumb--portrait {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  padding: 8px;
  gap: 6px;
  background: linear-gradient(160deg, #2a2230, #14111a);
}
.thumb-portrait-img {
  width: 30px;
  height: 38px;
  border-radius: 5px;
  background: linear-gradient(160deg, #f472b6, #a78bfa 50%, #60a5fa);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
}
.thumb-portrait-lines {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
}
.thumb-portrait-lines span {
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.28);
}
.thumb-portrait-lines span:nth-child(1) {
  width: 70%;
}
.thumb-portrait-lines span:nth-child(2) {
  width: 45%;
}

/* 歌词模式：居中多行歌词，当前行高亮 */
.skin-thumb--lyric {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: radial-gradient(circle at 50% 40%, #1f2937, #0d1117);
}
.thumb-lyric-lines {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0 10px;
}
.thumb-lyric-lines span {
  height: 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.18);
}
.thumb-lyric-lines span:nth-child(1) {
  width: 50%;
}
.thumb-lyric-lines span.is-current {
  width: 78%;
  height: 6px;
  background: linear-gradient(90deg, #fff, rgba(255, 255, 255, 0.7));
  box-shadow: 0 0 10px rgba(255, 255, 255, 0.35);
}
.thumb-lyric-lines span:nth-child(3) {
  width: 60%;
}
.thumb-lyric-lines span:nth-child(4) {
  width: 40%;
}

/* Apple Music 模式：渐变背景 + 发光大字歌词 */
.skin-thumb--amll {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 45%, #3b82f6 100%);
}
.thumb-amll-lines {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 0 12px;
}
.thumb-amll-lines span {
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.5);
}
.thumb-amll-lines span:nth-child(1) {
  width: 55%;
}
.thumb-amll-lines span.is-current {
  width: 85%;
  height: 7px;
  background: #fff;
  box-shadow: 0 0 14px rgba(255, 255, 255, 0.7);
}
.thumb-amll-lines span:nth-child(3) {
  width: 65%;
}

.skin-card-check {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: white;
  background: var(--color-primary);
  box-shadow:
    0 1px 6px color-mix(in srgb, var(--color-primary) 55%, transparent),
    inset 0 0 0 1px color-mix(in srgb, white 22%, transparent);
  z-index: 1;
  transition: opacity 0.15s ease;
}

/* 已选中皮肤卡片：hover 时显示设置图标，提示再次点击可进入设置 */
.skin-card-settings {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: white;
  background: var(--color-primary);
  box-shadow:
    0 1px 6px color-mix(in srgb, var(--color-primary) 55%, transparent),
    inset 0 0 0 1px color-mix(in srgb, white 22%, transparent);
  z-index: 1;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.skin-card.active:hover .skin-card-check {
  opacity: 0;
}

.skin-card.active:hover .skin-card-settings {
  opacity: 1;
}

.skin-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-main);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.skin-card-unavailable-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  line-height: 1;
}

/* 皮肤设置视图 */
.skin-settings-wrap {
  display: flex;
  flex-direction: column;
  padding: 4px 4px 8px;
}

.skin-settings-empty {
  padding: 24px 16px;
  text-align: center;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}
</style>
