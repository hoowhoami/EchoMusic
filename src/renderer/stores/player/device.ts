import logger from '@/utils/logger';
import type { PlayerState } from './state';
import type { useSettingStore } from '../setting';
import type { PlayerEngine } from '@/utils/player';
import type { OutputDeviceDisconnectBehavior } from '../../types';
import {
  getPlaybackIsPlaying,
  setEnginePlaybackStatus,
  setPlaybackIntentPlayback,
} from './stateMachine';

type PlayerAudioDevice = { name: string; description: string; isDefault?: boolean };

export const createDeviceManager = (
  state: PlayerState,
  engine: PlayerEngine,
  settingStore: ReturnType<typeof useSettingStore>,
) => {
  let refreshingOutputDevices = false;
  let lastDefaultOutputDeviceId: string | null | undefined;

  const resolveDefaultOutputDeviceId = (devices: PlayerAudioDevice[]) =>
    devices.find((device) => device.isDefault)?.name ?? null;

  const isOutputDeviceError = (message: string) => {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('audio output error') ||
      normalized.includes('audio output device') ||
      normalized.includes('output device') ||
      normalized.includes('output stream') ||
      normalized.includes('output config') ||
      normalized.includes('requested device is no longer available') ||
      normalized.includes('device is no longer available')
    );
  };

  const setReadyOutputDeviceStatus = (deviceId: string) => {
    if (deviceId === 'default') {
      settingStore.setOutputDeviceStatus('ready', '当前使用系统默认输出设备。');
      return;
    }
    const matched = settingStore.outputDevices.find((item) => item.value === deviceId);
    settingStore.setOutputDeviceStatus('ready', `已切换到 ${matched?.label || deviceId}。`);
  };

  const pauseForOutputDeviceDisconnect = (message: string) => {
    if (getPlaybackIsPlaying(state)) void engine.pause();
    state.awaitingTrackLoad = false;
    setPlaybackIntentPlayback(state, false);
    setEnginePlaybackStatus(state, 'paused');
    settingStore.syncPreventSleep(false);
    settingStore.setOutputDeviceStatus('fallback', message);
  };

  const handleOutputDeviceError = async (message: string): Promise<boolean> => {
    if (!isOutputDeviceError(message)) return false;

    const disconnectBehavior =
      settingStore.outputDeviceDisconnectBehavior as OutputDeviceDisconnectBehavior;

    if (disconnectBehavior === 'pause') {
      pauseForOutputDeviceDisconnect('输出设备已不可用，已按设置暂停播放。');
      return true;
    }

    await applyOutputDevice('default', { persistSelection: false, force: true });
    settingStore.setOutputDeviceStatus('fallback', '输出设备已不可用，已临时切回系统默认设备。');
    return true;
  };

  const applyOutputDevice = async (
    deviceId: string,
    options?: { persistSelection?: boolean; force?: boolean },
  ) => {
    const persistSelection = options?.persistSelection ?? true;
    const force = options?.force ?? false;
    const playerDevice = !deviceId || deviceId === 'default' ? 'auto' : deviceId;
    const exclusive = settingStore.exclusiveAudioDevice;

    const player = window.electron?.player;
    const exclusiveChanged = exclusive !== (state._lastAppliedExclusive ?? false);
    const deviceChanged = state.appliedOutputDeviceId !== deviceId;
    let applied = false;

    if (!force && !exclusiveChanged && !deviceChanged) {
      setReadyOutputDeviceStatus(deviceId);
      return;
    }

    if (exclusiveChanged) {
      let exclusiveApplied = false;
      try {
        await player?.setExclusive(exclusive);
        exclusiveApplied = true;
      } catch {
        exclusiveApplied = false;
      }
      if (!exclusiveApplied) {
        applied = false;
      } else {
        state._lastAppliedExclusive = exclusive;
        if (!deviceChanged) {
          applied = true;
        } else {
          applied = await engine.setOutputDevice(playerDevice);
          if (applied) state.appliedOutputDeviceId = deviceId;
        }
      }
    } else {
      applied = await engine.setOutputDevice(playerDevice);
      if (applied) state.appliedOutputDeviceId = deviceId;
    }

    if (!applied && deviceId !== 'default') {
      await engine.setOutputDevice('auto');
      state.appliedOutputDeviceId = 'default';
      if (persistSelection) settingStore.outputDevice = 'default';
      settingStore.setOutputDeviceStatus('fallback', '当前设备不支持切换到所选输出，已回退。');
    } else {
      setReadyOutputDeviceStatus(deviceId);
    }
  };

  const refreshOutputDevices = async (playerDevicesArg?: PlayerAudioDevice[]) => {
    if (refreshingOutputDevices) return;
    refreshingOutputDevices = true;
    const fallbackOptions = [{ label: '系统默认', value: 'default' }];
    try {
      let playerDevices: PlayerAudioDevice[];
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

      const currentOutput = settingStore.outputDevice;
      const defaultOutputDeviceId = resolveDefaultOutputDeviceId(playerDevices);
      const hasDefaultOutputDeviceInfo = playerDevices.some(
        (device) => typeof device.isDefault === 'boolean',
      );
      const defaultOutputDeviceChanged =
        hasDefaultOutputDeviceInfo &&
        currentOutput === 'default' &&
        lastDefaultOutputDeviceId !== undefined &&
        lastDefaultOutputDeviceId !== defaultOutputDeviceId;
      lastDefaultOutputDeviceId = hasDefaultOutputDeviceInfo
        ? defaultOutputDeviceId
        : lastDefaultOutputDeviceId;
      const hasCurrentDevice =
        currentOutput === 'default' || outputOptions.some((item) => item.value === currentOutput);
      const currentOutputOptions = [...fallbackOptions, ...outputOptions];
      const previousCurrentOutputLabel =
        settingStore.outputDevices.find((item) => item.value === currentOutput)?.label ??
        currentOutput;

      if (currentOutput !== 'default' && !hasCurrentDevice) {
        currentOutputOptions.push({
          label: `${previousCurrentOutputLabel}（不可用）`,
          value: currentOutput,
        });
      }

      settingStore.outputDevices = currentOutputOptions;

      if (defaultOutputDeviceChanged && settingStore.outputDeviceDisconnectBehavior === 'pause') {
        pauseForOutputDeviceDisconnect('系统默认输出设备已变化，已按设置暂停播放。');
        return;
      }

      if (!hasCurrentDevice) {
        const disconnectBehavior =
          settingStore.outputDeviceDisconnectBehavior as OutputDeviceDisconnectBehavior;
        if (disconnectBehavior === 'fallback') {
          await applyOutputDevice('default', { persistSelection: false, force: true });
          settingStore.setOutputDeviceStatus('fallback', '所选输出设备已不可用，已临时切回。');
        } else if (disconnectBehavior === 'pause') {
          pauseForOutputDeviceDisconnect('所选输出设备已不可用，已保持选择并暂停。');
          state.appliedOutputDeviceId = currentOutput;
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

  return {
    refreshOutputDevices,
    applyOutputDevice,
    handleOutputDeviceError,
  };
};
