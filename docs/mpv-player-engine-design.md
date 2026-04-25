# EchoMusic mpv 播放引擎设计文档

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        渲染进程 (Renderer)                       │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │ PlayerBar.vue│───▶│ player store     │───▶│ PlayerEngine  │  │
│  │ 播放控制 UI   │    │ (Pinia)          │    │ (IPC 代理)     │  │
│  └──────────────┘    └──────────────────┘    └───────┬───────┘  │
│                                                      │          │
│  ┌──────────────────────────────────────┐            │          │
│  │ MediaSession (浏览器原生 API)         │◀───────────┤          │
│  │ 系统媒体控制、元数据、播放状态         │            │          │
│  └──────────────────────────────────────┘            │          │
└──────────────────────────────────────────────────────┼──────────┘
                                                       │
                                          Electron IPC │
                                                       │
┌──────────────────────────────────────────────────────┼──────────┐
│                        主进程 (Main)                  │          │
│                                                      ▼          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    MpvController                           │  │
│  │                                                           │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐  │  │
│  │  │ 进程管理     │  │ JSON IPC     │  │ 事件分发         │  │  │
│  │  │ spawn/kill  │  │ socket 通信   │  │ property-change │  │  │
│  │  └─────────────┘  └──────┬───────┘  └─────────────────┘  │  │
│  └──────────────────────────┼────────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────────┘
                              │
                    Unix Socket / Named Pipe
                              │
                              ▼
                    ┌──────────────────┐
                    │   mpv 子进程      │
                    │                  │
                    │  FFmpeg 解码      │
                    │  音频输出         │
                    │  音量/倍速/滤镜   │
                    └──────────────────┘
```

### 核心设计原则

- **渲染进程零改动原则**：`PlayerEngine` 保持相同的公开 API 签名，store 和 UI 层不需要修改
- **单引擎架构**：完全替换 Chromium 引擎，不做双引擎共存，降低复杂度
- **进程隔离**：mpv 崩溃不影响 Electron 主进程和 UI

---

## 2. mpv 二进制获取方案

### 2.1 来源：mpv 官方 GitHub CI 构建

mpv 官方仓库的 CI 会自动构建所有平台的二进制，通过 [nightly.link](https://nightly.link/mpv-player/mpv/workflows/build/master) 可以免登录直接下载。

当前可用的构建产物（v0.41.0-dev）：

| 平台          | 构建产物名                          | 说明              |
| ------------- | ----------------------------------- | ----------------- |
| macOS arm64   | `mpv-*-macos-14-arm.zip`            | Apple Silicon     |
| macOS x64     | `mpv-*-macos-15-intel.zip`          | Intel Mac         |
| Windows x64   | `mpv-*-x86_64-pc-windows-msvc.zip`  | MSVC 构建         |
| Windows arm64 | `mpv-*-aarch64-pc-windows-msvc.zip` | ARM64 Windows     |
| Linux x64     | CI 中 `apt install mpv` 后提取      | Ubuntu x64 runner |
| Linux arm64   | CI 中 `apt install mpv` 后提取      | Ubuntu ARM runner |

优势：

- 官方一手构建，质量有保证
- 覆盖所有目标平台和架构
- 持续更新，跟踪最新 master

如果需要锁定稳定版本，也可以从 [mpv releases](https://github.com/mpv-player/mpv/releases) 下载正式发布版（当前最新 v0.40.0）。

### 2.2 CI 自动下载 + extraResources 分发

#### 目录结构

```
build/
  mpv/
    darwin-arm64/
      mpv                # macOS arm64 二进制（从 .app bundle 中提取）
      lib/               # 依赖的 dylib
    darwin-x64/
      mpv
      lib/
    win32-x64/
      mpv.exe            # Windows x64
      mpv-2.dll          # libmpv 运行时
      ...其他 DLL
    win32-arm64/
      mpv.exe
      ...
```

#### CI 下载脚本 `scripts/download-mpv.sh`

```bash
#!/bin/bash
set -euo pipefail

# 从 mpv 官方 CI 构建下载二进制
# 用法: ./download-mpv.sh <platform> <arch>
# 示例: ./download-mpv.sh darwin arm64
#       ./download-mpv.sh win32 x64

PLATFORM="${1:?用法: $0 <platform> <arch>}"
ARCH="${2:?用法: $0 <platform> <arch>}"

# nightly.link 基础 URL（免登录下载 GitHub Actions 产物）
NIGHTLY_BASE="https://nightly.link/mpv-player/mpv/workflows/build/master"

case "${PLATFORM}-${ARCH}" in
  darwin-arm64)
    TARGET_DIR="build/mpv/darwin-arm64"
    # 官方 CI 的 macOS arm64 构建
    ARTIFACT_PATTERN="macos-14-arm"
    ;;
  darwin-x64)
    TARGET_DIR="build/mpv/darwin-x64"
    ARTIFACT_PATTERN="macos-15-intel"
    ;;
  win32-x64)
    TARGET_DIR="build/mpv/win32-x64"
    ARTIFACT_PATTERN="x86_64-pc-windows-msvc"
    ;;
  win32-arm64)
    TARGET_DIR="build/mpv/win32-arm64"
    ARTIFACT_PATTERN="aarch64-pc-windows-msvc"
    ;;
  linux-*)
    TARGET_DIR="build/mpv/linux-${ARCH}"
    mkdir -p "$TARGET_DIR"

    # CI 环境中直接 apt install，然后提取二进制和依赖库
    echo "Linux: 从系统包提取 mpv 二进制"
    # mpv 二进制
    MPV_BIN=$(which mpv 2>/dev/null || echo "")
    if [ -z "$MPV_BIN" ]; then
      echo "mpv 未安装，尝试安装..."
      sudo apt-get update && sudo apt-get install -y mpv
      MPV_BIN=$(which mpv)
    fi
    cp "$MPV_BIN" "$TARGET_DIR/"

    # 复制 mpv 依赖的共享库（排除系统基础库）
    mkdir -p "$TARGET_DIR/lib"
    ldd "$MPV_BIN" | grep "=> /" | awk '{print $3}' | while read -r lib; do
      # 跳过基础系统库（libc、libm、libpthread 等）
      case "$(basename "$lib")" in
        libc.so*|libm.so*|libpthread.so*|libdl.so*|librt.so*|ld-linux*) continue ;;
      esac
      cp "$lib" "$TARGET_DIR/lib/" 2>/dev/null || true
    done

    echo "mpv Linux 二进制已提取到 $TARGET_DIR"
    ;;
  *)
    echo "不支持的平台: ${PLATFORM}-${ARCH}"
    exit 1
    ;;
