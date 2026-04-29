import { EventEmitter } from 'events';
import { app } from 'electron';
import path from 'path';
import { resolveLibmpvPath, resolveLibmpvDir } from './path';
import type { MpvAudioDevice, MpvState, MpvTrackInfo } from './types';
import log from '../logger';

// native addon 类型（与自动生成的 index.d.ts 对齐）
interface MpvAddon {
  initialize(libPath: string): void;
  destroy(): void;
  registerEventHandler(
    callback: (
      err: Error | null,
      event: { type: string; value?: number; flag?: boolean; message?: string },
    ) => void,
  ): void;
  loadFile(url: string): void;
  loadMkvTrack(url: string, trackId: number): void;
  setAudioTrack(trackId: number): void;
  getTrackList(): Array<{ id: number; type: string; codec: string; title?: string; lang?: string }>;
  play(): void;
  pause(): void;
  stop(): void;
  seek(time: number): void;
  setVolume(volume: number): void;
  setSpeed(speed: number): void;
  setAudioDevice(deviceName: string): void;
  getAudioDevices(): Array<{ name: string; description: string }>;
  setAudioFilter(filter: string): void;
  setNormalizationGain(gainDb: number): void;
  setExclusive(exclusive: boolean): void;
  setMediaTitle(title: string): void;
  getState(): MpvState;
  getProperty(name: string): string;
  setLoopFile(value: string): void;
  fade(from: number, to: number, durationMs: number): void;
  cancelFade(): void;
  pauseWithFade(savedVolume: number, durationMs: number): void;
  playWithFade(targetVolume: number, durationMs: number): void;
  isFading(): boolean;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export class MpvController extends EventEmitter {
  private addon: MpvAddon | null = null;
  private libmpvPath: string | null;
  private isDestroyed = false;

  // 文件加载就绪 promise
  private fileReadyPromise: Promise<void> = Promise.resolve();
  private fileReadyResolve: (() => void) | null = null;

  // 内部状态（与 addon 同步）
  private state: MpvState = {
    playing: false,
    paused: true,
    duration: 0,
    timePos: 0,
    volume: 100,
    speed: 1,
    idle: true,
    path: '',
    audioDevice: 'auto',
  };

  constructor() {
    super();
    this.libmpvPath = resolveLibmpvPath();
  }

  get available(): boolean {
    return this.libmpvPath !== null;
  }

  get currentState(): Readonly<MpvState> {
    if (this.addon) {
      try {
        return this.addon.getState();
      } catch {
        // addon 不可用时返回内部状态
      }
    }
    return { ...this.state };
  }

  // ── 生命周期 ──

  async start(): Promise<void> {
    if (!this.libmpvPath) throw new Error('libmpv library not found');

    log.info('[MpvController] Starting libmpv player', {
      libmpvPath: this.libmpvPath,
      platform: process.platform,
    });

    // 加载 native addon
    this.addon = this.loadAddon();
    if (!this.addon) throw new Error('Failed to load echo-mpv-player addon');

    // Windows: 设置 DLL 搜索路径
    if (process.platform === 'win32') {
      const libDir = resolveLibmpvDir(this.libmpvPath);
      // 通过环境变量确保 DLL 依赖可以被找到
      process.env.PATH = `${libDir};${process.env.PATH || ''}`;
    }

    // 初始化 libmpv
    try {
      this.addon.initialize(this.libmpvPath);
    } catch (err) {
      log.error('[MpvController] libmpv initialize failed:', err);
      throw err;
    }

    // 注册事件回调
    this.addon.registerEventHandler((err, event) => {
      if (err) {
        log.warn('[MpvController] Event callback error:', err);
        return;
      }
      this.handleEvent(event);
    });

    this.emit('ready');
  }

  destroy(): void {
    this.isDestroyed = true;
    try {
      this.addon?.cancelFade();
      this.addon?.destroy();
    } catch (err) {
      log.warn('[MpvController] destroy error:', err);
    }
    this.addon = null;
  }

  // ── 内部方法 ──

  private loadAddon(): MpvAddon | null {
    try {
      const addonPath = app.isPackaged
        ? path.join(process.resourcesPath, 'native', 'echo-mpv-player.node')
        : path.join(__dirname, '../../native/echo-mpv-player/echo-mpv-player.node');

      log.info('[MpvController] Loading native addon:', addonPath);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(addonPath) as MpvAddon;
    } catch (err) {
      log.warn('[MpvController] Primary path load failed:', err);
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../../native/echo-mpv-player') as MpvAddon;
      } catch {
        log.error('[MpvController] Failed to load echo-mpv-player addon');
        return null;
      }
    }
  }

