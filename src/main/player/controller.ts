import { EventEmitter } from 'events';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { PlayerAudioDevice, PlayerState, PlayerTrackInfo } from './types';
import type { ImpulseResponsePlaybackOptions } from '../../shared/audio';
import type {
  AudioSpectrumFrame,
  AudioSpectrumOptions,
  AudioSpectrumStatus,
} from '../../shared/audio-spectrum';
import log from '../logger';

const PLAYER_ADDON_NAME = 'echo-ffmpeg-player';

// native addon 类型（与自动生成的 index.d.ts 对齐）
interface PlayerAddon {
  initialize(libPath: string): void;
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
  startSpectrum?(options?: AudioSpectrumOptions | null): AudioSpectrumStatus;
  stopSpectrum?(): AudioSpectrumStatus;
  getSpectrumStatus?(): AudioSpectrumStatus;
  getSpectrumSnapshot?(): AudioSpectrumFrame | null;
  setAudioFilter(filter: string): void;
  setEq?(gains: number[]): void;
  afCommand(label: string, cmd: string, arg: string, target: string): void;
  setNormalizationGain(gainDb: number): void;
  setExclusive(exclusive: boolean): void;
  setMediaTitle(title: string): void;
  getState(): PlayerState;
  getProperty(name: string): string;
  setLoopFile(value: string): void;
  fade(from: number, to: number, durationMs: number): void;
  cancelFade(): void;
  pauseWithFade(savedVolume: number, durationMs: number): void;
  playWithFade(targetVolume: number, durationMs: number): void;
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

const quotePlayerOptionValue = (value: string): string =>
  `%${Buffer.byteLength(value, 'utf8')}%${value}`;

export class PlayerController extends EventEmitter {
  private addon: PlayerAddon | null = null;
  private isDestroyed = false;

  // 文件加载就绪 promise
  private fileReadyPromise: Promise<void> = Promise.resolve();
  private fileReadyResolve: (() => void) | null = null;

