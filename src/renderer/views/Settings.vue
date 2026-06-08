<script setup lang="ts">
defineOptions({ name: 'settings-page' });
import { computed, ref, onMounted, onUnmounted, nextTick } from 'vue';
import type { Component } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { useDesktopLyricStore } from '@/desktopLyric/store';
import type { UpdateCheckResult } from '../../shared/app';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import DisclaimerDialog from '@/components/app/DisclaimerDialog.vue';
import UpdateDialog from '@/components/app/UpdateDialog.vue';
import { iconArrowUp } from '@/icons';
import { marked } from 'marked';
import AppearanceSettingsSection from './settings/components/AppearanceSettingsSection.vue';
import FontSettingsSection from './settings/components/FontSettingsSection.vue';
import PlaybackSettingsSection from './settings/components/PlaybackSettingsSection.vue';
import QualitySettingsSection from './settings/components/QualitySettingsSection.vue';
import PageLyricSettingsSection from './settings/components/PageLyricSettingsSection.vue';
import DesktopLyricSettingsSection from './settings/components/DesktopLyricSettingsSection.vue';
import ShortcutSettingsSection from './settings/components/ShortcutSettingsSection.vue';
import AudioDeviceSettingsSection from './settings/components/AudioDeviceSettingsSection.vue';
import ExperimentalSettingsSection from './settings/components/ExperimentalSettingsSection.vue';
import PluginSettingsSection from './settings/components/PluginSettingsSection.vue';
import DataSettingsSection from './settings/components/DataSettingsSection.vue';
import AboutSettingsSection from './settings/components/AboutSettingsSection.vue';

const settingStore = useSettingStore();
const desktopLyricStore = useDesktopLyricStore();
const showDisclaimer = ref(false);

const contentRef = ref<HTMLElement | null>(null);
const scrollbarRef = ref<InstanceType<typeof Scrollbar> | null>(null);
const anchorListRef = ref<HTMLElement | null>(null);
const anchorRefs = new Map<string, HTMLElement>();

const setAnchorRef = (id: string, el: HTMLElement | null) => {
  if (el) {
    anchorRefs.set(id, el);
  } else {
    anchorRefs.delete(id);
  }
};

// 确保激活的锚点按钮在可视区域内
const scrollAnchorIntoView = (id: string) => {
  const anchorEl = anchorRefs.get(id);
  if (!anchorEl || !anchorListRef.value) return;
  anchorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
};

// 滑动指示条样式
const indicatorReady = ref(false);
const indicatorStyle = computed(() => {
  // 依赖 indicatorReady 确保 mounted 后重新计算
  if (!indicatorReady.value) return { opacity: '0' };
  const anchorEl = anchorRefs.get(activeSection.value);
  if (!anchorEl || !anchorListRef.value) {
    return { opacity: '0' };
  }
  const left = anchorEl.offsetLeft;
  const width = anchorEl.offsetWidth;
  return {
    transform: `translateX(${left}px)`,
    width: `${width}px`,
    opacity: '1',
  };
});

// 当前激活的锚点
const activeSection = ref('appearance');

// 标记：是否由用户点击锚点触发的滚动（期间忽略滚动监听）
let isClickScrolling = false;
let clickScrollTimer: any = null;

const getSectionOffsetTop = (sectionEl: HTMLElement, wrapEl: HTMLElement): number => {
  const sectionRect = sectionEl.getBoundingClientRect();
  const wrapRect = wrapEl.getBoundingClientRect();
  return sectionRect.top - wrapRect.top + wrapEl.scrollTop;
};

// 点击锚点时：滚动到对应 section
const scrollToSection = (id: string) => {
  if (isClickScrolling && activeSection.value === id) return;
  activeSection.value = id;
  scrollAnchorIntoView(id);

  isClickScrolling = true;
  if (clickScrollTimer) clearTimeout(clickScrollTimer);

  nextTick(() => {
    const sectionElement = findSectionElement(id);
    if (sectionElement && scrollbarRef.value?.wrapRef) {
      const wrap = scrollbarRef.value.wrapRef;
      const scrollTop = getSectionOffsetTop(sectionElement, wrap) - 12;
      wrap.scrollTo({
        top: scrollTop,
        behavior: 'instant',
      });

      clickScrollTimer = setTimeout(() => {
        isClickScrolling = false;
      }, 50);
    } else {
      isClickScrolling = false;
    }
  });
};

