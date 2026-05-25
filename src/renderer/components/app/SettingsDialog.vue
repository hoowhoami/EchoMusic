<script setup lang="ts">
defineOptions({ name: 'settings-dialog' });
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { useDesktopLyricStore } from '@/desktopLyric/store';
import { usePlayerStore } from '@/stores/player';
import { useThemeStore, type AccentMode } from '@/stores/theme';
import { ACCENT_PRESETS } from '@/utils/color';
import { useLyricColorPicker } from '@/composables/useLyricColorPicker';
import { useLyricStore } from '@/stores/lyric';
import { useToastStore } from '@/stores/toast';
import { useSettingsDialog } from '@/composables/useSettingsDialog';
import type {
  AudioQualityValue,
  OutputDeviceDisconnectBehavior,
  ShortcutItem,
  ShortcutRecordingState,
  ShortcutScope,
} from '@/types';
import type { DesktopLyricSettings } from '../../../shared/desktop-lyric';
import type { CloseBehavior, ThemeMode, UpdateCheckResult } from '../../../shared/app';
import type { ShortcutCommand } from '../../../shared/shortcuts';
import Select from '@/components/ui/Select.vue';
import Slider from '@/components/ui/Slider.vue';
import Switch from '@/components/ui/Switch.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import InputNumber from '@/components/ui/InputNumber.vue';
import ColorPickerDialog from '@/components/ui/ColorPickerDialog.vue';
import DisclaimerDialog from '@/components/app/DisclaimerDialog.vue';
import UpdateDialog from '@/components/app/UpdateDialog.vue';
import PageLyricIcon from '@/components/ui/PageLyricIcon.vue';
import {
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogClose,
  VisuallyHidden,
} from 'reka-ui';

import { marked } from 'marked';
import { areShortcutLabelsEquivalent, formatShortcutLabelForDisplay } from '@/utils/shortcuts';
import {
  iconPalette,
  iconPlayerPlay,
  iconVolume2,
  iconKeyboard,
  iconDeviceSpeaker,
  iconFlask,
  iconShield,
  iconInfo,
  iconExternalLink,
  iconChevronRight,
  iconTypography,
  iconX,
} from '@/icons';
import FontIcon from '@/components/ui/FontIcon.vue';

const settingStore = useSettingStore();
const desktopLyricStore = useDesktopLyricStore();
const playerStore = usePlayerStore();
const lyricStore = useLyricStore();
const themeStore = useThemeStore();
const toastStore = useToastStore();
const { isOpen, activeSection } = useSettingsDialog();
const showDisclaimer = ref(false);

// ── 分栏导航 ──
interface NavItem {
  id: string;
  label: string;
  icon: string;
}

const navItems: NavItem[] = [
  { id: 'appearance', label: '外观与界面', icon: 'palette' },
  { id: 'font', label: '字体设置', icon: 'font' },
  { id: 'playback', label: '播放体验', icon: 'play' },
  { id: 'quality', label: '播放音质', icon: 'volume' },
  { id: 'pageLyric', label: '页面歌词', icon: 'lyric' },
  { id: 'desktopLyric', label: '桌面歌词', icon: 'typography' },
  { id: 'shortcuts', label: '快捷键', icon: 'keyboard' },
  { id: 'audioDevice', label: '音频设备', icon: 'speaker' },
  { id: 'experimental', label: '实验性功能', icon: 'flask' },
  { id: 'data', label: '数据与安全', icon: 'shield' },
  { id: 'about', label: '关于', icon: 'info' },
];

const contentRef = ref<HTMLElement | null>(null);
const scrollbarRef = ref<InstanceType<typeof Scrollbar> | null>(null);

const scrollToSection = (id: string) => {
  activeSection.value = id;
  scrollbarRef.value?.setScrollTop(0);
};

// ── 主题色 ──
const accentModeOptions: { label: string; value: AccentMode }[] = [
  { label: '跟随封面', value: 'cover' },
  { label: '预设主题', value: 'preset' },
  { label: '自定义', value: 'custom' },
];
const accentPresets = ACCENT_PRESETS;
const showAccentPicker = ref(false);
const accentPresetValues = accentPresets.map((item) => item.color);

const activeDesktopLyricColorField = ref<'playedColor' | 'unplayedColor' | null>(null);

// ── 页面歌词颜色选择器 ──
const lyricColorPicker = useLyricColorPicker();

const lyricFontSizeLabel = computed(() => `${Math.round(lyricStore.fontScale * 100)}%`);
const lyricFontWeightLabel = computed(() => `W${lyricStore.fontWeightValue}`);

const desktopLyricColorPresets = [
  '#31cfa1',
  '#b9b9b9',
  '#ffffff',
  '#ffd166',
  '#ef476f',
  '#118ab2',
  '#8b5cf6',
  '#f97316',
  '#22c55e',
  '#60a5fa',
  '#f43f5e',
  '#0f172a',
];

const activeDesktopLyricColorValue = computed(() => {
  if (!activeDesktopLyricColorField.value) return '#31cfa1';
  return desktopLyricStore.settings[activeDesktopLyricColorField.value];
});

const openDesktopLyricColorPicker = (field: 'playedColor' | 'unplayedColor') => {
  activeDesktopLyricColorField.value = field;
};

const closeDesktopLyricColorPicker = () => {
  activeDesktopLyricColorField.value = null;
};

const applyDesktopLyricColor = async (value: string) => {
  if (!activeDesktopLyricColorField.value) return;
  await commitDesktopLyricSettings({
    [activeDesktopLyricColorField.value]: value,
  });
  closeDesktopLyricColorPicker();
};
// ── 系统字体列表 ──
const systemFontOptions = ref<{ label: string; value: string }[]>([]);
const globalFontOptions = computed(() => [
  { label: '系统默认', value: 'system-ui' },
  ...systemFontOptions.value,
]);
const lyricFontOptions = computed(() => [
  { label: '跟随全局', value: 'follow' },
  { label: '系统默认', value: 'system-ui' },
  ...systemFontOptions.value,
]);

const fetchSystemFonts = async () => {
  const fonts = await settingStore.fetchSystemFonts();
  // 短名优先排序
  const sorted = fonts.slice().sort((a, b) => {
    if (a === b) return 0;
    if (a.startsWith(b)) return 1;
    if (b.startsWith(a)) return -1;
    return a.localeCompare(b);
  });
  systemFontOptions.value = sorted.map((name) => ({ label: name, value: name }));
};

// 桌面歌词字体名
const desktopLyricFontName = computed(() => desktopLyricStore.settings.fontFamily || 'follow');

const applyDesktopLyricFont = (fontName: string) => {
  void commitDesktopLyricSettings({ fontFamily: fontName || 'follow' });
};

// 初始化：Dialog 打开时加载数据
watch(isOpen, (open) => {
  if (open) {
    settingStore.syncCloseBehavior();
    settingStore.syncTheme();
    void settingStore.hydrateAppInfo();
    void desktopLyricStore.hydrate();
    void fetchSystemFonts();
    void fetchInputDevices();
  } else {
    stopRecording();
  }
});

onMounted(() => {
  window.electron?.ipcRenderer?.on('update-check-result', handleUpdateCheckResult);
});

const desktopLyricAlignOptions = [
  { label: '左对齐', value: 'left' },
  { label: '居中', value: 'center' },
  { label: '右对齐', value: 'right' },
  { label: '交替', value: 'both' },
];

const commitDesktopLyricSettings = async (partial?: Partial<DesktopLyricSettings>) => {
  await desktopLyricStore.syncSettings(partial);
};

