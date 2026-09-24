import log from '../logger';
import { getMainWindow } from '../window';
import { PlayerController } from './controller';
import type { PlayerErrorPayload } from '../../shared/playerError';
import {
  beginDesktopLyricPlaybackBridgeTransition,
  patchDesktopLyricPlaybackFromPlayer,
} from '../desktopLyric';
import {
  beginMiniPlayerPlaybackBridgeTransition,
  patchMiniPlayerPlaybackFromPlayer,
} from '../miniPlayer';
import { destroyTaskbarProgress, setupTaskbarProgress } from '../taskbarProgress';
import { getOutputHost } from '../outputs/outputHost';

let playerController: PlayerController | null = null;
let cachedGetMainWindow: (() => Electron.BrowserWindow | null) | null = null;

export async function initPlayer(getWindow: () => Electron.BrowserWindow | null) {
  cachedGetMainWindow = getWindow;
  const controller = new PlayerController();
  if (!controller.available) {
    log.warn('[Main] player engine addon not found');
    return null;
  }
  registerEventForwarding(controller);
  setupTaskbarProgress(controller);
  if (!controller.start()) return null;
  playerController = controller;
  log.info('[Main] player engine started successfully');
  return controller;
}

export async function restartPlayer() {
  destroyPlayer();
  return initPlayer(cachedGetMainWindow ?? getMainWindow);
}

export function destroyPlayer(): void {
  playerController?.destroy();
  destroyTaskbarProgress();
  playerController = null;
}

function localPlaybackSuppressed(): boolean {
  return getOutputHost()?.suppressLocalPlaybackEvents === true;
}

/** 本机和远端共用的播放事件出口。DLNA 期间本机回调先被丢掉，避免旧 EOF 推进新队列。 */
export function publishPlayerEvent(name: string, payload?: unknown, extra?: unknown): void {
  const window = getMainWindow();
  if (name === 'time-update') {
    const body = (payload ?? {}) as { time?: number; trackSeq?: number };
    window?.webContents.send('player:time-update', body);
    if (typeof body.time === 'number') {
      patchDesktopLyricPlaybackFromPlayer({
        currentTime: body.time,
        trackSeq: body.trackSeq,
        reason: 'tick',
      });
      patchMiniPlayerPlaybackFromPlayer({
        currentTime: body.time,
        trackSeq: body.trackSeq,
        reason: 'tick',
      });
    }
    return;
  }
  if (name === 'seeked' && typeof payload === 'number') {
    window?.webContents.send('player:seeked', payload);
    patchDesktopLyricPlaybackFromPlayer({ currentTime: payload, reason: 'seek' });
    patchMiniPlayerPlaybackFromPlayer({ currentTime: payload, reason: 'seek' });
    return;
  }
  if (name === 'state-change') {
    const state = (payload ?? {}) as {
      timePos?: number;
      duration?: number;
      playing?: boolean;
      speed?: number;
      trackSeq?: number;
    };
    window?.webContents.send('player:state-change', state);
    const patch = {
      currentTime: state.timePos,
      duration: state.duration,
      isPlaying: Boolean(state.playing),
      playbackRate: state.speed,
      trackSeq: state.trackSeq,
      reason: state.playing ? ('play' as const) : ('pause' as const),
    };
    patchDesktopLyricPlaybackFromPlayer(patch);
    patchMiniPlayerPlaybackFromPlayer(patch);
    return;
  }
  if (name === 'playback-end') {
    window?.webContents.send('player:playback-end', payload, extra);
    patchDesktopLyricPlaybackFromPlayer({ isPlaying: false, reason: 'pause' });
    patchMiniPlayerPlaybackFromPlayer({ isPlaying: false, reason: 'pause' });
    return;
  }
  if (name === 'error') {
    window?.webContents.send('player:error', payload);
  }
}

function registerEventForwarding(controller: PlayerController): void {
  controller.on('time-update', (payload) => {
    if (localPlaybackSuppressed()) return;
    const output = getOutputHost();
    const next =
      output?.airplayActive && typeof payload?.time === 'number'
        ? { ...payload, time: Math.max(0, payload.time - output.airplayDelaySec()) }
        : payload;
    publishPlayerEvent('time-update', next);
  });
  controller.on('seeked', (time) => {
    if (localPlaybackSuppressed()) return;
    publishPlayerEvent('seeked', time);
  });
  controller.on('seek-state-change', (payload) => {
    if (localPlaybackSuppressed()) return;
    getMainWindow()?.webContents.send('player:seek-state-change', payload);
    const patch = { isAdvancing: !payload.active, trackSeq: payload.trackSeq };
    patchDesktopLyricPlaybackFromPlayer(patch);
    patchMiniPlayerPlaybackFromPlayer(patch);
  });
  controller.on('playback-restart', (payload) => {
    if (localPlaybackSuppressed()) return;
    getMainWindow()?.webContents.send('player:playback-restart', payload);
    if (typeof payload?.time === 'number') {
      patchDesktopLyricPlaybackFromPlayer({ currentTime: payload.time, reason: 'recover' });
      patchMiniPlayerPlaybackFromPlayer({ currentTime: payload.time, reason: 'recover' });
    }
  });
  controller.on('duration-change', (duration) => {
    if (localPlaybackSuppressed()) return;
    getMainWindow()?.webContents.send('player:duration-change', duration);
    patchDesktopLyricPlaybackFromPlayer({ duration, reason: 'load' });
    patchMiniPlayerPlaybackFromPlayer({ duration, reason: 'load' });
  });
  controller.on('file-loaded', (payload) => {
    if (localPlaybackSuppressed()) return;
    beginDesktopLyricPlaybackBridgeTransition(payload?.seq);
    beginMiniPlayerPlaybackBridgeTransition(payload?.seq);
    getMainWindow()?.webContents.send('player:file-loaded', payload);
  });
  controller.on('state-change', (state) => {
    if (localPlaybackSuppressed()) return;
    publishPlayerEvent('state-change', state);
  });
  controller.on('core-state-change', (payload) =>
    getMainWindow()?.webContents.send('player:core-state-change', payload),
  );
  controller.on('ao-state-change', (payload) =>
    getMainWindow()?.webContents.send('player:ao-state-change', payload),
  );
  controller.on('playback-end', (reason, context) => {
    if (localPlaybackSuppressed()) return;
    publishPlayerEvent('playback-end', reason, context);
  });
  controller.on('stalled', (position) => {
    if (localPlaybackSuppressed()) return;
    getMainWindow()?.webContents.send('player:stall', position);
  });
  controller.on('error', (payload: PlayerErrorPayload) =>
    getMainWindow()?.webContents.send('player:error', payload),
  );
  controller.on('audio-device-list-changed', (payload) =>
    getMainWindow()?.webContents.send('player:audio-device-list-changed', payload),
  );
  controller.on('packet-cache-stats', (payload) =>
    getMainWindow()?.webContents.send('player:packet-cache-stats', payload),
  );
  controller.on('audio-output-stats', (payload) =>
    getMainWindow()?.webContents.send('player:audio-output-stats', payload),
  );
  controller.on('audio-graph-change', (payload) =>
    getMainWindow()?.webContents.send('player:audio-graph-change', payload),
  );
}

export type { PlayerController } from './controller';