// 初始化
const initSettings = async () => {
  settingStore.syncCloseBehavior();
  settingStore.syncTheme();
  settingStore.syncLogSettings();
  void settingStore.hydrateAppInfo();
  void desktopLyricStore.hydrate();
};

onMounted(() => {
  initSettings();
  window.electron?.ipcRenderer?.on('update-check-result', handleUpdateCheckResult);
  nextTick(() => {
    indicatorReady.value = true;
  });
});

const showConfirmClear = ref(false);
const showUpdateResult = ref(false);
const showChangelog = ref(false);
const changelogHtml = ref('');
const isCheckingUpdate = ref(false);
const updateResult = ref<UpdateCheckResult | null>(null);
const handleCheckUpdates = () => {
  isCheckingUpdate.value = true;
  settingStore.checkForUpdates();
};

const handleShowChangelog = async () => {
  try {
    const raw = await window.electron.appInfo.getChangelog();
    if (!raw) {
      changelogHtml.value = '<p>暂无更新日志</p>';
    } else {
      changelogHtml.value = marked.parse(raw, { async: false }) as string;
    }
  } catch {
    changelogHtml.value = '<p>无法读取更新日志</p>';
  }
  showChangelog.value = true;
};

interface SettingsRenderSection {
  id: string;
  label: string;
  order: number;
  icon?: null;
  component: Component;
  props?: Record<string, unknown>;
  before?: string;
  after?: string;
  visible?: boolean | (() => boolean);
}

const builtinSettingsSections = computed<SettingsRenderSection[]>(() => [
  {
    id: 'appearance',
    label: '外观与界面',
    order: 100,
    component: AppearanceSettingsSection,
  },
  {
    id: 'font',
    label: '字体设置',
    order: 200,
    component: FontSettingsSection,
  },
  {
    id: 'playback',
    label: '播放体验',
    order: 300,
    component: PlaybackSettingsSection,
  },
  {
    id: 'quality',
    label: '播放音质',
    order: 400,
    component: QualitySettingsSection,
  },
  {
    id: 'pageLyric',
    label: '页面歌词',
    order: 500,
    component: PageLyricSettingsSection,
  },
  {
    id: 'desktopLyric',
    label: '桌面歌词',
    order: 600,
    component: DesktopLyricSettingsSection,
  },
  {
    id: 'shortcuts',
    label: '快捷键',
    order: 700,
    component: ShortcutSettingsSection,
  },
  {
    id: 'audioDevice',
    label: '音频设备',
    order: 800,
    component: AudioDeviceSettingsSection,
  },
  {
    id: 'experimental',
    label: '实验性功能',
    order: 1150,
    component: ExperimentalSettingsSection,
  },
  {
    id: 'plugins',
    label: '插件',
    order: 1000,
    component: PluginSettingsSection,
  },
  {
    id: 'data',
    label: '数据与安全',
    order: 1100,
    component: DataSettingsSection,
    props: {
      onClear: () => {
        showConfirmClear.value = true;
      },
    },
  },
  {
    id: 'about',
    label: '关于',
    order: 1200,
    component: AboutSettingsSection,
    props: {
      isCheckingUpdate: isCheckingUpdate.value,
      onCheckUpdates: handleCheckUpdates,
      onShowChangelog: handleShowChangelog,
      onShowDisclaimer: () => {
        showDisclaimer.value = true;
      },
    },
  },
]);

const resolveFlag = (value?: boolean | (() => boolean), fallback = true) => {
  if (typeof value === 'function') {
    try {
      return Boolean(value());
    } catch {
      return fallback;
    }
  }
  return value ?? fallback;
};

const matchesSectionAnchor = (section: SettingsRenderSection, anchor: string) => {
  return section.id === anchor;
};

const sortSettingsSections = (sections: SettingsRenderSection[]) => {
  const sorted = sections
    .slice()
    .sort(
      (left, right) =>
        left.order - right.order || left.label.localeCompare(right.label, 'zh-Hans-CN'),
    );

  const moveAroundAnchor = (
    item: SettingsRenderSection,
    anchor: string,
    placement: 'before' | 'after',
  ) => {
    const from = sorted.findIndex((candidate) => candidate.id === item.id);
    const to = sorted.findIndex((candidate) => matchesSectionAnchor(candidate, anchor));
    if (from < 0 || to < 0 || from === to) return;
    const [moving] = sorted.splice(from, 1);
    const nextTo = sorted.findIndex((candidate) => matchesSectionAnchor(candidate, anchor));
    if (nextTo < 0) {
      sorted.splice(from, 0, moving);
      return;
    }
    sorted.splice(placement === 'before' ? nextTo : nextTo + 1, 0, moving);
  };

  for (const section of sorted.slice()) {
    if (section.before) moveAroundAnchor(section, section.before, 'before');
    if (section.after) moveAroundAnchor(section, section.after, 'after');
  }

  return sorted;
};