esac

mkdir -p "$TARGET_DIR"

# 从 nightly.link 页面解析最新构建的下载链接
echo "查找 mpv ${PLATFORM}-${ARCH} 构建..."
DOWNLOAD_URL=$(curl -sL "$NIGHTLY_BASE" | \
  grep -oE "https://nightly\.link/[^\"]*${ARTIFACT_PATTERN}\.zip" | \
  grep -v '\-pdb' | head -1)

if [ -z "$DOWNLOAD_URL" ]; then
  echo "错误：未找到匹配的构建产物 (pattern: $ARTIFACT_PATTERN)"
  exit 1
fi

echo "下载: $DOWNLOAD_URL"
curl -L -o /tmp/mpv-download.zip "$DOWNLOAD_URL"

# 解压
echo "解压到 $TARGET_DIR..."
unzip -o /tmp/mpv-download.zip -d /tmp/mpv-extract

case "$PLATFORM" in
  darwin)
    # macOS 构建产物是 .app bundle 或直接的二进制
    # 从中提取 mpv 可执行文件和依赖库
    if [ -d /tmp/mpv-extract/mpv.app ]; then
      cp /tmp/mpv-extract/mpv.app/Contents/MacOS/mpv "$TARGET_DIR/"
      # 复制依赖的 dylib（如果有）
      if [ -d /tmp/mpv-extract/mpv.app/Contents/Frameworks ]; then
        mkdir -p "$TARGET_DIR/lib"
        cp -R /tmp/mpv-extract/mpv.app/Contents/Frameworks/* "$TARGET_DIR/lib/"
      fi
    else
      # 直接是二进制文件
      find /tmp/mpv-extract -name "mpv" -type f -exec cp {} "$TARGET_DIR/" \;
    fi
    chmod +x "$TARGET_DIR/mpv"
    ;;
  win32)
    # Windows 构建：复制 exe 和所有 DLL
    find /tmp/mpv-extract -name "*.exe" -exec cp {} "$TARGET_DIR/" \;
    find /tmp/mpv-extract -name "*.dll" -exec cp {} "$TARGET_DIR/" \;
    ;;
esac

# 清理临时文件
rm -rf /tmp/mpv-download.zip /tmp/mpv-extract

echo "mpv ${PLATFORM}-${ARCH} 已下载到 $TARGET_DIR"
ls -la "$TARGET_DIR"
```

#### electron-builder 配置变更（package.json）

```jsonc
{
  "build": {
    "extraResources": [
      // ... 现有配置 ...
      {
        "from": "build/mpv/${platform}-${arch}",
        "to": "mpv",
        "filter": ["**/*"],
      },
    ],
    "deb": {
      "depends": ["libasound2"],
    },
  },
}
```

#### CI workflow 变更（build.yml 新增步骤）

```yaml
- name: Download mpv binary
  shell: bash
  run: |
    chmod +x scripts/download-mpv.sh
    case "${{ matrix.os }}" in
      macos-latest)
        bash scripts/download-mpv.sh darwin arm64
        ;;
      macos-14)
        bash scripts/download-mpv.sh darwin x64
        ;;
      windows-latest)
        bash scripts/download-mpv.sh win32 x64
        # 如果需要 arm64 Windows，额外下载
        # bash scripts/download-mpv.sh win32 arm64
        ;;
      ubuntu-*)
        # Linux 也打包 mpv，CI 中 apt install 后提取
        sudo apt-get update && sudo apt-get install -y mpv
        bash scripts/download-mpv.sh linux x64
        ;;
    esac
```

### 2.3 运行时 mpv 路径解析

```typescript
// src/main/mpv/path.ts
import { app } from 'electron';
import path from 'path';
import fs from 'fs';

