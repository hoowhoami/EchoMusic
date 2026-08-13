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
type OutputDevicesRefreshArg = PlayerAudioDevice[] | PlayerAudioDeviceListChangedPayload;
type PlayerCoreStateChangedPayload = {
  state?: string;
  reason?: string;
};
type DeviceManagerCallbacks = {
  recoverPlaybackStatusAfterOutputChange?: (playerState: NativePlayerState) => void;
};

const OUTPUT_RECONFIG_SETTLE_MS = 3000;

export const createDeviceManager = (
  state: PlayerState,
  engine: PlayerEngine,
  settingStore: ReturnType<typeof useSettingStore>,
  callbacks: DeviceManagerCallbacks = {},
) => {
  let refreshingOutputDevices = false;
  let applyingOutputDevice = false;
  let applyingOutputDeviceKey: string | null = null;
  let applyingOutputDevicePromise: Promise<boolean> | null = null;
  let queuedOutputDevicesRefresh: OutputDevicesRefreshArg | true | null = null;
  let nativeOutputReconfigActive = false;
  let outputReconfigSettleUntil = 0;

  const isConcreteOutputDevice = (device: PlayerAudioDevice) =>
    Boolean(device.name && device.name !== 'auto' && device.name !== 'null');

  const outputDeviceErrorCodes = new Set<PlayerErrorCode>([
    'output-config',
    'output-device-unavailable',
    'output-exclusive',
    'output-runtime',
    'output-stream',
  ]);
  const deviceRecoveryReasons = new Set([
    'device-not-available',
    'device-changed',
    'stream-invalidated',
  ]);

  const isDeviceRecoveryReason = (reason?: string) =>
    reason !== undefined && deviceRecoveryReasons.has(reason);

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
      normalized.includes('no audio output device available') ||
      normalized.includes('failed to get default wasapi output device') ||
      normalized.includes('requested device is no longer available') ||
      normalized.includes('device is no longer available')
    );
  };

  const isNoOutputDeviceAvailableError = (error: PlayerErrorPayload) => {
    const normalized = (error.message || '').toLowerCase();
    return (
      normalized.includes('no audio output device available') ||
      normalized.includes('failed to get default wasapi output device')
    );
  };

  const beginIntentionalOutputReconfig = () => {
    nativeOutputReconfigActive = true;
    outputReconfigSettleUntil = Date.now() + OUTPUT_RECONFIG_SETTLE_MS;
  };

  const settleIntentionalOutputReconfig = () => {
    nativeOutputReconfigActive = false;
    outputReconfigSettleUntil = Date.now() + OUTPUT_RECONFIG_SETTLE_MS;
  };

  const isIntentionalOutputReconfigActive = () =>
    applyingOutputDevice || nativeOutputReconfigActive || Date.now() < outputReconfigSettleUntil;

  const handleCoreStateChange = (payload: PlayerCoreStateChangedPayload) => {
    if (payload.state === 'output-reconfig') {
      beginIntentionalOutputReconfig();
      return;
    }
    if (nativeOutputReconfigActive) {
      settleIntentionalOutputReconfig();
    }
  };

  const setReadyOutputDeviceStatus = (deviceId: string) => {
    if (deviceId === 'default') {
      settingStore.setOutputDeviceStatus('ready', '当前使用系统默认输出设备。');
      return;
    }
    const matched = settingStore.outputDevices.find((item) => item.value === deviceId);
    settingStore.setOutputDeviceStatus('ready', `已切换到 ${matched?.label || deviceId}。`);
  };

  const outputDeviceApplyKey = (deviceId: string, exclusive: boolean) =>
    `${!deviceId || deviceId === 'default' ? 'default' : deviceId}\u0000${exclusive ? 'exclusive' : 'shared'}`;

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
    state.lastError = 'output-device-unavailable';
    state.playbackNotice = {
      code: 'output-device-unavailable',
      title: '输出设备不可用',
      reason: message.replace(/，?已暂停播放。?$/, ''),
      detail: '连接或启用音频输出设备后重试',
      trackId: state.currentTrackId ? String(state.currentTrackId) : null,
    };
    state.awaitingTrackLoad = false;
    state.supersededNativeTrackSeq = null;
    state.stallRecovering = false;
    setPlaybackIntentPlayback(state, false);
    setEnginePlaybackStatus(state, 'paused');
    settingStore.syncPreventSleep(false);
    settingStore.setOutputDeviceStatus('error', message);
  };

  const handleOutputDeviceError = async (error: PlayerErrorPayload): Promise<boolean> => {
    if (!isOutputDeviceError(error)) return false;

    if (isIntentionalOutputReconfigActive()) {
      const isEscalatedDeviceError =
        isDeviceRecoveryReason(error.reason) &&
        !applyingOutputDevice &&
        !nativeOutputReconfigActive;
      if (!isEscalatedDeviceError && !isNoOutputDeviceAvailableError(error)) return true;
    }

    const message =
      error.errorCode === 'output-exclusive'
        ? '独占音频输出不可用，已保持当前输出配置并暂停播放。'
        : '输出设备不可用，已暂停播放。';
    pauseForOutputDeviceDisconnect(message);
    return true;
  };

  const applyOutputDeviceUnchecked = async (
    deviceId: string,
    options?: { force?: boolean },
  ): Promise<boolean> => {
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

    try {
      if (!player?.setAudioOutput) throw new Error('atomic audio output API is unavailable');
      await player.setAudioOutput(playerDevice, exclusive);
      state._lastAppliedExclusive = exclusive;
      state.appliedOutputDeviceId = deviceId;
      applied = true;
    } catch (error) {
      if (exclusiveChanged) {
        const previousExclusive = state._lastAppliedExclusive ?? false;
        if (settingStore.exclusiveAudioDevice !== previousExclusive) {
          settingStore.exclusiveAudioDevice = previousExclusive;
        }
      }
      logger.warn('PlayerDevice', 'Apply audio output failed:', String(error));
    }

    if (!applied) {
      settingStore.setOutputDeviceStatus(
        'error',
        deviceId === 'default'
          ? '系统默认输出设备不可用，已保持当前输出。'
          : '所选输出设备不可用，已保持当前输出。',
      );
      return false;
    } else {
      setReadyOutputDeviceStatus(deviceId);
      await recoverPlaybackStatusAfterOutputChange();
      return true;
    }
  };

  const applyOutputDevice = async (
    deviceId: string,
    options?: { force?: boolean },
  ): Promise<boolean> => {
    const applyKey = outputDeviceApplyKey(deviceId, settingStore.exclusiveAudioDevice);
    if (applyingOutputDevice) {
      if (applyingOutputDeviceKey === applyKey && applyingOutputDevicePromise) {
        return applyingOutputDevicePromise;
      }
      return false;
    }
    applyingOutputDevice = true;
    applyingOutputDeviceKey = applyKey;
    beginIntentionalOutputReconfig();
    applyingOutputDevicePromise = applyOutputDeviceUnchecked(deviceId, options);
    try {
      return await applyingOutputDevicePromise;
    } finally {
      settleIntentionalOutputReconfig();
      applyingOutputDevice = false;
      applyingOutputDeviceKey = null;
      applyingOutputDevicePromise = null;
    }
  };

  const refreshOutputDevicesOnce = async (playerDevicesArg?: OutputDevicesRefreshArg) => {
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
        if (
          settingStore.pauseOnOutputDeviceDisconnect &&
          (getPlaybackIsPlaying(state) || state.playbackIntent.phase === 'loading')
        ) {
          pauseForOutputDeviceDisconnect('未检测到可用输出设备，已暂停播放。');
        } else {
          settingStore.setOutputDeviceStatus('error', '未检测到可用输出设备。');
        }
        return;
      }

      const outputOptions = playerDevices
        .filter(isConcreteOutputDevice)
        .map((d) => ({ label: d.description || d.name, value: d.name }))
        .filter(
          (item, index, arr) => arr.findIndex((other) => other.label === item.label) === index,
        );

      const currentOutput = settingStore.outputDevice;
      const hasDisconnectedOutputDevice = disconnectedDevices.some(
        (device) => isConcreteOutputDevice(device) && device.name === currentOutput,
      );
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

      const shouldPauseForDisconnect =
        settingStore.pauseOnOutputDeviceDisconnect && !isIntentionalOutputReconfigActive();

      if (hasDisconnectedOutputDevice && shouldPauseForDisconnect) {
        pauseForOutputDeviceDisconnect('检测到输出设备断开，已暂停播放。');
        return;
      }

      if (!hasCurrentDevice) {
        if (shouldPauseForDisconnect) {
          pauseForOutputDeviceDisconnect('所选输出设备已不可用，已暂停播放。');
          state.appliedOutputDeviceId = currentOutput;
        } else {
          settingStore.setOutputDeviceStatus('error', '所选输出设备当前不可用。');
        }
        return;
      }

      await applyOutputDevice(currentOutput);
    } catch (error) {
      logger.warn('PlayerDevice', 'Refresh output devices failed:', error);
      settingStore.outputDevices = fallbackOptions;
    }
  };

  const refreshOutputDevices = async (playerDevicesArg?: OutputDevicesRefreshArg) => {
    if (refreshingOutputDevices) {
      queuedOutputDevicesRefresh = playerDevicesArg ?? true;
      return;
    }
    refreshingOutputDevices = true;
    try {
      let nextArg = playerDevicesArg;
      while (true) {
        queuedOutputDevicesRefresh = null;
        await refreshOutputDevicesOnce(nextArg);

        const queuedArg = queuedOutputDevicesRefresh;
        if (!queuedArg) break;
        nextArg = queuedArg === true ? undefined : queuedArg;
      }
    } finally {
      refreshingOutputDevices = false;
    }
  };

  return {
    refreshOutputDevices,
    applyOutputDevice,
    handleOutputDeviceError,
    handleCoreStateChange,
  };
};