const settingsSections = computed(() => {
  return sortSettingsSections([...builtinSettingsSections.value]).filter((section) =>
    resolveFlag(section.visible),
  );
});

const navItems = computed(() =>
  settingsSections.value.map((section) => ({
    id: section.id,
    label: section.label,
  })),
);

const handleUpdateCheckResult = (payload: unknown) => {
  if (
    payload &&
    typeof payload === 'object' &&
    Reflect.get(payload, 'silent') === true &&
    !isCheckingUpdate.value
  ) {
    return;
  }

  isCheckingUpdate.value = false;
  if (!payload || typeof payload !== 'object') {
    updateResult.value = {
      status: 'error',
      currentVersion: settingStore.appVersion || '未知',
      message: '返回的更新信息无效。',
    };
  } else {
    updateResult.value = payload as typeof updateResult.value;
  }
  showUpdateResult.value = true;
};

onUnmounted(() => {
  window.electron?.ipcRenderer?.off('update-check-result', handleUpdateCheckResult);
});

// 返回顶部
const scrollToTop = () => {
  scrollbarRef.value?.setScrollTop(0);
};

// 当前滚动位置
const currentScrollTop = ref(0);

// 是否显示返回顶部按钮
const showBackToTop = ref(false);

// 监听滚动，更新当前激活的锚点
const handleScroll = () => {
  if (!scrollbarRef.value?.wrapRef || isClickScrolling) return;
  const wrap = scrollbarRef.value.wrapRef;
  currentScrollTop.value = wrap.scrollTop;

  // 控制返回顶部按钮显示
  showBackToTop.value = currentScrollTop.value > 300;

  for (let i = navItems.value.length - 1; i >= 0; i--) {
    const section = findSectionElement(navItems.value[i].id);
    if (section && getSectionOffsetTop(section, wrap) <= currentScrollTop.value + 40) {
      if (activeSection.value !== navItems.value[i].id) {
        activeSection.value = navItems.value[i].id;
        scrollAnchorIntoView(navItems.value[i].id);
      }
      break;
    }
  }
};

const findSectionElement = (id: string) => {
  return (
    Array.from(contentRef.value?.querySelectorAll<HTMLElement>('[data-section]') ?? []).find(
      (section) => section.dataset.section === id,
    ) ?? null
  );
};
</script>

<template>
  <div class="settings-page h-full flex flex-col min-h-0">
    <!-- 页面头部 -->
    <header class="settings-header shrink-0 px-6 pt-4 pb-1">
      <div class="flex items-center justify-between">
        <h1 class="text-lg font-bold text-text-main">偏好设置</h1>
      </div>
    </header>

    <!-- 顶部锚点导航 -->
    <div class="settings-anchor-bar shrink-0 px-6 py-1.5 sticky top-0 z-10">
      <div ref="anchorListRef" class="settings-anchor-list flex items-center gap-0 overflow-x-auto">
        <button
          v-for="item in navItems"
          :key="item.id"
          type="button"
          :ref="(el) => setAnchorRef(item.id, el as HTMLElement | null)"
          class="settings-anchor-item"
          :class="{ 'is-active': activeSection === item.id }"
          @click="scrollToSection(item.id)"
        >
          <span class="settings-anchor-label">{{ item.label }}</span>
        </button>
        <!-- 滑动指示条 -->
        <div class="settings-anchor-indicator" :style="indicatorStyle"></div>
      </div>
    </div>

    <!-- 内容区域 -->
    <Scrollbar
      ref="scrollbarRef"
      class="flex-1 min-h-0 settings-content-scroll"
      :content-props="{ class: 'settings-content-inner' }"
      @scroll="handleScroll"
    >
      <div ref="contentRef" class="settings-content">
        <template v-for="section in settingsSections" :key="section.id">
          <component :is="section.component" v-bind="section.props ?? {}" />
        </template>

        <!-- 返回顶部按钮 -->
        <button
          class="settings-back-to-top"
          :class="{ visible: showBackToTop }"
          @click="scrollToTop"
        >
          <Icon :icon="iconArrowUp" width="18" height="18" />
        </button>
      </div>
    </Scrollbar>

    <!-- 弹窗组件 -->
    <Dialog
      v-model:open="showConfirmClear"
      title="清除应用数据"
      description="此操作将移除所有持久化设置与缓存，无法撤销。"
    >
      <template #footer>
        <Button
          class="settings-button"
          variant="outline"
          size="sm"
          @click="showConfirmClear = false"
          >取消</Button
        >
        <Button
          class="settings-button danger"
          variant="danger"
          size="sm"
          @click="
            settingStore.clearAppData();
            showConfirmClear = false;
          "
          >确认清除</Button
        >
      </template>
    </Dialog>

    <UpdateDialog v-model:open="showUpdateResult" :result="updateResult" />

    <Dialog
      v-model:open="showChangelog"
      :title="`更新日志`"
      showClose
      noScroll
      :content-style="{ width: '520px' }"
    >
      <Scrollbar class="settings-update-changelog" :content-props="{ class: 'px-4 py-3' }">
        <div class="changelog-content" v-html="changelogHtml"></div>
      </Scrollbar>
      <template #footer>
        <Button variant="ghost" size="sm" @click="showChangelog = false">关闭</Button>
      </template>
    </Dialog>

    <DisclaimerDialog v-model:open="showDisclaimer" />
  </div>
