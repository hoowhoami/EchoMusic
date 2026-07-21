import logger from '@/utils/logger';
import type { PlayerState } from './state';
import type { useSettingStore } from '../setting';
import type { PlayerEngine } from '@/utils/player';
import type { PlayerErrorCode, PlayerErrorPayload } from '../../../shared/player-error';
import {
  getPlaybackIsPlaying,
  setEnginePlaybackStatus,
  setPlaybackIntentPlayback,
} from './stateMachine';

type PlayerAudioDevice = { name: string; description: string; isDefault?: boolean };
type NativePlayerState = {
  playing?: boolean;
  paused?: boolean;
  duration?: number;
  timePos?: number;
} | null;
type PlayerAudioDeviceListChangedPayload = {
  devices: PlayerAudioDevice[];
  deviceChangeKind?: string;
  disconnectedDevices?: PlayerAudioDevice[];
};
type DeviceManagerCallbacks = {
  recoverPlaybackStatusAfterOutputChange?: (playerState: NativePlayerState) => void;
};

export const createDeviceManager = (
  state: PlayerState,
  engine: PlayerEngine,
  settingStore: ReturnType<typeof useSettingStore>,
  callbacks: DeviceManagerCallbacks = {},
) => {
  let refreshingOutputDevices = false;
  let applyingOutputDevice = false;
  let lastDefaultOutputDeviceId: string | null | undefined;

  const resolveDefaultOutputDeviceId = (devices: PlayerAudioDevice[]) =>
    devices.find((device) => device.isDefault)?.name ?? null;

  const isConcreteOutputDevice = (device: PlayerAudioDevice) =>
    Boolean(device.name && device.name !== 'auto' && device.name !== 'null');

  const outputDeviceErrorCodes = new Set<PlayerErrorCode>([
    'output-config',
    'output-device-unavailable',
    'output-exclusive',
    'output-runtime',
    'output-stream',
  ]);

  const isOutputDeviceError = (error: PlayerErrorPayload) => {
    if (error.errorCode && outputDeviceErrorCodes.has(error.errorCode)) return true;
    const message = error.message || '';
    const normalized = message.toLowerCase();
    return (
      normalized.includes('audio output error') ||
      normalized.includes('audio output device') ||
      normalized.includes('output device') ||
      normalized.includes('output stream') ||
      normalized.includes('output config') ||
      normalized.includes('exclusive output') ||
      normalized.includes('requested device is no longer available') ||
      normalized.includes('device is no longer available')
    );
  };

  const isExclusiveOutputError = (error: PlayerErrorPayload) =>
    error.errorCode === 'output-exclusive' ||
    error.message.toLowerCase().includes('exclusive output');

  const setReadyOutputDeviceStatus = (deviceId: string) => {
    if (deviceId === 'default') {
      settingStore.setOutputDeviceStatus('ready', '当前使用系统默认输出设备。');
      return;
    }
    const matched = settingStore.outputDevices.find((item) => item.value === deviceId);
    settingStore.setOutputDeviceStatus('ready', `已切换到 ${matched?.label || deviceId}。`);
  };

  const recoverPlaybackStatusAfterOutputChange = async () => {
    if (!callbacks.recoverPlaybackStatusAfterOutputChange) return;
    try {
      const playerState = (await window.electron?.player?.getState?.()) ?? null;
      callbacks.recoverPlaybackStatusAfterOutputChange(playerState);
    } catch (error) {
      logger.warn('PlayerDevice', 'Read player state after output change failed:', error);
    }
  };

  const pauseForOutputDeviceDisconnect = (message: string) => {
    if (getPlaybackIsPlaying(state)) void engine.pause();
    state.awaitingTrackLoad = false;
    setPlaybackIntentPlayback(state, false);
    setEnginePlaybackStatus(state, 'paused');
    settingStore.syncPreventSleep(false);
    settingStore.setOutputDeviceStatus('fallback', message);
  };

  const recoverFromExclusiveOutputError = async () => {
    if (!settingStore.exclusiveAudioDevice && !state._lastAppliedExclusive) return false;
    applyingOutputDevice = true;
    try {
      await window.electron?.player?.setExclusive(false);
      state._lastAppliedExclusive = false;
      if (settingStore.exclusiveAudioDevice) {
        settingStore.exclusiveAudioDevice = false;
      }
      settingStore.setOutputDeviceStatus('fallback', '独占音频输出不可用，已切回普通输出。');
      await recoverPlaybackStatusAfterOutputChange();
      return true;
    } catch (error) {
      logger.warn('PlayerDevice', 'Recover from exclusive audio output failed:', error);
      return false;
    } finally {
      applyingOutputDevice = false;
    }
  };

  const handleOutputDeviceError = async (error: PlayerErrorPayload): Promise<boolean> => {
    if (!isOutputDeviceError(error)) return false;

    if (applyingOutputDevice) return true;

    if (isExclusiveOutputError(error) && (await recoverFromExclusiveOutputError())) return true;

    if (settingStore.pauseOnOutputDeviceDisconnect) {
      pauseForOutputDeviceDisconnect('输出设备不可用，已暂停播放。');
      return true;
    }

    if (settingStore.outputDevice !== 'default' && state.appliedOutputDeviceId === 'default') {
      settingStore.setOutputDeviceStatus('fallback', '输出设备已不可用，已临时切回系统默认设备。');
      await recoverPlaybackStatusAfterOutputChange();
      return true;
    }

    const applied = await applyOutputDevice('default', { persistSelection: false, force: true });
    if (applied && settingStore.outputDevice === 'default') {
      settingStore.setOutputDeviceStatus('ready', '系统默认输出设备已变化，已继续跟随系统。');
      return true;
    }

    if (applied) {
      settingStore.setOutputDeviceStatus('fallback', '输出设备已不可用，已临时切回系统默认设备。');
    } else {
      pauseForOutputDeviceDisconnect('输出设备不可用，已暂停播放。');
    }
    return true;
  };

  const applyOutputDeviceUnchecked = async (
    deviceId: string,
    options?: { persistSelection?: boolean; force?: boolean },
  ): Promise<boolean> => {
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
      return true;
    }

    if (exclusiveChanged) {
      let exclusiveApplied = false;
      let exclusiveError = '';
      try {
        await player?.setExclusive(exclusive);
        exclusiveApplied = true;
      } catch (error) {
        exclusiveError = String(error);
        exclusiveApplied = false;
      }
      if (!exclusiveApplied) {
        const previousExclusive = state._lastAppliedExclusive ?? false;
        state._lastAppliedExclusive = previousExclusive;
        if (settingStore.exclusiveAudioDevice !== previousExclusive) {
          settingStore.exclusiveAudioDevice = previousExclusive;
        }
        settingStore.setOutputDeviceStatus(
          'fallback',
          exclusive
            ? '独占音频设备不可用，已保持当前输出模式。'
            : '关闭独占音频设备失败，已保持当前输出模式。',
        );
        logger.warn('PlayerDevice', 'Apply exclusive audio output failed:', exclusiveError);
        return false;
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

    if (!applied) {
      if (deviceId === 'default') {
        settingStore.setOutputDeviceStatus('fallback', '切换到系统默认输出设备失败。');
        return false;
      }
      const fallbackApplied = await engine.setOutputDevice('auto');
      if (fallbackApplied) state.appliedOutputDeviceId = 'default';
      if (persistSelection && fallbackApplied) settingStore.outputDevice = 'default';
      settingStore.setOutputDeviceStatus(
        'fallback',
        fallbackApplied
          ? '当前设备不支持切换到所选输出，已回退。'
          : '当前设备不支持切换到所选输出，且回退系统默认失败。',
      );
      if (fallbackApplied) await recoverPlaybackStatusAfterOutputChange();
      return fallbackApplied;
    } else {
      setReadyOutputDeviceStatus(deviceId);
      await recoverPlaybackStatusAfterOutputChange();
      return true;
    }
  };

  const applyOutputDevice = async (
    deviceId: string,
    options?: { persistSelection?: boolean; force?: boolean },
  ): Promise<boolean> => {
    if (applyingOutputDevice) return false;
    applyingOutputDevice = true;
    try {
      return await applyOutputDeviceUnchecked(deviceId, options);
    } finally {
      applyingOutputDevice = false;
    }
  };

  const refreshOutputDevices = async (
    playerDevicesArg?: PlayerAudioDevice[] | PlayerAudioDeviceListChangedPayload,
  ) => {
    if (refreshingOutputDevices) return;
    refreshingOutputDevices = true;
    const fallbackOptions = [{ label: '系统默认', value: 'default' }];
    try {
      let playerDevices: PlayerAudioDevice[];
      let disconnectedDevices: PlayerAudioDevice[] = [];
      if (Array.isArray(playerDevicesArg)) {
        playerDevices = playerDevicesArg;
      } else if (playerDevicesArg) {
        playerDevices = Array.isArray(playerDevicesArg.devices) ? playerDevicesArg.devices : [];
        disconnectedDevices = Array.isArray(playerDevicesArg.disconnectedDevices)
          ? playerDevicesArg.disconnectedDevices
          : [];
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
        .filter(isConcreteOutputDevice)
        .map((d) => ({ label: d.description || d.name, value: d.name }))
        .filter(
          (item, index, arr) => arr.findIndex((other) => other.label === item.label) === index,
        );

      const currentOutput = settingStore.outputDevice;
      const hasDisconnectedOutputDevice = disconnectedDevices.some(isConcreteOutputDevice);
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

      if (hasDisconnectedOutputDevice && settingStore.pauseOnOutputDeviceDisconnect) {
        pauseForOutputDeviceDisconnect('检测到输出设备断开，已暂停播放。');
        return;
      }

      if (defaultOutputDeviceChanged && currentOutput === 'default') {
        const applied = await applyOutputDevice('default', {
          persistSelection: false,
          force: true,
        });
        if (applied) {
          settingStore.setOutputDeviceStatus('ready', '系统默认输出设备已变化，已继续跟随系统。');
        }
        return;
      }

      if (!hasCurrentDevice) {
        if (settingStore.pauseOnOutputDeviceDisconnect) {
          pauseForOutputDeviceDisconnect('所选输出设备已不可用，已暂停播放。');
          state.appliedOutputDeviceId = currentOutput;
        } else if (state.appliedOutputDeviceId === 'default') {
          settingStore.setOutputDeviceStatus('fallback', '所选输出设备已不可用，已临时切回。');
          await recoverPlaybackStatusAfterOutputChange();
        } else {
          await applyOutputDevice('default', { persistSelection: false, force: true });
          settingStore.setOutputDeviceStatus('fallback', '所选输出设备已不可用，已临时切回。');
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