const shortcutItems: ShortcutItem[] = [
  { command: 'togglePlayback', title: '播放 / 暂停', desc: '切换当前歌曲的播放状态' },
  { command: 'previousTrack', title: '上一首', desc: '跳转到播放列表中的上一首歌曲' },
  { command: 'nextTrack', title: '下一首', desc: '跳转到播放列表中的下一首歌曲' },
  { command: 'volumeUp', title: '音量 +', desc: '将播放器音量提高 5%' },
  { command: 'volumeDown', title: '音量 -', desc: '将播放器音量降低 5%' },
  { command: 'toggleMute', title: '静音', desc: '切换播放器静音状态' },
  { command: 'toggleFavorite', title: '收藏当前歌曲', desc: '切换播放器当前歌曲的收藏状态' },
  {
    command: 'togglePlayMode',
    title: '切换播放模式',
    desc: '在列表循环、单曲循环、随机播放之间切换',
  },
  { command: 'toggleWindow', title: '显示 / 隐藏窗口', desc: '切换主窗口的显示和隐藏状态' },
  { command: 'toggleMainLyric', title: '页面歌词开关', desc: '打开或关闭页面歌词' },
  { command: 'toggleDesktopLyric', title: '桌面歌词开关', desc: '打开或关闭桌面歌词窗口' },
];

const themeOptions = [
  { label: '跟随系统', value: 'system' },
  { label: '浅色模式', value: 'light' },
  { label: '深色模式', value: 'dark' },
];

const shortcutBindings = computed(() => settingStore.shortcutBindings ?? {});
const globalShortcutBindings = computed(() => settingStore.globalShortcutBindings ?? {});
const isMac = computed(() => window.electron?.platform === 'darwin');
const isLinux = computed(() => window.electron?.platform === 'linux');
const recording = ref<ShortcutRecordingState | null>(null);
let removeRecorder: (() => void) | null = null;
let removeOutside: (() => void) | null = null;

const handleVolumeNormalizationChange = (enabled: boolean) => {
  settingStore.volumeNormalization = enabled;
  playerStore.setVolumeNormalization(enabled);
};

const handleReferenceLufsSlider = (value: number) => {
  settingStore.volumeNormalizationLufs = value;
  playerStore.setReferenceLufs(value);
};

const autoNextDelayInput = computed({
  get: () => String(settingStore.autoNextDelaySeconds ?? 0),
  set: (value: string | number) => {
    const parsed = Number.parseInt(String(value).trim(), 10);
    settingStore.autoNextDelaySeconds = Number.isNaN(parsed)
      ? 0
      : Math.max(0, Math.min(parsed, 600));
  },
});

const autoNextMaxAttemptsInput = computed({
  get: () => String(settingStore.autoNextMaxAttempts ?? 0),
  set: (value: string | number) => {
    const parsed = Number.parseInt(String(value).trim(), 10);
    settingStore.autoNextMaxAttempts = Number.isNaN(parsed)
      ? 1
      : Math.max(1, Math.min(parsed, 999));
  },
});

const isRecording = (command: ShortcutCommand, scope: ShortcutScope) =>
  recording.value?.command === command && recording.value?.scope === scope;

const formatMainKey = (key: string, mac: boolean) => {
  if (key === ' ' || key === 'Spacebar') return 'Space';
  if (key === 'ArrowLeft') return mac ? '←' : 'Left';
  if (key === 'ArrowRight') return mac ? '→' : 'Right';
  if (key === 'ArrowUp') return mac ? '↑' : 'Up';
  if (key === 'ArrowDown') return mac ? '↓' : 'Down';
  if (key.length === 1) return key.toUpperCase();
  return key;
};

const buildShortcutLabel = (event: KeyboardEvent) => {
  const key = event.key;
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return '';
  const mainKey = formatMainKey(key, isMac.value);
  if (!mainKey) return '';
  if (isMac.value) {
    const parts = [
      event.metaKey ? '⌘' : '',
      event.shiftKey ? '⇧' : '',
      event.altKey ? '⌥' : '',
      event.ctrlKey ? '⌃' : '',
      mainKey,
    ].filter(Boolean);
    return parts.join('');
  }
  const parts = [
    event.ctrlKey ? 'Ctrl' : '',
    event.shiftKey ? 'Shift' : '',
    event.altKey ? 'Alt' : '',
    event.metaKey ? 'Meta' : '',
    mainKey,
  ].filter(Boolean);
  return parts.join('+');
};

const resolveLabel = (
  binding: Record<string, string>,
  defaults: Record<string, string>,
  command: ShortcutCommand,
) => {
  if (Object.prototype.hasOwnProperty.call(binding, command)) {
    return binding[command] ?? '';
  }
  return defaults[command] ?? '';
};

const getShortcutValue = (command: ShortcutCommand, scope: ShortcutScope) => {
  if (isRecording(command, scope)) return '';
  const rawValue =
    scope === 'global'
      ? resolveLabel(
          globalShortcutBindings.value,
          settingStore.defaultGlobalShortcutLabels,
          command,
        )
      : resolveLabel(shortcutBindings.value, settingStore.defaultShortcutLabels, command);
  return formatShortcutLabelForDisplay(rawValue, window.electron?.platform);
};

const getShortcutPlaceholder = (command: ShortcutCommand, scope: ShortcutScope) => {
  if (isRecording(command, scope)) return '按键盘输入快捷键';
  if (scope === 'global' && !settingStore.globalShortcutsEnabled) return '开启后可录制';
  return '点击录制';
};

const getBindingState = (scope: ShortcutScope) =>
  scope === 'global' ? globalShortcutBindings.value : shortcutBindings.value;

const getShortcutCommandTitle = (command: ShortcutCommand) =>
  shortcutItems.find((item) => item.command === command)?.title || command;

const stopRecording = () => {
  recording.value = null;
  removeRecorder?.();
  removeRecorder = null;
  removeOutside?.();
  removeOutside = null;
};

const startRecording = (command: ShortcutCommand, scope: ShortcutScope) => {
  if (scope === 'global' && !settingStore.globalShortcutsEnabled) {
    return;
  }
  if (isRecording(command, scope)) return;
  if (recording.value && !isRecording(command, scope)) {
    stopRecording();
  }
  recording.value = { command, scope };
  removeRecorder?.();
  const handler = (event: KeyboardEvent) => {
    if (!recording.value) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Backspace' || event.key === 'Delete') {
      clearShortcut(recording.value.command, recording.value.scope);
      stopRecording();
      return;
    }
    const label = buildShortcutLabel(event);
    if (!label) return;
    const hasModifier = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
    if (!hasModifier) {
      toastStore.warning('快捷键至少需要包含一个修饰键');
      return;
    }
    const currentScope = recording.value.scope;
    const currentBindings = getBindingState(currentScope);
    const conflictEntry = Object.entries(currentBindings).find(
      ([existingCommand, existingLabel]) =>
        areShortcutLabelsEquivalent(existingLabel, label) &&
        existingCommand !== recording.value?.command,
    );
    if (conflictEntry) {
      toastStore.warning(
        `该快捷键已分配给“${getShortcutCommandTitle(conflictEntry[0] as ShortcutCommand)}”`,
      );
      return;
    }
    if (recording.value.scope === 'global') {
      settingStore.globalShortcutBindings = {
        ...globalShortcutBindings.value,
        [recording.value.command]: label,
      };
    } else {
      settingStore.shortcutBindings = {
        ...shortcutBindings.value,
        [recording.value.command]: label,
      };
    }
    stopRecording();
  };
  window.addEventListener('keydown', handler, true);
  removeRecorder = () => window.removeEventListener('keydown', handler, true);

  const outsideHandler = (event: MouseEvent) => {
    if (!recording.value) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('.shortcut-input')) return;
    stopRecording();
  };
  window.addEventListener('mousedown', outsideHandler, true);
  removeOutside = () => window.removeEventListener('mousedown', outsideHandler, true);
};