</template>

<style scoped>
@reference "@/style.css";

.settings-page {
  background: transparent;
}

.settings-header {
  @apply flex items-center;
}

.settings-anchor-bar {
  @apply flex items-center;
  border-bottom: 1px solid var(--border-subtle);
}

.settings-anchor-list {
  @apply flex-1 flex items-center gap-0 overflow-x-auto relative;
  scrollbar-width: none;
}

.settings-anchor-list::-webkit-scrollbar {
  display: none;
}

.settings-anchor-item {
  @apply relative flex items-center px-2.5 py-1.5 text-[13px] font-medium text-text-secondary transition-colors duration-200 cursor-pointer shrink-0 rounded-md;
}

.settings-anchor-item:hover {
  @apply text-text-main;
  background: var(--row-hover-bg);
}

.settings-anchor-item.is-active {
  @apply text-primary font-semibold;
}

.settings-anchor-indicator {
  @apply absolute bottom-0 left-0 h-[2px] rounded-full bg-primary;
  transition:
    transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
    width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
}

.settings-anchor-label {
  @apply whitespace-nowrap;
}

.settings-content-scroll {
  @apply flex-1 min-h-0;
}

:deep(.settings-content-inner) {
  padding: 24px 32px;
}

.settings-content {
  @apply space-y-7;
}

.settings-section {
  @apply min-h-[60px];
}

.settings-card {
  @apply rounded-2xl p-5 space-y-5 transition-all duration-300 border overflow-visible;
  background: var(--color-bg-elevated);
  border-color: var(--border-subtle);
  font-size: 13px;
  box-shadow: 0 2px 12px color-mix(in srgb, var(--color-text-main) 3%, transparent);
}

.settings-card h3 {
  font-size: 13px;
}

.settings-card p {
  font-size: 12px;
}

.settings-item {
  @apply flex items-center justify-between gap-6 py-1;
}

.settings-divider {
  @apply h-px shrink-0;
  background: color-mix(in srgb, var(--color-text-main) 12%, transparent);
}

.settings-button {
  @apply text-sm font-semibold;
}

.settings-button.danger {
  @apply text-red-500 hover:text-red-400 transition-colors;
}

.settings-color-swatch {
  @apply w-8 h-8 rounded-full border-2 border-white/20 shadow-sm cursor-pointer transition-all duration-200 active:scale-95;
}

.settings-color-stack {
  @apply flex flex-col gap-2 w-full max-w-[360px] pt-1;
}

.settings-color-grid {
  @apply grid grid-cols-2 gap-3 w-full max-w-[360px];
}

.settings-color-item {
  @apply flex items-center justify-between gap-3 rounded-xl border px-3 py-2;
  background: var(--control-muted-bg);
  border-color: var(--control-border);
}

.settings-color-actions {
  @apply flex items-center justify-end min-h-5 px-1;
}

.settings-color-reset {
  @apply text-[11px] font-semibold text-text-secondary hover:text-text-main transition-colors whitespace-nowrap;
}

.settings-color-swatch:hover {
  transform: scale(1.08);
}

.accent-preset-swatch {
  @apply w-8 h-8 rounded-full border-2 border-transparent cursor-pointer transition-all duration-200;
}

