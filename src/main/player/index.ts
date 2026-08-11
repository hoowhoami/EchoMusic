import log from '../logger';
import { getMainWindow } from '../window';
import { PlayerController } from './controller';
import type { PlayerErrorPayload } from '../../shared/player-error';
import {
  beginDesktopLyricPlaybackBridgeTransition,
  patchDesktopLyricPlaybackFromPlayer,
} from '../desktopLyric';
import {
  beginMiniPlayerPlaybackBridgeTransition,
  patchMiniPlayerPlaybackFromPlayer,
} from '../miniPlayer';

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
  playerController = null;
}

function registerEventForwarding(controller: PlayerController): void {
  controller.on('time-update', (payload) => {
    getMainWindow()?.webContents.send('player:time-update', payload);
    patchDesktopLyricPlaybackFromPlayer({
      currentTime: payload.time,
      trackSeq: payload.trackSeq,
      reason: 'tick',
    });
    patchMiniPlayerPlaybackFromPlayer({
      currentTime: payload.time,
      trackSeq: payload.trackSeq,
      reason: 'tick',
    });
  });
  controller.on('seeked', (time) => {
    const seekTimestamp = Date.now();
    getMainWindow()?.webContents.send('player:seeked', time);
    // Native seek/duration events do not carry trackSeq today; the bridge only applies them
    // outside a track transition, or after the transition timeout has released the guard.
    patchDesktopLyricPlaybackFromPlayer({ currentTime: time, seekTimestamp, reason: 'seek' });
    patchMiniPlayerPlaybackFromPlayer({ currentTime: time, seekTimestamp, reason: 'seek' });
  });
  controller.on('playback-restart', (payload) => {
    getMainWindow()?.webContents.send('player:playback-restart', payload);
    if (typeof payload?.time === 'number') {
      patchDesktopLyricPlaybackFromPlayer({ currentTime: payload.time, reason: 'recover' });
      patchMiniPlayerPlaybackFromPlayer({ currentTime: payload.time, reason: 'recover' });
    }
  });
  controller.on('duration-change', (duration) => {
    getMainWindow()?.webContents.send('player:duration-change', duration);
    // See seeked: duration-change currently has no native trackSeq context.
    patchDesktopLyricPlaybackFromPlayer({ duration, reason: 'load' });
    patchMiniPlayerPlaybackFromPlayer({ duration, reason: 'load' });
  });
  controller.on('file-loaded', (payload) => {
    beginDesktopLyricPlaybackBridgeTransition(payload?.seq);
    beginMiniPlayerPlaybackBridgeTransition(payload?.seq);
    getMainWindow()?.webContents.send('player:file-loaded', payload);
  });
  controller.on('state-change', (state) => {
    getMainWindow()?.webContents.send('player:state-change', state);
    patchDesktopLyricPlaybackFromPlayer({
      currentTime: state.timePos,
      duration: state.duration,
      isPlaying: Boolean(state.playing),
      playbackRate: state.speed,
      trackSeq: state.trackSeq,
      reason: state.playing ? 'play' : 'pause',
    });
    patchMiniPlayerPlaybackFromPlayer({
      currentTime: state.timePos,
      duration: state.duration,
      isPlaying: Boolean(state.playing),
      playbackRate: state.speed,
      trackSeq: state.trackSeq,
      reason: state.playing ? 'play' : 'pause',
    });
  });
  controller.on('core-state-change', (payload) =>
    getMainWindow()?.webContents.send('player:core-state-change', payload),
  );
  controller.on('cache-state-change', (payload) =>
    getMainWindow()?.webContents.send('player:cache-state-change', payload),
  );
  controller.on('playback-end', (reason) => {
    getMainWindow()?.webContents.send('player:playback-end', reason);
    patchDesktopLyricPlaybackFromPlayer({ isPlaying: false, reason: 'pause' });
    patchMiniPlayerPlaybackFromPlayer({ isPlaying: false, reason: 'pause' });
  });
  controller.on('stalled', (position) =>
    getMainWindow()?.webContents.send('player:stall', position),
  );
  controller.on('error', (payload: PlayerErrorPayload) =>
    getMainWindow()?.webContents.send('player:error', payload),
  );
  controller.on('impulse-response-disabled', (payload) =>
    getMainWindow()?.webContents.send('player:impulse-response-disabled', payload),
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