const clearShortcut = (command: ShortcutCommand, scope: ShortcutScope) => {
  if (scope === 'global') {
    const next = { ...globalShortcutBindings.value, [command]: '' };
    settingStore.globalShortcutBindings = next;
  } else {
    const next = { ...shortcutBindings.value, [command]: '' };
    settingStore.shortcutBindings = next;
  }
  if (isRecording(command, scope)) stopRecording();
};

const resetAllShortcuts = () => {
  settingStore.resetShortcutDefaults();
  settingStore.shortcutBindings = { ...settingStore.defaultShortcutLabels };
  settingStore.globalShortcutBindings = { ...settingStore.defaultGlobalShortcutLabels };
  stopRecording();
};

const showConfirmClear = ref(false);
const showUpdateResult = ref(false);
const showChangelog = ref(false);
const changelogHtml = ref('');
const isCheckingUpdate = ref(false);
const updateResult = ref<UpdateCheckResult | null>(null);

const audioQualityOptions = [
  { label: '标准品质', value: '128' },
  { label: 'HQ 高品质', value: '320' },
  { label: 'SQ 无损品质', value: 'flac' },
  { label: 'Hi-Res 品质', value: 'high' },
  { label: 'DSD 臻品音质', value: 'super' },
];

const closeBehaviorOptions = [
  { label: '最小化到托盘', value: 'tray' },
  { label: '彻底退出程序', value: 'exit' },
];

const outputDeviceDisconnectBehaviorOptions = [
  { label: '暂停播放', value: 'pause' },
  { label: '切到默认设备', value: 'fallback' },
];

const outputDeviceOptions = computed(() => settingStore.outputDevices);

const currentOutputDeviceLabel = computed(() => {
  const matched = settingStore.outputDevices.find(
    (item) => item.value === playerStore.appliedOutputDeviceId,
  );
  return (
    matched?.label || (playerStore.appliedOutputDeviceId === 'default' ? '系统默认' : '未知设备')
  );
});

const handleOutputDeviceChange = async (value: string | number | boolean | null | undefined) => {
  const nextValue = String(value ?? 'default');
  if (nextValue === settingStore.outputDevice) return;
  settingStore.outputDevice = nextValue;
};

// ── 输入设备 ──
const inputDeviceOptions = ref<{ label: string; value: string }[]>([
  { label: '系统默认', value: 'default' },
]);

async function fetchInputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((d) => d.kind === 'audioinput');
    inputDeviceOptions.value = [
      { label: '系统默认', value: 'default' },
      ...audioInputs
        .filter((d) => d.deviceId && d.deviceId !== 'default')
        .map((d) => ({
          label: d.label || `麦克风 (${d.deviceId.slice(0, 6)})`,
          value: d.deviceId,
        })),
    ];
    if (!inputDeviceOptions.value.some((d) => d.value === settingStore.inputDevice)) {
      settingStore.inputDevice = 'default';
    }
  } catch {
    inputDeviceOptions.value = [{ label: '系统默认', value: 'default' }];
  }
}

const handleInputDeviceChange = (value: string | number | boolean | null | undefined) => {
  settingStore.inputDevice = String(value ?? 'default');
};

const versionLabel = computed(() => settingStore.appVersion || '未知');
const releaseChannelLabel = computed(() => (settingStore.isPrerelease ? 'Prerelease' : 'Release'));
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
      currentVersion: versionLabel.value,
      message: '返回的更新信息无效。',
    };
  } else {
    updateResult.value = payload as typeof updateResult.value;
  }
  showUpdateResult.value = true;
};

onUnmounted(() => {
  stopRecording();
  window.electron?.ipcRenderer?.off('update-check-result', handleUpdateCheckResult);
});
</script>

