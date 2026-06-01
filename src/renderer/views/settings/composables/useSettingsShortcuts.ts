import { computed, onUnmounted, ref } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import type { ShortcutRecordingState, ShortcutScope } from '@/types';
import type { ShortcutCommand } from '../../../../shared/shortcuts';
import { areShortcutLabelsEquivalent, formatShortcutLabelForDisplay } from '@/utils/shortcuts';
import { shortcutItems } from '../constants';

export function useSettingsShortcuts() {
  const settingStore = useSettingStore();
  const toastStore = useToastStore();
  const recording = ref<ShortcutRecordingState | null>(null);
  const shortcutBindings = computed(() => settingStore.shortcutBindings ?? {});
  const globalShortcutBindings = computed(() => settingStore.globalShortcutBindings ?? {});
  const isMac = computed(() => window.electron?.platform === 'darwin');

  let removeRecorder: (() => void) | null = null;
  let removeOutside: (() => void) | null = null;

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

  const clearShortcut = (command: ShortcutCommand, scope: ShortcutScope) => {
    if (scope === 'global') {
      settingStore.globalShortcutBindings = { ...globalShortcutBindings.value, [command]: '' };
    } else {
      settingStore.shortcutBindings = { ...shortcutBindings.value, [command]: '' };
    }
    if (isRecording(command, scope)) stopRecording();
  };

  const startRecording = (command: ShortcutCommand, scope: ShortcutScope) => {
    if (scope === 'global' && !settingStore.globalShortcutsEnabled) return;
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
      if (!(event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)) {
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

  const resetAllShortcuts = () => {
    settingStore.resetShortcutDefaults();
    settingStore.shortcutBindings = { ...settingStore.defaultShortcutLabels };
    settingStore.globalShortcutBindings = { ...settingStore.defaultGlobalShortcutLabels };
    stopRecording();
  };

  const resetShortcut = (command: ShortcutCommand, scope: ShortcutScope) => {
    if (scope === 'global') {
      const defaultValue = settingStore.defaultGlobalShortcutLabels[command] ?? '';
      settingStore.globalShortcutBindings = {
        ...globalShortcutBindings.value,
        [command]: defaultValue,
      };
    } else {
      const defaultValue = settingStore.defaultShortcutLabels[command] ?? '';
      settingStore.shortcutBindings = { ...shortcutBindings.value, [command]: defaultValue };
    }
    if (isRecording(command, scope)) stopRecording();
  };

  const isShortcutModified = (command: ShortcutCommand, scope: ShortcutScope): boolean => {
    if (scope === 'global') {
      const current = globalShortcutBindings.value[command];
      if (current === undefined) return false;
      return current !== (settingStore.defaultGlobalShortcutLabels[command] ?? '');
    }
    const current = shortcutBindings.value[command];
    if (current === undefined) return false;
    return current !== (settingStore.defaultShortcutLabels[command] ?? '');
  };

  onUnmounted(() => {
    stopRecording();
  });

  return {
    getShortcutPlaceholder,
    getShortcutValue,
    isRecording,
    isShortcutModified,
    resetAllShortcuts,
    resetShortcut,
    shortcutBindings,
    globalShortcutBindings,
    startRecording,
    stopRecording,
  };
}