  // 内部状态（与 addon 同步）
  private state: PlayerState = {
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
  // file-loaded 后置位：强制下一次 sync 整链重设，且不做 duck。
  private forceReapply = false;

  get available(): boolean {
    return this.resolveAddonPath() !== null;
  }

  get engineName(): string {
    return PLAYER_ADDON_NAME;
  }

  get hasPlayerCoreSpectrum(): boolean {
    return typeof this.addon?.startSpectrum === 'function';
  }

  get currentState(): Readonly<PlayerState> {
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
    log.info('[PlayerController] Starting player engine', {
      addon: PLAYER_ADDON_NAME,
      platform: process.platform,
    });

    await this.startBackend();
    this.emit('ready');
  }

  destroy(): void {
    this.isDestroyed = true;
    try {
      this.addon?.cancelFade();
      this.addon?.destroy();
    } catch (err) {
      log.warn('[PlayerController] destroy error:', err);
    }
    this.addon = null;
  }

  // ── 内部方法 ──

  private async startBackend(): Promise<void> {
    const addon = this.loadAddon();
    if (!addon) throw new Error(`Failed to load ${PLAYER_ADDON_NAME} addon`);

    log.info(`[PlayerController] Initializing ${PLAYER_ADDON_NAME}`);
    addon.initialize('');
    addon.registerEventHandler((err, event) => {
      if (err) {
        log.warn('[PlayerController] Event callback error:', err);
        return;
      }
      this.handleEvent(event);
    });

    this.addon = addon;
  }

  private resolveAddonPath(): string | null {
    const addonPath = app.isPackaged
      ? path.join(process.resourcesPath, 'native', `${PLAYER_ADDON_NAME}.node`)
      : path.join(__dirname, '../../native', PLAYER_ADDON_NAME, `${PLAYER_ADDON_NAME}.node`);

    if (fs.existsSync(addonPath)) return addonPath;
    return null;
  }

  private loadAddon(): PlayerAddon | null {
    try {
      const addonPath = this.resolveAddonPath();
      if (!addonPath) throw new Error(`${PLAYER_ADDON_NAME} addon file not found`);
      log.info('[PlayerController] Loading native addon:', addonPath);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(addonPath) as PlayerAddon;
    } catch (err) {
      log.warn(`[PlayerController] ${PLAYER_ADDON_NAME} primary path load failed:`, err);
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require(`../../native/${PLAYER_ADDON_NAME}`) as PlayerAddon;
      } catch (fallbackErr) {
        log.warn(`[PlayerController] Failed to load ${PLAYER_ADDON_NAME} addon:`, fallbackErr);
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
        // 重新应用音频滤镜。强制下一次 sync 整链重设，确保这次重应用
        // 一定下发，避免换歌后音效悄悄消失。
        // 走整链重设而非 af-command，且不做 duck（换歌本身另有淡入淡出）。
        this.forceReapply = true;
        void this.syncAudioFilters();
        // 触发原始事件名
        this.emit('player:file-loaded');
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
      log.error('[PlayerController] player log:', payload);
    } else {
      log.warn('[PlayerController] player log:', payload);
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
    log.warn('[PlayerController] Disabling IR after audio filter failure:', {
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
      log.info('[PlayerController] Audio info', info);
    }, 500);
  }

  // ── 命令发送 ──

  /** 向播放核心发送兼容命令，用于 set-media-title 等直接属性操作 */
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

    log.warn('[PlayerController] Unhandled command:', args);
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
    this.addon.loadMkvTrack(url, audioTrackId);
  }

  async getTrackList(): Promise<PlayerTrackInfo[]> {
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

  private async updateAudioFilter(updater: () => void): Promise<void> {
    if (!this.addon) return;
    updater();
    await this.syncAudioFilters();
  }

  async setEq(gains: number[]): Promise<void> {
    this.equalizerGains = gains.map((g) => clamp(g, -12, 12));
    if (typeof this.addon?.setEq === 'function') {
      this.addon.setEq(this.equalizerGains);
      return;
    }
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
        '[PlayerController] Impulse response file not found, disabling filter:',
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
    this.addon.setAudioDevice(deviceName);
    this.state.audioDevice = deviceName;
  }

  async getAudioDevices(): Promise<PlayerAudioDevice[]> {
    if (!this.addon) return [];
    try {
      return this.addon.getAudioDevices();
    } catch {
      return [];
    }
  }

  startSpectrum(options?: AudioSpectrumOptions): AudioSpectrumStatus | null {
    if (!this.hasPlayerCoreSpectrum) return null;
    try {
      return this.addon?.startSpectrum?.(options ?? null) ?? null;
    } catch (err) {
      log.warn('[PlayerController] player-core spectrum start failed:', err);
      return null;
    }
  }

  stopSpectrum(): AudioSpectrumStatus | null {
    if (!this.hasPlayerCoreSpectrum) return null;
    try {
      return this.addon?.stopSpectrum?.() ?? null;
    } catch (err) {
      log.warn('[PlayerController] player-core spectrum stop failed:', err);
      return null;
    }
  }

  getSpectrumStatus(): AudioSpectrumStatus | null {
    if (!this.hasPlayerCoreSpectrum) return null;
    try {
      return this.addon?.getSpectrumStatus?.() ?? null;
    } catch (err) {
      log.warn('[PlayerController] player-core spectrum status failed:', err);
      return null;
    }
  }

  getSpectrumSnapshot(): AudioSpectrumFrame | null {
    if (!this.hasPlayerCoreSpectrum) return null;
    try {
      return this.addon?.getSpectrumSnapshot?.() ?? null;
    } catch (err) {
      log.warn('[PlayerController] player-core spectrum snapshot failed:', err);
      return null;
    }
  }

  async setAudioFilter(filterString: string): Promise<void> {
    if (!this.addon) return;
    this.addon.setAudioFilter(filterString || '');
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
    await this.syncAudioFilters();
  }

  /** 同步合并后的音频滤镜到播放核心 */
  private async syncAudioFilters(): Promise<void> {
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
      // 真实下发串：真实 mix + 正确的字节长度前缀（quotePlayerOptionValue 按字节数计前缀，
      // 所以必须对真实图计算，不能对占位符串再做替换）。
      filters.push(
        `@${IMPULSE_RESPONSE_AF_LABEL}:lavfi=graph=${quotePlayerOptionValue(buildGraph(String(mix)))}`,
      );
      // 结构键无需是合法滤镜串，仅用于比较，故用占位符、省去字节前缀。
      structuralParts.push(
        `@${IMPULSE_RESPONSE_AF_LABEL}:lavfi=${buildGraph(IMPULSE_RESPONSE_MIX_PLACEHOLDER)}`,
      );
    }

    if (hasEq) {
      const freqs = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
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

    if (this.normalizationGainDb !== 0) {
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
          this.addon.afCommand(
            IMPULSE_RESPONSE_AF_LABEL,
            'weights',
            `1 ${mix}`,
            IMPULSE_RESPONSE_MIX_FILTER,
          );
          this.lastAppliedMix = mix;
          return;
        } catch (err) {
          // af-command 不被支持时清结构键，落到下方整链重设兜底。
          log.warn('[PlayerController] af-command failed, falling back to full rebuild:', err);
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

    log.info('[PlayerController] Applying audio filter:', filterString || '(cleared)');
    try {
      if (shouldDuck) await this.applyFilterWithDuck(filterString);
      else this.addon.setAudioFilter(filterString);
      this.lastStructuralKey = structuralKey;
      this.lastAppliedMix = mix;
      this.lastIrActive = irActive;
      this.lastIrPath = irPath;
      this.forceReapply = false;
    } catch (err) {
      if (!irActive) throw err;
      log.warn('[PlayerController] Impulse response filter failed, disabling IR:', err);
      const failedPath = this.impulseResponsePath;
      this.impulseResponsePath = '';
      // 清结构键，确保禁用 IR 后的重建一定下发；置位恢复标志，使重建走整链分支而不 duck。
      this.lastStructuralKey = null;
      this.impulseResponseFailureRecovering = true;
      try {
        await this.syncAudioFilters();
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
    try {
      this.addon.setAudioFilter(filterString);
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
   * 整个流程在 Rust 侧完成，不阻塞 UI 线程。
   */
  async pauseWithFade(savedVolumePercent: number, durationMs: number): Promise<void> {
    if (!this.addon) return;
    // 非阻塞调用，淡出在 Rust 后台线程执行
    this.addon.pauseWithFade(savedVolumePercent, durationMs);
  }

  /**
   * 复合操作：设置音量为 0 → 播放 → 淡入到目标音量。
   * fade 部分不阻塞，播放命令发出后立即返回。
   */
  async playWithFade(targetVolumePercent: number, durationMs: number): Promise<void> {
    if (!this.addon) return;
    await this.whenReady();
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