<template>
  <DialogRoot v-model:open="isOpen" modal>
    <DialogPortal>
      <DialogOverlay as-child>
        <div class="settings-overlay"></div>
      </DialogOverlay>

      <DialogContent as-child>
        <div class="settings-dialog-content">
          <VisuallyHidden>
            <DialogTitle>偏好设置</DialogTitle>
          </VisuallyHidden>

          <div class="settings-layout">
            <!-- 左侧导航 -->
            <nav class="settings-nav">
              <div class="settings-nav-title">偏好设置</div>
              <div class="settings-nav-list">
                <button
                  v-for="item in navItems"
                  :key="item.id"
                  type="button"
                  class="settings-nav-item"
                  :class="{ 'is-active': activeSection === item.id }"
                  @click="scrollToSection(item.id)"
                >
                  <span class="settings-nav-icon">
                    <Icon
                      v-if="item.icon === 'palette'"
                      :icon="iconPalette"
                      width="16"
                      height="16"
                    />
                    <FontIcon v-else-if="item.icon === 'font'" :size="16" />
                    <Icon
                      v-else-if="item.icon === 'play'"
                      :icon="iconPlayerPlay"
                      width="16"
                      height="16"
                    />
                    <Icon
                      v-else-if="item.icon === 'volume'"
                      :icon="iconVolume2"
                      width="16"
                      height="16"
                    />
                    <PageLyricIcon v-else-if="item.icon === 'lyric'" :size="16" />
                    <Icon
                      v-else-if="item.icon === 'typography'"
                      :icon="iconTypography"
                      width="16"
                      height="16"
                    />
                    <Icon
                      v-else-if="item.icon === 'keyboard'"
                      :icon="iconKeyboard"
                      width="16"
                      height="16"
                    />
                    <Icon
                      v-else-if="item.icon === 'speaker'"
                      :icon="iconDeviceSpeaker"
                      width="16"
                      height="16"
                    />
                    <Icon
                      v-else-if="item.icon === 'flask'"
                      :icon="iconFlask"
                      width="16"
                      height="16"
                    />
                    <Icon
                      v-else-if="item.icon === 'shield'"
                      :icon="iconShield"
                      width="16"
                      height="16"
                    />
                    <Icon
                      v-else-if="item.icon === 'info'"
                      :icon="iconInfo"
                      width="16"
                      height="16"
                    />
                  </span>
                  <span class="settings-nav-label">{{ item.label }}</span>
                </button>
              </div>
            </nav>

            <!-- 右侧内容 -->
            <div class="settings-right">
              <div class="settings-right-header">
                <h2 class="settings-right-title">
                  {{ navItems.find((n) => n.id === activeSection)?.label }}
                </h2>
                <DialogClose as-child>
                  <Button
                    class="settings-dialog-close"
                    variant="ghost"
                    size="xs"
                    type="button"
                    aria-label="关闭"
                  >
                    <Icon :icon="iconX" width="14" height="14" />
                  </Button>
                </DialogClose>
              </div>
              <Scrollbar
                ref="scrollbarRef"
                class="settings-content-scroll"
                :content-props="{ class: 'settings-content-inner' }"
              >
                <div ref="contentRef" class="settings-content">
                  <section
                    data-section="appearance"
                    v-show="activeSection === 'appearance'"
                    class="settings-section"
                  >
                    <div class="settings-card">
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">主题模式</h3>
                          <p class="text-sm text-text-secondary">选择您喜欢的主题外观</p>
                        </div>
                        <Select
                          class="w-[180px]"
                          :model-value="settingStore.theme"
                          :options="themeOptions"
                          @update:model-value="settingStore.setTheme($event as ThemeMode)"
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">主题色来源</h3>
                          <p class="text-sm text-text-secondary">
                            切歌自动跟随封面，或固定为预设 / 自定义颜色
                          </p>
                        </div>
                        <Select
                          class="w-[180px]"
                          :model-value="themeStore.accentMode"
                          :options="accentModeOptions"
                          @update:model-value="themeStore.setMode($event as AccentMode)"
                        />
                      </div>
                      <div
                        v-if="themeStore.accentMode === 'preset'"
                        class="settings-item items-start"
                      >
                        <div class="space-y-1">
                          <h3 class="font-semibold">预设主题色</h3>
                          <p class="text-sm text-text-secondary">挑一个贴合心情的配色</p>
                        </div>
                        <div class="flex gap-2 flex-nowrap">
                          <button
                            v-for="preset in accentPresets"
                            :key="preset.id"
                            type="button"
                            class="accent-preset-swatch"
                            :class="{ 'is-active': themeStore.presetId === preset.id }"
                            :style="{ backgroundColor: preset.color }"
                            :title="preset.name"
                            @click="themeStore.setPreset(preset.id)"
                          ></button>
                        </div>
                      </div>
                      <div v-if="themeStore.accentMode === 'custom'" class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">自定义主题色</h3>
                          <p class="text-sm text-text-secondary">从色盘中选一种颜色固定为主题色</p>
                        </div>
                        <button
                          type="button"
                          class="settings-color-swatch"
                          :style="{ backgroundColor: themeStore.customColor }"
                          @click="showAccentPicker = true"
                        ></button>
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">全局主题色</h3>
                          <p class="text-sm text-text-secondary">
                            关闭后仅播放栏与歌词页跟随主题色
                          </p>
                        </div>
                        <Switch
                          :model-value="themeStore.globalAccent"
                          @update:model-value="themeStore.setGlobalAccent(Boolean($event))"
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">歌词字色跟随主题</h3>
                          <p class="text-sm text-text-secondary">
                            歌词已播色自动跟随主题色，手动设置的颜色优先
                          </p>
                        </div>
                        <Switch
                          :model-value="themeStore.lyricAccentSync"
                          @update:model-value="themeStore.setLyricAccentSync(Boolean($event))"
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">记住窗口大小</h3>
                          <p class="text-sm text-text-secondary">
                            在下次启动时自动恢复窗口大小和位置
                          </p>
                        </div>
                        <Switch v-model="settingStore.rememberWindowSize" />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">音质音效徽标</h3>
                          <p class="text-sm text-text-secondary">
                            在播放器音质按钮上显示当前实际音质或音效标识
                          </p>
                        </div>
                        <Switch v-model="settingStore.showAudioQualityBadge" />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">播放列表计数</h3>
                          <p class="text-sm text-text-secondary">在播放器播放列表图标上显示计数</p>
                        </div>
                        <Switch v-model="settingStore.showPlaylistCount" />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">关闭行为</h3>
                          <p class="text-sm text-text-secondary">点击窗口关闭按钮时的应用行为</p>
                        </div>
                        <Select
                          class="w-[180px]"
                          :model-value="settingStore.closeBehavior"
                          :options="closeBehaviorOptions"
                          @update:model-value="
                            settingStore.closeBehavior = $event as CloseBehavior;
                            settingStore.syncCloseBehavior();
                          "
                        />
                      </div>
                    </div>
                  </section>

                  <section
                    data-section="font"
                    v-show="activeSection === 'font'"
                    class="settings-section"
                  >
                    <div class="settings-card">
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">全局字体</h3>
                          <p class="text-sm text-text-secondary">应用到软件内所有区域的字体</p>
                        </div>
                        <div class="flex items-center gap-2">
                          <button
                            v-if="settingStore.globalFont !== 'system-ui'"
                            type="button"
                            class="text-[11px] font-semibold text-text-secondary hover:text-text-main transition-colors whitespace-nowrap"
                            @click="settingStore.globalFont = 'system-ui'"
                          >
                            重置
                          </button>
                          <Select
                            filterable
                            class="w-[180px]"
                            :model-value="settingStore.globalFont"
                            :options="globalFontOptions"
                            @update:model-value="settingStore.globalFont = String($event)"
                          />
                        </div>
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">页面歌词字体</h3>
                          <p class="text-sm text-text-secondary">
                            歌词页面使用的字体，跟随全局或单独指定
                          </p>
                        </div>
                        <div class="flex items-center gap-2">
                          <button
                            v-if="settingStore.lyricFont !== 'follow'"
                            type="button"
                            class="text-[11px] font-semibold text-text-secondary hover:text-text-main transition-colors whitespace-nowrap"
                            @click="settingStore.lyricFont = 'follow'"
                          >
                            重置
                          </button>
                          <Select
                            filterable
                            class="w-[180px]"
                            :model-value="settingStore.lyricFont"
                            :options="lyricFontOptions"
                            @update:model-value="settingStore.lyricFont = String($event)"
                          />
                        </div>
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">桌面歌词字体</h3>
                          <p class="text-sm text-text-secondary">
                            桌面歌词窗口使用的字体，跟随全局或单独指定
                          </p>
                        </div>
                        <div class="flex items-center gap-2">
                          <button
                            v-if="desktopLyricFontName !== 'follow'"
                            type="button"
                            class="text-[11px] font-semibold text-text-secondary hover:text-text-main transition-colors whitespace-nowrap"
                            @click="applyDesktopLyricFont('follow')"
                          >
                            重置
                          </button>
                          <Select
                            filterable
                            class="w-[180px]"
                            :model-value="desktopLyricFontName"
                            :options="lyricFontOptions"
                            @update:model-value="applyDesktopLyricFont(String($event))"
                          />
                        </div>
                      </div>
                    </div>
                  </section>

                  <section
                    data-section="playback"
                    v-show="activeSection === 'playback'"
                    class="settings-section"
                  >
                    <div class="settings-card">
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">播放替换队列</h3>
                          <p class="text-sm text-text-secondary">
                            双击播放单曲时用当前列表替换播放队列
                          </p>
                        </div>
                        <Switch v-model="settingStore.replacePlaylist" />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">淡入淡出播放</h3>
                          <p class="text-sm text-text-secondary">启用歌曲切换时的过渡效果</p>
                        </div>
                        <Switch v-model="settingStore.volumeFade" />
                      </div>
                      <div v-if="settingStore.volumeFade" class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">淡入淡出时长</h3>
                          <p class="text-sm text-text-secondary">调整歌曲切换时的过渡时长</p>
                        </div>
                        <Slider
                          class="w-48"
                          :model-value="settingStore.volumeFadeTime"
                          :min="500"
                          :max="3000"
                          :step="100"
                          show-value
                          :value-suffix="'ms'"
                          @update:model-value="settingStore.volumeFadeTime = $event"
                          @value-commit="settingStore.volumeFadeTime = $event"
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">音量均衡</h3>
                          <p class="text-sm text-text-secondary">
                            自动调整不同歌曲的音量，使播放响度保持一致
                          </p>
                        </div>
                        <Switch
                          :model-value="settingStore.volumeNormalization"
                          @update:model-value="handleVolumeNormalizationChange"
                        />
                      </div>
                      <div v-if="settingStore.volumeNormalization" class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">参考响度</h3>
                          <p class="text-sm text-text-secondary">
                            数值越高整体音量越大，越低越安静
                          </p>
                        </div>
                        <Slider
                          class="w-48"
                          :model-value="settingStore.volumeNormalizationLufs"
                          :min="-20"
                          :max="-8"
                          :step="1"
                          show-value
                          :value-suffix="' LUFS'"
                          @update:model-value="handleReferenceLufsSlider($event)"
                          @value-commit="handleReferenceLufsSlider($event)"
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">自动跳过错误</h3>
                          <p class="text-sm text-text-secondary">
                            播放失败时停留在当前歌曲，并按设定延迟自动尝试下一首
                          </p>
                        </div>
                        <Switch v-model="settingStore.autoNext" />
                      </div>
                      <div v-if="settingStore.autoNext" class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">失败后切换延迟</h3>
                          <p class="text-sm text-text-secondary">
                            给用户留出确认失败状态的时间，再自动切换
                          </p>
                        </div>
                        <InputNumber
                          class="w-[180px]"
                          :model-value="autoNextDelayInput"
                          :min="0"
                          :max="600"
                          :step="1"
                          placeholder="0"
                          suffix="秒"
                          @update:model-value="autoNextDelayInput = $event"
                        />
                      </div>
                      <div v-if="settingStore.autoNext" class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">最大自动切换次数</h3>
                          <p class="text-sm text-text-secondary">
                            连续失败时最多自动尝试的次数，避免无限跳歌
                          </p>
                        </div>
                        <InputNumber
                          class="w-[180px]"
                          :model-value="autoNextMaxAttemptsInput"
                          :min="1"
                          :max="999"
                          :step="1"
                          placeholder="10"
                          suffix="次"
                          @update:model-value="autoNextMaxAttemptsInput = $event"
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">播放恢复超时</h3>
                          <p class="text-sm text-text-secondary">
                            长时间暂停后恢复播放可能卡住，超时后自动重新加载音频源。设为 0 禁用
                          </p>
                        </div>
                        <InputNumber
                          class="w-[180px]"
                          :model-value="String(settingStore.playResumeTimeout ?? 5)"
                          :min="0"
                          :max="30"
                          :step="1"
                          placeholder="5"
                          suffix="秒"
                          @update:model-value="
                            settingStore.playResumeTimeout = Math.max(
                              0,
                              Math.min(30, Number($event) || 0),
                            )
                          "
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">防止系统休眠</h3>
                          <p class="text-sm text-text-secondary">播放音乐时阻止系统进入睡眠</p>
                        </div>
                        <Switch v-model="settingStore.preventSleep" />
                      </div>
                    </div>
                  </section>

                  <section
                    data-section="quality"
                    v-show="activeSection === 'quality'"
                    class="settings-section"
                  >
                    <div class="settings-card">
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">默认音质</h3>
                          <p class="text-sm text-text-secondary">
                            新歌曲默认按此音质解析，播放器中可临时覆盖当前歌曲
                          </p>
                        </div>
                        <Select
                          class="w-[180px]"
                          :model-value="settingStore.defaultAudioQuality"
                          :options="audioQualityOptions"
                          @update:model-value="
                            settingStore.defaultAudioQuality = $event as AudioQualityValue
                          "
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">智能兼容模式</h3>
                          <p class="text-sm text-text-secondary">首选音质不可用时自动尝试备选</p>
                        </div>
                        <Switch v-model="settingStore.compatibilityMode" />
                      </div>
                    </div>
                  </section>

                  <section
                    data-section="pageLyric"
                    v-show="activeSection === 'pageLyric'"
                    class="settings-section"
                  >
                    <div class="settings-card">
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">显示翻译</h3>
                          <p class="text-sm text-text-secondary">有翻译时在歌词页面中显示翻译行</p>
                        </div>
                        <Switch v-model="lyricStore.wantTranslation" />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">显示音译</h3>
                          <p class="text-sm text-text-secondary">有音译时在歌词页面中显示音译行</p>
                        </div>
                        <Switch v-model="lyricStore.wantRomanization" />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">字体大小</h3>
                          <p class="text-sm text-text-secondary">调整歌词页面的文字大小</p>
                        </div>
                        <Slider
                          class="w-48"
                          :model-value="lyricStore.fontScale"
                          :min="0.7"
                          :max="1.4"
                          :step="0.1"
                          show-value
                          :format-value="() => lyricFontSizeLabel"
                          @update:model-value="lyricStore.updateFontScale($event)"
                          @value-commit="lyricStore.updateFontScale($event)"
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">字体字重</h3>
                          <p class="text-sm text-text-secondary">调整歌词页面的文字粗细</p>
                        </div>
                        <Slider
                          class="w-48"
                          :model-value="lyricStore.fontWeightIndex"
                          :min="0"
                          :max="8"
                          :step="1"
                          show-value
                          :format-value="() => lyricFontWeightLabel"
                          @update:model-value="lyricStore.updateFontWeight($event)"
                          @value-commit="lyricStore.updateFontWeight($event)"
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item items-start">
                        <div class="space-y-1">
                          <h3 class="font-semibold">歌词颜色</h3>
                          <p class="text-sm text-text-secondary">
                            设置逐字歌词的已播颜色与未播颜色
                          </p>
                        </div>
                        <div class="flex items-center gap-5 pt-1">
                          <div class="flex items-center gap-2.5">
                            <span class="text-[13px] font-semibold text-text-secondary"
                              >已播字色</span
                            >
                            <button
                              type="button"
                              class="settings-color-swatch"
                              :style="{ backgroundColor: lyricStore.effectivePlayedColor }"
                              @click="lyricColorPicker.open('playedColor')"
                            ></button>
                          </div>
                          <div class="flex items-center gap-2.5">
                            <span class="text-[13px] font-semibold text-text-secondary"
                              >未播字色</span
                            >
                            <button
                              type="button"
                              class="settings-color-swatch"
                              :style="{ backgroundColor: lyricStore.effectiveUnplayedColor }"
                              @click="lyricColorPicker.open('unplayedColor')"
                            ></button>
                          </div>
                          <button
                            v-if="lyricStore.playedColor || lyricStore.unplayedColor"
                            type="button"
                            class="text-[11px] font-semibold text-text-secondary hover:text-text-main transition-colors"
                            @click="lyricColorPicker.reset"
                          >
                            重置
                          </button>
                        </div>
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">歌手写真背景</h3>
                          <p class="text-sm text-text-secondary">
                            优先使用歌手写真作为背景，获取失败时回退到专辑封面
                          </p>
                        </div>
                        <Switch v-model="settingStore.lyricArtistBackdrop" />
                      </div>
                      <div v-if="settingStore.lyricArtistBackdrop" class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">写真背景透明度</h3>
                          <p class="text-sm text-text-secondary">
                            调节歌词页写真模式下的背景透明度
                          </p>
                        </div>
                        <Slider
                          class="w-48"
                          :model-value="settingStore.lyricBackdropOpacity"
                          :min="10"
                          :max="100"
                          :step="5"
                          show-value
                          :value-suffix="'%'"
                          @update:model-value="settingStore.lyricBackdropOpacity = $event"
                          @value-commit="settingStore.lyricBackdropOpacity = $event"
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div v-if="settingStore.lyricArtistBackdrop" class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">写真自动轮播</h3>
                          <p class="text-sm text-text-secondary">多张写真时自动切换</p>
                        </div>
                        <Switch v-model="settingStore.lyricCarouselEnabled" />
                      </div>
                      <div
                        v-if="settingStore.lyricArtistBackdrop && settingStore.lyricCarouselEnabled"
                        class="settings-item"
                      >
                        <div class="space-y-1">
                          <h3 class="font-semibold">轮播间隔</h3>
                          <p class="text-sm text-text-secondary">每张写真的展示时间</p>
                        </div>
                        <Slider
                          class="w-48"
                          :model-value="settingStore.lyricCarouselInterval"
                          :min="5"
                          :max="60"
                          :step="5"
                          show-value
                          :value-suffix="'s'"
                          @update:model-value="settingStore.lyricCarouselInterval = $event"
                          @value-commit="settingStore.lyricCarouselInterval = $event"
                        />
                      </div>
                      <div v-if="settingStore.lyricArtistBackdrop" class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">歌词自动收起</h3>
                          <p class="text-sm text-text-secondary">
                            写真模式下无操作后歌词自动收起到底部两行
                          </p>
                        </div>
                        <Switch v-model="settingStore.lyricAutoCollapseEnabled" />
                      </div>
                      <div
                        v-if="
                          settingStore.lyricArtistBackdrop && settingStore.lyricAutoCollapseEnabled
                        "
                        class="settings-item"
                      >
                        <div class="space-y-1">
                          <h3 class="font-semibold">收起延迟</h3>
                          <p class="text-sm text-text-secondary">无操作后等待多久自动收起</p>
                        </div>
                        <Slider
                          class="w-48"
                          :model-value="settingStore.lyricAutoCollapseDelay"
                          :min="5"
                          :max="60"
                          :step="1"
                          show-value
                          :value-suffix="'s'"
                          @update:model-value="settingStore.lyricAutoCollapseDelay = $event"
                          @value-commit="settingStore.lyricAutoCollapseDelay = $event"
                        />
                      </div>
                      <div v-if="settingStore.lyricArtistBackdrop" class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">写真模式颜色自适应</h3>
                          <p class="text-sm text-text-secondary">
                            根据写真背景亮度自动切换按钮和控件的深浅配色
                          </p>
                        </div>
                        <Switch v-model="settingStore.lyricAdaptiveColor" />
                      </div>
                    </div>
                  </section>

                  <section
                    data-section="desktopLyric"
                    v-show="activeSection === 'desktopLyric'"
                    class="settings-section"
                  >
                    <div class="settings-card">
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">置顶显示</h3>
                          <p class="text-sm text-text-secondary">
                            关闭后桌面歌词不会固定显示在其他窗口或全屏应用之上
                          </p>
                          <p v-if="isLinux" class="text-xs text-text-secondary/70">
                            Wayland 下置顶和鼠标穿透受协议限制，建议使用 XWayland
                            模式启动或通过窗口管理器规则配置
                          </p>
                        </div>
                        <Switch
                          :model-value="desktopLyricStore.settings.alwaysOnTop"
                          @update:model-value="
                            commitDesktopLyricSettings({ alwaysOnTop: Boolean($event) })
                          "
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">双行显示</h3>
                          <p class="text-sm text-text-secondary">同时显示当前行和下一行歌词</p>
                        </div>
                        <Switch
                          :model-value="desktopLyricStore.settings.doubleLine"
                          @update:model-value="
                            commitDesktopLyricSettings({ doubleLine: Boolean($event) })
                          "
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">显示翻译</h3>
                          <p class="text-sm text-text-secondary">有翻译时在桌面歌词中显示翻译行</p>
                        </div>
                        <Switch
                          :model-value="desktopLyricStore.settings.wantTranslation"
                          @update:model-value="
                            commitDesktopLyricSettings({ wantTranslation: Boolean($event) })
                          "
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">显示音译</h3>
                          <p class="text-sm text-text-secondary">有音译时在桌面歌词中显示音译行</p>
                        </div>
                        <Switch
                          :model-value="desktopLyricStore.settings.wantRomanization"
                          @update:model-value="
                            commitDesktopLyricSettings({ wantRomanization: Boolean($event) })
                          "
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">文字对齐</h3>
                          <p class="text-sm text-text-secondary">歌词文字的排版位置</p>
                        </div>
                        <Select
                          class="w-[180px]"
                          :model-value="desktopLyricStore.settings.alignment"
                          :options="desktopLyricAlignOptions"
                          @update:model-value="
                            commitDesktopLyricSettings({ alignment: $event as any })
                          "
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">文字粗体</h3>
                          <p class="text-sm text-text-secondary">歌词使用更高字重显示</p>
                        </div>
                        <Switch
                          :model-value="desktopLyricStore.settings.bold"
                          @update:model-value="
                            commitDesktopLyricSettings({ bold: Boolean($event) })
                          "
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item items-start">
                        <div class="space-y-1">
                          <h3 class="font-semibold">文字颜色</h3>
                          <p class="text-sm text-text-secondary">
                            设置逐字歌词的已播颜色与未播颜色
                          </p>
                        </div>
                        <div class="flex items-center gap-5 pt-1">
                          <div class="flex items-center gap-2.5">
                            <span class="text-[13px] font-semibold text-text-secondary"
                              >已播字色</span
                            >
                            <button
                              type="button"
                              class="settings-color-swatch"
                              :style="{ backgroundColor: desktopLyricStore.settings.playedColor }"
                              @click="openDesktopLyricColorPicker('playedColor')"
                            ></button>
                          </div>
                          <div class="flex items-center gap-2.5">
                            <span class="text-[13px] font-semibold text-text-secondary"
                              >未播字色</span
                            >
                            <button
                              type="button"
                              class="settings-color-swatch"
                              :style="{ backgroundColor: desktopLyricStore.settings.unplayedColor }"
                              @click="openDesktopLyricColorPicker('unplayedColor')"
                            ></button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </section>

                  <ColorPickerDialog
                    :open="activeDesktopLyricColorField !== null"
                    :title="
                      activeDesktopLyricColorField === 'unplayedColor'
                        ? '选择未播字色'
                        : '选择已播字色'
                    "
                    :value="activeDesktopLyricColorValue"
                    :presets="desktopLyricColorPresets"
                    @update:open="(open) => !open && closeDesktopLyricColorPicker()"
                    @confirm="applyDesktopLyricColor"
                  />

                  <ColorPickerDialog
                    :open="lyricColorPicker.isOpen.value"
                    :title="lyricColorPicker.activeTitle.value"
                    :value="lyricColorPicker.activeValue.value"
                    :presets="lyricColorPicker.presets"
                    @update:open="(open) => !open && lyricColorPicker.close()"
                    @confirm="lyricColorPicker.apply"
                  />

                  <ColorPickerDialog
                    :open="showAccentPicker"
                    title="选择主题色"
                    :value="themeStore.customColor"
                    :presets="accentPresetValues"
                    @update:open="(open) => (showAccentPicker = open)"
                    @confirm="(color: string) => themeStore.setCustomColor(color)"
                  />

                  <section
                    data-section="shortcuts"
                    v-show="activeSection === 'shortcuts'"
                    class="settings-section"
                  >
                    <div class="settings-card">
                      <div class="shortcut-grid-header">
                        <div>功能说明</div>
                        <div class="shortcut-col-title">快捷键</div>
                        <div class="shortcut-col-title">全局快捷键</div>
                      </div>
                      <div class="settings-divider"></div>
                      <div class="shortcut-list">
                        <div
                          v-for="item in shortcutItems"
                          :key="item.command"
                          class="shortcut-grid-row"
                        >
                          <div class="space-y-1">
                            <h3 class="font-semibold">{{ item.title }}</h3>
                            <p class="text-sm text-text-secondary">{{ item.desc }}</p>
                          </div>
                          <div class="shortcut-cell shortcut-cell-offset">
                            <input
                              class="shortcut-input"
                              :class="{ recording: isRecording(item.command, 'local') }"
                              :value="getShortcutValue(item.command, 'local')"
                              :placeholder="getShortcutPlaceholder(item.command, 'local')"
                              readonly
                              @click="startRecording(item.command, 'local')"
                              @focus="startRecording(item.command, 'local')"
                            />
                          </div>
                          <div class="shortcut-cell shortcut-cell-offset">
                            <input
                              class="shortcut-input"
                              :class="{
                                recording: isRecording(item.command, 'global'),
                                'shortcut-input-disabled': !settingStore.globalShortcutsEnabled,
                              }"
                              :value="getShortcutValue(item.command, 'global')"
                              :placeholder="getShortcutPlaceholder(item.command, 'global')"
                              :disabled="!settingStore.globalShortcutsEnabled"
                              readonly
                              @click="startRecording(item.command, 'global')"
                              @focus="startRecording(item.command, 'global')"
                            />
                          </div>
                        </div>
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">启用全局快捷键</h3>
                          <p class="text-sm text-text-secondary">允许应用在后台响应系统级快捷键</p>
                        </div>
                        <Switch v-model="settingStore.globalShortcutsEnabled" />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">恢复默认</h3>
                          <p class="text-sm text-text-secondary">恢复所有快捷键为默认</p>
                        </div>
                        <Button
                          variant="outline"
                          size="xs"
                          class="settings-button"
                          @click="resetAllShortcuts"
                          >恢复默认</Button
                        >
                      </div>
                    </div>
                  </section>

                  <section
                    data-section="audioDevice"
                    v-show="activeSection === 'audioDevice'"
                    class="settings-section"
                  >
                    <div class="settings-card">
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">输入设备</h3>
                          <p class="text-sm text-text-secondary">用于听歌识曲等需要录音的功能</p>
                        </div>
                        <Select
                          class="w-[180px]"
                          :model-value="settingStore.inputDevice"
                          :options="inputDeviceOptions"
                          @update:model-value="handleInputDeviceChange"
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">输出设备</h3>
                          <p class="text-sm text-text-secondary">选择音频播放输出设备</p>
                          <p class="text-xs text-text-secondary/80">
                            当前使用：{{ currentOutputDeviceLabel }}
                          </p>
                        </div>
                        <Select
                          class="w-[180px]"
                          :model-value="settingStore.outputDevice"
                          :options="outputDeviceOptions"
                          @update:model-value="handleOutputDeviceChange($event as string)"
                        />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">独占音频设备</h3>
                          <p class="text-sm text-text-secondary">
                            绕过系统混音器直接输出，可获得更高音质，但开启后其他应用将无法播放声音
                          </p>
                        </div>
                        <Switch v-model="settingStore.exclusiveAudioDevice" />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">设备断开后的行为</h3>
                          <p class="text-sm text-text-secondary">
                            当前所选输出设备断开时，选择暂停播放或临时切换到系统默认设备
                          </p>
                        </div>
                        <Select
                          class="w-[180px]"
                          :model-value="settingStore.outputDeviceDisconnectBehavior"
                          :options="outputDeviceDisconnectBehaviorOptions"
                          @update:model-value="
                            settingStore.outputDeviceDisconnectBehavior =
                              $event as OutputDeviceDisconnectBehavior
                          "
                        />
                      </div>
                    </div>
                  </section>

                  <section
                    data-section="experimental"
                    v-show="activeSection === 'experimental'"
                    class="settings-section"
                  >
                    <div class="settings-card">
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">自动领取 VIP</h3>
                          <p class="text-sm text-text-secondary">每次启动自动领取每日 VIP</p>
                        </div>
                        <Switch v-model="settingStore.autoReceiveVip" />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">页面缓存</h3>
                          <p class="text-sm text-text-secondary">
                            缓存已访问的页面，返回时无需重新加载，关闭后所有页面不缓存
                          </p>
                        </div>
                        <Switch v-model="settingStore.keepAliveEnabled" />
                      </div>
                      <template v-if="settingStore.keepAliveEnabled">
                        <div class="settings-divider"></div>
                        <div class="settings-item">
                          <div class="space-y-1">
                            <h3 class="font-semibold">最大缓存页面数</h3>
                            <p class="text-sm text-text-secondary">
                              超出后自动释放最早缓存的页面，避免占用过多内存
                            </p>
                          </div>
                          <InputNumber
                            class="w-[180px]"
                            :model-value="String(settingStore.keepAliveMax)"
                            :min="3"
                            :max="30"
                            :step="1"
                            placeholder="20"
                            @update:model-value="
                              (val) => {
                                const parsed = Number.parseInt(String(val), 10);
                                settingStore.keepAliveMax = Number.isNaN(parsed)
                                  ? 20
                                  : Math.max(3, Math.min(parsed, 30));
                              }
                            "
                          />
                        </div>
                      </template>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">禁用 GPU 加速</h3>
                          <p class="text-sm text-text-secondary">
                            遇到界面花屏等渲染异常时可尝试开启，重启后生效
                          </p>
                        </div>
                        <Switch
                          :model-value="settingStore.disableGpuAcceleration"
                          @update:model-value="
                            (v: boolean) => {
                              settingStore.disableGpuAcceleration = v;
                              settingStore.syncDisableGpuAcceleration();
                            }
                          "
                        />
                      </div>
                    </div>
                  </section>

                  <section
                    data-section="data"
                    v-show="activeSection === 'data'"
                    class="settings-section"
                  >
                    <div class="settings-card">
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">查看运行日志</h3>
                          <p class="text-sm text-text-secondary">打开本地日志目录以供排查问题</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="xs"
                          class="settings-button"
                          @click="settingStore.openLogDirectory()"
                          >立即查看</Button
                        >
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">清除应用数据</h3>
                          <p class="text-sm text-text-secondary">移除所有持久化设置及缓存信息</p>
                        </div>
                        <Button
                          variant="danger"
                          size="xs"
                          class="settings-button danger"
                          @click="showConfirmClear = true"
                          >立即清除</Button
                        >
                      </div>
                    </div>
                  </section>

                  <section
                    data-section="about"
                    v-show="activeSection === 'about'"
                    class="settings-section"
                  >
                    <div class="settings-card">
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">自动检查更新</h3>
                          <p class="text-sm text-text-secondary">启动时自动检查是否有新版本</p>
                        </div>
                        <Switch v-model="settingStore.autoCheckUpdate" />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">检查预发布版本</h3>
                          <p class="text-sm text-text-secondary">
                            开启后可收到 Alpha/Beta/RC 版本更新推送
                          </p>
                        </div>
                        <Switch v-model="settingStore.checkPrerelease" />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">静默安装</h3>
                          <p class="text-sm text-text-secondary">
                            更新安装时不弹出安装向导，后台自动完成
                          </p>
                        </div>
                        <Switch v-model="settingStore.silentUpdate" />
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">当前版本</h3>
                          <p class="text-sm text-text-secondary">
                            Version v{{ versionLabel }} {{ releaseChannelLabel }}
                          </p>
                        </div>
                        <div class="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            size="xs"
                            class="text-text-secondary text-sm font-semibold"
                            @click="handleShowChangelog"
                            >更新日志</Button
                          >
                          <Button
                            variant="ghost"
                            size="xs"
                            class="text-primary text-sm font-semibold"
                            :disabled="isCheckingUpdate"
                            @click="handleCheckUpdates"
                            >{{ isCheckingUpdate ? '检查中...' : '检查更新' }}</Button
                          >
                        </div>
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">项目源码</h3>
                          <p class="text-sm text-text-secondary">开源共享于 GitHub</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="xs"
                          class="text-text-secondary h-10 w-10 min-w-0 p-0"
                          @click="settingStore.openRepo()"
                        >
                          <Icon :icon="iconExternalLink" width="20" height="20" />
                        </Button>
                      </div>
                      <div class="settings-divider"></div>
                      <div class="settings-item">
                        <div class="space-y-1">
                          <h3 class="font-semibold">免责声明</h3>
                          <p class="text-sm text-text-secondary">查看法律条款与免责声明</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="xs"
                          class="text-text-secondary h-10 w-10 min-w-0 p-0"
                          @click="showDisclaimer = true"
                        >
                          <Icon :icon="iconChevronRight" width="20" height="20" />
                        </Button>
                      </div>
                    </div>
                  </section>

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
                    <Scrollbar
                      class="settings-update-changelog"
                      :content-props="{ class: 'px-4 py-3' }"
                    >
                      <div class="changelog-content" v-html="changelogHtml"></div>
                    </Scrollbar>
                    <template #footer>
                      <Button variant="ghost" size="sm" @click="showChangelog = false">关闭</Button>
                    </template>
                  </Dialog>

                  <DisclaimerDialog v-model:open="showDisclaimer" />
                </div>
              </Scrollbar>
            </div>
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
@reference "@/style.css";

