<script setup lang="ts">
defineOptions({ name: 'settings-page' });
import { computed, ref, onMounted, onUnmounted, nextTick, watch } from 'vue';
import type { Component } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { useDesktopLyricStore } from '@/desktopLyric/store';
import type { UpdateCheckResult } from '../../shared/app';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import DisclaimerDialog from '@/components/app/DisclaimerDialog.vue';
import UpdateDialog from '@/components/app/UpdateDialog.vue';
import { iconArrowUp, iconSearch, iconX } from '@/icons';
import { marked } from 'marked';
import { sanitizeHtml } from '@/utils/sanitize';
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
import { shortcutItems } from './settings/constants';

const settingStore = useSettingStore();
const desktopLyricStore = useDesktopLyricStore();
const showDisclaimer = ref(false);

const contentRef = ref<HTMLElement | null>(null);
const scrollbarRef = ref<InstanceType<typeof Scrollbar> | null>(null);
const anchorListRef = ref<HTMLElement | null>(null);
const anchorRefs = new Map<string, HTMLElement>();
const settingsSearchKeyword = ref('');
const settingsSearchInputRef = ref<HTMLInputElement | null>(null);
const settingsSearchContainerRef = ref<HTMLElement | null>(null);
const isSettingsSearchExpanded = ref(false);
const isSettingsSearchCollapsing = ref(false);
let settingsSearchCollapseTimer: number | null = null;