/** 解析 mpv 二进制路径，优先使用打包的版本，回退到系统 PATH */
export function resolveMpvPath(): string | null {
  // 1. 打包在 extraResources 中的 mpv
  const bundledDir = path.join(
    app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../build'),
    'mpv',
    `${process.platform}-${process.arch}`,
  );
  const bundledBin =
    process.platform === 'win32' ? path.join(bundledDir, 'mpv.exe') : path.join(bundledDir, 'mpv');

  if (fs.existsSync(bundledBin)) {
    return bundledBin;
  }

  // 2. 开发环境或 Linux：尝试系统 PATH
  const systemBin = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
  // 检查 PATH 中是否存在 mpv
  const { execSync } = require('child_process');
  try {
    const result = execSync(
      process.platform === 'win32' ? `where ${systemBin}` : `which ${systemBin}`,
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    if (result) return result.split('\n')[0].trim();
  } catch {
    // 未找到
  }

  return null;
}
```

### 2.4 体积优化策略

macOS 上 `brew install mpv` 安装的是完整版（含视频解码器），体积较大。可以通过自定义编译减小体积：

```bash
# 精简编译参数（仅保留音频功能）
# 预计可将二进制从 ~25MB 缩减到 ~8-12MB
meson setup build \
  --prefix=/usr/local \
  -Dlibmpv=true \
  -Dcplayer=true \
  -Dgl=disabled \
  -Dvulkan=disabled \
  -Dx11=disabled \
  -Dwayland=disabled \
  -Dcocoa=disabled \
  -Ddrm=disabled \
  -Djpeg=disabled \
  -Dlibavdevice=disabled
```

不过初期建议先用完整版验证功能，后续再做体积优化。

---

## 3. 主进程：MpvController 详细设计

### 3.1 文件结构

```
src/main/mpv/
  index.ts          # 导出 + 初始化
  path.ts           # mpv 二进制路径解析
  controller.ts     # MpvController 核心类
  ipc-protocol.ts   # mpv JSON IPC 协议封装
  types.ts          # 类型定义
```

### 3.2 MpvController 类设计

```typescript
// src/main/mpv/controller.ts
import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import net from 'net';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { resolveMpvPath } from './path';

interface MpvState {
  playing: boolean;
  paused: boolean;
  duration: number;
  timePos: number;
  volume: number;
  speed: number;
  idle: boolean;
  path: string; // 当前播放的 URL
  audioDevice: string;
}

interface MpvControllerEvents {
  'state-change': (state: Partial<MpvState>) => void;
  'time-update': (time: number) => void;
  'duration-change': (duration: number) => void;
  'playback-end': (reason: 'eof' | 'error' | 'stop' | 'redirect' | 'quit') => void;
  error: (error: Error) => void;
  ready: () => void;
  exit: (code: number | null) => void;
}

export class MpvController extends EventEmitter {
  private process: ChildProcess | null = null;
  private socket: net.Socket | null = null;
  private socketPath: string;
  private mpvBinPath: string | null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    {
      resolve: (data: any) => void;
      reject: (error: Error) => void;
    }
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

  constructor() {
    super();
    // socket 路径：macOS/Linux 用 Unix socket，Windows 用 named pipe
    if (process.platform === 'win32') {
      this.socketPath = `\\\\.\\pipe\\echomusic-mpv-${process.pid}`;
    } else {
      this.socketPath = path.join(os.tmpdir(), `echomusic-mpv-${process.pid}.sock`);
    }
    this.mpvBinPath = resolveMpvPath();
  }

  /** mpv 是否可用 */
  get available(): boolean {
    return this.mpvBinPath !== null;
  }

  /** 当前播放状态快照 */
  get currentState(): Readonly<MpvState> {
    return { ...this.state };
  }

  /** 启动 mpv 子进程 */
  async start(): Promise<void> {
    if (!this.mpvBinPath) {
      throw new Error('mpv 二进制未找到');
    }

    // 清理旧的 socket 文件
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {}
    }

    const args = [
      '--idle=yes', // 空闲模式，等待命令
      '--no-video', // 纯音频，禁用视频
      '--no-terminal', // 不输出到终端
      '--no-config', // 不读取用户配置
      `--input-ipc-server=${this.socketPath}`, // IPC socket
      '--volume=100', // 初始音量（由应用控制）
      '--audio-display=no', // 不显示专辑封面
      '--hr-seek=yes', // 精确 seek
      '--demuxer-max-bytes=50MiB', // 缓冲区大小
      '--demuxer-max-back-bytes=10MiB',
      '--cache=yes', // 启用缓存
      '--cache-secs=30', // 缓存 30 秒
      '--user-agent=Mozilla/5.0', // UA 伪装
    ];

    this.process = spawn(this.mpvBinPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 上需要设置 cwd 到 mpv 所在目录（DLL 依赖）
      cwd: process.platform === 'win32' ? path.dirname(this.mpvBinPath) : undefined,
      env: this.buildMpvEnv(),
    });

    this.process.on('exit', (code) => {
      this.emit('exit', code);
      this.cleanup();
      // 非主动退出时尝试重启
      if (!this.isDestroyed && code !== 0) {
        this.scheduleRestart();
      }
    });

    this.process.on('error', (err) => {
      this.emit('error', err);
    });

    // 等待 socket 就绪后连接
    await this.waitForSocket(5000);
    await this.connectSocket();
    await this.observeProperties();
    this.emit('ready');
  }

  /** 等待 mpv 创建 socket 文件 */
  private waitForSocket(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const check = () => {
        if (process.platform === 'win32') {
          // Windows named pipe 不需要检查文件
          resolve();
          return;
        }
        if (fs.existsSync(this.socketPath)) {
          resolve();
          return;
        }
        if (Date.now() - startTime > timeoutMs) {
          reject(new Error('等待 mpv socket 超时'));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  /** 连接 mpv IPC socket */
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

      this.socket.on('error', (err) => {
        reject(err);
      });

      this.socket.on('close', () => {
        this.socket = null;
      });
    });
  }

  /** 解析 JSON IPC 消息（按行分割） */
  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    // 最后一个元素可能是不完整的行，保留在 buffer 中
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        // 忽略解析失败的行
      }
    }
  }

  /** 处理 mpv 返回的消息 */
  private handleMessage(msg: any): void {
    // 命令响应
    if ('request_id' in msg && msg.request_id !== undefined) {
      const pending = this.pendingRequests.get(msg.request_id);
      if (pending) {
        this.pendingRequests.delete(msg.request_id);
        if (msg.error === 'success') {
          pending.resolve(msg.data);
        } else {
          pending.reject(new Error(msg.error || 'mpv 命令失败'));
        }
      }
      return;
    }

    // 事件
    if ('event' in msg) {
      this.handleEvent(msg);
    }
  }

  /** 处理 mpv 事件 */
  private handleEvent(msg: any): void {
    switch (msg.event) {
      case 'property-change':
        this.handlePropertyChange(msg.name, msg.data);
        break;
      case 'end-file':
        this.state.playing = false;
        this.state.paused = true;
        this.emit('playback-end', msg.reason || 'eof');
        break;
      case 'file-loaded':
        this.state.idle = false;
        break;
      case 'idle':
        this.state.idle = true;
        break;
    }
  }

  /** 处理属性变更通知 */
  private handlePropertyChange(name: string, value: any): void {
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
        this.emit('state-change', {
          paused: this.state.paused,
          playing: this.state.playing,
        });
        break;
      case 'volume':
        if (typeof value === 'number') {
          this.state.volume = value;
        }
        break;
      case 'speed':
        if (typeof value === 'number') {
          this.state.speed = value;
        }
        break;
    }
  }

  /** 注册需要观察的属性（mpv 会在变化时主动推送） */
  private async observeProperties(): Promise<void> {
    const properties = [
      'time-pos', // 播放位置
      'duration', // 总时长
      'pause', // 暂停状态
      'volume', // 音量
      'speed', // 播放速度
      'eof-reached', // 是否播放到末尾
      'idle-active', // 是否空闲
    ];
    for (const prop of properties) {
      await this.command('observe_property', 0, prop);
    }
  }

  /** 发送命令到 mpv */
  command(...args: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('mpv socket 未连接'));
        return;
      }

      const id = ++this.requestId;
      const payload =
        JSON.stringify({
          command: args,
          request_id: id,
        }) + '\n';

      this.pendingRequests.set(id, { resolve, reject });

      // 超时处理
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`mpv 命令超时: ${args[0]}`));
        }
      }, 5000);

      this.socket.write(payload);
    });
  }

  // ── 播放控制 API（供 IPC handler 调用） ──

  /** 加载并播放音频 URL */
  async loadFile(url: string): Promise<void> {
    this.state.path = url;
    await this.command('loadfile', url, 'replace');
  }

  /** 加载 MKV 文件并选择指定音轨（替代 mkvExtractor） */
  async loadMkvTrack(url: string, audioTrackId: number): Promise<void> {
    this.state.path = url;
    await this.command('loadfile', url, 'replace', `aid=${audioTrackId}`);
  }

  /** 获取当前文件的音轨列表 */
  async getTrackList(): Promise<
    Array<{
      id: number;
      type: string;
      codec: string;
      title?: string;
      lang?: string;
    }>
  > {
    return await this.command('get_property', 'track-list');
  }

  /** 播放 */
  async play(): Promise<void> {
    await this.command('set_property', 'pause', false);
  }

  /** 暂停 */
  async pause(): Promise<void> {
    await this.command('set_property', 'pause', true);
  }

  /** 停止并清空 */
  async stop(): Promise<void> {
    await this.command('stop');
    this.state.playing = false;
    this.state.paused = true;
    this.state.timePos = 0;
    this.state.duration = 0;
    this.state.path = '';
  }

  /** 跳转到指定时间（秒） */
  async seek(time: number): Promise<void> {
    await this.command('seek', time, 'absolute');
  }

  /** 设置音量（0-100） */
  async setVolume(volume: number): Promise<void> {
    const clamped = Math.min(100, Math.max(0, volume));
    await this.command('set_property', 'volume', clamped);
    this.state.volume = clamped;
  }

  /** 设置播放速度 */
  async setSpeed(speed: number): Promise<void> {
    const clamped = Math.min(5, Math.max(0.1, speed));
    await this.command('set_property', 'speed', clamped);
    this.state.speed = clamped;
  }

  /** 设置音频输出设备 */
  async setAudioDevice(deviceName: string): Promise<void> {
    await this.command('set_property', 'audio-device', deviceName);
    this.state.audioDevice = deviceName;
  }

  /** 获取可用音频输出设备列表 */
  async getAudioDevices(): Promise<Array<{ name: string; description: string }>> {
    return await this.command('get_property', 'audio-device-list');
  }

  /** 设置音频滤镜（用于音量均衡） */
  async setAudioFilter(filterString: string): Promise<void> {
    if (filterString) {
      await this.command('set_property', 'af', filterString);
    } else {
      await this.command('set_property', 'af', '');
    }
  }

  /**
   * 应用音量均衡增益
   * 使用 mpv 的 lavfi volume 滤镜
   */
  async applyNormalizationGain(gainDb: number): Promise<void> {
    if (gainDb === 0) {
      await this.setAudioFilter('');
    } else {
      await this.setAudioFilter(`lavfi=[volume=${gainDb}dB]`);
    }
  }

  // ── 淡入淡出 ──

  private fadeTimer: NodeJS.Timeout | null = null;
  private fadeSeq = 0;

  /**
   * 音量渐变：通过高频设置 volume 属性实现平滑过渡。
   *
   * mpv 本身没有内置的 volume fade 命令，但可以通过两种方式实现：
   * 1. 主进程定时器快速调整 volume 属性（推荐，简单可靠）
   * 2. lavfi afade 滤镜（适合固定时长的 fade，不适合交互式 fade）
   *
   * 这里采用方案 1，因为交互式 fade（如暂停时淡出）需要随时取消。
   * 16ms 间隔 ≈ 60fps，mpv 的 volume 属性设置是即时生效的，延迟极低。
   */
  async fade(from: number, to: number, durationMs: number): Promise<void> {
    this.cancelFade();
    if (durationMs <= 0) {
      await this.setVolume(to);
      return;
    }

    const seq = ++this.fadeSeq;
    const steps = Math.ceil(durationMs / 16);
    const stepMs = durationMs / steps;
    const diff = to - from;
    let step = 0;

    return new Promise<void>((resolve) => {
      this.fadeTimer = setInterval(async () => {
        if (seq !== this.fadeSeq) {
          resolve();
          return;
        }
        step++;
        // ease-out 曲线
        const progress = step / steps;
        const eased = 1 - Math.pow(1 - progress, 2);
        const current = from + diff * eased;
        await this.setVolume(current).catch(() => {});

        if (step >= steps) {
          this.cancelFade();
          resolve();
        }
      }, stepMs);
    });
  }

  /** 取消正在进行的淡入淡出 */
  cancelFade(): void {
    if (this.fadeTimer) {
      clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }
    this.fadeSeq++;
  }

  /** 构建 mpv 子进程的环境变量 */
  private buildMpvEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    // Linux 上需要设置 LD_LIBRARY_PATH 指向打包的共享库目录
    if (process.platform === 'linux' && this.mpvBinPath) {
      const libDir = path.join(path.dirname(this.mpvBinPath), 'lib');
      if (fs.existsSync(libDir)) {
        env.LD_LIBRARY_PATH = `${libDir}:${env.LD_LIBRARY_PATH || ''}`;
      }
    }
    return env;
  }

  /** 异常重启调度 */
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

  /** 清理资源 */
  private cleanup(): void {
    this.socket?.destroy();
    this.socket = null;
    this.pendingRequests.forEach(({ reject }) => reject(new Error('mpv 进程已退出')));
    this.pendingRequests.clear();
    this.buffer = '';
  }

  /** 销毁控制器，终止 mpv 进程 */
  destroy(): void {
    this.isDestroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanup();
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      // 给 mpv 2 秒优雅退出，超时强杀
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 2000);
    }
    // 清理 socket 文件
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {}
    }
  }
}
```

---

## 4. 主进程 IPC 注册

### 4.1 新增 IPC 模块 `src/main/ipc/player.ts`

```typescript
// src/main/ipc/player.ts
import { ipcMain } from 'electron';
import type { MpvController } from '../mpv/controller';