.settings-overlay {
  @apply fixed inset-0 bg-black/30 backdrop-blur-[1px] z-1400;
  opacity: 0;
  transition: opacity 0.16s ease-out;
}

.settings-overlay[data-state='open'] {
  opacity: 1;
  -webkit-app-region: no-drag;
}

.settings-overlay[data-state='closed'] {
  opacity: 0;
}

.settings-dialog-content {
  @apply fixed left-1/2 top-1/2 z-1410 rounded-2xl bg-bg-main border border-border-light/40 shadow-2xl flex flex-col select-none;
  width: min(860px, calc(100vw - 80px));
  min-width: 640px;
  height: min(620px, calc(100vh - 120px));
  min-height: 480px;
  padding: 0;
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.98);
  transition:
    opacity 0.18s ease-out,
    transform 0.18s ease-out;
  will-change: transform, opacity;
  overflow: hidden;
}

.settings-dialog-content[data-state='open'] {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1);
  -webkit-app-region: no-drag;
}

.settings-dialog-content[data-state='closed'] {
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.98);
}

.settings-layout {
  @apply flex h-full min-h-0;
}

.settings-nav {
  @apply w-[180px] shrink-0 flex flex-col border-r border-border-light/40 bg-bg-sidebar;
  border-radius: 16px 0 0 16px;
  padding: 20px 0;
}