const normalizeSearchText = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, '');

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
  document.addEventListener('pointerdown', handleSettingsSearchPointerDown, true);
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
      changelogHtml.value = sanitizeHtml(marked.parse(raw, { async: false }) as string);
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
  searchKeywords?: string[];
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
    searchKeywords: [
      '主题模式',
      '浅色模式',
      '深色模式',
      '跟随系统',
      '主题色来源',
      '跟随封面',
      '预设主题色',
      '自定义主题色',
      '全局主题色',
      '记住窗口大小',
      '音质音效徽标',
      '桌面歌词状态',
      '播放列表计数',
      '搜索框默认推荐词',
      '全屏按钮',
      '侧边栏折叠',
      '关闭行为',
      '最小化到托盘',
      '彻底退出程序',
      '开机自启动',
      '启动时最小化到托盘',
    ],
  },
  {
    id: 'font',
    label: '字体设置',
    order: 200,
    component: FontSettingsSection,
    searchKeywords: ['全局字体', '页面歌词字体', '桌面歌词字体', '系统默认', '跟随全局'],
  },
  {
    id: 'playback',
    label: '播放体验',
    order: 300,
    component: PlaybackSettingsSection,
    searchKeywords: [
      '播放替换队列',
      '双击播放',
      '淡入淡出播放',
      '淡入淡出时长',
      '音量均衡',
      '参考响度',
      'LUFS',
      '空间音效',
      '导入音效文件',
      '自动跳过错误',
      '失败后切换延迟',
      '最大自动切换次数',
      '播放恢复超时',
      '防止系统休眠',
      '音频缓冲时长',
      '音频设备缓冲',
      '网络波动',
      '播放稳定性',
    ],
  },
  {
    id: 'quality',
    label: '播放音质',
    order: 400,
    component: QualitySettingsSection,
    searchKeywords: [
      '默认音质',
      '智能兼容模式',
      '标准品质',
      'HQ 高品质',
      'SQ 无损品质',
      'Hi-Res 品质',
      'DSD 臻品音质',
      'flac',
      '无损',
    ],
  },
  {
    id: 'pageLyric',
    label: '页面歌词',
    order: 500,
    component: PageLyricSettingsSection,
    searchKeywords: [
      '显示翻译',
      '显示音译',
      '字体大小',
      '字体字重',
      '歌词颜色',
      '已播字色',
      '未播字色',
      '封面模糊背景',
      '背景律动',
      '歌词过滤',
      '过滤表达式',
      '正则表达式',
      '写真背景透明度',
      '写真自动轮播',
      '轮播间隔',
      '歌词自动收起',
      '收起延迟',
      '收起时隐藏底部控件',
    ],
  },
  {
    id: 'desktopLyric',
    label: '桌面歌词',
    order: 600,
    component: DesktopLyricSettingsSection,
    searchKeywords: [
      '置顶显示',
      '显示翻译',
      '显示音译',
      '文字对齐',
      '文字粗体',
      '文字颜色',
      '已播字色',
      '未播字色',
      '歌词过滤',
      '过滤表达式',
      '鼠标穿透',
      'Wayland',
      'XWayland',
    ],
  },
  {
    id: 'shortcuts',
    label: '快捷键',
    order: 700,
    component: ShortcutSettingsSection,
    searchKeywords: [
      '功能说明',
      '全局快捷键',
      '启用全局快捷键',
      '恢复默认',
      ...shortcutItems.flatMap((item) => [item.command, item.title, item.desc]),
    ],
  },
  {
    id: 'audioDevice',
    label: '音频设备',
    order: 800,
    component: AudioDeviceSettingsSection,
    searchKeywords: [
      '输入设备',
      '输出设备',
      '麦克风',
      '听歌识曲',
      '录音',
      '音频播放输出设备',
      '系统默认',
      '独占音频设备',
      '系统混音器',
      '设备断开后的行为',
      '暂停播放',
      '切到默认设备',
    ],
  },
  {
    id: 'experimental',
    label: '实验性功能',
    order: 1150,
    component: ExperimentalSettingsSection,
    searchKeywords: [
      '自动领取 VIP',
      '页面缓存',
      '最大缓存页面数',
      'GitHub 加速地址',
      '在线插件源',
      '插件下载',
      '日志级别',
      'API 响应体日志',
      '临时诊断日志',
      '禁用 GPU 加速',
      '花屏',
      '渲染异常',
    ],
  },
  {
    id: 'plugins',
    label: '插件',
    order: 1000,
    component: PluginSettingsSection,
    searchKeywords: ['插件管理', '管理面板', '在线插件源', '已安装插件', '插件设置', '插件文档'],
  },
  {
    id: 'data',
    label: '数据与安全',
    order: 1100,
    component: DataSettingsSection,
    searchKeywords: ['查看运行日志', '本地日志目录', '清除应用数据', '持久化设置', '缓存信息'],
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
    searchKeywords: [
      '自动检查更新',
      '检查预发布版本',
      'Alpha',
      'Beta',
      'RC',
      '静默安装',
      '当前版本',
      '更新日志',
      '检查更新',
      '项目源码',
      'GitHub',
      '免责声明',
    ],
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

const normalizedSettingsSearchKeyword = computed(() =>
  normalizeSearchText(settingsSearchKeyword.value.trim()),
);

const hasSettingsSearchKeyword = computed(() => normalizedSettingsSearchKeyword.value.length > 0);

const matchesSettingsSearch = (section: SettingsRenderSection, keyword: string) => {
  const searchText = normalizeSearchText(
    [section.id, section.label, ...(section.searchKeywords ?? [])].join(' '),
  );
  return searchText.includes(keyword);
};

const settingsSections = computed(() => {
  const keyword = normalizedSettingsSearchKeyword.value;
  const sections = sortSettingsSections([...builtinSettingsSections.value]).filter((section) =>
    resolveFlag(section.visible),
  );

  if (!keyword) return sections;

  return sections.filter((section) => matchesSettingsSearch(section, keyword));
});

const clearSettingsSearch = () => {
  settingsSearchKeyword.value = '';
  nextTick(() => {
    if (isSettingsSearchExpanded.value) settingsSearchInputRef.value?.focus();
  });
};

const expandSettingsSearch = async () => {
  if (settingsSearchCollapseTimer) {
    window.clearTimeout(settingsSearchCollapseTimer);
    settingsSearchCollapseTimer = null;
  }
  isSettingsSearchExpanded.value = true;
  isSettingsSearchCollapsing.value = false;
  await nextTick();
  settingsSearchInputRef.value?.focus();
};

const collapseSettingsSearch = (force = false) => {
  if (!isSettingsSearchExpanded.value || isSettingsSearchCollapsing.value) return;
  if (settingsSearchKeyword.value.trim() && !force) return;
  isSettingsSearchCollapsing.value = true;
  if (settingsSearchCollapseTimer) {
    window.clearTimeout(settingsSearchCollapseTimer);
    settingsSearchCollapseTimer = null;
  }
  settingsSearchCollapseTimer = window.setTimeout(() => {
    isSettingsSearchExpanded.value = false;
    isSettingsSearchCollapsing.value = false;
    settingsSearchCollapseTimer = null;
  }, 200);
};

const handleSettingsSearchBlur = () => {
  window.setTimeout(() => {
    if (settingsSearchContainerRef.value?.contains(document.activeElement)) return;
    collapseSettingsSearch();
  }, 160);
};

const handleSettingsSearchKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return;
  settingsSearchKeyword.value = '';
  collapseSettingsSearch(true);
};