  private handleEvent(event: {
    type: string;
    value?: number;
    flag?: boolean;
    message?: string;
  }): void {
    switch (event.type) {
      case 'time-update':
        if (typeof event.value === 'number') {
          this.state.timePos = event.value;
          this.emit('time-update', event.value);
        }
        break;
      case 'duration-change':
        if (typeof event.value === 'number') {
          this.state.duration = event.value;
          this.emit('duration-change', event.value);
        }
        break;
      case 'state-change':
        if (typeof event.flag === 'boolean') {
          this.state.paused = event.flag;
          this.state.playing = !event.flag;
          this.emit('state-change', { paused: this.state.paused, playing: this.state.playing });
        }
        break;
      case 'playback-end':
        this.state.playing = false;
        this.state.paused = true;
        this.emit('playback-end', event.message || 'eof');
        break;
      case 'file-loaded':
        this.state.idle = false;
        if (this.fileReadyResolve) {
          this.fileReadyResolve();
          this.fileReadyResolve = null;
        }
        // 打印音频详细信息
        this.logAudioInfo();
        // 触发原始事件名
        this.emit('mpv:file-loaded');
        break;
      case 'idle':
        this.state.idle = true;
        break;
      case 'error':
        this.emit('error', new Error(event.message || 'unknown error'));
        break;
      case 'fade-complete':
        this.emit('fade-complete');
        break;
    }
  }

  /** 文件加载后打印音频详细信息 */
  private logAudioInfo(): void {
    setTimeout(() => {
      if (!this.addon) return;
      const props = ['audio-params', 'audio-codec-name', 'audio-exclusive', 'audio-device'];
      const info: Record<string, string | null> = {};
      for (const p of props) {
        try {
          info[p] = this.addon.getProperty(p);
        } catch {
          info[p] = null;
        }
      }
      log.info('[MpvController] Audio info', info);
    }, 500);
  }

  // ── 命令发送 ──

  /** 向 mpv 发送命令（兼容旧接口，用于 set-media-title 等直接属性操作） */
  async command(...args: unknown[]): Promise<unknown> {
    if (!this.addon) throw new Error('addon not initialized');

    const cmd = String(args[0] ?? '');
    if (cmd === 'set_property' && args.length >= 3) {
      const prop = String(args[1]);
      const value = args[2];
      try {
        this.addon.getProperty(prop); // 验证属性存在
      } catch {
        // 忽略
      }
      // 根据属性名路由到对应方法
      if (prop === 'force-media-title') {
        this.addon.setMediaTitle(String(value));
      } else if (prop === 'audio-exclusive') {
        this.addon.setExclusive(value === 'yes' || value === true);
      } else if (prop === 'audio-device') {
        this.addon.setAudioDevice(String(value));
      } else if (prop === 'pause') {
        if (value) this.addon.pause();
        else this.addon.play();
      } else if (prop === 'volume') {
        this.addon.setVolume(Number(value));
      } else if (prop === 'speed') {
        this.addon.setSpeed(Number(value));
      } else if (prop === 'aid') {
        this.addon.setAudioTrack(Number(value));
      } else if (prop === 'af') {
        this.addon.setAudioFilter(String(value));
      }
      return undefined;
    }
    if (cmd === 'get_property' && args.length >= 2) {
      const prop = String(args[1]);
      try {
        return this.addon.getProperty(prop);
      } catch {
        return null;
      }
    }
    if (cmd === 'observe_property') {
      // 属性观察已在 Rust 侧初始化时完成，无需额外操作
      return undefined;
    }
    if (cmd === 'loadfile') {
      this.addon.loadFile(String(args[1]));
      return undefined;
    }
    if (cmd === 'stop') {
      this.addon.stop();
      return undefined;
    }
    if (cmd === 'seek') {
      this.addon.seek(Number(args[1]));
      return undefined;
    }

    log.warn('[MpvController] Unhandled command:', args);
    return undefined;
  }

  // ── 播放控制 ──

  async loadFile(url: string): Promise<void> {
    if (!this.addon) throw new Error('addon not initialized');
    this.state.path = url;
    this.state.idle = true;
    this.fileReadyPromise = new Promise<void>((resolve) => {
      this.fileReadyResolve = resolve;
      setTimeout(() => {
        if (this.fileReadyResolve === resolve) {
          resolve();
          this.fileReadyResolve = null;
        }
      }, 15000);
    });
    this.addon.loadFile(url);
  }