export function registerPlayerIpc(mpv: MpvController): void {
  // 加载音频
  ipcMain.handle('mpv:load', async (_e, url: string) => {
    await mpv.loadFile(url);
  });

  // 加载 MKV 指定音轨
  ipcMain.handle('mpv:load-mkv-track', async (_e, url: string, trackId: number) => {
    await mpv.loadMkvTrack(url, trackId);
  });

  // 获取音轨列表
  ipcMain.handle('mpv:get-track-list', async () => {
    return mpv.getTrackList();
  });

  // 播放
  ipcMain.handle('mpv:play', async () => {
    await mpv.play();
  });

  // 暂停
  ipcMain.handle('mpv:pause', async () => {
    await mpv.pause();
  });

  // 停止
  ipcMain.handle('mpv:stop', async () => {
    await mpv.stop();
  });

  // 跳转
  ipcMain.handle('mpv:seek', async (_e, time: number) => {
    await mpv.seek(time);
  });

  // 设置音量（渲染进程传 0~1，这里转换为 0~100）
  ipcMain.handle('mpv:set-volume', async (_e, volume: number) => {
    await mpv.setVolume(volume * 100);
  });

  // 设置播放速度
  ipcMain.handle('mpv:set-speed', async (_e, speed: number) => {
    await mpv.setSpeed(speed);
  });

  // 设置输出设备
  ipcMain.handle('mpv:set-audio-device', async (_e, deviceName: string) => {
    await mpv.setAudioDevice(deviceName);
  });

  // 获取音频设备列表
  ipcMain.handle('mpv:get-audio-devices', async () => {
    return mpv.getAudioDevices();
  });

  // 应用音量均衡增益（dB）
  ipcMain.handle('mpv:set-normalization-gain', async (_e, gainDb: number) => {
    await mpv.applyNormalizationGain(gainDb);
  });

  // 淡入淡出
  ipcMain.handle('mpv:fade', async (_e, from: number, to: number, durationMs: number) => {
    await mpv.fade(from * 100, to * 100, durationMs);
  });

  // 取消淡入淡出
  ipcMain.handle('mpv:cancel-fade', () => {
    mpv.cancelFade();
  });

  // 获取当前状态快照
  ipcMain.handle('mpv:get-state', () => {
    return mpv.currentState;
  });

  // 检查 mpv 是否可用
  ipcMain.handle('mpv:available', () => {
    return mpv.available;
  });
}
```

### 4.2 主进程事件转发到渲染进程

```typescript
// src/main/mpv/index.ts
import { BrowserWindow } from 'electron';
import { MpvController } from './controller';
import { registerPlayerIpc } from '../ipc/player';