const handleSettingsSearchPointerDown = (event: PointerEvent) => {
  if (!isSettingsSearchExpanded.value) return;
  if (settingsSearchContainerRef.value?.contains(event.target as Node)) return;
  collapseSettingsSearch();
};

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

// 当前滚动位置
const currentScrollTop = ref(0);

// 是否显示返回顶部按钮
const showBackToTop = ref(false);

onUnmounted(() => {
  window.electron?.ipcRenderer?.off('update-check-result', handleUpdateCheckResult);
  document.removeEventListener('pointerdown', handleSettingsSearchPointerDown, true);
  if (settingsSearchCollapseTimer) window.clearTimeout(settingsSearchCollapseTimer);
});

watch(
  normalizedSettingsSearchKeyword,
  async () => {
    const firstSectionId = settingsSections.value[0]?.id ?? '';
    activeSection.value = firstSectionId;
    showBackToTop.value = false;
    currentScrollTop.value = 0;
    await nextTick();
    scrollbarRef.value?.setScrollTop(0);
    if (firstSectionId) scrollAnchorIntoView(firstSectionId);
  },
  { flush: 'post' },
);

watch(
  settingsSections,
  async (sections) => {
    if (sections.some((section) => section.id === activeSection.value)) return;
    activeSection.value = sections[0]?.id ?? '';
    await nextTick();
    if (activeSection.value) scrollAnchorIntoView(activeSection.value);
  },
  { flush: 'post' },
);

// 返回顶部
const scrollToTop = () => {
  scrollbarRef.value?.setScrollTop(0);
};

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
      <div class="flex w-full items-center justify-between">
        <h1 class="text-lg font-bold text-text-main">偏好设置</h1>
        <div
          ref="settingsSearchContainerRef"
          class="settings-search-shell"
          :class="{ 'is-expanded': isSettingsSearchExpanded || isSettingsSearchCollapsing }"
        >
          <button
            v-if="!isSettingsSearchExpanded && !isSettingsSearchCollapsing"
            type="button"
            class="settings-search-icon-button"
            title="搜索设置"
            aria-label="搜索设置"
            @click="expandSettingsSearch"
          >
            <Icon :icon="iconSearch" width="17" height="17" class="settings-search-trigger-icon" />
          </button>
          <div
            v-if="isSettingsSearchExpanded || isSettingsSearchCollapsing"
            class="settings-search"
            :class="{ 'is-collapsing': isSettingsSearchCollapsing }"
          >
            <Icon :icon="iconSearch" width="15" height="15" class="settings-search-icon" />
            <input
              ref="settingsSearchInputRef"
              v-model="settingsSearchKeyword"
              type="search"
              class="settings-search-input"
              placeholder="搜索设置"
              aria-label="搜索设置"
              @keydown="handleSettingsSearchKeydown"
              @blur="handleSettingsSearchBlur"
            />
            <button
              v-if="settingsSearchKeyword"
              type="button"
              class="settings-search-clear"
              aria-label="清空搜索"
              @mousedown.prevent
              @click="clearSettingsSearch"
            >
              <Icon :icon="iconX" width="14" height="14" />
            </button>
          </div>
        </div>
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
      :content-props="{
        class: 'settings-content-inner',
        'data-echo-scroll-container': 'true',
        'data-echo-scroll-role': 'settings',
      }"
      @scroll="handleScroll"
    >
      <div ref="contentRef" class="settings-content">
        <div
          v-if="hasSettingsSearchKeyword && settingsSections.length === 0"
          class="settings-empty"
        >
          <Icon :icon="iconSearch" width="22" height="22" />
          <span>没有找到匹配的设置</span>
          <button type="button" class="settings-empty-clear" @click="clearSettingsSearch">
            清空搜索
          </button>
        </div>

        <template v-else>
          <component
            :is="section.component"
            v-for="section in settingsSections"
            :key="section.id"
            v-bind="section.props ?? {}"
          />
        </template>
      </div>
    </Scrollbar>

    <!-- 返回顶部按钮 -->
    <button class="settings-back-to-top" :class="{ visible: showBackToTop }" @click="scrollToTop">
      <Icon :icon="iconArrowUp" width="18" height="18" />
    </button>

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
          class="settings-button"
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
  position: relative;
  background: transparent;
}

