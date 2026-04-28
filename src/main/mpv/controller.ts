import { ChildProcess, execSync, spawn } from 'child_process';
import { EventEmitter } from 'events';
import net from 'net';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { app } from 'electron';
import { resolveMpvPath, resolveMpvLibDir } from './path';
import type { MpvAudioDevice, MpvMessage, MpvState, MpvTrackInfo } from './types';
import log from '../logger';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export class MpvController extends EventEmitter {
  private process: ChildProcess | null = null;
  private socket: net.Socket | null = null;
  private socketPath: string;
  private mpvBinPath: string | null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (data: unknown) => void; reject: (err: Error) => void }
  >();
  private buffer = '';
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
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isDestroyed = false;

  // 淡入淡出
  private fadeTimer: ReturnType<typeof setInterval> | null = null;
  private fadeSeq = 0;
  private fadeResolve: (() => void) | null = null;

  // 文件加载就绪 promise
  private fileReadyPromise: Promise<void> = Promise.resolve();
  private fileReadyResolve: (() => void) | null = null;

  constructor() {
    super();
    if (process.platform === 'win32') {
      this.socketPath = `\\\\.\\pipe\\echomusic-mpv-${process.pid}`;
    } else {
      this.socketPath = path.join(os.tmpdir(), `echomusic-mpv-${process.pid}.sock`);
    }
    this.mpvBinPath = resolveMpvPath();
  }

  get available(): boolean {
    return this.mpvBinPath !== null;
  }

  get currentState(): Readonly<MpvState> {
    return { ...this.state };
  }

  // ── 生命周期 ──

  async start(): Promise<void> {
    if (!this.mpvBinPath) throw new Error('mpv binary not found');

    log.info('[MpvController] Starting mpv process', {
      binPath: this.mpvBinPath,
      socketPath: this.socketPath,
      platform: process.platform,
    });

    // 清理旧 socket
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {}
    }

    // macOS: 清除 Gatekeeper 隔离属性，防止 mpv 被 SIGKILL
    if (process.platform === 'darwin') {
      try {
        const mpvDir = path.dirname(this.mpvBinPath);
        execSync(`xattr -cr "${mpvDir}"`, { timeout: 5000 });
      } catch {
        // 忽略，可能没有隔离属性
      }
    }

    const args = [
      '--idle=yes',
      '--pause',
      '--no-video',
      '--no-terminal',
      '--no-config',
      `--input-ipc-server=${this.socketPath}`,
      '--volume=100',
      '--audio-display=no',
      '--hr-seek=yes',
      '--volume-max=100',
      '--demuxer-max-bytes=50MiB',
      '--demuxer-max-back-bytes=10MiB',
      '--cache=yes',
      '--cache-secs=30',
      '--user-agent=Mozilla/5.0',
      '--input-media-keys=no',
      // 音频优化：采样率跟随源文件，避免不必要的重采样
      '--audio-samplerate=0',
      '--audio-channels=stereo',
    ];

    this.process = spawn(this.mpvBinPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // 所有平台都设置 cwd 到 mpv 所在目录
      // Windows: DLL 依赖需要在同目录
      // macOS/Linux: bundled dylib/so 可能在同级 lib/ 下
      cwd: path.dirname(this.mpvBinPath),
      env: this.buildEnv(),
    });

    this.process.on('exit', (code, signal) => {
      log.info('[MpvController] mpv process exited', { code, signal });
      this.emit('exit', code);
      this.cleanup();
      // 只在非正常退出（非 0 且非信号杀死）时重启
      if (!this.isDestroyed && code !== null && code !== 0) this.scheduleRestart();
    });

    this.process.on('error', (err) => {
      log.error('[MpvController] mpv process spawn error:', err.message);
      this.emit('error', err);
    });

    // 捕获 stderr，方便排查启动失败
    this.process.stderr?.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) log.warn('[MpvController] mpv stderr:', msg);
    });

    await this.waitForSocket(5000);
    await this.connectSocket();
    await this.observeProperties();
    this.emit('ready');
  }

  destroy(): void {
    this.isDestroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cancelFade();
    this.cleanup();
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process && !this.process.killed) this.process.kill('SIGKILL');
      }, 2000);
    }
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {}
    }
  }

  // ── 内部方法 ──

  private buildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (!this.mpvBinPath) return env;

    // 只有打包后使用 bundled mpv 时才需要设置库搜索路径
    // 系统安装的 mpv 已通过 rpath 正确链接，不需要额外设置
    const libDir = resolveMpvLibDir(this.mpvBinPath);
    if (!libDir) return env;

    const isBundled = app.isPackaged || this.mpvBinPath.includes('build/mpv');

    if (!isBundled) return env;

    if (process.platform === 'linux') {
      env.LD_LIBRARY_PATH = `${libDir}:${env.LD_LIBRARY_PATH || ''}`;
    } else if (process.platform === 'darwin') {
      env.DYLD_LIBRARY_PATH = `${libDir}:${env.DYLD_LIBRARY_PATH || ''}`;
      env.DYLD_FALLBACK_LIBRARY_PATH = `${libDir}:${env.DYLD_FALLBACK_LIBRARY_PATH || ''}`;
    }

    return env;
  }

  private waitForSocket(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        // Windows named pipe：轮询尝试连接，直到成功或超时
        const start = Date.now();
        const tryConnect = () => {
          const testSocket = net.connect(this.socketPath);
          testSocket.on('connect', () => {
            testSocket.destroy();
            resolve();
          });
          testSocket.on('error', () => {
            testSocket.destroy();
            if (Date.now() - start > timeoutMs) {
              return reject(new Error('mpv named pipe connect timeout'));
            }
            setTimeout(tryConnect, 100);
          });
        };
        // 给 mpv 进程一点启动时间
        setTimeout(tryConnect, 200);
        return;
      }
      const start = Date.now();
      const check = () => {
        if (fs.existsSync(this.socketPath)) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error('mpv socket timeout'));
        setTimeout(check, 50);
      };
      check();
    });
  }

  private connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.connect(this.socketPath);
      this.socket.on('connect', () => {
        this.buffer = '';
        resolve();
      });
      this.socket.on('data', (data) => {
        this.buffer += data.toString();
        this.processBuffer();
      });
      this.socket.on('error', reject);
      this.socket.on('close', () => {
        this.socket = null;
      });
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.handleMessage(JSON.parse(line) as MpvMessage);
      } catch {}
    }
  }

  private handleMessage(msg: MpvMessage): void {
    if (msg.request_id !== undefined) {
      const pending = this.pendingRequests.get(msg.request_id);
      if (pending) {
        this.pendingRequests.delete(msg.request_id);
        if (msg.error === 'success') pending.resolve(msg.data);
        else pending.reject(new Error(msg.error || 'mpv command failed'));
      }
      return;
    }
    if (msg.event) this.handleEvent(msg);
  }

  private handleEvent(msg: MpvMessage): void {
    // 触发原始事件名，供 waitForEvent 使用
    if (msg.event) this.emit(`mpv:${msg.event}`);

    switch (msg.event) {
      case 'property-change':
        this.handlePropertyChange(msg.name!, msg.data);
        break;
      case 'end-file':
        this.state.playing = false;
        this.state.paused = true;
        this.emit('playback-end', msg.reason || 'eof');
        break;
      case 'file-loaded':
        this.state.idle = false;
        if (this.fileReadyResolve) {
          this.fileReadyResolve();
          this.fileReadyResolve = null;
        }
        // 打印当前音频详细信息，方便排查音质问题
        this.logAudioInfo();
        break;
      case 'idle':
        this.state.idle = true;
        break;
    }
  }

  /** 文件加载后打印音频详细信息 */
  private logAudioInfo(): void {
    // 独占模式下音频输出初始化稍慢，延迟查询确保 audio-params 就绪
    setTimeout(() => {
      const props = ['audio-params', 'audio-codec-name', 'audio-exclusive', 'audio-device'];
      Promise.all(
        props.map((p) =>
          this.command('get_property', p)
            .then((v) => [p, v] as const)
            .catch(() => [p, null] as const),
        ),
      ).then((results) => {
        const info = Object.fromEntries(results);
        log.info('[MpvController] Audio info', info);
      });
    }, 500);
  }

  private handlePropertyChange(name: string, value: unknown): void {
    switch (name) {
      case 'time-pos':
        if (typeof value === 'number') {
          this.state.timePos = value;
          this.emit('time-update', value);
        }
        break;
      case 'duration':
        if (typeof value === 'number') {
          this.state.duration = value;
          this.emit('duration-change', value);
        }
        break;
      case 'pause':
        this.state.paused = !!value;
        this.state.playing = !value;
        this.emit('state-change', { paused: this.state.paused, playing: this.state.playing });
        break;
      case 'volume':
        if (typeof value === 'number') this.state.volume = value;
        break;
      case 'speed':
        if (typeof value === 'number') this.state.speed = value;
        break;
    }
  }

  private async observeProperties(): Promise<void> {
    const props = [
      'time-pos',
      'duration',
      'pause',
      'volume',
      'speed',
      'eof-reached',
      'idle-active',
    ];
    for (const prop of props) {
      await this.command('observe_property', 0, prop);
    }
  }

  private cleanup(): void {
    this.socket?.destroy();
    this.socket = null;
    this.pendingRequests.forEach(({ reject }) => reject(new Error('mpv process exited')));
    this.pendingRequests.clear();
    this.buffer = '';
  }

  private scheduleRestart(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.start();
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }, 2000);
  }

  // ── 命令发送 ──

  command(...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        return reject(new Error('mpv socket not connected'));
      }
      const id = ++this.requestId;
      const payload = JSON.stringify({ command: args, request_id: id }) + '\n';
      // 根据命令类型设置不同超时：文件加载类 15s，属性设置类 2s
      const cmdName = String(args[0] ?? '');
      const timeoutMs = cmdName === 'loadfile' || cmdName === 'stop' ? 15000 : 2000;
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`mpv command timeout (${timeoutMs}ms): ${cmdName}`));
        }
      }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.socket.write(payload);
    });
  }

  /** 向 mpv 发送命令但不等待响应，用于高频操作（如 fade 每步的音量设置） */
  private fireAndForget(...args: unknown[]): void {
    if (!this.socket || this.socket.destroyed) return;
    const id = ++this.requestId;
    const payload = JSON.stringify({ command: args, request_id: id }) + '\n';
    // 注册一个静默处理的 pending，防止响应到达时报错
    this.pendingRequests.set(id, {
      resolve: () => this.pendingRequests.delete(id),
      reject: () => this.pendingRequests.delete(id),
    });
    // 超时自动清理，防止内存泄漏
    setTimeout(() => this.pendingRequests.delete(id), 3000);
    this.socket.write(payload);
  }

  // ── 播放控制 ──

  async loadFile(url: string): Promise<void> {
    this.state.path = url;
    this.state.idle = true;
    this.fileReadyPromise = new Promise<void>((resolve) => {
      this.fileReadyResolve = resolve;
      // 超时兜底
      setTimeout(() => {
        if (this.fileReadyResolve === resolve) {
          resolve();
          this.fileReadyResolve = null;
        }
      }, 15000);
    });
    await this.command('loadfile', url, 'replace');
  }

  async loadMkvTrack(url: string, audioTrackId: number): Promise<void> {
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
    await this.command('loadfile', url, 'replace');
    // file-loaded 后设置音轨
    this.fileReadyPromise
      .then(() => this.command('set_property', 'aid', audioTrackId))
      .catch(() => {});
  }

  async getTrackList(): Promise<MpvTrackInfo[]> {
    return (await this.command('get_property', 'track-list')) as MpvTrackInfo[];
  }

  /** 等待文件加载就绪（loadFile 后的命令都应先 await 这个） */
  private async whenReady(): Promise<void> {
    await this.fileReadyPromise;
  }

  async play(): Promise<void> {
    await this.whenReady();
    await this.command('set_property', 'pause', false);
  }

  async pause(): Promise<void> {
    await this.command('set_property', 'pause', true);
  }

  async stop(): Promise<void> {
    try {
      await this.command('stop');
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
    try {
      await this.whenReady();
      await this.command('seek', time, 'absolute');
    } catch {
      // seek 失败时忽略
    }
  }

  async setVolume(volume: number): Promise<void> {
    const v = clamp(volume, 0, 100);
    await this.command('set_property', 'volume', v);
    this.state.volume = v;
  }

  async setSpeed(speed: number): Promise<void> {
    const s = clamp(speed, 0.1, 5);
    await this.command('set_property', 'speed', s);
    this.state.speed = s;
  }

  async setAudioDevice(deviceName: string): Promise<void> {
    await this.command('set_property', 'audio-device', deviceName);
    this.state.audioDevice = deviceName;
  }

  async getAudioDevices(): Promise<MpvAudioDevice[]> {
    return (await this.command('get_property', 'audio-device-list')) as MpvAudioDevice[];
  }

  async setAudioFilter(filterString: string): Promise<void> {
    await this.command('set_property', 'af', filterString || '');
  }

  async applyNormalizationGain(gainDb: number): Promise<void> {
    // 使用 volume-gain 属性独立于 volume 做增益，避免和 volume 叠加
    try {
      await this.command('set_property', 'volume-gain', gainDb);
    } catch {
      // volume-gain 在旧版 mpv 不支持，回退到 af 滤镜
      if (gainDb === 0) {
        await this.setAudioFilter('');
      } else {
        await this.setAudioFilter(`lavfi=[volume=${gainDb}dB]`);
      }
    }
  }

  // ── 淡入淡出 ──

  async fade(fromPercent: number, toPercent: number, durationMs: number): Promise<void> {
    this.cancelFade();
    if (durationMs <= 0) {
      await this.setVolume(toPercent);
      return;
    }

    const seq = ++this.fadeSeq;
    const steps = Math.ceil(durationMs / 16);
    const stepMs = durationMs / steps;
    const diff = toPercent - fromPercent;
    let step = 0;

    return new Promise<void>((resolve) => {
      this.fadeResolve = resolve;
      const safetyTimeout = setTimeout(() => {
        if (this.fadeResolve === resolve) {
          this.fadeResolve = null;
          this.cancelFade();
          resolve();
        }
      }, durationMs + 500);
      this.fadeTimer = setInterval(() => {
        if (seq !== this.fadeSeq) {
          clearTimeout(safetyTimeout);
          resolve();
          this.fadeResolve = null;
          return;
        }
        step++;
        const progress = step / steps;
        const eased = 1 - Math.pow(1 - progress, 2);
        const current = fromPercent + diff * eased;
        // 使用 fire-and-forget 写入，不等待 socket 响应，避免命令堆积
        this.fireAndForget('set_property', 'volume', clamp(current, 0, 100));

        if (step >= steps) {
          clearTimeout(safetyTimeout);
          this.fadeResolve = null;
          this.cancelFade();
          resolve();
        }
      }, stepMs);
    });
  }

  /**
   * 复合操作：淡出音量 → 暂停 → 恢复音量。
   * 整个流程在主进程内完成，渲染进程只需一次 IPC 调用。
   */
  async pauseWithFade(savedVolumePercent: number, durationMs: number): Promise<void> {
    await this.fade(savedVolumePercent, 0, durationMs);
    await this.pause();
    await this.setVolume(savedVolumePercent);
  }

  /**
   * 复合操作：设置音量为 0 → 播放 → 淡入到目标音量。
   * fade 部分不阻塞，播放命令发出后立即返回。
   */
  async playWithFade(targetVolumePercent: number, durationMs: number): Promise<void> {
    await this.setVolume(0);
    await this.play();
    // 淡入不阻塞，后台完成后同步最终音量
    this.fade(0, targetVolumePercent, durationMs)
      .then(() => this.setVolume(targetVolumePercent).catch(() => {}))
      .catch(() => {});
  }

  cancelFade(): void {
    if (this.fadeTimer) {
      clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }
    // 主动 resolve 被取消的 fade Promise，防止悬挂
    if (this.fadeResolve) {
      this.fadeResolve();
      this.fadeResolve = null;
    }
    this.fadeSeq++;
  }
}