let mpvController: MpvController | null = null;

export async function initMpvPlayer(
  getMainWindow: () => BrowserWindow | null,
): Promise<MpvController | null> {
  const controller = new MpvController();

  if (!controller.available) {
    console.warn('[Main] mpv 二进制未找到，将使用 Chromium 播放引擎');
    return null;
  }

  // 注册 IPC
  registerPlayerIpc(controller);

  // 转发 mpv 事件到渲染进程
  controller.on('time-update', (time: number) => {
    getMainWindow()?.webContents.send('mpv:time-update', time);
  });

  controller.on('duration-change', (duration: number) => {
    getMainWindow()?.webContents.send('mpv:duration-change', duration);
  });

  controller.on('state-change', (state) => {
    getMainWindow()?.webContents.send('mpv:state-change', state);
  });

  controller.on('playback-end', (reason) => {
    getMainWindow()?.webContents.send('mpv:playback-end', reason);
  });

  controller.on('error', (error) => {
    getMainWindow()?.webContents.send('mpv:error', error.message);
  });

  // 启动 mpv
  try {
    await controller.start();
    console.log('[Main] mpv 播放引擎已启动');
    mpvController = controller;
    return controller;
  } catch (err) {
    console.error('[Main] mpv 启动失败:', err);
    return null;
  }
}

export function destroyMpvPlayer(): void {
  mpvController?.destroy();
  mpvController = null;
}
```

---

## 5. Preload 层变更

在 `src/preload/index.ts` 中新增 mpv 相关 API 暴露：

```typescript
// 在 contextBridge.exposeInMainWorld('electron', { ... }) 中新增：
mpv: {
  // 命令
  load: (url: string) => ipcRenderer.invoke('mpv:load', url),
  loadMkvTrack: (url: string, trackId: number) =>
    ipcRenderer.invoke('mpv:load-mkv-track', url, trackId),
  getTrackList: () => ipcRenderer.invoke('mpv:get-track-list'),
  play: () => ipcRenderer.invoke('mpv:play'),
  pause: () => ipcRenderer.invoke('mpv:pause'),
  stop: () => ipcRenderer.invoke('mpv:stop'),
  seek: (time: number) => ipcRenderer.invoke('mpv:seek', time),
  setVolume: (volume: number) => ipcRenderer.invoke('mpv:set-volume', volume),
  setSpeed: (speed: number) => ipcRenderer.invoke('mpv:set-speed', speed),
  setAudioDevice: (deviceName: string) =>
    ipcRenderer.invoke('mpv:set-audio-device', deviceName),
  getAudioDevices: () =>
    ipcRenderer.invoke('mpv:get-audio-devices') as Promise<
      Array<{ name: string; description: string }>
    >,
  setNormalizationGain: (gainDb: number) =>
    ipcRenderer.invoke('mpv:set-normalization-gain', gainDb),
  fade: (from: number, to: number, durationMs: number) =>
    ipcRenderer.invoke('mpv:fade', from, to, durationMs),
  cancelFade: () => ipcRenderer.invoke('mpv:cancel-fade'),
  getState: () => ipcRenderer.invoke('mpv:get-state'),
  available: () => ipcRenderer.invoke('mpv:available') as Promise<boolean>,

  // 事件监听
  onTimeUpdate: (func: (time: number) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, time: number) => func(time);
    ipcRenderer.on('mpv:time-update', listener);
    return () => ipcRenderer.removeListener('mpv:time-update', listener);
  },
  onDurationChange: (func: (duration: number) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, duration: number) =>
      func(duration);
    ipcRenderer.on('mpv:duration-change', listener);
    return () => ipcRenderer.removeListener('mpv:duration-change', listener);
  },
  onStateChange: (func: (state: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: any) => func(state);
    ipcRenderer.on('mpv:state-change', listener);
    return () => ipcRenderer.removeListener('mpv:state-change', listener);
  },
  onPlaybackEnd: (func: (reason: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, reason: string) => func(reason);
    ipcRenderer.on('mpv:playback-end', listener);
    return () => ipcRenderer.removeListener('mpv:playback-end', listener);
  },
  onError: (func: (message: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) =>
      func(message);
    ipcRenderer.on('mpv:error', listener);
    return () => ipcRenderer.removeListener('mpv:error', listener);
  },
},
```

---

## 6. 渲染进程：PlayerEngine 改造

### 6.1 核心思路：接口不变，完全替换实现

`PlayerEngine` 保持相同的公开 API 签名，内部实现从 `HTMLAudioElement` + `Web Audio API` 完全替换为通过 `window.electron.mpv` 调用主进程。不保留 Chromium 引擎，不做双引擎分发。

可删除的代码：

- `HTMLAudioElement` 相关的所有逻辑
- `AudioContext` / `GainNode` / `MediaElementAudioSourceNode` 整条 Web Audio 链路
- `setSinkId` 相关逻辑
- `mkvExtractor.ts` 整个文件
- `mkv-extract://` 自定义协议注册

