import { EventEmitter } from 'events';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { resolveLibmpvPath, resolveLibmpvDir } from './path';
import type { MpvAudioDevice, MpvState, MpvTrackInfo } from './types';
import type { ImpulseResponsePlaybackOptions } from '../../shared/audio';
import log from '../logger';
import { refreshNetworkSettingsFromStorage } from '../networkSettings';
import type { NetworkSettings } from '../../shared/network';

// native addon 类型（与自动生成的 index.d.ts 对齐）
interface MpvAddon {
  initialize(
    libPath: string,
    config?: {
      cacheSecs?: number;
      demuxerMaxMb?: number;
      demuxerBackMb?: number;
      audioBufferSecs?: number;
      networkTimeoutSecs?: number;
      httpProxy?: string;
    },
  ): void;
  destroy(): void;
  registerEventHandler(
    callback: (
      err: Error | null,
      event: {
        type: string;
        value?: number;
        flag?: boolean;
        message?: string;
        prefix?: string;
        level?: string;
      },
    ) => void,
  ): void;
  loadFile(url: string, seq?: number): Promise<void>;
  loadMkvTrack(url: string, trackId: number, seq?: number): Promise<void>;
  setAudioTrack(trackId: number): void;
  setHttpProxy(proxy: string): void;
  setNetworkTimeout(seconds: number): void;
  getTrackList(): Promise<
    Array<{ id: number; type: string; codec: string; title?: string; lang?: string }>
  >;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  seek(time: number): void;
  setVolume(volume: number): void;
  setSpeed(speed: number): Promise<void>;
  setAudioDevice(deviceName: string): Promise<void>;
  getAudioDevices(): Promise<Array<{ name: string; description: string }>>;
  setAudioFilter(filter: string): void;
  // 异步设置音频滤镜：在工作线程重建滤镜链，不阻塞主线程
  setAudioFilterAsync(filter: string): Promise<void>;
  // 设置响度归一增益（dB），走 volume-gain 属性，不重建 af 链
  setVolumeGain(gainDb: number): Promise<void>;
  afCommand(label: string, cmd: string, arg: string, target: string): void;
  setExclusive(exclusive: boolean): Promise<void>;
  setMediaTitle(title: string): void;
  getState(): MpvState;
  getProperty(name: string): string;
  setLoopFile(value: string): Promise<void>;
  fade(from: number, to: number, durationMs: number): void;
  cancelFade(): void;
  pauseWithFade(savedVolume: number, durationMs: number): void;
  playWithFade(targetVolume: number, durationMs: number): Promise<void>;
  isFading(): boolean;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const DEFAULT_IMPULSE_RESPONSE_MIX = 0.4;
// 归一化后的卷积湿声本就比干声低约 15dB，直接按 mix 叠加会“拖满也偏淡”。给 afir 的 wet
// 一个 makeup 增益把湿声补到与干声同量级，让“湿声比例”滑块整段都有手感（实测 wet=3 时
// mix=1.0 输出 ≈ 干声 +0~1dB、峰值仍有 ~10dB 余量，正常音量不会削顶）。
const IMPULSE_RESPONSE_WET_MAKEUP = 3;

// IR lavfi 项的 af 标签与图内部 amix 实例名。强度（mix）变化时用 af-command 寻址内部 amix
// 在运行时改权重，而不重设整条 af（重设会重建 afir 卷积器 → 卡顿/爆音）。
const IMPULSE_RESPONSE_AF_LABEL = 'irs';
const IMPULSE_RESPONSE_MIX_FILTER = 'amix@irsmix';
// 构造「结构键」时用占位符替换真实 mix：只有 mix 变化时结构键不变 → 走 af-command 而非重建。
const IMPULSE_RESPONSE_MIX_PLACEHOLDER = '__IRS_MIX__';

// IR 路径会放进 lavfi 图的单引号里传给 amovie 滤镜。amovie 用 ':' 分隔 filename 与选项，
// 图层单引号只能挡住图解析器、挡不住 amovie 自己的选项解析器，因此 Windows 盘符里的 ':'
// （如 C:/…）会被当成分隔符，文件名被截断成 'C' 而打不开 IR——表现为加滤镜后音频静默、
// 进度条停住（歌词走的是独立时钟所以照常滚动）。把 ':' 转义成 '\:' 即可保留完整路径。
const escapeLavfiQuotedValue = (value: string): string =>
  value.replace(/\\/g, '/').replace(/'/g, "\\'").replace(/:/g, '\\:');

const quoteMpvOptionValue = (value: string): string =>
  `%${Buffer.byteLength(value, 'utf8')}%${value}`;

export class MpvController extends EventEmitter {
  private addon: MpvAddon | null = null;
  private libmpvPath: string | null;
  private isDestroyed = false;
  // mpv/libuv 工作线程命令串行化：异步 native 调用不会阻塞主线程，但多个会重建输出链的
  // 操作若并发进入 worker pool，业务顺序可能被打乱。这里统一按 JS 侧提交顺序下发。
  private mpvCommandQueue: Promise<void> = Promise.resolve();

  // ── 播放卡死看门狗 ──
  // 主进程定时检测：播放中（非暂停/非 idle）若超过 stallTimeoutMs 收不到进度推进，
  // 判定为卡死并 emit('stall', 当前位置)，交由渲染进程重取地址并从断点恢复。
  // 放主进程而非 renderer：主进程 setInterval 不受 Chromium 后台节流影响，窗口最小化时仍可靠。
  private stallTimeoutMs = 8000;
  private stallWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  private stallLastProgressAt = 0;
  // 只有"播放已推进过一次"后才布防，避免把首次加载/起播缓冲误判为卡死（起播另有加载超时处理）。
  private stallArmed = false;
  // 一次卡死只通知一次，恢复重载后重新布防，防止重复触发。
  private stallNotified = false;

  // 文件加载就绪 promise
  private fileReadyPromise: Promise<void> = Promise.resolve();
  private fileReadyResolve: (() => void) | null = null;
  private fileReadyTimer: ReturnType<typeof setTimeout> | null = null;
  private loadSeq = 0;
  private fileReadySeq = 0;
  private pendingFileReady: {
    seq: number;
    url: string;
    resolve: () => void;
  } | null = null;

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
    audioTrackId: 0,
  };

  private equalizerGains: number[] = Array(10).fill(0);
  private normalizationGainDb = 0;
  // 响度归一默认走 mpv 的 volume-gain 属性（不重建 af 链）；若某次设置失败（老版 mpv 不支持），
  // 永久切到 af 滤镜回退（在 af 串尾部追加 volume=XdB，老行为）。
  private normalizationUsesAfFallback = false;
  // 当前 loop-file 值缓存（null 表示未知/未设置），用于跳过未变更的重复设置
  private loopFileValue: string | null = null;
  private impulseResponsePath = '';
  private impulseResponseMix = DEFAULT_IMPULSE_RESPONSE_MIX;
  private impulseResponseFailureRecovering = false;
  // 「结构键」= 完整 af 串，但 IR 的 mix 用占位符替换。只有结构（IR 路径/开关、EQ、归一化）
  // 变化时它才变 → 触发整链重设；仅 mix 变化时结构键不变 → 走 af-command 运行时改权重，
  // 不重建 afir，避免拖强度滑块卡顿/爆音。null 表示「未知/需强制下发」。
  private lastStructuralKey: string | null = null;
  // 上次实际生效的 mix（无论经整链重设还是 af-command 下发），用于判断是否需要更新权重。
  private lastAppliedMix = DEFAULT_IMPULSE_RESPONSE_MIX;
  // 上次 af 中 IR 的激活状态与路径，用于判断是否为「IR 结构变化」（决定是否做音量 duck）。
  private lastIrActive = false;
  private lastIrPath = '';
  // file-loaded 后置位：强制下一次 sync 整链重设（mpv 换文件可能重置 af），且不做 duck。
  private forceReapply = false;

  constructor() {
    super();
    this.libmpvPath = resolveLibmpvPath();
  }

  private getAddonOrThrow(): MpvAddon {
    if (!this.addon) throw new Error('addon not initialized');
    return this.addon;
  }

  private enqueueMpvCommand<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.mpvCommandQueue.catch(() => {}).then(operation);
    this.mpvCommandQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private resolvePendingFileReady(markReady: boolean): void {
    if (this.fileReadyTimer) {
      clearTimeout(this.fileReadyTimer);
      this.fileReadyTimer = null;
    }
    const pending = this.pendingFileReady;
    if (!pending) return;
    if (markReady) this.fileReadySeq = Math.max(this.fileReadySeq, pending.seq);
    this.pendingFileReady = null;
    this.fileReadyResolve = null;
    pending.resolve();
  }

  private resetFileReadyWait(url: string): number {
    // Wake waiters for the superseded load so they can observe loadSeq changed and wait on the
    // replacement instead of sitting on the old 15s timeout.
    this.resolvePendingFileReady(false);
    const seq = this.loadSeq + 1;
    this.loadSeq = seq;
    this.fileReadyPromise = new Promise<void>((resolve) => {
      this.pendingFileReady = { seq, url, resolve };
      this.fileReadyResolve = resolve;
      this.fileReadyTimer = setTimeout(() => {
        if (this.pendingFileReady?.seq === seq) {
          log.warn('[MpvController] file-loaded wait timed out, continuing', { seq, url });
          this.resolvePendingFileReady(true);
        }
      }, 15000);
      if (typeof this.fileReadyTimer.unref === 'function') this.fileReadyTimer.unref();
    });
    return seq;
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

    log.info('[MpvController] Native addon loaded, initializing libmpv...');

    // Windows: 设置 DLL 搜索路径
    if (process.platform === 'win32') {
      const libDir = resolveLibmpvDir(this.libmpvPath);
      // 通过环境变量确保 DLL 依赖可以被找到
      process.env.PATH = `${libDir};${process.env.PATH || ''}`;
    }

    // 初始化 libmpv
    try {
      // 读取音频缓冲区配置
      const { getKvStorage } = await import('../storage/kv');
      const storage = getKvStorage();
      const cacheSecs = (await storage.get('audioCacheSecs')) ?? 30;
      const demuxerMaxMb = (await storage.get('audioDemuxerMaxMB')) ?? 48;
      const demuxerBackMb = (await storage.get('audioDemuxerBackMB')) ?? 12;
      const audioBufferSecs = (await storage.get('audioBufferSecs')) ?? 0.5;
      const networkSettings = refreshNetworkSettingsFromStorage();

      this.addon.initialize(this.libmpvPath, {
        cacheSecs: Number(cacheSecs),
        demuxerMaxMb: Number(demuxerMaxMb),
        demuxerBackMb: Number(demuxerBackMb),
        audioBufferSecs: Number(audioBufferSecs),
        networkTimeoutSecs: networkSettings.mpvNetworkTimeoutSecs,
        httpProxy: networkSettings.mpvHttpProxyUrl,
      });
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

    this.startStallWatchdog();

    this.emit('ready');
  }

  destroy(): void {
    this.isDestroyed = true;
    this.stopStallWatchdog();
    try {
      this.addon?.cancelFade();
      this.addon?.destroy();
    } catch (err) {
      log.warn('[MpvController] destroy error:', err);
    }
    this.addon = null;
  }

  // ── 播放卡死看门狗 ──

  /** 设置卡死判定阈值（秒，<=0 表示禁用检测）。由渲染进程根据用户设置下发。 */
  setStallTimeout(seconds: number): void {
    const value = Number(seconds);
    this.stallTimeoutMs = Number.isFinite(value) && value > 0 ? value * 1000 : 0;
  }

  private startStallWatchdog(): void {
    if (this.stallWatchdogTimer) return;
    this.stallWatchdogTimer = setInterval(() => {
      if (!this.stallArmed || this.stallNotified) return;
      if (this.stallTimeoutMs <= 0) return;
      // 暂停或空闲状态不算卡死（暂停时本就不推进进度）。
      if (this.state.paused || this.state.idle) return;
      const elapsed = Date.now() - this.stallLastProgressAt;
      if (elapsed < this.stallTimeoutMs) return;
      // 撤防 + 标记已通知，等渲染进程重载后由 time-update 重新布防，避免重复触发。
      this.stallNotified = true;
      this.stallArmed = false;
      log.warn('[MpvController] Playback stall detected', {
        position: this.state.timePos,
        elapsedMs: elapsed,
      });
      this.emit('stall', this.state.timePos);
    }, 1000);
  }

  private stopStallWatchdog(): void {
    if (this.stallWatchdogTimer) {
      clearInterval(this.stallWatchdogTimer);
      this.stallWatchdogTimer = null;
    }
  }

  /** 撤防卡死检测（加载新文件 / 停止时调用），等下一次进度推进重新布防。 */
  private disarmStallWatchdog(): void {
    this.stallArmed = false;
    this.stallNotified = false;
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
    prefix?: string;
    level?: string;
    devices?: Array<{ name: string; description: string }>;
  }): void {
    switch (event.type) {
      case 'time-update':
        if (typeof event.value === 'number') {
          this.state.timePos = event.value;
          // 收到进度推进即视为播放正常：刷新计时并布防（首次推进后才开始监测卡死）。
          this.stallLastProgressAt = Date.now();
          this.stallArmed = true;
          this.stallNotified = false;
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
        if (this.pendingFileReady) {
          const loadedSeq = Number(event.value || 0);
          const loadedPath = String(event.message || '');
          if (
            loadedSeq === this.pendingFileReady.seq ||
            (loadedSeq <= 0 && (!loadedPath || loadedPath === this.pendingFileReady.url))
          ) {
            this.resolvePendingFileReady(true);
          } else {
            log.warn('[MpvController] Ignoring stale file-loaded event', {
              expectedSeq: this.pendingFileReady.seq,
              actualSeq: loadedSeq,
              expected: this.pendingFileReady.url,
              actual: loadedPath,
            });
            break;
          }
        }
        // 重新应用音频滤镜（防止被新文件加载重置）。强制下一次 sync 整链重设，确保这次重应用
        // 一定下发——否则若 mpv 在换文件时重置了 af，幂等命中会跳过、导致换歌后音效悄悄消失。
        // 走整链重设而非 af-command，且不做 duck（换歌本身另有淡入淡出）。
        this.forceReapply = true;
        void this.syncAudioFilters();
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
      case 'audio-device-list-changed':
        this.emit('audio-device-list-changed', event.devices ?? []);
        break;
      case 'log-message':
        this.handleLogMessage(event);
        break;
    }
  }

  private handleLogMessage(event: { message?: string; prefix?: string; level?: string }): void {
    const message = String(event.message || '').trim();
    if (!message) return;

    const payload = {
      message,
      prefix: String(event.prefix || '').trim(),
      level: String(event.level || '').trim(),
    };
    if (payload.level === 'error' || payload.level === 'fatal') {
      log.error('[MpvController] mpv log:', payload);
    } else {
      log.warn('[MpvController] mpv log:', payload);
    }
    this.emit('log-message', payload);

    if (this.isImpulseResponseFailureLog(payload)) {
      void this.disableImpulseResponseFromFailure(message);
    }
  }

  private isImpulseResponseFailureLog(payload: {
    message: string;
    prefix: string;
    level: string;
  }): boolean {
    if (!this.impulseResponsePath || this.impulseResponseFailureRecovering) return false;

    const level = payload.level.toLowerCase();
    if (level !== 'error' && level !== 'fatal' && level !== 'warn') return false;

    const text = `${payload.prefix} ${payload.message}`.toLowerCase();
    const relatesToAudioFilter =
      text.includes('afir') ||
      text.includes('amovie') ||
      text.includes('lavfi') ||
      text.includes('filter graph') ||
      text.includes('audio filter') ||
      text.includes('reconfig') ||
      text.includes('failed to configure') ||
      text.includes('error reinitializing filters');
    const looksLikeFailure =
      text.includes('error') ||
      text.includes('failed') ||
      text.includes('invalid') ||
      text.includes('cannot') ||
      text.includes('no such') ||
      text.includes('could not');
    return relatesToAudioFilter && looksLikeFailure;
  }

  private async disableImpulseResponseFromFailure(reason: string): Promise<void> {
    if (!this.impulseResponsePath || this.impulseResponseFailureRecovering) return;
    this.impulseResponseFailureRecovering = true;
    const failedPath = this.impulseResponsePath;
    this.impulseResponsePath = '';
    log.warn('[MpvController] Disabling IR after mpv filter failure:', {
      path: failedPath,
      reason,
    });
    try {
      await this.syncAudioFilters();
    } finally {
      this.impulseResponseFailureRecovering = false;
    }
    this.emit('impulse-response-disabled', { path: failedPath, reason });
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
        await this.enqueueMpvCommand(() => this.getAddonOrThrow().setMediaTitle(String(value)));
      } else if (prop === 'audio-exclusive') {
        await this.enqueueMpvCommand(() =>
          this.getAddonOrThrow().setExclusive(value === 'yes' || value === true),
        );
      } else if (prop === 'audio-device') {
        await this.enqueueMpvCommand(() => this.getAddonOrThrow().setAudioDevice(String(value)));
      } else if (prop === 'pause') {
        if (value) await this.enqueueMpvCommand(() => this.getAddonOrThrow().pause());
        else await this.enqueueMpvCommand(() => this.getAddonOrThrow().play());
      } else if (prop === 'volume') {
        await this.setVolume(Number(value));
      } else if (prop === 'speed') {
        await this.setSpeed(Number(value));
      } else if (prop === 'aid') {
        await this.enqueueMpvCommand(() => this.getAddonOrThrow().setAudioTrack(Number(value)));
      } else if (prop === 'af') {
        await this.enqueueMpvCommand(() => this.getAddonOrThrow().setAudioFilter(String(value)));
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
      const url = String(args[1]);
      this.disarmStallWatchdog();
      this.state.path = url;
      this.state.idle = true;
      const loadSeq = this.resetFileReadyWait(url);
      await this.enqueueMpvCommand(() => this.getAddonOrThrow().loadFile(url, loadSeq));
      return undefined;
    }
    if (cmd === 'stop') {
      this.disarmStallWatchdog();
      await this.enqueueMpvCommand(() => this.getAddonOrThrow().stop());
      return undefined;
    }
    if (cmd === 'seek') {
      await this.enqueueMpvCommand(() => this.getAddonOrThrow().seek(Number(args[1])));
      return undefined;
    }

    log.warn('[MpvController] Unhandled command:', args);
    return undefined;
  }

  // ── 播放控制 ──

  async loadFile(url: string): Promise<void> {
    if (!this.addon) throw new Error('addon not initialized');
    this.disarmStallWatchdog();
    this.state.path = url;
    this.state.idle = true;
    const loadSeq = this.resetFileReadyWait(url);
    await this.enqueueMpvCommand(() => this.getAddonOrThrow().loadFile(url, loadSeq));
  }

  async loadMkvTrack(url: string, audioTrackId: number): Promise<void> {
    if (!this.addon) throw new Error('addon not initialized');
    this.disarmStallWatchdog();
    this.state.path = url;
    this.state.idle = true;
    const loadSeq = this.resetFileReadyWait(url);
    await this.enqueueMpvCommand(() => this.getAddonOrThrow().loadFile(url, loadSeq));
    // file-loaded 后设置音轨
    this.fileReadyPromise
      .then(async () => {
        if (loadSeq !== this.loadSeq || loadSeq > this.fileReadySeq) return;
        try {
          await this.enqueueMpvCommand(() => this.getAddonOrThrow().setAudioTrack(audioTrackId));
        } catch (err) {
          log.warn('[MpvController] setAudioTrack failed:', err);
        }
      })
      .catch(() => {});
  }

  async getTrackList(): Promise<MpvTrackInfo[]> {
    if (!this.addon) return [];
    try {
      return await this.addon.getTrackList();
    } catch {
      return [];
    }
  }

  /** 等待文件加载就绪 */
  private async whenReady(): Promise<void> {
    for (;;) {
      const seq = this.loadSeq;
      if (this.fileReadySeq >= seq) return;
      const wait = this.fileReadyPromise;
      await wait;
      if (seq === this.loadSeq && this.fileReadySeq >= seq) return;
    }
  }

  async play(): Promise<void> {
    if (!this.addon) return;
    await this.whenReady();
    await this.enqueueMpvCommand(() => this.getAddonOrThrow().play());
  }

  async pause(): Promise<void> {
    if (!this.addon) return;
    await this.enqueueMpvCommand(() => this.getAddonOrThrow().pause());
  }

  async stop(): Promise<void> {
    if (!this.addon) return;
    this.disarmStallWatchdog();
    try {
      await this.enqueueMpvCommand(() => this.getAddonOrThrow().stop());
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
      await this.enqueueMpvCommand(() => this.getAddonOrThrow().seek(time));
    } catch {
      // seek 失败时忽略
    }
  }

  async setVolume(volume: number): Promise<void> {
    if (!this.addon) return;
    const v = clamp(volume, 0, 100);
    await this.enqueueMpvCommand(() => {
      this.getAddonOrThrow().setVolume(v);
      this.state.volume = v;
    });
  }

  async setSpeed(speed: number): Promise<void> {
    if (!this.addon) return;
    const s = clamp(speed, 0.1, 5);
    await this.enqueueMpvCommand(async () => {
      // 值未变则跳过：设置 speed 会触发 mpv 重建音频滤镜链（含 afir/IR 卷积，约 500ms），
      // 切歌时 speed 恒为默认值，重复下发会无谓地阻塞/重建，这里直接短路。
      if (s === this.state.speed) return;
      await this.getAddonOrThrow().setSpeed(s);
      this.state.speed = s;
    });
  }

  private async updateAudioFilter(updater: () => void): Promise<void> {
    if (!this.addon) return;
    updater();
    await this.syncAudioFilters();
  }

  // af 滤镜应用串行化队列：自从滤镜重建改到工作线程异步执行后，多个触发源
  // （file-loaded 重应用、EQ、IR、归一化）可能并发，用链式 Promise 串行化，
  // 保证滤镜下发顺序与 lastStructuralKey 等状态记账一致。
  private afSyncQueue: Promise<void> = Promise.resolve();

  /** 在工作线程应用滤镜串，避免阻塞主线程。 */
  private async applyAudioFilterString(filterString: string): Promise<void> {
    if (!this.addon) return;
    await this.enqueueMpvCommand(() => this.getAddonOrThrow().setAudioFilterAsync(filterString));
  }

  async setEq(gains: number[]): Promise<void> {
    this.equalizerGains = gains.map((g) => clamp(g, -12, 12));
    await this.syncAudioFilters();
  }

  async setImpulseResponse(options: string | ImpulseResponsePlaybackOptions): Promise<void> {
    const filePath = typeof options === 'string' ? options : options.filePath;
    const normalizedPath = String(filePath ?? '').trim();
    this.impulseResponseMix =
      typeof options === 'string'
        ? DEFAULT_IMPULSE_RESPONSE_MIX
        : clamp(Number(options.mix) || DEFAULT_IMPULSE_RESPONSE_MIX, 0.1, 1);

    if (normalizedPath && !fs.existsSync(normalizedPath)) {
      log.warn(
        '[MpvController] Impulse response file not found, disabling filter:',
        normalizedPath,
      );
      this.impulseResponsePath = '';
    } else {
      this.impulseResponsePath = normalizedPath;
    }
    await this.syncAudioFilters();
  }

  async setAudioDevice(deviceName: string): Promise<void> {
    if (!this.addon) return;
    await this.enqueueMpvCommand(async () => {
      await this.getAddonOrThrow().setAudioDevice(deviceName);
      this.state.audioDevice = deviceName;
    });
  }

  async getAudioDevices(): Promise<MpvAudioDevice[]> {
    if (!this.addon) return [];
    try {
      return await this.addon.getAudioDevices();
    } catch {
      return [];
    }
  }

  async setAudioFilter(filterString: string): Promise<void> {
    if (!this.addon) return;
    await this.enqueueMpvCommand(() => this.getAddonOrThrow().setAudioFilter(filterString || ''));
  }

  async getAudioFilter(): Promise<string> {
    if (!this.addon) return '';
    try {
      return this.addon.getProperty('af');
    } catch {
      return '';
    }
  }

  async applyNormalizationGain(gainDb: number): Promise<void> {
    this.normalizationGainDb = gainDb;
    if (!this.addon) return;
    // 优先走 volume-gain 属性：作为独立输出增益，切歌改响度时不重建 afir 卷积链。
    if (!this.normalizationUsesAfFallback) {
      try {
        await this.enqueueMpvCommand(() => this.getAddonOrThrow().setVolumeGain(gainDb));
        return;
      } catch (err) {
        // 老版 mpv 不支持 volume-gain → 永久回退到 af 滤镜方式
        log.warn('[MpvController] volume-gain unsupported, fallback to af volume filter:', err);
        this.normalizationUsesAfFallback = true;
        try {
          await this.enqueueMpvCommand(() => this.getAddonOrThrow().setVolumeGain(0));
        } catch {
          // 忽略：回退时清零失败无影响
        }
      }
    }
    // 回退路径：把 volume=XdB 并入 af 串（老行为，会触发整链重建）
    await this.syncAudioFilters();
  }

  /** 同步合并后的音频滤镜到 mpv */
  private async syncAudioFilters(): Promise<void> {
    // 串行化：把本次同步排到队列尾部，避免异步滤镜应用并发导致状态记账错乱。
    const run = this.afSyncQueue.catch(() => {}).then(() => this.syncAudioFiltersInner());
    this.afSyncQueue = run.catch(() => {});
    return run;
  }

  private async syncAudioFiltersInner(): Promise<void> {
    if (!this.addon) return;

    const filters: string[] = [];
    // 与 filters 一一对应，但 IR 的 mix 用占位符——用于「结构键」比较，区分「仅 mix 变化」
    // （走 af-command）与「结构变化」（整链重设）。
    const structuralParts: string[] = [];
    const irActive = !!this.impulseResponsePath;
    const irPath = this.impulseResponsePath;
    const mix = Number(this.impulseResponseMix.toFixed(2));
    const hasEq = this.equalizerGains.some((g) => g !== 0);

    if (irActive) {
      const irPathEsc = escapeLavfiQuotedValue(irPath);
      // afir 的输出永远是纯卷积湿声（dry/wet 只是卷积器的输入/输出增益，不是干湿混合），
      // 所以必须用 asplit 留一路干声、afir 出湿声、再用 amix 把干声混回，否则只剩很轻的
      // 混响尾音（湿声本就比干声低 ~15dB）→ 表现为“开启后声音特别小”。
      // 两路都对齐到 48k stereo fltp 是 afir 能 bind 成功的前提（IR 多为 mono/44.1k）。
      // 干声权重恒为 1（原声始终满幅），湿声先经 wet=makeup 补到与干声同量级，再按 mix 叠加。
      // amix 命名为 @irsmix、整项 af 打标签 @irs，使强度变化能用 af-command 运行时改权重而
      // 不重建 afir。mixStr 参数化：真实串用真实 mix，结构键用占位符。
      const buildGraph = (mixStr: string) =>
        `[in]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[irsdry][irsin];` +
        `amovie='${irPathEsc}',asetpts=N/SR/TB,aresample=48000,` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo[ir];` +
        `[irsin][ir]afir=dry=1:wet=${IMPULSE_RESPONSE_WET_MAKEUP}[irswet];` +
        `[irsdry][irswet]${IMPULSE_RESPONSE_MIX_FILTER}=inputs=2:weights='1 ${mixStr}':normalize=0[out]`;
      // 真实下发串：真实 mix + 正确的字节长度前缀（quoteMpvOptionValue 按字节数计前缀，
      // 所以必须对真实图计算，不能对占位符串再做替换）。
      filters.push(
        `@${IMPULSE_RESPONSE_AF_LABEL}:lavfi=graph=${quoteMpvOptionValue(buildGraph(String(mix)))}`,
      );
      // 结构键无需是合法 mpv 串，仅用于比较，故用占位符、省去字节前缀。
      structuralParts.push(
        `@${IMPULSE_RESPONSE_AF_LABEL}:lavfi=${buildGraph(IMPULSE_RESPONSE_MIX_PLACEHOLDER)}`,
      );
    }

    if (hasEq) {
      const freqs = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
      const eqParts = this.equalizerGains
        .map((gain, i) => {
          if (gain === 0) return '';
          return `equalizer=f=${freqs[i]}:g=${gain}:w=1`;
        })
        .filter(Boolean);

      if (eqParts.length > 0) {
        filters.push(...eqParts);
        structuralParts.push(...eqParts);
      }
    }

    // 响度归一默认走 volume-gain 属性（见 applyNormalizationGain），不进 af 链，
    // 避免切歌改响度时重建 afir。仅在回退模式下才把 volume 并入 af 串。
    if (this.normalizationUsesAfFallback && this.normalizationGainDb !== 0) {
      const volFilter = `volume=${this.normalizationGainDb}dB`;
      filters.push(volFilter);
      structuralParts.push(volFilter);
    }

    const filterString = filters.join(',');
    const structuralKey = structuralParts.join(',');
    const irStructuralChange = irActive !== this.lastIrActive || irPath !== this.lastIrPath;

    // 结构未变（且非强制重应用）：仅 mix 变化 → af-command 运行时改权重，不重建 afir；
    // 否则完全幂等，直接跳过。
    if (structuralKey === this.lastStructuralKey && !this.forceReapply) {
      if (irActive && mix !== this.lastAppliedMix) {
        try {
          await this.enqueueMpvCommand(() =>
            this.getAddonOrThrow().afCommand(
              IMPULSE_RESPONSE_AF_LABEL,
              'weights',
              `1 ${mix}`,
              IMPULSE_RESPONSE_MIX_FILTER,
            ),
          );
          this.lastAppliedMix = mix;
          return;
        } catch (err) {
          // af-command 不被支持（如旧版 mpv）→ 清结构键，落到下方整链重设兜底。
          log.warn('[MpvController] af-command failed, falling back to full rebuild:', err);
          this.lastStructuralKey = null;
        }
      } else {
        return;
      }
    }

    // 整链重设：结构变化 / 强制重应用 / af-command 回退。仅在「IR 结构变化」且正在播放、
    // 非强制重应用、非失败恢复时做音量 duck，把重建 afir 的间隙藏进静音区。
    const shouldDuck =
      irStructuralChange &&
      !this.state.paused &&
      !this.forceReapply &&
      !this.impulseResponseFailureRecovering;

    log.info('[MpvController] Applying audio filter:', filterString || '(cleared)');
    try {
      if (shouldDuck) {
        await this.applyFilterWithDuck(filterString);
      } else {
        // 非 duck 场景（如切歌）：在工作线程异步重建滤镜链，避免阻塞主进程，
        // 否则锁定桌面歌词时 Windows 全局鼠标钩子会被饿死导致光标卡顿。
        await this.applyAudioFilterString(filterString);
      }
      this.lastStructuralKey = structuralKey;
      this.lastAppliedMix = mix;
      this.lastIrActive = irActive;
      this.lastIrPath = irPath;
      this.forceReapply = false;
    } catch (err) {
      if (!irActive) throw err;
      log.warn('[MpvController] Impulse response filter failed, disabling IR:', err);
      const failedPath = this.impulseResponsePath;
      this.impulseResponsePath = '';
      // 清结构键，确保禁用 IR 后的重建一定下发；置位恢复标志，使重建走整链分支而不 duck。
      this.lastStructuralKey = null;
      this.impulseResponseFailureRecovering = true;
      try {
        // 直接调用 inner：当前已在串行队列内执行，走 syncAudioFilters 会等待自身完成而死锁。
        await this.syncAudioFiltersInner();
      } finally {
        this.impulseResponseFailureRecovering = false;
      }
      this.emit('impulse-response-disabled', {
        path: failedPath,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 应用滤镜串前后做一次极短音量 duck（淡出→应用→淡入），把重建 afir 卷积器的间隙藏进
   * 低音量区，避免切预设/开关空间音效时的卡顿/爆音。execute_fade 用 set_property_double 改
   * volume，不污染 state.volume，所以 vol 是用户真实音量、结束精确复原。
   */
  private async applyFilterWithDuck(filterString: string): Promise<void> {
    if (!this.addon) return;
    const vol = this.state.volume;
    let applyErr: unknown = null;
    try {
      await this.fade(vol, 0, 70);
    } catch {
      // 淡出失败也要继续应用滤镜
    }
    // 异步调用避免阻塞主进程，await 确保淡入前滤镜已应用完成
    try {
      await this.applyAudioFilterString(filterString);
    } catch (err) {
      applyErr = err;
    }
    try {
      await this.fade(0, vol, 140);
    } catch {
      // 兜底：保证音量一定复原，不卡在 0
      try {
        await this.setVolume(vol);
      } catch {
        // ignore
      }
    }
    // 应用失败时抛出，交由上层禁用 IR（此时音量已复原）
    if (applyErr) throw applyErr;
  }

  // ── 淡入淡出 ──

  async fade(fromPercent: number, toPercent: number, durationMs: number): Promise<void> {
    if (!this.addon) return;
    if (durationMs <= 0) {
      await this.setVolume(toPercent);
      return;
    }
    // Rust 侧异步执行，通过 fade-complete 事件通知完成
    let resolveComplete: (() => void) | null = null;
    const completion = new Promise<void>((resolve) => {
      resolveComplete = resolve;
    });

    await this.enqueueMpvCommand(() => {
      const onComplete = () => {
        this.removeListener('fade-complete', onComplete);
        clearTimeout(timer);
        resolveComplete?.();
      };
      // 安全超时
      const timer = setTimeout(() => {
        this.removeListener('fade-complete', onComplete);
        resolveComplete?.();
      }, durationMs + 500);
      this.once('fade-complete', onComplete);
      try {
        this.getAddonOrThrow().fade(fromPercent, toPercent, durationMs);
      } catch (err) {
        this.removeListener('fade-complete', onComplete);
        clearTimeout(timer);
        resolveComplete?.();
        throw err;
      }
    });

    return completion;
  }

  /**
   * 复合操作：淡出音量 → 暂停 → 恢复音量。
   * 整个流程在 Rust 侧完成，不阻塞 UI 线程。
   */
  async pauseWithFade(savedVolumePercent: number, durationMs: number): Promise<void> {
    if (!this.addon) return;
    // 非阻塞调用，淡出在 Rust 后台线程执行
    await this.enqueueMpvCommand(() =>
      this.getAddonOrThrow().pauseWithFade(savedVolumePercent, durationMs),
    );
  }

  /**
   * 复合操作：设置音量为 0 → 播放 → 淡入到目标音量。
   * fade 部分不阻塞，播放命令发出后立即返回。
   */
  async playWithFade(targetVolumePercent: number, durationMs: number): Promise<void> {
    if (!this.addon) return;
    // Rust 侧会先设置音量 0、播放、然后后台 fade
    await this.enqueueMpvCommand(() =>
      this.getAddonOrThrow().playWithFade(targetVolumePercent, durationMs),
    );
  }

  cancelFade(): void {
    void this.enqueueMpvCommand(() => this.getAddonOrThrow().cancelFade()).catch(() => {});
  }

  /** 设置文件循环模式 */
  async setLoopFile(loop: boolean): Promise<void> {
    if (!this.addon) return;
    const value = loop ? 'inf' : 'no';
    try {
      await this.enqueueMpvCommand(async () => {
        // 值未变则跳过：设置 loop-file 会触发 mpv 重建音频滤镜链（含 afir/IR 卷积，约 350ms），
        // 切歌时循环值通常恒为 'no'，重复下发会无谓阻塞/重建，这里直接短路。
        if (value === this.loopFileValue) return;
        await this.getAddonOrThrow().setLoopFile(value);
        this.loopFileValue = value;
      });
    } catch {
      // 忽略循环设置失败
    }
  }

  async setNetworkSettings(settings: NetworkSettings): Promise<void> {
    if (!this.addon) return;
    await this.enqueueMpvCommand(() => {
      const addon = this.getAddonOrThrow();
      addon.setNetworkTimeout(settings.mpvNetworkTimeoutSecs);
      addon.setHttpProxy(settings.mpvHttpProxyUrl);
    });
    log.info('[MpvController] Applied network settings', {
      proxy: settings.mpvHttpProxyUrl ? 'configured' : 'none',
      timeoutSecs: settings.mpvNetworkTimeoutSecs,
    });
  }
}