.accent-preset-swatch:hover {
  @apply scale-110;
}

.accent-preset-swatch.is-active {
  @apply scale-110 ring-2 ring-primary/50;
}

.shortcut-grid-header {
  @apply grid grid-cols-[1fr_140px_140px_40px] gap-4 px-1 py-2 text-[12px] font-semibold text-text-secondary;
}

.shortcut-col-title {
  @apply text-center;
}

.shortcut-list {
  @apply space-y-3;
}

.shortcut-grid-row {
  @apply grid grid-cols-[1fr_140px_140px_40px] gap-4 items-center;
}

.shortcut-cell {
  @apply text-center;
}

.shortcut-cell-offset {
  @apply translate-x-1;
}

.shortcut-cell-reset {
  @apply flex items-center justify-center;
}

.shortcut-reset-btn {
  @apply text-[11px] font-semibold text-text-secondary hover:text-primary transition-colors cursor-pointer whitespace-nowrap;
}

.shortcut-input {
  @apply w-full px-3 py-1.5 text-[13px] font-medium border rounded-lg text-text-main text-center cursor-pointer transition-all tracking-wide;
  background: var(--control-bg);
  border-color: var(--control-border);
}

.shortcut-input:hover {
  @apply border-primary/50;
}

.shortcut-input.recording {
  @apply border-primary bg-primary/5 text-primary;
}

.shortcut-input-disabled {
  @apply opacity-50 cursor-not-allowed;
}

.settings-back-to-top {
  @apply fixed bottom-28 right-10 w-11 h-11 rounded-full backdrop-blur-sm border flex items-center justify-center text-text-secondary hover:text-primary hover:border-primary/60 transition-all duration-300 cursor-pointer shadow-lg shadow-black/5 z-50;
  background: var(--color-bg-elevated);
  border-color: var(--border-subtle);
  opacity: 0;
  visibility: hidden;
}

.settings-back-to-top.visible {
  opacity: 1;
  visibility: visible;
}

:global(.dark .settings-back-to-top) {
  border-color: rgba(255, 255, 255, 0.26);
}

.settings-input {
  @apply px-3 py-1.5 text-[12px] font-medium border rounded-lg text-text-main transition-all;
  background: var(--control-bg);
  border-color: var(--control-border);
}

.settings-input:hover {
  @apply border-primary/50;
}

.settings-input:focus {
  @apply border-primary outline-none ring-1 ring-primary/30;
}

.settings-back-to-top:hover {
  @apply scale-110;
  box-shadow: 0 4px 16px color-mix(in srgb, var(--color-primary) 20%, transparent);
}

.settings-update-changelog {
  max-height: min(288px, 40vh);
  font-size: 13px;
  line-height: 1.5;
  border-radius: 12px;
  background: var(--control-muted-bg);
}

.changelog-content {
  @apply text-sm text-text-secondary leading-relaxed;
}

.changelog-content :deep(h1) {
  @apply text-base font-bold text-text-main mt-4 mb-2;
}

.changelog-content :deep(h2) {
  @apply text-sm font-bold text-text-main mt-4 mb-1.5 pb-1;
  border-bottom: 1px solid var(--border-subtle);
}

.changelog-content :deep(h2:first-child) {
  @apply mt-0;
}

.changelog-content :deep(h3),
.changelog-content :deep(h4) {
  @apply text-sm font-semibold text-text-main mt-3 mb-1;
}

.changelog-content :deep(h3:first-child),
.changelog-content :deep(h4:first-child) {
  @apply mt-0;
}

.changelog-content :deep(ul) {
  @apply list-none pl-0 my-1;
}

.changelog-content :deep(ol) {
  @apply pl-4 my-1;
}

.changelog-content :deep(li) {
  @apply relative pl-3.5 leading-7 text-text-secondary;
}

.changelog-content :deep(li::before) {
  content: '·';
  @apply absolute left-0.5 font-bold;
}

.changelog-content :deep(p) {
  @apply my-1;
}

.changelog-content :deep(a) {
  @apply text-primary hover:underline;
}

.changelog-content :deep(code) {
  @apply px-1 py-0.5 rounded bg-[var(--control-hover-bg)] text-xs font-mono;
}

.changelog-content :deep(pre) {
  @apply my-2 p-3 rounded-lg bg-[var(--control-hover-bg)] overflow-x-auto;
}

.changelog-content :deep(pre code) {
  @apply p-0 bg-transparent;
}
</style>