.settings-nav-title {
  @apply text-[15px] font-bold text-text-main px-5 pb-4;
}

.settings-nav-list {
  @apply flex flex-col gap-0.5 px-2 overflow-y-auto flex-1;
}

.settings-nav-item {
  @apply flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium text-text-secondary transition-all duration-150 cursor-pointer;
}

.settings-nav-item:hover {
  @apply text-text-main;
  background: color-mix(in srgb, var(--color-text-main) 5%, transparent);
}

.settings-nav-item.is-active {
  @apply text-primary font-semibold;
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.settings-nav-icon {
  @apply w-4 h-4 flex items-center justify-center shrink-0;
}

.settings-nav-label {
  @apply truncate;
}

.settings-content-scroll {
  @apply flex-1 min-w-0 min-h-0;
}

:deep(.settings-content-inner) {
  padding: 12px 28px 24px 24px;
}

.settings-content {
  @apply space-y-0;
}

.settings-right {
  @apply flex-1 flex flex-col min-w-0 min-h-0;
}

.settings-right-header {
  @apply shrink-0 px-6 pt-4 pb-3 flex items-center justify-between;
}

.settings-right-title {
  @apply text-[14px] font-bold text-text-main;
}

.settings-dialog-close {
  @apply h-7 w-7 min-w-0 p-0 text-text-main/50 hover:text-text-main shrink-0;
}

.settings-card {
  @apply bg-bg-sidebar rounded-2xl p-5 space-y-5 transition-colors duration-300 border border-border-light/40 overflow-visible;
}

.settings-item {
  @apply flex items-center justify-between gap-6;
}

.settings-divider {
  @apply h-px bg-border-light/40;
}

.settings-select {
  @apply bg-bg-main text-text-main border border-border-light rounded-lg px-3 py-1.5 text-sm font-semibold focus:outline-none min-w-[160px];
}

.settings-text-input {
  width: 320px;
  height: 42px;
  padding: 0 14px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--color-border-light) 92%, transparent);
  background: color-mix(in srgb, var(--color-text-main) 4%, transparent);
  color: var(--color-text-main);
  font-size: 13px;
  font-weight: 600;
}