.settings-header {
  @apply flex items-center;
}

.settings-search-shell {
  @apply relative flex h-7 w-7 items-center justify-end transition-[width] duration-200 ease-out;
}

.settings-search-shell.is-expanded {
  @apply w-[200px];
}

.settings-search-icon-button {
  @apply flex h-7 w-7 items-center justify-center rounded-full text-text-main transition-colors cursor-pointer;
  background: transparent;
}

.settings-search-icon-button:hover {
  background: var(--control-hover-bg);
}

.settings-search-trigger-icon {
  @apply text-text-main opacity-60 transition-opacity;
}

.settings-search-icon-button:hover .settings-search-trigger-icon {
  @apply opacity-100;
}

.settings-search {
  @apply relative flex h-7 items-center rounded-full border;
  width: 200px;
  background: var(--control-muted-bg);
  border-color: transparent;
  padding: 0 4px 0 9px;
  animation: settings-search-expand 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  transform-origin: right center;
}

.settings-search.is-collapsing {
  animation: settings-search-collapse 0.2s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}

@keyframes settings-search-expand {
  from {
    width: 30px;
    opacity: 0.6;
  }
  to {
    width: 200px;
    opacity: 1;
  }
}

@keyframes settings-search-collapse {
  from {
    width: 200px;
    opacity: 1;
  }
  to {
    width: 30px;
    opacity: 0;
  }
}

.settings-search:focus-within {
  background: var(--control-bg);
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 12%, transparent);
}

.settings-search-icon {
  @apply shrink-0 text-text-secondary pointer-events-none opacity-60;
}

.settings-search-input {
  @apply h-full min-w-0 flex-1 bg-transparent px-2 text-[12px] font-medium text-text-main placeholder:text-text-secondary border-0 outline-none;
}

.settings-search-input::-webkit-search-cancel-button {
  appearance: none;
}

.settings-search-clear {
  @apply flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors cursor-pointer hover:text-text-main;
}

.settings-search-clear:hover {
  background: var(--control-hover-bg);
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

.settings-empty {
  @apply min-h-[220px] flex flex-col items-center justify-center gap-3 text-text-secondary;
}

.settings-empty span {
  @apply text-[13px] font-medium;
}

.settings-empty-clear {
  @apply text-[12px] font-semibold text-primary hover:opacity-80 transition-opacity cursor-pointer;
}

.settings-section {
  @apply min-h-[60px];
}

.settings-card {
  @apply rounded-2xl p-5 space-y-5 transition-all duration-300 border overflow-visible;
  background: var(--color-bg-elevated);
  border-color: var(--border-subtle);
  --settings-divider-color: color-mix(in srgb, var(--color-text-main) 12%, transparent);
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
  @apply h-0 shrink-0;
  border-top: 1px solid var(--settings-divider-color);
  background: transparent;
}

.settings-button {
  @apply text-sm font-semibold;
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
  @apply absolute bottom-4 right-6 w-11 h-11 rounded-full backdrop-blur-sm border flex items-center justify-center text-text-secondary hover:text-primary hover:border-primary/60 transition-all duration-300 cursor-pointer shadow-lg shadow-black/5 z-50;
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