  async loadMkvTrack(url: string, audioTrackId: number): Promise<void> {
    if (!this.addon) throw new Error('addon not initialized');
    this.state.path = url;
    this.state.idle = true;
    this.fileReadyPromise = new Promise<void>((resolve) => {
      this.fileReadyResolve = resolve;
      setTimeout(() => {
        if (this.fileReadyResolve === resolve) {
          resolve();
          this.fileReadyResolve = null;
        }
      }, 15000);
    });
    this.addon.loadFile(url);
    // file-loaded 后设置音轨
    this.fileReadyPromise
      .then(() => {
        try {
          this.addon?.setAudioTrack(audioTrackId);
        } catch (err) {
          log.warn('[MpvController] setAudioTrack failed:', err);
        }
      })
      .catch(() => {});
  }

  async getTrackList(): Promise<MpvTrackInfo[]> {
    if (!this.addon) return [];
    try {
      return this.addon.getTrackList();
    } catch {
      return [];
    }
  }

  /** 等待文件加载就绪 */
  private async whenReady(): Promise<void> {
    await this.fileReadyPromise;
  }

  async play(): Promise<void> {
    if (!this.addon) return;
    await this.whenReady();
    this.addon.play();
  }

  async pause(): Promise<void> {
    if (!this.addon) return;
    this.addon.pause();
  }

  async stop(): Promise<void> {
    if (!this.addon) return;
    try {
      this.addon.stop();
    } catch {
      // idle 状态下 stop 可能失败
    }
    this.state.playing = false;
    this.state.paused = true;
    this.state.timePos = 0;
    this.state.duration = 0;
    this.state.path = '';
  }

  async seek(time: number): Promise<void> {
    if (!this.addon) return;
    try {
      await this.whenReady();
      this.addon.seek(time);
    } catch {
      // seek 失败时忽略
    }
  }

  async setVolume(volume: number): Promise<void> {
    if (!this.addon) return;
    const v = clamp(volume, 0, 100);
    this.addon.setVolume(v);
    this.state.volume = v;
  }

  async setSpeed(speed: number): Promise<void> {
    if (!this.addon) return;
    const s = clamp(speed, 0.1, 5);
    this.addon.setSpeed(s);
    this.state.speed = s;
  }

  async setAudioDevice(deviceName: string): Promise<void> {
    if (!this.addon) return;
    this.addon.setAudioDevice(deviceName);
    this.state.audioDevice = deviceName;
  }

  async getAudioDevices(): Promise<MpvAudioDevice[]> {
    if (!this.addon) return [];
    try {
      return this.addon.getAudioDevices();
    } catch {
      return [];
    }
  }

  async setAudioFilter(filterString: string): Promise<void> {
    if (!this.addon) return;
    this.addon.setAudioFilter(filterString || '');
  }

  async applyNormalizationGain(gainDb: number): Promise<void> {
    if (!this.addon) return;
    this.addon.setNormalizationGain(gainDb);
  }

  // ── 淡入淡出 ──

  async fade(fromPercent: number, toPercent: number, durationMs: number): Promise<void> {
    if (!this.addon) return;
    if (durationMs <= 0) {
      await this.setVolume(toPercent);
      return;
    }
    // Rust 侧异步执行，通过 fade-complete 事件通知完成
    return new Promise<void>((resolve) => {
      const onComplete = () => {
        this.removeListener('fade-complete', onComplete);
        clearTimeout(timer);
        resolve();
      };
      // 安全超时
      const timer = setTimeout(() => {
        this.removeListener('fade-complete', onComplete);
        resolve();
      }, durationMs + 500);
      this.once('fade-complete', onComplete);
      this.addon!.fade(fromPercent, toPercent, durationMs);
    });
  }

  /**
   * 复合操作：淡出音量 → 暂停 → 恢复音量。
   * 整个流程在 Rust 侧完成。
   */
  async pauseWithFade(savedVolumePercent: number, durationMs: number): Promise<void> {
    if (!this.addon) return;
    return new Promise<void>((resolve) => {
      const onComplete = () => {
        this.removeListener('fade-complete', onComplete);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.removeListener('fade-complete', onComplete);
        resolve();
      }, durationMs + 500);
      this.once('fade-complete', onComplete);
      this.addon!.pauseWithFade(savedVolumePercent, durationMs);
    });
  }

  /**
   * 复合操作：设置音量为 0 → 播放 → 淡入到目标音量。
   * fade 部分不阻塞，播放命令发出后立即返回。
   */
  async playWithFade(targetVolumePercent: number, durationMs: number): Promise<void> {
    if (!this.addon) return;
    // Rust 侧会先设置音量 0、播放、然后后台 fade
    this.addon.playWithFade(targetVolumePercent, durationMs);
  }

  cancelFade(): void {
    try {
      this.addon?.cancelFade();
    } catch {
      // 忽略
    }
  }

  /** 设置文件循环模式 */
  setLoopFile(loop: boolean): void {
    try {
      this.addon?.setLoopFile(loop ? 'inf' : 'no');
    } catch {
      // 忽略
    }
  }
}