.settings-text-input:focus-visible {
  outline: none;
  box-shadow: none;
  border-color: color-mix(in srgb, var(--color-primary) 35%, var(--color-border-light));
}

.settings-color-input {
  width: 34px;
  height: 28px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--color-border-light) 92%, transparent);
  border-radius: 8px;
  background: transparent;
}

.dark .settings-number-input {
  color-scheme: dark;
}

.settings-number-input:focus-visible {
  outline: none;
  box-shadow: none;
  border-color: color-mix(in srgb, var(--color-primary) 35%, var(--color-border-light));
}

.settings-number-input::-webkit-outer-spin-button,
.settings-number-input::-webkit-inner-spin-button {
  margin: 0;
  opacity: 1;
  min-height: 34px;
  transform: scale(1.08);
  transform-origin: right center;
}

.shortcut-input {
  @apply w-full max-w-[220px] px-3 py-2 rounded-lg bg-bg-main border border-border-light text-[12px] font-semibold text-left;
  outline: none;
}

.shortcut-input.recording {
  border-color: #0071e3;
  color: #0071e3;
  background-color: rgba(0, 113, 227, 0.12);
  box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.25);
}

.dark .shortcut-input.recording {
  border-color: #4aa3ff;
  color: #8cc6ff;
  background-color: rgba(0, 113, 227, 0.24);
  box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.4);
}