### 6.2 新 PlayerEngine 实现

```typescript
// src/renderer/utils/player.ts

import logger from './logger';

export interface PlayerEngineEvents {
  timeUpdate?: (currentTime: number) => void;
  durationChange?: (duration: number) => void;
  ended?: () => void;
  play?: () => void;
  pause?: () => void;
  error?: (event: Event) => void;
}

export interface MediaSessionMeta {
  title: string;
  artist: string;
  album?: string;
  artwork?: Array<{ src: string; sizes: string; type: string }>;
}

export interface MediaSessionState {
  isPlaying: boolean;
  duration: number;
  currentTime: number;
  playbackRate: number;
}

export interface TrackLoudness {
  lufs: number;
  gain: number;
  peak: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const DEFAULT_REFERENCE_LUFS = -14.0;

// mpv preload API 类型
const mpv = (window as any).electron.mpv;

export class PlayerEngine {
  private events: PlayerEngineEvents = {};
  private sourceUrl = '';
  private volumeValue = 1;
  private playbackRateValue = 1;
  private durationValue = 0;
  private lastTimeValue = -1;
  private normalizationEnabled = false;
  private normalizationGain = 1.0;
  private referenceLufs = DEFAULT_REFERENCE_LUFS;
  private lastTrackLoudness: TrackLoudness | null = null;
  private cleanupFns: Array<() => void> = [];

  constructor() {
    this.bindMpvEvents();
  }

  // ── mpv 事件监听 ──

  private bindMpvEvents(): void {
    const offTime = mpv.onTimeUpdate((time: number) => {
      if (time === this.lastTimeValue) return;
      this.lastTimeValue = time;
      this.events.timeUpdate?.(time);
    });
    this.cleanupFns.push(offTime);

    const offDuration = mpv.onDurationChange((duration: number) => {
      if (duration === this.durationValue) return;
      this.durationValue = duration;
      this.events.durationChange?.(duration);
    });
    this.cleanupFns.push(offDuration);

    const offState = mpv.onStateChange((state: any) => {
      if (state.playing) this.events.play?.();
      else if (state.paused) this.events.pause?.();
    });
    this.cleanupFns.push(offState);

    const offEnd = mpv.onPlaybackEnd((reason: string) => {
      if (reason === 'eof') {
        this.events.ended?.();
      } else if (reason === 'error') {
        this.events.error?.(new Event('error'));
      }
    });
    this.cleanupFns.push(offEnd);

    const offError = mpv.onError((message: string) => {
      logger.error('PlayerEngine', 'mpv error', { message });
    });
    this.cleanupFns.push(offError);
  }

  // ── 公开 API ──

  setEvents(events: PlayerEngineEvents): void {
    this.events = events;
  }

  setSource(url: string): void {
    if (!url || this.sourceUrl === url) return;
    this.sourceUrl = url;
    this.durationValue = 0;
    this.lastTimeValue = -1;
    this.events.durationChange?.(0);
    mpv.load(url);
  }

  /** 加载 MKV 并选择指定音轨（替代 mkvExtractor） */
  setMkvSource(url: string, audioTrackId: number): void {
    this.sourceUrl = url;
    this.durationValue = 0;
    this.lastTimeValue = -1;
    this.events.durationChange?.(0);
    mpv.loadMkvTrack(url, audioTrackId);
  }

  async play(options?: {
    fadeIn?: boolean;
    fadeDurationMs?: number;
    timeoutMs?: number;
  }): Promise<void> {
    const durationMs = options?.fadeIn ? (options.fadeDurationMs ?? 500) : 0;
    if (durationMs > 0) {
      const targetVolume = this.volumeValue;
      await mpv.setVolume(0);
      await mpv.play();
      void mpv.fade(0, targetVolume, durationMs);
    } else {
      await mpv.play();
    }
  }

  async pause(options?: { fadeOut?: boolean; fadeDurationMs?: number }): Promise<void> {
    const durationMs = options?.fadeOut ? (options.fadeDurationMs ?? 500) : 0;
    if (durationMs > 0) {
      const savedVolume = this.volumeValue;
      await mpv.fade(savedVolume, 0, durationMs);
      await mpv.pause();
      await mpv.setVolume(savedVolume);
      this.volumeValue = savedVolume;
    } else {
      await mpv.pause();
    }
  }

  seek(time: number): void {
    mpv.seek(time);
    this.lastTimeValue = time;
    this.events.timeUpdate?.(time);
  }

  setVolume(value: number): number {
    const next = clamp(value, 0, 1);
    this.volumeValue = next;
    mpv.setVolume(next);
    return next;
  }

  fadeTo(value: number, durationMs = 0): Promise<void> {
    const to = clamp(value, 0, 1);
    const from = this.volumeValue;
    this.volumeValue = to;
    if (durationMs <= 0) {
      mpv.setVolume(to);
      return Promise.resolve();
    }
    return mpv.fade(from, to, durationMs);
  }

  setPlaybackRate(rate: number): number {
    const next = clamp(rate, 0.1, 5);
    this.playbackRateValue = next;
    mpv.setSpeed(next);
    return next;
  }

  async setOutputDevice(deviceId: string): Promise<boolean> {
    try {
      await mpv.setAudioDevice(deviceId);
      return true;
    } catch {
      return false;
    }
  }

  reset(): void {
    mpv.stop();
    this.sourceUrl = '';
    this.durationValue = 0;
    this.lastTimeValue = -1;
    this.events.durationChange?.(0);
    this.events.timeUpdate?.(0);
  }

  // ── 音量均衡 ──

  setVolumeNormalization(enabled: boolean): void {
    this.normalizationEnabled = enabled;
    if (!enabled) {
      mpv.setNormalizationGain(0);
      this.normalizationGain = 1.0;
    }
  }

  applyTrackLoudness(loudness: TrackLoudness | null): void {
    this.lastTrackLoudness = loudness;
    if (!loudness || !this.normalizationEnabled) {
      this.normalizationGain = 1.0;
      mpv.setNormalizationGain(0);
      return;
    }
    const { lufs, gain: suggestedGain, peak } = loudness;
    if (!Number.isFinite(lufs)) {
      this.normalizationGain = 1.0;
      mpv.setNormalizationGain(0);
      return;
    }
    const gainLinear = this.computeNormalizationGain(loudness);
    const gainDb = 20 * Math.log10(gainLinear);
    this.normalizationGain = gainLinear;
    mpv.setNormalizationGain(gainDb);
  }

  setReferenceLufs(lufs: number): void {
    this.referenceLufs = clamp(lufs, -20, -8);
    if (this.normalizationEnabled && this.lastTrackLoudness) {
      this.applyTrackLoudness(this.lastTrackLoudness);
    }
  }

  private computeNormalizationGain(loudness: TrackLoudness): number {
    const { lufs, gain: suggestedGain, peak } = loudness;
    let gain = Math.pow(10, (this.referenceLufs - lufs) / 20);
    if (suggestedGain !== 0) {
      gain *= Math.pow(10, suggestedGain / 20);
    }
    if (peak > 0 && peak * gain > 0.95) {
      gain = 0.95 / peak;
    }
    return clamp(gain, 0.1, 3.0);
  }

  // ── MediaSession（保持在渲染进程，不依赖 mpv） ──

  updateMediaMetadata(meta: MediaSessionMeta): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title,
        artist: meta.artist,
        album: meta.album ?? '',
        artwork: meta.artwork ?? [],
      });
    } catch {}
  }

  updateMediaPlaybackState(state: MediaSessionState): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
    if (typeof navigator.mediaSession.setPositionState === 'function') {
      try {
        navigator.mediaSession.setPositionState({
          duration: state.duration || 0,
          playbackRate: state.playbackRate || 1,
          position: state.currentTime || 0,
        });
      } catch {}
    }
  }

  setMediaSessionHandlers(handlers: {
    play?: () => void;
    pause?: () => void;
    previoustrack?: () => void;
    nexttrack?: () => void;
    seekto?: (time: number) => void;
    seekbackward?: (offset: number) => void;
    seekforward?: (offset: number) => void;
  }): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    session.setActionHandler('play', handlers.play ?? null);
    session.setActionHandler('pause', handlers.pause ?? null);
    session.setActionHandler('previoustrack', handlers.previoustrack ?? null);
    session.setActionHandler('nexttrack', handlers.nexttrack ?? null);
    session.setActionHandler(
      'seekto',
      handlers.seekto ? (d) => handlers.seekto?.(d.seekTime ?? 0) : null,
    );
    session.setActionHandler(
      'seekbackward',
      handlers.seekbackward ? (d) => handlers.seekbackward?.(d.seekOffset ?? 10) : null,
    );
    session.setActionHandler(
      'seekforward',
      handlers.seekforward ? (d) => handlers.seekforward?.(d.seekOffset ?? 10) : null,
    );
  }

  // ── getter ──

  get volumeNormalizationEnabled(): boolean {
    return this.normalizationEnabled;
  }
  get source(): string {
    return this.sourceUrl;
  }
  get currentTime(): number {
    return this.lastTimeValue >= 0 ? this.lastTimeValue : 0;
  }
  get duration(): number {
    return this.durationValue;
  }
  get volume(): number {
    return this.volumeValue;
  }
  get playbackRate(): number {
    return this.playbackRateValue;
  }
}
```

