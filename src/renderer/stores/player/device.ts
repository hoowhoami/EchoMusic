import logger from '@/utils/logger';
import type { PlayerState } from './state';
import type { useSettingStore } from '../setting';
import type { PlayerEngine } from '@/utils/player';
import type { OutputDeviceDisconnectBehavior } from '../../types';

const OUTPUT_DEVICE_REFRESH_DEBOUNCE_MS = 800;
const OUTPUT_DEVICE_POLL_INTERVAL_MS = 8000;

export const createDeviceManager = (
  state: PlayerState,
  engine: PlayerEngine,
  settingStore: ReturnType<typeof useSettingStore>,
) => {
  const clearOutputDeviceRefreshTimer = () => {
    if (state.outputDeviceRefreshTimer !== null) {
      window.clearTimeout(state.outputDeviceRefreshTimer);
      state.outputDeviceRefreshTimer = null;
    }
  };

  const clearOutputDevicePollTimer = () => {
    if (state.outputDevicePollTimer !== null) {
      window.clearInterval(state.outputDevicePollTimer);
      state.outputDevicePollTimer = null;
    }
  };

  let removeMediaDeviceChangeListener: (() => void) | null = null;
  let refreshingOutputDevices = false;

  const scheduleOutputDeviceRefresh = (delayMs = OUTPUT_DEVICE_REFRESH_DEBOUNCE_MS) => {
    clearOutputDeviceRefreshTimer();
    state.outputDeviceRefreshTimer = window.setTimeout(() => {
      state.outputDeviceRefreshTimer = null;
      void refreshOutputDevices();
    }, delayMs);
  };

  const unregisterOutputDeviceWatcher = () => {
    state.outputDeviceWatcherRegistered = false;
    clearOutputDeviceRefreshTimer();
    clearOutputDevicePollTimer();
    removeMediaDeviceChangeListener?.();
    removeMediaDeviceChangeListener = null;
  };

  const applyOutputDevice = async (deviceId: string, options?: { persistSelection?: boolean }) => {
    const persistSelection = options?.persistSelection ?? true;
    const mpvDevice = !deviceId || deviceId === 'default' ? 'auto' : deviceId;
    const exclusive = settingStore.exclusiveAudioDevice;

    const mpv = window.electron?.mpv;
    const exclusiveChanged = exclusive !== (state._lastAppliedExclusive ?? false);
    let applied = false;

    if (exclusiveChanged) {
      const wasPlaying = state.isPlaying;
      try {
        await mpv?.setExclusive(exclusive);
      } catch {
        // ignore
      }
      state._lastAppliedExclusive = exclusive;
      applied = await engine.setOutputDevice(mpvDevice);
      if (applied) state.appliedOutputDeviceId = deviceId;

      if (wasPlaying && state.currentTrackId && state.currentAudioUrl) {
        const savedUrl = state.currentAudioUrl;
        const savedTime = state.currentTime;
        engine.reset();
        engine.setSource(savedUrl);
        await engine.play();
        if (savedTime > 0) engine.seek(savedTime);
      }
    } else {
      applied = await engine.setOutputDevice(mpvDevice);
      if (applied) state.appliedOutputDeviceId = deviceId;
    }

    if (!applied && deviceId !== 'default') {
      await engine.setOutputDevice('auto');
      state.appliedOutputDeviceId = 'default';
      if (persistSelection) settingStore.outputDevice = 'default';
      settingStore.setOutputDeviceStatus('fallback', '当前设备不支持切换到所选输出，已回退。');
    } else if (deviceId === 'default') {
      settingStore.setOutputDeviceStatus('ready', '当前使用系统默认输出设备。');
    } else {
      const matched = settingStore.outputDevices.find((item) => item.value === deviceId);
      settingStore.setOutputDeviceStatus('ready', `已切换到 ${matched?.label || deviceId}。`);
    }
  };

  const refreshOutputDevices = async (
    mpvDevicesArg?: Array<{ name: string; description: string }>,
  ) => {
    if (refreshingOutputDevices) return;
    refreshingOutputDevices = true;
    const fallbackOptions = [{ label: '系统默认', value: 'default' }];
    try {
      let mpvDevices: Array<{ name: string; description: string }>;
      if (mpvDevicesArg) {
        mpvDevices = mpvDevicesArg;
      } else {
        try {
          mpvDevices = (await window.electron?.mpv?.getAudioDevices()) ?? [];
        } catch {
          mpvDevices = [];
        }
      }

      if (!Array.isArray(mpvDevices) || mpvDevices.length === 0) {
        settingStore.outputDevices = fallbackOptions;
        settingStore.setOutputDeviceStatus('ready', '当前仅检测到系统默认输出设备。');
        return;
      }

      const outputOptions = mpvDevices
        .filter((d) => d.name && d.name !== 'auto' && d.name !== 'null')
        .map((d) => ({ label: d.description || d.name, value: d.name }))
        .filter(
          (item, index, arr) => arr.findIndex((other) => other.label === item.label) === index,
        );

      settingStore.outputDevices = [...fallbackOptions, ...outputOptions];

      const currentOutput = settingStore.outputDevice;
      const hasCurrentDevice =
        currentOutput === 'default' || outputOptions.some((item) => item.value === currentOutput);

      if (!hasCurrentDevice) {
        const disconnectBehavior =
          settingStore.outputDeviceDisconnectBehavior as OutputDeviceDisconnectBehavior;
        if (disconnectBehavior === 'fallback') {
          await applyOutputDevice('default', { persistSelection: false });
          settingStore.setOutputDeviceStatus('fallback', '所选输出设备已不可用，已临时切回。');
        } else if (disconnectBehavior === 'pause' && state.isPlaying) {
          engine.pause();
          settingStore.setOutputDeviceStatus('fallback', '所选输出设备已不可用，播放已暂停。');
        }
        return;
      }

      await applyOutputDevice(currentOutput);
    } catch (error) {
      logger.warn('PlayerDevice', 'Refresh output devices failed:', error);
      settingStore.outputDevices = fallbackOptions;
    } finally {
      refreshingOutputDevices = false;
    }
  };

  const registerOutputDeviceWatcher = () => {
    if (state.outputDeviceWatcherRegistered) return;
    state.outputDeviceWatcherRegistered = true;

    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices?.addEventListener) {
      // Chromium 的 devicechange 只作为“设备拓扑可能变了”的信号。
      // 输出设备 ID 仍统一从 mpv audio-device-list 获取，避免混用浏览器 deviceId。
      const handleDeviceChange = () => scheduleOutputDeviceRefresh();
      mediaDevices.addEventListener('devicechange', handleDeviceChange);
      removeMediaDeviceChangeListener = () => {
        mediaDevices.removeEventListener('devicechange', handleDeviceChange);
      };
    }

    state.outputDevicePollTimer = window.setInterval(() => {
      void refreshOutputDevices();
    }, OUTPUT_DEVICE_POLL_INTERVAL_MS);
  };

  return {
    clearOutputDeviceRefreshTimer,
    unregisterOutputDeviceWatcher,
    refreshOutputDevices,
    applyOutputDevice,
    registerOutputDeviceWatcher,
  };
};