.shortcut-input:focus-visible {
  border-color: var(--color-border-light);
  box-shadow: none;
}

.dark .shortcut-input:focus-visible {
  border-color: var(--color-border-light);
  box-shadow: none;
}

.shortcut-input::placeholder {
  color: rgba(0, 0, 0, 0.45);
}

.dark .shortcut-input::placeholder {
  color: rgba(255, 255, 255, 0.5);
}

.shortcut-input-disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.shortcut-grid-header,
.shortcut-grid-row,
.shortcut-grid-footer {
  @apply grid items-center gap-4;
  grid-template-columns: minmax(200px, 1fr) minmax(180px, 240px) minmax(180px, 240px);
}

.shortcut-grid-header {
  @apply text-[12px] text-text-secondary font-semibold tracking-wide text-left;
}

.shortcut-col-title {
  @apply text-left pl-10;
}

.shortcut-grid-row {
  @apply py-1.5;
}

.shortcut-cell {
  @apply flex items-center justify-start;
}

.shortcut-cell-offset {
  @apply pl-10;
}

.settings-warning {
  @apply mt-3 text-[12px] rounded-lg px-3 py-2;
  color: #b45309;
  background: rgba(245, 158, 11, 0.12);
}

.settings-warning-content {
  @apply flex items-center justify-between gap-3;
}

.settings-warning-content span {
  @apply min-w-0 flex-1;
}

.settings-warning.is-info {
  color: color-mix(in srgb, var(--color-text-main) 78%, var(--color-primary) 22%);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}

.settings-warning.is-danger {
  color: #dc2626;
  background: rgba(239, 68, 68, 0.12);
}

.settings-update-changelog {
  @apply max-h-[min(288px,40vh)] text-[13px] leading-6 text-text-secondary rounded-xl bg-black/3 dark:bg-white/4;
}

.changelog-content :deep(h2) {
  font-size: 14px;
  font-weight: 800;
  color: var(--color-text-main);
  margin: 16px 0 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

:global(.dark) .changelog-content :deep(h2) {
  border-bottom-color: rgba(255, 255, 255, 0.08);
}

.changelog-content :deep(h2:first-child) {
  margin-top: 0;
}

.changelog-content :deep(h3),
.changelog-content :deep(h4) {
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text-main);
  margin: 12px 0 4px;
}

.changelog-content :deep(h3:first-child),
.changelog-content :deep(h4:first-child) {
  margin-top: 0;
}

.changelog-content :deep(ul) {
  list-style: none;
  padding: 0;
  margin: 0;
}

.changelog-content :deep(li) {
  position: relative;
  padding-left: 14px;
  line-height: 1.8;
}

.changelog-content :deep(li::before) {
  content: '·';
  position: absolute;
  left: 2px;
  font-weight: 700;
}

:global(.settings-update-dialog) {
  @apply w-[520px] max-w-[92vw];
}

:global(.settings-update-body) {
  @apply pr-4 pb-1;
}

.settings-button {
  @apply px-4 py-1.5 rounded-lg bg-primary/10 text-primary text-[12px] font-semibold hover:bg-primary/20 transition-colors;
}

.settings-button.danger {
  @apply bg-red-500/10 text-red-500 hover:bg-red-500/20;
}

.settings-color-swatch {
  width: 42px;
  height: 28px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 999px;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.26);
}

.dark .settings-color-swatch {
  border-color: rgba(255, 255, 255, 0.12);
}

.accent-preset-swatch {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  border: 2px solid transparent;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.26);
  transition:
    transform 0.15s ease,
    border-color 0.15s ease;
}

.accent-preset-swatch:hover {
  transform: scale(1.08);
}

.accent-preset-swatch.is-active {
  border-color: var(--color-text-main);
  transform: scale(1.08);
}
</style>