---

## 7. 输出设备映射

mpv 和 Chromium 的设备 ID 格式不同，需要做映射：

```typescript
// src/main/mpv/device-mapper.ts

/**
 * mpv 设备列表格式：
 * [{ name: "pulse/alsa_output.pci-0000_00_1f.3.analog-stereo", description: "Built-in Audio" }]
 *
 * Chromium 设备列表格式（navigator.mediaDevices.enumerateDevices）：
 * [{ deviceId: "abc123...", label: "Built-in Audio" }]
 *
 * 映射策略：通过 description/label 模糊匹配
 */
export function mapChromiumDeviceToMpv(
  chromiumDeviceId: string,
  chromiumDevices: MediaDeviceInfo[],
  mpvDevices: Array<{ name: string; description: string }>,
): string {
  if (chromiumDeviceId === 'default' || !chromiumDeviceId) {
    return 'auto';
  }

  // 找到 Chromium 设备的 label
  const chromiumDevice = chromiumDevices.find((d) => d.deviceId === chromiumDeviceId);
  if (!chromiumDevice?.label) return 'auto';

  // 在 mpv 设备列表中按 description 匹配
  const mpvDevice = mpvDevices.find(
    (d) =>
      d.description.toLowerCase().includes(chromiumDevice.label.toLowerCase()) ||
      chromiumDevice.label.toLowerCase().includes(d.description.toLowerCase()),
  );

  return mpvDevice?.name ?? 'auto';
}
```

---

## 8. 启动检测与错误提示

mpv 不可用时（二进制缺失或损坏），应用启动时在设置页面或播放区域显示明确提示：

```typescript
// 应用启动时检测 mpv 可用性
const mpvAvailable = await window.electron.mpv.available();
if (!mpvAvailable) {
  // 显示提示：播放引擎不可用，请重新安装应用
  toastStore.showError('播放引擎初始化失败，请重新安装应用或检查 mpv 是否完整');
}
```

不提供引擎切换选项，不做静默 fallback。mpv 是唯一引擎，缺失就是安装问题。

---

## 9. 实施计划

### 阶段一：基础框架（预计 2-3 天）

1. 创建 `src/main/mpv/` 目录结构
2. 实现 `MpvController` 核心类（进程管理 + JSON IPC + fade）
3. 实现 mpv 路径解析
4. 注册 IPC handler
5. 扩展 preload API

### 阶段二：渲染进程替换（预计 2 天）

