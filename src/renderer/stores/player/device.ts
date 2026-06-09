import logger from '@/utils/logger';
import type { PlayerState } from './state';
import type { useSettingStore } from '../setting';
import type { PlayerEngine } from '@/utils/player';
import type { OutputDeviceDisconnectBehavior } from '../../types';

let outputDeviceChangeHandler:
  | ((devices: Array<{ name: string; description: string }>) => void)
  | null = null;

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

  const unregisterOutputDeviceWatcher = () => {
    outputDeviceChangeHandler = null;
    state.outputDeviceWatcherRegistered = false;
    clearOutputDeviceRefreshTimer();
  };

  const applyOutputDevice = async (deviceId: string, options?: { persistSelection?: boolean }) => {
    const persistSelection = options?.persistSelection ?? true;
    const playerDevice = !deviceId || deviceId === 'default' ? 'auto' : deviceId;
    const exclusive = settingStore.exclusiveAudioDevice;

    const player = window.electron?.player;
    const exclusiveChanged = exclusive !== (state._lastAppliedExclusive ?? false);
    const deviceChanged = state.appliedOutputDeviceId !== deviceId;
    let applied = false;

    if (exclusiveChanged) {
      try {
        const exclusiveApplied = await player?.setExclusive(exclusive);
        if (!exclusiveApplied) {
          throw new Error('exclusive mode was rejected by the audio backend');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('PlayerDevice', 'Failed to apply exclusive audio mode', message);
        settingStore.exclusiveAudioDevice = !exclusive;
        state._lastAppliedExclusive = !exclusive;
        settingStore.setOutputDeviceStatus(
          'fallback',
          '当前平台或设备暂不支持独占输出，已保持共享模式。',
        );
        return;
      }
      state._lastAppliedExclusive = exclusive;
      applied = deviceChanged ? await engine.setOutputDevice(playerDevice) : true;
      if (applied) state.appliedOutputDeviceId = deviceId;
    } else {
      applied = await engine.setOutputDevice(playerDevice);
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
    playerDevicesArg?: Array<{ name: string; description: string }>,
  ) => {
    const fallbackOptions = [{ label: '系统默认', value: 'default' }];
    try {
      let playerDevices: Array<{ name: string; description: string }>;
      if (playerDevicesArg) {
        playerDevices = playerDevicesArg;
      } else {
        try {
          playerDevices = (await window.electron?.player?.getAudioDevices()) ?? [];
        } catch {
          playerDevices = [];
        }
      }

      if (!Array.isArray(playerDevices) || playerDevices.length === 0) {
        settingStore.outputDevices = fallbackOptions;
        settingStore.setOutputDeviceStatus('ready', '当前仅检测到系统默认输出设备。');
        return;
      }

      const outputOptions = playerDevices
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
    }
  };

  const registerOutputDeviceWatcher = () => {
    if (state.outputDeviceWatcherRegistered) return;
    state.outputDeviceWatcherRegistered = true;

    if (!window.electron?.player?.onAudioDeviceListChanged) return;

    outputDeviceChangeHandler = () => {
      clearOutputDeviceRefreshTimer();
      state.outputDeviceRefreshTimer = window.setTimeout(() => {
        state.outputDeviceRefreshTimer = null;
        void refreshOutputDevices();
      }, 800);
    };
    window.electron.player.onAudioDeviceListChanged(outputDeviceChangeHandler);
  };

  return {
    clearOutputDeviceRefreshTimer,
    unregisterOutputDeviceWatcher,
    refreshOutputDevices,
    applyOutputDevice,
    registerOutputDeviceWatcher,
  };
};