1. 用新的 `PlayerEngine` 完全替换旧实现
2. 删除 `HTMLAudioElement` / `Web Audio API` / `AudioContext` 相关代码
3. 删除 `mkvExtractor.ts`，MKV 播放改为 `setMkvSource()`
4. 删除 `mkv-extract://` 自定义协议注册
5. 适配 player store 中构造音频 URL 的逻辑

### 阶段三：分发与 CI（预计 1-2 天）

1. 编写 mpv 下载脚本 `scripts/download-mpv.sh`
2. 修改 electron-builder 配置（extraResources）
3. 修改 CI workflow（各平台下载 mpv）
4. 各平台构建测试

### 阶段四：打磨（预计 1 天）

1. mpv 不可用时的错误提示
2. 日志完善
3. 清理 `howler` 等不再需要的依赖（package.json 中有 howler 但看起来未使用）

---

## 10. 风险与注意事项

### 10.1 macOS 代码签名

打包的 mpv 二进制需要和应用一起签名，否则 macOS Gatekeeper 会阻止运行。
electron-builder 会自动对 extraResources 中的可执行文件签名，但需要确认。

### 10.2 macOS 动态库依赖

macOS 上 `brew install mpv` 的二进制依赖 Homebrew 安装的 dylib。
解决方案：

- 使用 `otool -L` 检查依赖
- 使用 `install_name_tool` 修改 rpath，将依赖的 dylib 一起打包
- 或者使用静态编译的 mpv（更复杂但更干净）

### 10.3 Windows DLL 地狱

Windows 上 mpv 依赖多个 DLL（libmpv-2.dll、ffmpeg 相关 DLL 等）。
需要确保所有 DLL 都放在 mpv.exe 同目录下，并且 spawn 时 cwd 设置正确。

### 10.4 Linux 共享库依赖

Linux 上通过 CI `apt install mpv` 提取二进制时，需要一并提取依赖的 `.so` 文件。
运行时通过设置 `LD_LIBRARY_PATH` 指向打包的 lib 目录来加载：

```typescript
// spawn mpv 时设置环境变量
const env = { ...process.env };
if (process.platform === 'linux') {
  const libDir = path.join(path.dirname(mpvBinPath), 'lib');
  env.LD_LIBRARY_PATH = `${libDir}:${env.LD_LIBRARY_PATH || ''}`;
}
this.process = spawn(mpvBinPath, args, { env });
```

如果提取的共享库过多导致包体积膨胀，可以考虑只打包 mpv 二进制，在 deb/rpm 的 depends 中声明 `libmpv` 作为 fallback。但初期建议全量打包，确保开箱即用。

---

## 11. MKV 音轨提取：mpv 原生替代方案

### 11.1 现有方案的问题

当前 `mkvExtractor.ts` 实现了一个完整的 EBML 流式解析器，手动解析 MKV 容器格式，提取指定音轨的裸帧数据，通过自定义协议 `mkv-extract://` 喂给 `<audio>` 元素。

这个方案的痛点：

- ~300 行手写的 EBML 解析代码，维护成本高
- 需要自定义协议注册、流式 TransformStream、内存缓存管理
- 裸帧数据缺少容器头信息，某些编码格式可能出现兼容性问题
- 不支持 seek（需要完整缓存后才能 Range 请求）

### 11.2 mpv 原生方案

mpv 内置 FFmpeg 的 demuxer，原生支持 MKV 容器，可以直接播放 MKV URL 并选择指定音轨：

```typescript
// 直接播放 MKV URL，选择第 N 个音轨
// --aid=N 选择音轨（从 1 开始）
// --no-video 禁用视频轨
await mpv.command('loadfile', mkvUrl, 'replace');
await mpv.command('set_property', 'aid', targetTrackNumber);
```

或者在 loadFile 时通过启动参数指定：

```typescript
// MpvController 中新增方法
async loadMkvTrack(url: string, audioTrackId: number): Promise<void> {
  this.state.path = url;
  // loadfile 支持附加选项，用逗号分隔
  await this.command('loadfile', url, 'replace', `aid=${audioTrackId}`);
}
```

### 11.3 对比

| 维度      | 现有 EBML 解析器     | mpv 原生                  |
| --------- | -------------------- | ------------------------- |
| 代码量    | ~300 行              | 1 行命令                  |
| 格式支持  | 仅 SimpleBlock/Block | FFmpeg 全格式             |
| Seek 支持 | 需完整缓存           | 原生支持                  |
| 缓冲策略  | 自管理内存缓存       | mpv 内置 demuxer 缓存     |
| 音轨信息  | 手动解析 Tracks 元素 | `get_property track-list` |

### 11.4 迁移后可删除的代码

切换到 mpv 引擎后，以下文件/代码可以完全移除：

- `src/main/mkvExtractor.ts` — 整个文件
- `src/main/app.ts` 中的 `registerMkvExtractScheme()` 和 `registerMkvExtractHandler()` 调用
- `src/main/index.ts` 中的 `registerMkvExtractScheme` 导入（如果有）
- 渲染进程中构造 `mkv-extract://` URL 的逻辑，改为直接传 MKV URL + track ID 给 mpv

### 11.5 渲染进程适配

在 player store 中，原来构造 `mkv-extract://` URL 的地方改为：

```typescript
// 之前（Chromium 引擎）
const audioUrl = `mkv-extract://extract?track=${trackId}&url=${encodeURIComponent(mkvUrl)}&hash=${hash}`;
engine.setSource(audioUrl);

// 之后（mpv 引擎）
if (engine.backend === 'mpv') {
  // 直接传 MKV URL，mpv 原生处理
  await window.electron.mpv.loadMkvTrack(mkvUrl, trackId);
} else {
  // Chromium fallback 保留原有逻辑
  const audioUrl = `mkv-extract://extract?track=${trackId}&url=${encodeURIComponent(mkvUrl)}`;
  engine.setSource(audioUrl);
}
```

### 11.6 获取音轨列表

mpv 可以直接获取 MKV 文件的音轨信息，不需要手动解析 EBML：

```typescript
// MpvController 中新增
async getTrackList(): Promise<Array<{
  id: number;
  type: string;        // 'audio' | 'video' | 'sub'
  codec: string;       // 'opus' | 'aac' | 'flac' 等
  title?: string;
  lang?: string;
  channels?: number;
  samplerate?: number;
}>> {
  return await this.command('get_property', 'track-list');
}
```

这样如果未来需要让用户选择音轨，UI 层可以直接拿到结构化的音轨信息。
